import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Adapter, AdapterDetection, EmitFn } from "@ai-usage-widget/core";
import { mapRecord, resolvePath, splitGlob, type CustomSource } from "./mapping.js";

export * from "./mapping.js";

/**
 * Reads any tool's JSON/JSONL logs using a mapping the user writes in
 * config.json. This is the "bring your own tool" path: no package to publish,
 * no TypeScript to compile — describe where the fields are and the tool shows
 * up in the widget like any built-in source.
 *
 * JSONL files are tailed by byte offset (append-only logs are the common
 * case); whole-JSON files are re-read when they change. Either way ids are
 * stable, so re-reading only upserts.
 */
export class CustomAdapter implements Adapter {
  readonly name: string;
  private cursors = new Map<string, { offset: number; lines: number }>();
  private sizes = new Map<string, number>();

  constructor(private readonly src: CustomSource, private readonly pollMs = 5000) {
    this.name = src.name;
  }

  async detect(): Promise<AdapterDetection> {
    const files = this.listFiles();
    if (files.length === 0) return { available: false, location: this.src.files, reason: "No files matched" };
    return { available: true, location: `${this.src.files} (${files.length} file${files.length === 1 ? "" : "s"})` };
  }

  async backfill(emit: EmitFn): Promise<void> {
    this.scan(emit);
  }

  async watch(emit: EmitFn): Promise<() => void> {
    const t = setInterval(() => this.scan(emit), this.pollMs);
    return () => clearInterval(t);
  }

  scan(emit: EmitFn): void {
    const { root } = splitGlob(this.src.files);
    for (const file of this.listFiles()) {
      const fileKey = relative(root, file) || file;
      try {
        if ((this.src.format ?? "jsonl") === "json") this.scanJson(file, fileKey, emit);
        else this.scanJsonl(file, fileKey, emit);
      } catch (e) {
        console.error(`[${this.name}] ${file}: ${(e as Error).message}`);
      }
    }
  }

  private scanJsonl(file: string, fileKey: string, emit: EmitFn): void {
    const size = statSync(file).size;
    let cur = this.cursors.get(file) ?? { offset: 0, lines: 0 };
    if (size < cur.offset) cur = { offset: 0, lines: 0 }; // truncated or rotated
    if (size === cur.offset) return;

    const chunk = readRange(file, cur.offset, size);
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl === -1) return; // no complete line yet
    const complete = chunk.slice(0, lastNl + 1);
    let index = cur.lines;
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { index++; continue; }
      const ev = mapRecord(record, this.src, { fileKey, index });
      index++;
      if (ev) emit(ev);
    }
    this.cursors.set(file, { offset: cur.offset + Buffer.byteLength(complete, "utf8"), lines: index });
  }

  private scanJson(file: string, fileKey: string, emit: EmitFn): void {
    const size = statSync(file).size;
    if (this.sizes.get(file) === size) return;
    this.sizes.set(file, size);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const records = this.src.recordsAt ? resolvePath(doc, this.src.recordsAt) : doc;
    const list = Array.isArray(records) ? records : [records];
    list.forEach((record, index) => {
      const ev = mapRecord(record, this.src, { fileKey, index });
      if (ev) emit(ev);
    });
  }

  listFiles(): string[] {
    const { root, match } = splitGlob(this.src.files);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 8) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && match(relative(root, p))) out.push(p);
      }
    };
    const st = statSync(root);
    if (st.isFile()) return match(root) ? [root] : [];
    walk(root, 0);
    return out.sort();
  }
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
