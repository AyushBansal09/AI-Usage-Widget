import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { Adapter, AdapterDetection, EmitFn, UsageEventInput } from "@ai-usage-widget/core";

/**
 * Reads OpenAI Codex CLI rollouts: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * (plus archived_sessions/). Validated against Codex CLI 0.154 (fixture in
 * src/__fixtures__, scrubbed from a real session).
 *
 * Each line is {timestamp, ordinal?, type, payload}. What matters:
 *  - session_meta: {id, cwd, model_provider, cli_version, source}. `model` is
 *    null here in 0.154; the model comes from turn_context.
 *  - turn_context: {model, cwd, turn_id?}. One per turn.
 *  - token_usage_record (0.15x+): one per API response, with `response_id`
 *    and `usage` {input_tokens, cached_input_tokens, cache_write_input_tokens,
 *    output_tokens, reasoning_output_tokens, total_tokens}. This is the event
 *    source of choice: the id is OpenAI's own, so re-reading is idempotent.
 *  - event_msg/token_count: {info.{total,last}_token_usage, rate_limits}.
 *    Older Codex has only this; we then emit one event per line from the
 *    `last_token_usage` delta. Always the source of `rate_limits`: the
 *    account's own plan windows ({primary,secondary}.{used_percent,
 *    window_minutes, resets_at}, plan_type, credits), which is how ChatGPT
 *    quota reaches the widget without any network call of ours.
 *  - response_item: function_call / custom_tool_call / local_shell_call for
 *    tool use; message role=user for the prompt (skip the "<...>" preambles
 *    Codex injects). event_msg/item_completed with item.type UserMessage is
 *    the cleaner prompt source when present.
 *
 * Note `input_tokens` includes the cached part; we split it so "all tokens"
 * never double counts: inputTokens = input - cached, cacheReadTokens = cached.
 * Codex's own "tokens used" line equals input - cached + output.
 */

export interface CodexRateLimitWindow {
  id: "primary" | "secondary";
  /** 0..100 as Codex reports it. */
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface CodexRateLimits {
  /** Timestamp of the rollout line this came from. */
  at: string;
  planType: string | null;
  limitId: string | null;
  windows: CodexRateLimitWindow[];
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
}

export interface RolloutParse {
  events: UsageEventInput[];
  rateLimits: CodexRateLimits | null;
}

export class CodexAdapter implements Adapter {
  readonly name = "codex";
  private dir: string;
  private latest: CodexRateLimits | null = null;

  constructor(opts: { codexHome?: string } = {}) {
    this.dir = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  }

  async detect(): Promise<AdapterDetection> {
    const sessions = join(this.dir, "sessions");
    if (!existsSync(sessions)) return { available: false, location: sessions, reason: "No Codex sessions directory (run `codex` once after `codex login`)" };
    return { available: true, location: sessions };
  }

  async backfill(emit: EmitFn): Promise<void> {
    for (const file of this.listRollouts()) this.ingest(file, emit);
  }

  async watch(emit: EmitFn): Promise<() => void> {
    // Cheap full rescan of changed files every 10s; idempotent ids make this safe.
    const seen = new Map<string, number>();
    const tick = () => {
      for (const file of this.listRollouts()) {
        let size: number;
        try { size = statSync(file).size; } catch { continue; }
        if (seen.get(file) === size) continue;
        seen.set(file, size);
        this.ingest(file, emit);
      }
    };
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }

  /**
   * The newest rate-limit snapshot seen in any rollout.
   *
   * Falls back to reading the most recent rollouts directly, so a caller that
   * never ingested (`doctor`, or an account link polling before the first
   * watch tick) still sees the plan's windows. Cheap: newest files first,
   * stopping at the first one that carries `rate_limits`.
   */
  rateLimits(): CodexRateLimits | null {
    if (!this.latest) this.scanForRateLimits();
    return this.latest;
  }

  private scanForRateLimits(limit = 5): void {
    const newest = this.listRollouts()
      .map((f) => {
        try { return { f, m: statSync(f).mtimeMs }; } catch { return null; }
      })
      .filter((x): x is { f: string; m: number } => x !== null)
      .sort((a, b) => b.m - a.m)
      .slice(0, limit);
    for (const { f } of newest) {
      let text: string;
      try { text = readFileSync(f, "utf8"); } catch { continue; }
      const { rateLimits } = parseRolloutFull(text, basename(f));
      if (rateLimits) {
        this.latest = rateLimits;
        return;
      }
    }
  }

  private ingest(file: string, emit: EmitFn): void {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return; }
    const { events, rateLimits } = parseRolloutFull(text, basename(file));
    for (const ev of events) emit(ev);
    if (rateLimits && (!this.latest || rateLimits.at > this.latest.at)) this.latest = rateLimits;
  }

  listRollouts(): string[] {
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      if (!existsSync(d) || depth > 5) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith(".jsonl")) out.push(p);
      }
    };
    walk(join(this.dir, "sessions"), 0);
    walk(join(this.dir, "archived_sessions"), 0);
    return out.sort();
  }
}

/** Events only; see parseRolloutFull for the rate limits as well. */
export function parseRollout(text: string, fileId: string): UsageEventInput[] {
  return parseRolloutFull(text, fileId).events;
}

export function parseRolloutFull(text: string, fileId: string): RolloutParse {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const parsed: Array<{ d: any; i: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    try { parsed.push({ d: JSON.parse(lines[i]!), i }); } catch { /* partial line while tailing */ }
  }
  // 0.15x writes token_usage_record; if a file has any, token_count is only
  // used for rate limits, never for events (it would double count).
  const hasRecords = parsed.some(({ d }) => d.type === "token_usage_record");

  const events: UsageEventInput[] = [];
  let rateLimits: CodexRateLimits | null = null;
  let sessionId = fileId.replace(/^rollout-.*?-([0-9a-f-]{36})\.jsonl$/, "$1");
  let cwd: string | undefined;
  let model = "unknown";
  let turnId: string | undefined;
  let pendingTools: string[] = [];
  let lastToolActivity: string | undefined;
  let lastPrompt: string | undefined;
  let prevTotal: Record<string, number> | null = null;

  const emitUsage = (id: string, usage: any, timestamp: string, extra: Record<string, unknown>) => {
    const cached = num(usage.cached_input_tokens);
    events.push({
      id,
      source: "codex",
      provider: "openai",
      model,
      timestamp,
      sessionId,
      agentId: "main",
      project: cwd,
      inputTokens: Math.max(num(usage.input_tokens) - cached, 0),
      cacheReadTokens: cached,
      cacheWriteTokens: num(usage.cache_write_input_tokens),
      outputTokens: num(usage.output_tokens),
      reasoningTokens: num(usage.reasoning_output_tokens),
      costUsd: null,
      toolCalls: pendingTools,
      activity: lastToolActivity ?? lastPrompt,
      meta: { prompt: lastPrompt, turnId, ...extra },
    });
    pendingTools = [];
    lastToolActivity = undefined;
  };

  for (const { d, i } of parsed) {
    const p = d.payload ?? {};
    const ts: string = typeof d.timestamp === "string" ? d.timestamp : new Date().toISOString();

    switch (d.type) {
      case "session_meta":
        sessionId = p.id ?? sessionId;
        cwd = p.cwd ?? cwd;
        if (typeof p.model === "string") model = p.model;
        break;
      case "turn_context":
        if (typeof p.model === "string") model = p.model;
        cwd = p.cwd ?? cwd;
        turnId = p.turn_id ?? p.root_turn_id ?? turnId;
        break;
      case "response_item":
        if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
          const name = String(p.name ?? (p.type === "local_shell_call" ? "shell" : "tool"));
          pendingTools.push(name);
          lastToolActivity = describeCodexTool(name, p.arguments ?? p.input ?? p.action);
        } else if (p.type === "message" && p.role === "user") {
          const t = messageText(p.content);
          if (t && !t.startsWith("<")) lastPrompt = excerpt(t);
        }
        break;
      case "event_msg":
        if (p.type === "user_message" && typeof p.message === "string") {
          lastPrompt = excerpt(p.message);
        } else if (p.type === "item_completed" && p.item?.type === "UserMessage") {
          const t = messageText(p.item.content);
          if (t) lastPrompt = excerpt(t);
        } else if (p.type === "token_count") {
          if (p.rate_limits) rateLimits = parseRateLimits(p.rate_limits, ts);
          if (!hasRecords && p.info) {
            const total = p.info.total_token_usage ?? {};
            let delta = p.info.last_token_usage;
            if (!delta && prevTotal) delta = Object.fromEntries(Object.keys(total).map((k) => [k, (total[k] ?? 0) - (prevTotal![k] ?? 0)]));
            prevTotal = total;
            if (delta) emitUsage(`codex:${sessionId}:${d.ordinal ?? i}`, delta, ts, { format: "token_count" });
          }
        }
        break;
      case "token_usage_record": {
        const usage = p.usage ?? p.turn_token_usage;
        if (!usage) break;
        const rid = typeof p.response_id === "string" && p.response_id ? p.response_id : `${sessionId}:${d.ordinal ?? i}`;
        if (typeof p.turn_id === "string") turnId = p.turn_id;
        emitUsage(`codex:${rid}`, usage, ts, { format: "token_usage_record", responseId: p.response_id });
        break;
      }
    }
  }
  return { events, rateLimits };
}

export function parseRateLimits(rl: any, at: string): CodexRateLimits | null {
  if (!rl || typeof rl !== "object") return null;
  const windows: CodexRateLimitWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const w = rl[id];
    if (!w || typeof w !== "object" || typeof w.used_percent !== "number") continue;
    windows.push({
      id,
      usedPercent: Math.max(0, Math.min(100, w.used_percent)),
      windowMinutes: typeof w.window_minutes === "number" ? w.window_minutes : null,
      resetsAt: epochToIso(w.resets_at),
    });
  }
  const c = rl.credits;
  return {
    at,
    planType: typeof rl.plan_type === "string" ? rl.plan_type : null,
    limitId: typeof rl.limit_id === "string" ? rl.limit_id : null,
    windows,
    credits: c && typeof c === "object" ? { hasCredits: !!c.has_credits, unlimited: !!c.unlimited, balance: typeof c.balance === "number" ? c.balance : null } : null,
  };
}

/** "shell: git status", "apply_patch" */
export function describeCodexTool(name: string, args: unknown): string {
  let a: any = args;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = { command: a }; } }
  let detail: string | undefined;
  const cmd = a?.command ?? a?.cmd;
  if (Array.isArray(cmd)) detail = cmd.join(" ");
  else if (typeof cmd === "string") detail = cmd;
  else if (typeof a?.path === "string") detail = a.path;
  return detail ? `${name}: ${excerpt(detail, 70)}` : name;
}

function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function excerpt(s: string, n = 120): string {
  const one = s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}

function epochToIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}
