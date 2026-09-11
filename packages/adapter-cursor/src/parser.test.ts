import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageEventSchema } from "@ai-usage-widget/core";
import { parseCursorRows, classifyModel, describeTool, type KvRow } from "./parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "__fixtures__", "state.json"), "utf8")) as {
  cursorDiskKV: Array<{ key: string; value: Record<string, unknown> }>;
};
const rows = (): KvRow[] => fixture.cursorDiskKV.map((r) => ({ key: r.key, value: JSON.stringify(r.value) }));

describe("parseCursorRows on a scrubbed real database", () => {
  const events = parseCursorRows(rows(), { projectFor: () => "/scrubbed/project" });

  it("emits one event per assistant bubble, none for user bubbles, all schema-valid", () => {
    const assistant = fixture.cursorDiskKV.filter((r) => r.key.startsWith("bubbleId:") && r.value.type === 2).length;
    expect(events).toHaveLength(assistant);
    expect(events.length).toBeGreaterThan(200);
    for (const e of events) UsageEventSchema.parse(e);
  });

  it("uses Cursor's bubble id as the event id (idempotent) and orders by time", () => {
    const ids = new Set(events.map((e) => e.id));
    expect(ids.size).toBe(events.length);
    expect(events[0]!.id).toMatch(/^cursor:[0-9a-f-]{36}:[0-9a-f-]{36}$/);
    const ts = events.map((e) => e.timestamp);
    expect([...ts].sort()).toEqual(ts);
  });

  it("carries token counts only where Cursor recorded them, and says so", () => {
    const withTokens = events.filter((e) => e.meta?.tokensReported);
    expect(withTokens).toHaveLength(11);
    const biggest = withTokens.reduce((a, b) => (b.inputTokens > a.inputTokens ? b : a));
    expect(biggest.inputTokens).toBe(104531);
    expect(biggest.outputTokens).toBeGreaterThan(0);
    expect(withTokens.some((e) => e.inputTokens === 53511 && e.outputTokens === 26620)).toBe(true);
    const without = events.filter((e) => !e.meta?.tokensReported);
    expect(without.every((e) => e.inputTokens === 0 && e.outputTokens === 0)).toBe(true);
  });

  it("leaves the auto-routed model unpriced rather than guessing", () => {
    expect(new Set(events.map((e) => e.model))).toEqual(new Set(["cursor-auto"]));
    expect(events.every((e) => e.provider === "other")).toBe(true);
  });

  it("turns tool steps into toolCalls with a short activity line", () => {
    const tools = events.filter((e) => e.toolCalls.length > 0);
    expect(tools.length).toBeGreaterThan(100);
    const names = new Set(tools.flatMap((e) => e.toolCalls));
    expect(names.has("read_file")).toBe(true);
    for (const e of tools) {
      expect(e.activity).toMatch(new RegExp(`^${e.toolCalls[0]}`));
      expect(e.activity!.length).toBeLessThanOrEqual(90);
    }
  });

  it("never leaks absolute paths from tool arguments into activity", () => {
    for (const e of events) expect(e.activity ?? "").not.toMatch(/\/Users\//);
  });

  it("labels the project and the mode", () => {
    expect(events.every((e) => e.project === "/scrubbed/project")).toBe(true);
    expect(new Set(events.map((e) => e.meta?.mode))).toEqual(new Set(["agent"]));
  });
});

describe("subagent linkage", () => {
  it("puts a subagent composer under its parent's session", () => {
    const r: KvRow[] = [
      { key: "composerData:parent", value: JSON.stringify({ createdAt: 1_700_000_000_000, unifiedMode: "agent", subagentComposerIds: ["child"] }) },
      { key: "composerData:child", value: JSON.stringify({ createdAt: 1_700_000_001_000, unifiedMode: "agent" }) },
      { key: "bubbleId:child:b1", value: JSON.stringify({ type: 2, createdAt: "2025-01-01T00:00:00Z", text: "hi", tokenCount: { inputTokens: 5, outputTokens: 2 } }) },
      { key: "bubbleId:parent:b2", value: JSON.stringify({ type: 2, createdAt: "2025-01-01T00:00:01Z", text: "done" }) },
    ];
    const [child, parent] = parseCursorRows(r);
    expect(child).toMatchObject({ sessionId: "parent", agentId: "child", parentAgentId: "main", inputTokens: 5 });
    expect(parent).toMatchObject({ sessionId: "parent", agentId: "main" });
    expect(parent!.parentAgentId).toBeUndefined();
  });

  it("skips rows whose JSON is NULL or malformed (seen on a live database)", () => {
    const r: KvRow[] = [
      { key: "composerData:c", value: null },
      { key: "bubbleId:c:half", value: null },
      { key: "bubbleId:c:bad", value: "{not json" },
      { key: "bubbleId:c:ok", value: JSON.stringify({ type: 2, createdAt: "2025-01-01T00:00:00Z", text: "x" }) },
    ];
    expect(parseCursorRows(r).map((e) => e.id)).toEqual(["cursor:c:ok"]);
  });

  it("falls back to the composer's createdAt when a bubble has none", () => {
    const r: KvRow[] = [
      { key: "composerData:c", value: JSON.stringify({ createdAt: 1_700_000_000_000 }) },
      { key: "bubbleId:c:b", value: JSON.stringify({ type: 2, text: "x" }) },
    ];
    expect(parseCursorRows(r)[0]!.timestamp).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("helpers", () => {
  it("classifyModel maps names to providers and keeps auto unpriced", () => {
    expect(classifyModel("default")).toEqual({ provider: "other", model: "cursor-auto" });
    expect(classifyModel(undefined)).toEqual({ provider: "other", model: "cursor-auto" });
    expect(classifyModel("claude-4-sonnet")).toEqual({ provider: "anthropic", model: "claude-4-sonnet" });
    expect(classifyModel("gpt-5")).toEqual({ provider: "openai", model: "gpt-5" });
    expect(classifyModel("o3")).toEqual({ provider: "openai", model: "o3" });
    expect(classifyModel("gemini-2.5-pro")).toEqual({ provider: "google", model: "gemini-2.5-pro" });
  });

  it("describeTool shortens paths and commands", () => {
    expect(describeTool("read_file", '{"target_file":"/Users/x/proj/lib/main.dart"}')).toBe("read_file: lib/main.dart");
    expect(describeTool("run_terminal_cmd", JSON.stringify({ command: "flutter pub get" }))).toBe("run_terminal_cmd: flutter pub get");
    expect(describeTool("codebase_search", "not json")).toBe("codebase_search");
  });
});
