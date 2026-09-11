import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { UsageEventInput } from "@ai-usage-widget/core";

/**
 * The pure half of the custom adapter: turn one parsed log record into a
 * UsageEvent using a user-written field map. No I/O, so every rule here is
 * testable without touching a disk.
 */

export interface CustomSource {
  /** Becomes UsageEvent.source, so it shows up as its own row in Sources. */
  name: string;
  provider?: "anthropic" | "openai" | "google" | "other";
  /** Glob over files to read, `~` allowed. e.g. "~/.mytool/logs/**\/*.jsonl" */
  files: string;
  format?: "jsonl" | "json";
  /** For `json`: path to the array of records inside the document. */
  recordsAt?: string;
  /** Keep a record only if every path here matches (true = "just be present"). */
  where?: Record<string, unknown>;
  /** Event field -> path in the record. `timestamp` is the only required one. */
  map: FieldMap;
  /** Static values merged in, e.g. { model: "gpt-4o" } when the log omits it. */
  defaults?: Partial<Record<MappableField, string | number>>;
}

export type MappableField =
  | "id" | "model" | "timestamp" | "sessionId" | "agentId" | "parentAgentId" | "project"
  | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens"
  | "costUsd" | "activity" | "toolCalls";

export type FieldMap = Partial<Record<MappableField, string>>;

/**
 * Resolve "a.b[0].c" against a parsed record. Deliberately not full JSONPath:
 * dots and numeric brackets cover every log shape seen so far, and a tiny
 * resolver cannot surprise anyone with wildcard semantics.
 */
export function resolvePath(record: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: any = record;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    const m = /^([^[\]]*)((\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) cur = cur[m[1]];
    for (const idx of m[2]?.match(/\d+/g) ?? []) {
      if (cur == null) return undefined;
      cur = cur[Number(idx)];
    }
  }
  return cur;
}

/** ISO string, epoch seconds, epoch ms, or Date -> ISO string. */
export function toIso(v: unknown): string | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+$/.test(s)) return toIso(Number(s));
    const t = Date.parse(s);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return undefined;
}

function toNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(v));
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Math.max(0, Math.round(Number(v)));
  return 0;
}

function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "name" in (x as any) ? String((x as any).name) : String(x))).filter(Boolean);
  if (typeof v === "string" && v) return [v];
  return [];
}

/** Every `where` entry must match: `true` means "present and truthy". */
export function matchesWhere(record: unknown, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [path, expected] of Object.entries(where)) {
    const actual = resolvePath(record, path);
    if (expected === true) {
      if (actual === undefined || actual === null || actual === false || actual === "") return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

export interface MapContext {
  /** Stable per-file key used for the fallback id (usually the path relative to the glob root). */
  fileKey: string;
  /** 0-based record number within the file, for the fallback id. */
  index: number;
}

/**
 * One record -> one UsageEvent, or null when it should be skipped (filtered
 * out by `where`, or missing a usable timestamp).
 *
 * Unmapped token fields are 0 rather than guessed, and `costUsd` stays null
 * unless mapped, so the pricing table decides and unknown models stay
 * "unpriced" — the same rule every built-in adapter follows.
 */
export function mapRecord(record: unknown, src: CustomSource, ctx: MapContext): UsageEventInput | null {
  if (!matchesWhere(record, src.where)) return null;
  const pick = (f: MappableField): unknown => {
    const p = src.map[f];
    const v = p ? resolvePath(record, p) : undefined;
    return v === undefined || v === null ? src.defaults?.[f] : v;
  };

  const timestamp = toIso(pick("timestamp"));
  if (!timestamp) return null;

  const rawId = pick("id");
  // Falling back to file+line keeps ingestion idempotent for append-only logs;
  // map an id when the source has one, so rewrites cannot duplicate.
  const id = rawId === undefined || rawId === null || rawId === "" ? `${src.name}:${ctx.fileKey}:${ctx.index}` : `${src.name}:${String(rawId)}`;

  const sessionId = str(pick("sessionId")) ?? ctx.fileKey;
  const model = str(pick("model")) ?? "unknown";
  const costRaw = pick("costUsd");

  return {
    id,
    source: src.name,
    provider: src.provider ?? "other",
    model,
    timestamp,
    sessionId,
    agentId: str(pick("agentId")) ?? "main",
    parentAgentId: str(pick("parentAgentId")),
    project: str(pick("project")),
    inputTokens: toNumber(pick("inputTokens")),
    outputTokens: toNumber(pick("outputTokens")),
    cacheReadTokens: toNumber(pick("cacheReadTokens")),
    cacheWriteTokens: toNumber(pick("cacheWriteTokens")),
    reasoningTokens: toNumber(pick("reasoningTokens")),
    costUsd: typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null,
    toolCalls: toStringList(pick("toolCalls")),
    activity: str(pick("activity")),
    meta: { custom: true },
  };
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Split a glob into the deepest literal directory to walk and a matcher for
 * the rest, so we never walk the whole home directory looking for matches.
 */
export function splitGlob(pattern: string): { root: string; match: (relative: string) => boolean } {
  const full = expandHome(pattern);
  const parts = full.split("/");
  const literal: string[] = [];
  let i = 0;
  for (; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.includes("*") || p.includes("?")) break;
    literal.push(p);
  }
  const rest = parts.slice(i).join("/");
  let root = literal.join("/") || (isAbsolute(full) ? sep : ".");
  if (root === "") root = sep;
  // No wildcard at all: the "glob" is a single file; match it exactly.
  if (!rest) {
    const file = literal[literal.length - 1] ?? "";
    return { root: literal.slice(0, -1).join("/") || sep, match: (rel) => rel === file };
  }
  const re = globToRegExp(rest);
  return { root, match: (rel) => re.test(rel) };
}

/** `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` may also match zero directories
        if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}
