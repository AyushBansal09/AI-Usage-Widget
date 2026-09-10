import { describe, it, expect } from "vitest";
import { TranscriptParser } from "./parser.js";

const base = {
  sessionId: "sess-1",
  cwd: "/home/me/repo",
  version: "2.1.267",
  timestamp: "2026-09-09T20:45:46.456Z",
};

function assistantLine(
  msgId: string,
  requestId: string,
  block: any,
  usage: any,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    ...base,
    ...extra,
    type: "assistant",
    requestId,
    uuid: Math.random().toString(36).slice(2),
    message: { id: msgId, model: "claude-sonnet-4-5", role: "assistant", content: [block], usage, stop_reason: "tool_use" },
  });
}

const usage = {
  input_tokens: 2,
  cache_creation_input_tokens: 87836,
  cache_read_input_tokens: 0,
  output_tokens: 924,
  output_tokens_details: { thinking_tokens: 794 },
};

describe("TranscriptParser", () => {
  it("merges the per-content-block lines of one API response into one event", () => {
    const p = new TranscriptParser({ defaultAgentId: "main" });
    const lines = [
      JSON.stringify({ ...base, type: "user", message: { role: "user", content: "Fix the login bug" } }),
      assistantLine("msg_1", "req_1", { type: "thinking", thinking: "" }, usage),
      assistantLine("msg_1", "req_1", { type: "tool_use", name: "Bash", input: { command: "npm test", description: "Run tests" } }, usage),
      assistantLine("msg_1", "req_1", { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } }, usage),
      JSON.stringify({ ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    ];
    const events = lines.map((l) => p.feed(l)).filter(Boolean);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.id).toBe("claude-code:msg_1:req_1");
    expect(e.outputTokens).toBe(924);
    expect(e.cacheWriteTokens).toBe(87836);
    expect(e.reasoningTokens).toBe(794);
    expect(e.toolCalls).toEqual(["Bash", "Read"]);
    expect(e.activity).toBe("Read: src/auth.ts");
    expect(e.meta?.prompt).toBe("Fix the login bug");
    expect(e.project).toBe("/home/me/repo");
    expect(e.agentId).toBe("main");
    expect(e.parentAgentId).toBeUndefined();
  });

  it("separates consecutive messages and marks sidechains as subagents", () => {
    const p = new TranscriptParser({ defaultAgentId: "main" });
    const out = [
      p.feed(assistantLine("msg_1", "req_1", { type: "text", text: "Looking into it." }, usage)),
      p.feed(assistantLine("msg_2", "req_2", { type: "text", text: "Done." }, usage, { isSidechain: true })),
      p.flush(),
    ].filter(Boolean);
    expect(out).toHaveLength(2);
    expect(out[0]!.activity).toBe("Looking into it.");
    expect(out[1]!.agentId).toBe("sidechain");
    expect(out[1]!.parentAgentId).toBe("main");
  });

  it("strips system reminders from prompts and ignores synthetic/half lines", () => {
    const p = new TranscriptParser({ defaultAgentId: "main" });
    expect(p.feed('{"type":"assistant","mess')).toBeNull();
    expect(
      p.feed(JSON.stringify({ ...base, type: "user", message: { role: "user", content: "<system-reminder>x</system-reminder>hello there" } })),
    ).toBeNull();
    p.feed(assistantLine("msg_1", "req_1", { type: "text", text: "hi" }, usage));
    const e = p.flush()!;
    expect(e.meta?.prompt).toBe("hello there");
    const synthetic = JSON.parse(assistantLine("msg_s", "req_s", { type: "text", text: "" }, usage));
    synthetic.message.model = "<synthetic>";
    expect(p.feed(JSON.stringify(synthetic))).toBeNull();
    expect(p.flush()).toBeNull();
  });
});
