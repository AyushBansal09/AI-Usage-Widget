import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageEventInput } from "@ai-usage-widget/core";
import { CustomAdapter } from "./index.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "auw-custom-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("CustomAdapter on JSONL", () => {
  it("reads nested directories and only emits mapped records", async () => {
    mkdirSync(join(dir, "2026", "09"), { recursive: true });
    const f = join(dir, "2026", "09", "usage.jsonl");
    writeFileSync(f, [
      line({ kind: "usage", ts: "2026-09-11T10:00:00Z", id: "a", model: "gpt-4o", usage: { in: 100, out: 10 } }),
      line({ kind: "debug", ts: "2026-09-11T10:00:01Z", id: "b" }),
      line({ kind: "usage", ts: "2026-09-11T10:00:02Z", id: "c", model: "gpt-4o", usage: { in: 5, out: 1 } }),
    ].join(""));

    const a = new CustomAdapter({
      name: "mytool", provider: "openai", files: join(dir, "**/*.jsonl"),
      where: { kind: "usage" },
      map: { id: "id", timestamp: "ts", model: "model", inputTokens: "usage.in", outputTokens: "usage.out" },
    });
    expect((await a.detect()).available).toBe(true);

    const got: UsageEventInput[] = [];
    await a.backfill((e) => got.push(e));
    expect(got.map((e) => e.id)).toEqual(["mytool:a", "mytool:c"]);
    expect(got[0]).toMatchObject({ source: "mytool", provider: "openai", inputTokens: 100, outputTokens: 10 });
  });

  it("tails by offset: a rescan emits only the new lines", async () => {
    const f = join(dir, "u.jsonl");
    writeFileSync(f, line({ ts: 1, id: "a" }));
    const a = new CustomAdapter({ name: "t", files: f, map: { id: "id", timestamp: "ts" } });

    const first: UsageEventInput[] = [];
    await a.backfill((e) => first.push(e));
    expect(first).toHaveLength(1);

    const second: UsageEventInput[] = [];
    a.scan((e) => second.push(e));
    expect(second).toHaveLength(0); // nothing changed

    appendFileSync(f, line({ ts: 2, id: "b" }));
    const third: UsageEventInput[] = [];
    a.scan((e) => third.push(e));
    expect(third.map((e) => e.id)).toEqual(["t:b"]);
  });

  it("ignores a half-written trailing line until it is complete", async () => {
    const f = join(dir, "u.jsonl");
    writeFileSync(f, line({ ts: 1, id: "a" }) + '{"ts":2,"id":"b"');
    const a = new CustomAdapter({ name: "t", files: f, map: { id: "id", timestamp: "ts" } });
    const got: UsageEventInput[] = [];
    await a.backfill((e) => got.push(e));
    expect(got.map((e) => e.id)).toEqual(["t:a"]);

    appendFileSync(f, "}\n");
    const more: UsageEventInput[] = [];
    a.scan((e) => more.push(e));
    expect(more.map((e) => e.id)).toEqual(["t:b"]);
  });

  it("restarts cleanly if the log is rotated (file shrinks)", async () => {
    const f = join(dir, "u.jsonl");
    writeFileSync(f, line({ ts: 1, id: "a" }) + line({ ts: 2, id: "b" }));
    const a = new CustomAdapter({ name: "t", files: f, map: { id: "id", timestamp: "ts" } });
    await a.backfill(() => {});
    writeFileSync(f, line({ ts: 3, id: "c" }));
    const got: UsageEventInput[] = [];
    a.scan((e) => got.push(e));
    expect(got.map((e) => e.id)).toEqual(["t:c"]);
  });

  it("keeps the line index stable across scans for id-less records", async () => {
    const f = join(dir, "u.jsonl");
    writeFileSync(f, line({ ts: 1 }));
    const a = new CustomAdapter({ name: "t", files: f, map: { timestamp: "ts" } });
    const got: UsageEventInput[] = [];
    await a.backfill((e) => got.push(e));
    appendFileSync(f, line({ ts: 2 }));
    a.scan((e) => got.push(e));
    expect(got.map((e) => e.id)).toEqual(["t:u.jsonl:0", "t:u.jsonl:1"]);
  });

  it("survives a corrupt line without losing the rest of the file", async () => {
    const f = join(dir, "u.jsonl");
    writeFileSync(f, line({ ts: 1, id: "a" }) + "{not json}\n" + line({ ts: 3, id: "c" }));
    const a = new CustomAdapter({ name: "t", files: f, map: { id: "id", timestamp: "ts" } });
    const got: UsageEventInput[] = [];
    await a.backfill((e) => got.push(e));
    expect(got.map((e) => e.id)).toEqual(["t:a", "t:c"]);
  });
});

describe("CustomAdapter on whole-JSON files", () => {
  it("reads an array behind recordsAt and re-reads when the file changes", async () => {
    const f = join(dir, "usage.json");
    writeFileSync(f, JSON.stringify({ data: [{ ts: "2026-09-11T10:00:00Z", id: "a", tokens: 5 }] }));
    const a = new CustomAdapter({
      name: "t", files: f, format: "json", recordsAt: "data",
      map: { id: "id", timestamp: "ts", outputTokens: "tokens" },
    });
    const got: UsageEventInput[] = [];
    await a.backfill((e) => got.push(e));
    expect(got).toHaveLength(1);
    expect(got[0]!.outputTokens).toBe(5);

    writeFileSync(f, JSON.stringify({ data: [{ ts: "2026-09-11T10:00:00Z", id: "a", tokens: 5 }, { ts: "2026-09-11T11:00:00Z", id: "b", tokens: 7 }] }));
    const again: UsageEventInput[] = [];
    a.scan((e) => again.push(e));
    expect(again.map((e) => e.id)).toEqual(["t:a", "t:b"]); // ids are stable, so re-emitting upserts
  });
});

describe("detect", () => {
  it("reports unavailable when nothing matches", async () => {
    const a = new CustomAdapter({ name: "t", files: join(dir, "nope", "*.jsonl"), map: { timestamp: "ts" } });
    expect(await a.detect()).toMatchObject({ available: false });
  });
});
