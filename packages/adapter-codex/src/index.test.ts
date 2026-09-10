import { describe, it, expect } from "vitest";
import { parseRollout } from "./index.js";

describe("parseRollout (synthetic fixture — replace with a real scrubbed rollout)", () => {
  it("emits one event per token_count using the last-request delta", () => {
    const lines = [
      { timestamp: "2026-09-09T10:00:00Z", type: "session_meta", payload: { id: "thread-1", cwd: "/repo", model: "gpt-5-codex" } },
      { timestamp: "2026-09-09T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: "add tests" } },
      { timestamp: "2026-09-09T10:00:02Z", type: "response_item", payload: { type: "function_call", name: "shell" } },
      {
        timestamp: "2026-09-09T10:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 },
            last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 },
          },
        },
      },
    ];
    const ev = parseRollout(lines.map((l) => JSON.stringify(l)).join("\n"), "rollout-x.jsonl");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      sessionId: "thread-1",
      model: "gpt-5-codex",
      inputTokens: 400,
      cacheReadTokens: 600,
      outputTokens: 50,
      reasoningTokens: 20,
      toolCalls: ["shell"],
      project: "/repo",
    });
  });
});
