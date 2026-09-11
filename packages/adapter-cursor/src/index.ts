import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, AdapterDetection, EmitFn } from "@ai-usage-widget/core";
import { parseCursorRows, type KvRow } from "./parser.js";

export { parseCursorRows, classifyModel, describeTool } from "./parser.js";

export interface CursorAdapterOptions {
  /** Cursor's `User` directory. Defaults to the platform location. */
  userDir?: string;
  /** Poll interval for change detection, ms. */
  pollMs?: number;
}

/**
 * Reads Cursor's own composer database. Cursor keeps it open in WAL mode, so
 * a read-only connection from another process is safe and sees committed
 * rows. We never write to it.
 *
 * Change detection is by file mtime + row size: a bubble's `tokenCount` can
 * be filled in after the row first appears, so rows whose JSON grew are
 * re-emitted (the store upserts by id).
 */
export class CursorAdapter implements Adapter {
  readonly name = "cursor";
  private userDir: string;
  private pollMs: number;
  private seen = new Map<string, number>();
  private lastMtime = 0;
  private projects: { at: number; map: Map<string, string> } | null = null;

  constructor(opts: CursorAdapterOptions = {}) {
    this.userDir = opts.userDir ?? defaultUserDir();
    this.pollMs = opts.pollMs ?? 15_000;
  }

  private get dbPath(): string {
    return join(this.userDir, "globalStorage", "state.vscdb");
  }

  async detect(): Promise<AdapterDetection> {
    if (!existsSync(this.dbPath)) return { available: false, location: this.dbPath, reason: "Cursor database not found" };
    return { available: true, location: this.dbPath };
  }

  async backfill(emit: EmitFn): Promise<void> {
    this.scan(emit, true);
  }

  async watch(emit: EmitFn): Promise<() => void> {
    const t = setInterval(() => this.scan(emit, false), this.pollMs);
    return () => clearInterval(t);
  }

  scan(emit: EmitFn, full: boolean): void {
    let mtime: number;
    try {
      // The WAL file changes before the main db file does.
      const wal = this.dbPath + "-wal";
      mtime = Math.max(statSync(this.dbPath).mtimeMs, existsSync(wal) ? statSync(wal).mtimeMs : 0);
    } catch {
      return;
    }
    if (!full && mtime === this.lastMtime) return;
    this.lastMtime = mtime;

    const rows = this.readRows();
    const changed: KvRow[] = [];
    const composers: KvRow[] = [];
    for (const r of rows) {
      // Cursor inserts the key first and fills the JSON later; a NULL value
      // is a row still being written.
      if (typeof r.value !== "string") continue;
      const size = r.value.length;
      if (r.key.startsWith("composerData:")) composers.push(r);
      if (full || this.seen.get(r.key) !== size) changed.push(r);
      this.seen.set(r.key, size);
    }
    if (changed.length === 0) return;
    // Composers are always included: the parser needs them for timestamps and
    // subagent linkage even when only one bubble changed.
    const input = [...composers, ...changed.filter((r) => !r.key.startsWith("composerData:"))];
    const projects = this.projectMap();
    for (const ev of parseCursorRows(input, { projectFor: (id) => projects.get(id) })) emit(ev);
  }

  private readRows(): KvRow[] {
    let db: Database.Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      return db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' OR key LIKE 'composerData:%'")
        .all() as KvRow[];
    } catch (e) {
      console.error(`[cursor] cannot read ${this.dbPath}:`, (e as Error).message);
      return [];
    } finally {
      db?.close();
    }
  }

  /**
   * composerId -> workspace folder, from each workspace's own state db
   * (`composer.composerData.allComposers`) plus its `workspace.json`.
   * Rebuilt at most once a minute.
   */
  projectMap(): Map<string, string> {
    if (this.projects && Date.now() - this.projects.at < 60_000) return this.projects.map;
    const map = new Map<string, string>();
    const wsDir = join(this.userDir, "workspaceStorage");
    if (existsSync(wsDir)) {
      for (const entry of readdirSync(wsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(wsDir, entry.name);
        const folder = readFolder(join(dir, "workspace.json"));
        const db = join(dir, "state.vscdb");
        if (!folder || !existsSync(db)) continue;
        let conn: Database.Database | null = null;
        try {
          conn = new Database(db, { readonly: true, fileMustExist: true });
          const row = conn.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as { value: string } | undefined;
          if (!row) continue;
          const all = JSON.parse(row.value)?.allComposers;
          if (Array.isArray(all)) for (const c of all) if (typeof c?.composerId === "string") map.set(c.composerId, folder);
        } catch {
          /* a workspace db we cannot read is just a missing project label */
        } finally {
          conn?.close();
        }
      }
    }
    this.projects = { at: Date.now(), map };
    return map;
  }
}

function readFolder(file: string): string | undefined {
  try {
    const f = JSON.parse(readFileSync(file, "utf8"))?.folder;
    if (typeof f !== "string") return undefined;
    return f.startsWith("file://") ? fileURLToPath(f) : f;
  } catch {
    return undefined;
  }
}

export function defaultUserDir(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin": return join(home, "Library", "Application Support", "Cursor", "User");
    case "win32": return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User");
    default: return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Cursor", "User");
  }
}
