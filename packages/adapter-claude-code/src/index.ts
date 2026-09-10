import { existsSync, openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import type { Adapter, AdapterDetection, EmitFn } from "@ai-usage-widget/core";
import { TranscriptParser } from "./parser.js";

export { TranscriptParser, describeToolUse } from "./parser.js";

export interface ClaudeCodeAdapterOptions {
  /** Defaults to $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects. */
  projectsDir?: string;
  /** Poll interval for tailing, ms. */
  pollMs?: number;
  /** Optional persistence for file offsets so restarts don't re-read everything. */
  state?: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
}

interface FileCursor {
  offset: number;
  parser: TranscriptParser;
}

/**
 * Tails every transcript under the projects dir. Idempotent: event ids are
 * derived from Claude's own message ids, so re-reading a file is harmless.
 */
export class ClaudeCodeAdapter implements Adapter {
  readonly name = "claude-code";
  private dir: string;
  private pollMs: number;
  private cursors = new Map<string, FileCursor>();

  constructor(private opts: ClaudeCodeAdapterOptions = {}) {
    this.dir =
      opts.projectsDir ??
      join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
    this.pollMs = opts.pollMs ?? 2000;
  }

  async detect(): Promise<AdapterDetection> {
    if (!existsSync(this.dir)) {
      return { available: false, location: this.dir, reason: "Claude Code projects directory not found" };
    }
    return { available: true, location: this.dir };
  }

  async backfill(emit: EmitFn): Promise<void> {
    this.scan(emit);
  }

  async watch(emit: EmitFn): Promise<() => void> {
    const timer = setInterval(() => this.scan(emit), this.pollMs);
    return () => clearInterval(timer);
  }

  /** One pass: read any new bytes in any transcript and emit completed events. */
  scan(emit: EmitFn): void {
    for (const file of this.listTranscripts()) {
      let cursor = this.cursors.get(file);
      if (!cursor) {
        const saved = this.opts.state?.get(`offset:${file}`);
        cursor = {
          offset: saved ? Number(saved) : 0,
          parser: new TranscriptParser({ defaultAgentId: agentIdForFile(file) }),
        };
        this.cursors.set(file, cursor);
      }
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size < cursor.offset) cursor.offset = 0; // truncated/rewritten
      if (size === cursor.offset) continue;

      const chunk = readRange(file, cursor.offset, size);
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl === -1) continue; // no complete line yet
      const complete = chunk.slice(0, lastNl + 1);
      for (const line of complete.split("\n")) {
        const ev = cursor.parser.feed(line);
        if (ev) emit(ev);
      }
      // If the file looks finished for now, flush the pending message too. On
      // the next scan the same message id would just be a no-op upsert.
      const tail = cursor.parser.flush();
      if (tail) emit(tail);

      cursor.offset += Buffer.byteLength(complete, "utf8");
      this.opts.state?.set(`offset:${file}`, String(cursor.offset));
    }
  }

  listTranscripts(): string[] {
    if (!existsSync(this.dir)) return [];
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 4) return;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
      }
    };
    walk(this.dir, 0);
    return out.sort();
  }
}

function agentIdForFile(file: string): string {
  // ~/.claude/projects/<proj>/<session>/subagents/agent-xyz.jsonl -> "agent-xyz"
  if (basename(dirname(file)) === "subagents") return basename(file, ".jsonl");
  return "main";
}

function readRange(file: string, start: number, end: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
