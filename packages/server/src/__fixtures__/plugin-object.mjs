// The whole plugin contract, as a user would write it: one file, no build.
export default {
  name: "my-tool",
  async detect() {
    return { available: true, location: "/somewhere/my-tool.log" };
  },
  async backfill(emit) {
    emit({
      id: "my-tool:1",
      source: "my-tool",
      provider: "other",
      model: "some-model",
      timestamp: "2026-09-11T10:00:00Z",
      sessionId: "s1",
      agentId: "main",
      inputTokens: 10,
      outputTokens: 2,
    });
  },
  async watch() {
    return () => {};
  },
};
