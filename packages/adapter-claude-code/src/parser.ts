import type { UsageEventInput } from "@ai-usage-widget/core";

/**
 * Pure parser for Claude Code transcript lines.
 *
 * Format notes (observed on Claude Code 2.1.x, Sept 2026):
 *  - One JSON object per line. `type` is "user" | "assistant" | "attachment" |
 *    "queue-operation" | "last-prompt" | ... ; only "assistant" carries usage.
 *  - A single API response is written as SEVERAL "assistant" lines, one per
 *    content block (thinking, text, tool_use), all sharing `message.id` and
 *    `requestId`, and each repeating the FULL `message.usage`. Counting every
 *    line would multiply usage by the number of blocks, so lines are merged
 *    per (message.id, requestId) and emitted once.
 *  - `message.usage` has input_tokens, output_tokens,
 *    cache_creation_input_tokens, cache_read_input_tokens and optionally
 *    output_tokens_details.thinking_tokens.
 *  - `isSidechain: true` marks subagent traffic inside the main file; newer
 *    versions also write subagents to `<session>/subagents/*.jsonl`.
 *  - `cwd`, `sessionId`, `gitBranch`, `version` give project context.
 */

export interface ParseContext {
  /** Agent id to assign when the line itself does not say (from file path). */
  defaultAgentId: string;
  /** Most recent user prompt seen in this file; carried onto the next event. */
  lastPrompt?: string;
}

interface Pending {
  key: string;
  event: UsageEventInput;
  toolCalls: string[];
  activities: string[];
}

export class TranscriptParser {
  private pending: Pending | null = null;

  constructor(private ctx: ParseContext) {}

  /** Feed one line. Returns a completed event when a previous message closed. */
  feed(line: string): UsageEventInput | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let d: any;
    try {
      d = JSON.parse(trimmed);
    } catch {
      return null; // half-written line; caller will re-read it later
    }

    if (d.type === "user") {
      const prompt = extractPrompt(d);
      if (prompt) this.ctx.lastPrompt = prompt;
      // A user turn always closes the previous assistant message.
      return this.flush();
    }

    if (d.type !== "assistant" || !d.message?.usage) return null;
    const msg = d.message;
    if (!msg.model || msg.model === "<synthetic>") return null;
    const key = `${msg.id}:${d.requestId ?? ""}`;

    let out: UsageEventInput | null = null;
    if (this.pending && this.pending.key !== key) out = this.flush();

    const u = msg.usage;
    if (!this.pending) {
      const agentId: string = d.agentId ?? (d.isSidechain ? "sidechain" : this.ctx.defaultAgentId);
      this.pending = {
        key,
        toolCalls: [],
        activities: [],
        event: {
          id: `claude-code:${key}`,
          source: "claude-code",
          provider: "anthropic",
          model: msg.model,
          timestamp: d.timestamp,
          sessionId: d.sessionId ?? "unknown",
          agentId,
          parentAgentId: agentId === "main" ? undefined : "main",
          project: d.cwd,
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
          costUsd: null,
          toolCalls: [],
          meta: {
            prompt: this.ctx.lastPrompt,
            version: d.version,
            gitBranch: d.gitBranch,
            effort: d.effort,
            stopReason: msg.stop_reason ?? undefined,
          },
        },
      };
    } else {
      // Later lines for the same message carry the final usage; keep the latest.
      const ev = this.pending.event;
      ev.outputTokens = u.output_tokens ?? ev.outputTokens;
      ev.reasoningTokens = u.output_tokens_details?.thinking_tokens ?? ev.reasoningTokens;
      if (msg.stop_reason) (ev.meta as any).stopReason = msg.stop_reason;
    }

    for (const block of msg.content ?? []) {
      if (block?.type === "tool_use") {
        this.pending.toolCalls.push(block.name);
        this.pending.activities.push(describeToolUse(block.name, block.input));
      } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        this.pending.activities.push(block.text.trim().slice(0, 120));
      }
    }
    return out;
  }

  /** Emit whatever is pending (call at end of a read). */
  flush(): UsageEventInput | null {
    if (!this.pending) return null;
    const p = this.pending;
    this.pending = null;
    p.event.toolCalls = p.toolCalls;
    // Prefer the last tool call as "what it's doing"; fall back to text.
    const lastTool = [...p.activities].reverse().find((a) => a.includes(": ") || p.toolCalls.length === 0);
    p.event.activity = lastTool ?? p.activities[p.activities.length - 1];
    return p.event;
  }
}

function extractPrompt(d: any): string | undefined {
  const c = d.message?.content;
  if (typeof c === "string") return clean(c);
  if (Array.isArray(c)) {
    const text = c.find((b: any) => b?.type === "text" && typeof b.text === "string");
    if (text) return clean(text.text);
  }
  return undefined;
}

function clean(s: string): string | undefined {
  // Strip injected system reminders so the dashboard shows the human's words.
  const stripped = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return stripped ? stripped.slice(0, 200) : undefined;
}

export function describeToolUse(name: string, input: any): string {
  if (!input || typeof input !== "object") return name;
  const pick =
    input.description ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.query ??
    input.url ??
    (typeof input.command === "string" ? input.command : undefined) ??
    (typeof input.prompt === "string" ? input.prompt : undefined) ??
    input.skill;
  return pick ? `${name}: ${String(pick).replace(/\s+/g, " ").slice(0, 100)}` : name;
}
