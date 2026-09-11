import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageEventSchema } from "@ai-usage-widget/core";
import { parseRollout, parseRolloutFull, parseRateLimits, describeCodexTool } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = "rollout-2026-09-11T13-32-47-01a09187-6fbe-7392-8253-664bf63843ce.jsonl";
const real = () => readFileSync(join(here, "__fixtures__", "rollout-0.154.jsonl"), "utf8");

describe("Codex CLI 0.154 rollout (scrubbed real session)", () => {
  const { events, rateLimits } = parseRolloutFull(real(), FILE);

  it("emits exactly one event per token_usage_record, keyed by OpenAI's response id", () => {
    expect(events).toHaveLength(1);
    const e = events[0]!;
    UsageEventSchema.parse(e);
    expect(e.id).toBe("codex:resp_07fe6e01fd8a17e8016aa43b417e2487d2983366d79bb84986");
    expect(e.sessionId).toBe("01a09187-6fbe-7392-8253-664bf63843ce");
    expect(e.meta).toMatchObject({ format: "token_usage_record", turnId: "01a09187-6fd2-7f61-b2ce-ab3f8912dd8f" });
  });

  it("takes the model from turn_context (session_meta.model is null in 0.154)", () => {
    expect(events[0]!.model).toBe("gpt-5.6-terra");
    expect(events[0]!.provider).toBe("openai");
    expect(events[0]!.project).toBe("/home/user/.claude/jobs/137ae308/tmp");
  });

  it("splits cached input out so all-token sums never double count; matches Codex's own 'tokens used'", () => {
    const e = events[0]!;
    expect(e.inputTokens).toBe(13865 - 9984);
    expect(e.cacheReadTokens).toBe(9984);
    expect(e.outputTokens).toBe(5);
    expect(e.reasoningTokens).toBe(0);
    expect(e.inputTokens + e.outputTokens).toBe(3886); // what `codex exec` printed
    expect(e.costUsd).toBeNull(); // pricing is the store's job
  });

  it("uses the user's prompt as the activity when no tool ran", () => {
    expect(events[0]!.activity).toBe("[scrubbed text]");
    expect(events[0]!.toolCalls).toEqual([]);
  });

  it("extracts the plan's rate-limit window from token_count (epoch seconds -> ISO)", () => {
    expect(rateLimits).toEqual({
      at: "2026-09-11T17:32:50.664Z",
      planType: "free",
      limitId: "codex",
      windows: [{ id: "primary", usedPercent: 0, windowMinutes: 43200, resetsAt: "2026-10-11T17:32:49.000Z" }],
      credits: { hasCredits: false, unlimited: false, balance: null },
    });
  });

  it("skips Codex's injected <…> user preambles when picking the prompt", () => {
    const lines = [
      { timestamp: "2026-09-11T00:00:00Z", type: "session_meta", payload: { id: "t" } },
      { timestamp: "2026-09-11T00:00:01Z", type: "turn_context", payload: { model: "gpt-5.6-terra" } },
      { timestamp: "2026-09-11T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>…</recommended_plugins>" }] } },
      { timestamp: "2026-09-11T00:00:03Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the failing test" }] } },
      { timestamp: "2026-09-11T00:00:04Z", type: "token_usage_record", payload: { response_id: "resp_1", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } } },
    ];
    const ev = parseRollout(lines.map((l) => JSON.stringify(l)).join("\n"), "rollout-p.jsonl");
    expect(ev[0]!.activity).toBe("fix the failing test");
    expect(ev[0]!.id).toBe("codex:resp_1");
  });

  it("does not also emit from token_count when records exist (no double counting)", () => {
    expect(events.filter((e) => e.meta?.format === "token_count")).toHaveLength(0);
  });
});

describe("older rollouts without token_usage_record", () => {
  it("falls back to one event per token_count using the last-request delta", () => {
    const lines = [
      { timestamp: "2026-09-09T10:00:00Z", type: "session_meta", payload: { id: "thread-1", cwd: "/repo", model: "gpt-5-codex" } },
      { timestamp: "2026-09-09T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: "add tests" } },
      { timestamp: "2026-09-09T10:00:02Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["git", "status"] }) } },
      {
        timestamp: "2026-09-09T10:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 },
            last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 },
          },
          rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1789150000 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1789500000 }, plan_type: "plus" },
        },
      },
    ];
    const { events, rateLimits } = parseRolloutFull(lines.map((l) => JSON.stringify(l)).join("\n"), "rollout-x.jsonl");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "codex:thread-1:3",
      sessionId: "thread-1",
      model: "gpt-5-codex",
      inputTokens: 400,
      cacheReadTokens: 600,
      outputTokens: 50,
      reasoningTokens: 20,
      toolCalls: ["shell"],
      activity: "shell: git status",
      project: "/repo",
    });
    expect(rateLimits?.windows.map((w) => [w.id, w.usedPercent, w.windowMinutes])).toEqual([["primary", 12.5, 300], ["secondary", 3, 10080]]);
    expect(rateLimits?.planType).toBe("plus");
  });

  it("diffs cumulative totals when last_token_usage is missing", () => {
    const mk = (i: number, total: number) => JSON.stringify({ timestamp: `2026-09-09T10:00:0${i}Z`, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, output_tokens: i } } } });
    const ev = parseRollout([mk(1, 100), mk(2, 250)].join("\n"), "rollout-y.jsonl");
    expect(ev.map((e) => e.inputTokens)).toEqual([150]);
  });

  it("ignores partial trailing lines while a rollout is still being written", () => {
    expect(parseRollout('{"type":"session_meta","payload":{"id":"t"}}\n{"type":"token_usa', "rollout-z.jsonl")).toEqual([]);
  });
});

describe("helpers", () => {
  it("parseRateLimits tolerates missing windows and clamps", () => {
    expect(parseRateLimits({ primary: { used_percent: 140 } }, "t")?.windows[0]).toMatchObject({ usedPercent: 100, windowMinutes: null, resetsAt: null });
    expect(parseRateLimits({ primary: null, secondary: null }, "t")?.windows).toEqual([]);
    expect(parseRateLimits(null, "t")).toBeNull();
  });

  it("describeCodexTool summarises shell commands and paths", () => {
    expect(describeCodexTool("shell", { command: ["ls", "-la"] })).toBe("shell: ls -la");
    expect(describeCodexTool("apply_patch", undefined)).toBe("apply_patch");
    expect(describeCodexTool("read", { path: "src/a.ts" })).toBe("read: src/a.ts");
  });
});
