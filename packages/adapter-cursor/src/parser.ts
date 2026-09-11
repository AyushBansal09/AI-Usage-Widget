import type { UsageEventInput } from "@ai-usage-widget/core";

/**
 * Pure parser for rows out of Cursor's `cursorDiskKV` table. No I/O, so the
 * test can feed it a scrubbed fixture of real rows.
 *
 * What Cursor stores (state.vscdb, table cursorDiskKV, key -> JSON value):
 *  - `composerData:<composerId>`: one chat/agent conversation. `unifiedMode`
 *    is "agent" | "chat" | "edit"; `subagentComposerIds` links spawned
 *    subagents to their parent; `createdAt` is epoch ms.
 *  - `bubbleId:<composerId>:<bubbleId>`: one message. `type` 1 = user,
 *    2 = assistant. Assistant bubbles are either a text step or a tool step
 *    (`toolFormerData` with `name`, `status`, `rawArgs`). `tokenCount` is
 *    `{inputTokens, outputTokens}` but is only populated on some bubbles —
 *    on the sampled install, 11 of 297. `modelInfo.modelName` is usually
 *    "default" (Cursor's auto-router), so the real model is unknown.
 *
 * Every assistant bubble becomes one event: it is one model step and the
 * only way to show *what the agent is doing*. Bubbles without a token count
 * are emitted with zeros and `meta.tokensReported = false`, so aggregation
 * can say "tokens reported for 11 of 297 steps" instead of quietly
 * understating usage. The id is Cursor's own bubble id, so re-reading the
 * database is idempotent.
 */

export interface KvRow {
  key: string;
  /** JSON text as stored; null while Cursor is still writing the row. */
  value: string | Record<string, unknown> | null;
}

export interface ParseOptions {
  /** Workspace folder for a composer, when known (from workspaceStorage). */
  projectFor?: (composerId: string) => string | undefined;
}

interface Composer {
  id: string;
  createdAt?: number;
  unifiedMode?: string;
  isAgentic?: boolean;
  subagentComposerIds: string[];
  parent?: string;
}

export function parseCursorRows(rows: KvRow[], opts: ParseOptions = {}): UsageEventInput[] {
  const composers = new Map<string, Composer>();
  const bubbles: Array<{ composerId: string; bubbleId: string; b: any }> = [];

  for (const row of rows) {
    const v = typeof row.value === "string" ? safeJson(row.value) : row.value;
    if (!v || typeof v !== "object") continue;
    if (row.key.startsWith("composerData:")) {
      const id = row.key.slice("composerData:".length);
      composers.set(id, {
        id,
        createdAt: typeof v.createdAt === "number" ? v.createdAt : undefined,
        unifiedMode: typeof v.unifiedMode === "string" ? v.unifiedMode : undefined,
        isAgentic: v.isAgentic === true,
        subagentComposerIds: Array.isArray(v.subagentComposerIds) ? v.subagentComposerIds.filter((x: unknown) => typeof x === "string") : [],
      });
    } else if (row.key.startsWith("bubbleId:")) {
      const parts = row.key.split(":");
      if (parts.length < 3) continue;
      bubbles.push({ composerId: parts[1]!, bubbleId: parts.slice(2).join(":"), b: v });
    }
  }
  for (const c of composers.values()) {
    for (const sub of c.subagentComposerIds) {
      const s = composers.get(sub);
      if (s) s.parent = c.id;
    }
  }

  const events: UsageEventInput[] = [];
  for (const { composerId, bubbleId, b } of bubbles) {
    if (b.type !== 2) continue; // user messages carry no usage
    const composer = composers.get(composerId);
    const ts = isoTimestamp(b.createdAt) ?? (composer?.createdAt ? new Date(composer.createdAt).toISOString() : undefined);
    if (!ts) continue;

    const tc = b.tokenCount ?? {};
    const input = nonNeg(tc.inputTokens);
    const output = nonNeg(tc.outputTokens);
    const modelName: string | undefined = b.modelInfo?.modelName;
    const { provider, model } = classifyModel(modelName);

    const tool = b.toolFormerData;
    const toolCalls = tool?.name ? [String(tool.name)] : [];
    const activity = tool?.name ? describeTool(String(tool.name), tool.rawArgs) : excerpt(b.text);

    // Subagent composers are their own agent under the parent's session.
    const parent = composer?.parent;
    events.push({
      id: `cursor:${composerId}:${bubbleId}`,
      source: "cursor",
      provider,
      model,
      timestamp: ts,
      sessionId: parent ?? composerId,
      agentId: parent ? composerId : "main",
      parentAgentId: parent ? "main" : undefined,
      project: opts.projectFor?.(parent ?? composerId),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      toolCalls,
      activity,
      meta: {
        tokensReported: input + output > 0,
        mode: composer?.unifiedMode ?? (b.isAgentic ? "agent" : undefined),
        toolStatus: tool?.status,
      },
    });
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}

/** Cursor's "default" is its auto-router: the real model is not recorded, so it stays unpriced. */
export function classifyModel(name: string | undefined): { provider: UsageEventInput["provider"]; model: string } {
  if (!name || name === "default" || name === "auto") return { provider: "other", model: "cursor-auto" };
  const n = name.toLowerCase();
  if (n.includes("claude")) return { provider: "anthropic", model: name };
  if (/^(gpt|o[1-9]|codex)/.test(n)) return { provider: "openai", model: name };
  if (n.includes("gemini")) return { provider: "google", model: name };
  return { provider: "other", model: name };
}

/** "read_file: lib/main.dart", "run_terminal_cmd: flutter pub get" */
export function describeTool(name: string, rawArgs: unknown): string {
  const args = typeof rawArgs === "string" ? safeJson(rawArgs) : rawArgs && typeof rawArgs === "object" ? (rawArgs as any) : null;
  const pick = args?.target_file ?? args?.path ?? args?.relative_workspace_path ?? args?.command ?? args?.query ?? args?.pattern ?? args?.explanation;
  const detail = typeof pick === "string" ? shortPath(pick) : "";
  return detail ? `${name}: ${excerpt(detail, 70)}` : name;
}

function shortPath(s: string): string {
  // absolute paths -> last two segments, keeps the widget line short and the DB private
  return s.startsWith("/") ? s.split("/").filter(Boolean).slice(-2).join("/") : s;
}

function excerpt(s: unknown, n = 80): string | undefined {
  if (typeof s !== "string") return undefined;
  const one = s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  if (!one) return undefined;
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}

function isoTimestamp(v: unknown): string | undefined {
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  return undefined;
}

function nonNeg(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function safeJson(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
}
