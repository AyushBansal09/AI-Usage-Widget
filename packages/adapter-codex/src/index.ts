import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { Adapter, AdapterDetection, EmitFn, UsageEventInput } from "@ai-usage-widget/core";

/**
 * STATUS: skeleton, written from the documented rollout format, not yet
 * validated against a real ~/.codex install. First thing to do on a machine
 * with Codex: copy one rollout file into src/fixtures/ (scrubbed) and make
 * the test below pass against it.
 *
 * Rollout format notes (Codex CLI 0.4x+):
 *  - Files: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, plus
 *    archived_sessions/. Active copies win over archived ones.
 *  - First line: {"type":"session_meta","payload":{"id","cwd","model",...}}
 *  - Turn context: {"type":"turn_context","payload":{"model": "..."}}
 *  - Usage: {"type":"event_msg","payload":{"type":"token_count","info":{
 *      "total_token_usage":{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens},
 *      "last_token_usage":{...same...}}}}
 *    `total_token_usage` is cumulative for the thread; `last_token_usage` is
 *    the delta for the most recent request. We emit one event per
 *    token_count line using the delta, and fall back to diffing cumulative
 *    totals when the delta is missing.
 *  - Tool calls: {"type":"response_item","payload":{"type":"function_call","name":"shell",...}}
 */
export class CodexAdapter implements Adapter {
  readonly name = "codex";
  private dir: string;

  constructor(opts: { codexHome?: string } = {}) {
    this.dir = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  }

  async detect(): Promise<AdapterDetection> {
    const sessions = join(this.dir, "sessions");
    if (!existsSync(sessions)) return { available: false, location: sessions, reason: "No Codex sessions directory" };
    return { available: true, location: sessions };
  }

  async backfill(emit: EmitFn): Promise<void> {
    for (const file of this.listRollouts()) {
      for (const ev of parseRollout(readFileSync(file, "utf8"), basename(file))) emit(ev);
    }
  }

  async watch(emit: EmitFn): Promise<() => void> {
    // TODO: offset-based tailing like the Claude Code adapter. For now a
    // cheap full rescan every 10s (idempotent ids make this safe).
    const seen = new Map<string, number>();
    const tick = () => {
      for (const file of this.listRollouts()) {
        const size = statSync(file).size;
        if (seen.get(file) === size) continue;
        seen.set(file, size);
        for (const ev of parseRollout(readFileSync(file, "utf8"), basename(file))) emit(ev);
      }
    };
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
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
    return out.sort();
  }
}

export function parseRollout(text: string, fileId: string): UsageEventInput[] {
  const events: UsageEventInput[] = [];
  let sessionId = fileId;
  let cwd: string | undefined;
  let model = "unknown";
  let lastTools: string[] = [];
  let lastPrompt: string | undefined;
  let prevTotal: Record<string, number> | null = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload ?? {};

    if (d.type === "session_meta") {
      sessionId = p.id ?? sessionId;
      cwd = p.cwd ?? cwd;
      model = p.model ?? model;
    } else if (d.type === "turn_context") {
      model = p.model ?? model;
    } else if (d.type === "response_item" && p.type === "function_call") {
      lastTools.push(p.name ?? "tool");
    } else if (d.type === "event_msg" && p.type === "user_message") {
      lastPrompt = typeof p.message === "string" ? p.message.slice(0, 200) : lastPrompt;
    } else if (d.type === "event_msg" && p.type === "token_count" && p.info) {
      const total = p.info.total_token_usage ?? {};
      let delta = p.info.last_token_usage;
      if (!delta && prevTotal) {
        delta = Object.fromEntries(Object.keys(total).map((k) => [k, (total[k] ?? 0) - (prevTotal![k] ?? 0)]));
      }
      prevTotal = total;
      if (!delta) continue;
      const cached = delta.cached_input_tokens ?? 0;
      events.push({
        id: `codex:${sessionId}:${i}`,
        source: "codex",
        provider: "openai",
        model,
        timestamp: d.timestamp ?? new Date().toISOString(),
        sessionId,
        agentId: "main",
        project: cwd,
        inputTokens: Math.max((delta.input_tokens ?? 0) - cached, 0),
        cacheReadTokens: cached,
        outputTokens: delta.output_tokens ?? 0,
        reasoningTokens: delta.reasoning_output_tokens ?? 0,
        costUsd: null,
        toolCalls: lastTools,
        activity: lastTools.length ? `${lastTools[lastTools.length - 1]}` : lastPrompt,
        meta: { prompt: lastPrompt },
      });
      lastTools = [];
    }
  }
  return events;
}
