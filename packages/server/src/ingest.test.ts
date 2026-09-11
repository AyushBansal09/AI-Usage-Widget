import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collector } from "./collector.js";
import { createApp } from "./app.js";

let dir: string;
let collector: Collector;
let app: ReturnType<typeof createApp>;

const event = (over: Record<string, unknown> = {}) => ({
  id: "script:1",
  source: "my-script",
  provider: "openai",
  model: "gpt-5",
  timestamp: "2026-09-11T10:00:00Z",
  sessionId: "s1",
  agentId: "main",
  inputTokens: 100,
  outputTokens: 20,
  ...over,
});

const post = (body: unknown) =>
  app.request("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "auw-ingest-"));
  // No adapters: this exercises the endpoint, not the log readers.
  collector = new Collector({ storePath: join(dir, "events.sqlite"), adapters: [] });
  app = createApp(collector, join(dir, "public"));
});
afterEach(() => {
  collector.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/ingest", () => {
  it("accepts one event and it lands in the store", async () => {
    const res = await post(event());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ingested: 1, duplicates: 0, rejected: 0, errors: [] });
    expect(collector.store.events({}).map((e) => e.id)).toEqual(["script:1"]);
  });

  it("accepts a batch and prices it like any other source", async () => {
    const res = await post([event(), event({ id: "script:2", inputTokens: 5 })]);
    expect(await res.json()).toMatchObject({ ingested: 2, rejected: 0 });
    const stored = collector.store.events({});
    expect(stored).toHaveLength(2);
    expect(stored[0]!.costUsd).not.toBeNull(); // gpt-5 is in the seed pricing table
  });

  it("is idempotent: re-posting the same id is a duplicate, not an error", async () => {
    await post(event());
    const res = await post(event());
    expect(await res.json()).toMatchObject({ ingested: 0, duplicates: 1, rejected: 0 });
    expect(collector.store.events({})).toHaveLength(1);
  });

  it("rejects an invalid event with a message naming the field", async () => {
    const res = await post(event({ timestamp: "yesterday" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.rejected).toBe(1);
    expect(body.errors[0]).toMatch(/timestamp/i);
  });

  it("keeps the good events in a mixed batch", async () => {
    const res = await post([event(), { nonsense: true }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ingested: 1, rejected: 1 });
  });

  it("refuses a non-JSON body and an oversized batch", async () => {
    const bad = await app.request("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
    expect(bad.status).toBe(400);
    const huge = await post(Array.from({ length: 1001 }, (_, i) => event({ id: `x:${i}` })));
    expect(huge.status).toBe(413);
  });

  it("shows up as its own source in the summary", async () => {
    await post(event());
    const summary = await (await app.request("/api/summary?range=30d")).json();
    expect(summary.bySource.map((s: { key: string }) => s.key)).toContain("my-script");
  });
});
