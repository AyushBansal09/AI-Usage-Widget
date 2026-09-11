import { describe, it, expect } from "vitest";
import { UsageEventSchema } from "@ai-usage-widget/core";
import { globToRegExp, mapRecord, matchesWhere, resolvePath, splitGlob, toIso, type CustomSource } from "./mapping.js";

const src: CustomSource = {
  name: "my-tool",
  provider: "openai",
  files: "~/.mytool/**/*.jsonl",
  map: {
    id: "response.id",
    model: "response.model",
    timestamp: "created",
    sessionId: "thread",
    project: "meta.cwd",
    inputTokens: "response.usage.prompt_tokens",
    outputTokens: "response.usage.completion_tokens",
    activity: "prompt",
    toolCalls: "response.tools",
  },
};

const record = {
  created: 1789150000,
  thread: "t-1",
  prompt: "summarise the changelog",
  meta: { cwd: "/repo" },
  response: { id: "resp_9", model: "gpt-4o", usage: { prompt_tokens: 1200, completion_tokens: 340 }, tools: ["search", { name: "write" }] },
};

describe("resolvePath", () => {
  it("walks dots and array indices", () => {
    expect(resolvePath(record, "response.usage.prompt_tokens")).toBe(1200);
    expect(resolvePath({ a: [{ b: [1, 2] }] }, "a[0].b[1]")).toBe(2);
    expect(resolvePath(record, "response.missing.deep")).toBeUndefined();
    expect(resolvePath(null, "a")).toBeUndefined();
    expect(resolvePath(record, "")).toBeUndefined();
  });
});

describe("toIso", () => {
  it("accepts ISO, epoch seconds, epoch millis and numeric strings", () => {
    expect(toIso("2026-09-11T10:00:00Z")).toBe("2026-09-11T10:00:00.000Z");
    expect(toIso(1789150000)).toBe("2026-09-11T18:06:40.000Z");
    expect(toIso(1789150000000)).toBe("2026-09-11T18:06:40.000Z");
    expect(toIso("1789150000")).toBe("2026-09-11T18:06:40.000Z");
    expect(toIso("not a date")).toBeUndefined();
    expect(toIso(undefined)).toBeUndefined();
  });
});

describe("mapRecord", () => {
  it("builds a schema-valid event from a user field map", () => {
    const ev = mapRecord(record, src, { fileKey: "a/b.jsonl", index: 3 })!;
    UsageEventSchema.parse(ev);
    expect(ev).toMatchObject({
      id: "my-tool:resp_9",
      source: "my-tool",
      provider: "openai",
      model: "gpt-4o",
      timestamp: "2026-09-11T18:06:40.000Z",
      sessionId: "t-1",
      agentId: "main",
      project: "/repo",
      inputTokens: 1200,
      outputTokens: 340,
      activity: "summarise the changelog",
      toolCalls: ["search", "write"],
    });
  });

  it("leaves unmapped tokens at zero and cost null so pricing decides", () => {
    const ev = mapRecord(record, { ...src, map: { timestamp: "created" } }, { fileKey: "f", index: 0 })!;
    expect(ev).toMatchObject({ model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null });
  });

  it("falls back to file+index for the id when the log has none", () => {
    const ev = mapRecord(record, { ...src, map: { ...src.map, id: undefined } }, { fileKey: "a/b.jsonl", index: 3 })!;
    expect(ev.id).toBe("my-tool:a/b.jsonl:3");
  });

  it("skips records with no usable timestamp", () => {
    expect(mapRecord({ ...record, created: "nope" }, src, { fileKey: "f", index: 0 })).toBeNull();
  });

  it("applies defaults only where the log is silent", () => {
    const withDefault = { ...src, defaults: { model: "claude-opus-5" } };
    expect(mapRecord(record, withDefault, { fileKey: "f", index: 0 })!.model).toBe("gpt-4o");
    expect(mapRecord({ ...record, response: { ...record.response, model: undefined } }, withDefault, { fileKey: "f", index: 0 })!.model).toBe("claude-opus-5");
  });

  it("coerces numeric strings and ignores junk", () => {
    const ev = mapRecord({ created: 1, response: { usage: { prompt_tokens: "42", completion_tokens: "x" } } }, src, { fileKey: "f", index: 0 })!;
    expect(ev.inputTokens).toBe(42);
    expect(ev.outputTokens).toBe(0);
  });
});

describe("where", () => {
  it("requires presence for true and equality otherwise", () => {
    expect(matchesWhere(record, { "response.id": true })).toBe(true);
    expect(matchesWhere(record, { "response.missing": true })).toBe(false);
    expect(matchesWhere(record, { thread: "t-1" })).toBe(true);
    expect(matchesWhere(record, { thread: "other" })).toBe(false);
    expect(matchesWhere(record, undefined)).toBe(true);
  });

  it("filters records out of mapping", () => {
    expect(mapRecord(record, { ...src, where: { "response.usage.prompt_tokens": true } }, { fileKey: "f", index: 0 })).not.toBeNull();
    expect(mapRecord(record, { ...src, where: { kind: "usage" } }, { fileKey: "f", index: 0 })).toBeNull();
  });
});

describe("globs", () => {
  it("** crosses directories, * does not", () => {
    expect(globToRegExp("**/*.jsonl").test("a/b/c.jsonl")).toBe(true);
    expect(globToRegExp("**/*.jsonl").test("c.jsonl")).toBe(true);
    expect(globToRegExp("*.jsonl").test("a/c.jsonl")).toBe(false);
    expect(globToRegExp("*.jsonl").test("c.jsonl")).toBe(true);
    expect(globToRegExp("log-?.json").test("log-1.json")).toBe(true);
    expect(globToRegExp("*.json").test("x.jsonl")).toBe(false);
  });

  it("splits at the deepest literal directory so we never walk the whole home dir", () => {
    const g = splitGlob("/var/logs/tool/**/*.jsonl");
    expect(g.root).toBe("/var/logs/tool");
    expect(g.match("2026/09/a.jsonl")).toBe(true);
    expect(g.match("a.txt")).toBe(false);
  });

  it("treats a wildcard-free pattern as a single file", () => {
    const g = splitGlob("/var/logs/tool/usage.jsonl");
    expect(g.root).toBe("/var/logs/tool");
    expect(g.match("usage.jsonl")).toBe(true);
    expect(g.match("other.jsonl")).toBe(false);
  });
});
