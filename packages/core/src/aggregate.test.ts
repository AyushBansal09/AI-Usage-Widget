import { describe, it, expect } from "vitest";
import { buildAgentSnapshots, efficiency, rollingWindow, budgetWindow } from "./aggregate.js";
import { EventStore } from "./store.js";
import { PricingTable } from "./pricing.js";
import type { UsageEvent } from "./types.js";

const T0 = Date.parse("2026-09-09T12:00:00Z");

function ev(offsetMin: number, over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: `t:${offsetMin}:${Math.random()}`,
    source: "claude-code",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    timestamp: new Date(T0 + offsetMin * 60000).toISOString(),
    sessionId: "s1",
    agentId: "main",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 800,
    cacheWriteTokens: 100,
    reasoningTokens: 10,
    costUsd: 0.01,
    toolCalls: ["Bash"],
    ...over,
  };
}

describe("rollingWindow", () => {
  const win = { id: "5h", label: "5h", sources: ["claude-code"], hours: 5, limit: 10_000, counting: "all" as const };

  it("anchors on the first message and re-anchors after the window expires", () => {
    const events = [ev(0), ev(60), ev(6 * 60), ev(6 * 60 + 30)]; // 2 in window A, 2 in window B
    const now = T0 + 10 * 3600000; // 4h into window B, 2100 tokens burned -> won't reach 10k before reset
    const w = rollingWindow(events, win, now);
    expect(w.windowStart).toBe(new Date(T0 + 6 * 3600000).toISOString());
    expect(w.used).toBe(2 * 1050);
    expect(w.fraction).toBeCloseTo(0.21);
    expect(w.projectedExhaustion).toBeNull(); // burn too slow to hit limit before reset
  });

  it("reports an empty window when nothing is open", () => {
    const w = rollingWindow([ev(0)], win, T0 + 10 * 3600000);
    expect(w.used).toBe(0);
    expect(w.fraction).toBe(0);
  });

  it("projects exhaustion when burn rate would cross the limit before reset", () => {
    const events = Array.from({ length: 8 }, (_, i) => ev(i)); // 8400 tokens in 8 minutes
    const w = rollingWindow(events, win, T0 + 8 * 60000);
    expect(w.projectedExhaustion).not.toBeNull();
    expect(Date.parse(w.projectedExhaustion!)).toBeLessThan(Date.parse(w.windowEnd));
  });

  it("honours the counting rule and source filter", () => {
    const events = [ev(0), ev(1, { source: "codex" })];
    expect(rollingWindow(events, { ...win, counting: "output" }, T0 + 60000).used).toBe(50);
    expect(rollingWindow(events, { ...win, sources: [] }, T0 + 60000).used).toBe(2100);
  });
});

describe("budgetWindow", () => {
  it("sums USD within the calendar period", () => {
    const now = T0;
    const events = [ev(-60), ev(0), ev(-3 * 24 * 60)];
    const b = { id: "d", label: "daily", unit: "usd" as const, sources: [], period: "day" as const, limit: 1 };
    const w = budgetWindow(events, b, now);
    expect(w.used).toBeCloseTo(0.02);
    expect(w.unit).toBe("usd");
  });
});

describe("efficiency + snapshots", () => {
  it("computes explainable ratios", () => {
    const e = efficiency([ev(0), ev(1)]);
    expect(e.cacheHitRatio).toBeCloseTo(800 / 1000);
    expect(e.reasoningShare).toBeCloseTo(0.2);
    expect(e.avgContextPerTurn).toBe(1000);
    expect(e.tokensPerToolCall).toBe(1050);
    expect(e.costPerTurn).toBeCloseTo(0.01);
  });

  it("folds events into one snapshot per agent with live status", () => {
    const now = T0 + 90_000;
    const snaps = buildAgentSnapshots(
      [ev(0, { activity: "Bash: npm test" }), ev(1, { activity: "Edit: src/a.ts" }), ev(0, { agentId: "agent-1", parentAgentId: "main" })],
      now,
    );
    expect(snaps).toHaveLength(2);
    const main = snaps.find((s) => s.agentId === "main")!;
    expect(main.turns).toBe(2);
    expect(main.lastActivity).toBe("Edit: src/a.ts");
    expect(main.status).toBe("active");
    expect(main.toolCallCounts).toEqual({ Bash: 2 });
    expect(snaps.find((s) => s.agentId === "agent-1")!.parentAgentId).toBe("main");
  });
});

describe("EventStore", () => {
  it("is idempotent on id, prices at ingest, and upserts richer re-reads", () => {
    const store = new EventStore(":memory:", new PricingTable());
    const first = store.ingest({ ...ev(0), id: "x", costUsd: null, toolCalls: [] });
    expect(first?.costUsd).toBeCloseTo((100 * 3 + 50 * 15 + 800 * 0.3 + 100 * 3.75) / 1e6);
    expect(store.ingest({ ...ev(0), id: "x", costUsd: null, toolCalls: [] })).toBeNull(); // exact duplicate
    const upd = store.ingest({ ...ev(0), id: "x", costUsd: null, toolCalls: ["Bash"] });
    expect(upd?.toolCalls).toEqual(["Bash"]);
    expect(store.totals().events).toBe(1);
    expect(store.ingest({ ...ev(0), id: "y", model: "mystery-9000", costUsd: null })?.costUsd).toBeNull();
    expect(store.totals().unpricedEvents).toBe(1);
    store.close();
  });
});
