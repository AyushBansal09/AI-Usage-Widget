import { describe, it, expect } from "vitest";
import { CodexAccount, quotaFromRateLimits } from "./codex-account.js";
import type { CodexRateLimits } from "@ai-usage-widget/adapter-codex";

const snapshot: CodexRateLimits = {
  at: "2026-09-11T13:32:49.000Z",
  planType: "free",
  limitId: "codex",
  windows: [
    { id: "primary", usedPercent: 0, windowMinutes: 43200, resetsAt: "2026-10-11T13:32:49.000Z" },
    { id: "secondary", usedPercent: 37.5, windowMinutes: 300, resetsAt: "2026-09-11T18:00:00.000Z" },
  ],
  credits: { hasCredits: false, unlimited: false, balance: null },
};

describe("quotaFromRateLimits", () => {
  it("maps windows to provider 'openai' with labels from the window length and the log's timestamp", () => {
    const q = quotaFromRateLimits(snapshot);
    expect(q).toEqual([
      { id: "codex_primary", label: "ChatGPT Codex 30-day window", provider: "openai", fraction: 0, resetsAt: "2026-10-11T13:32:49.000Z", measuredAt: snapshot.at },
      { id: "codex_secondary", label: "ChatGPT Codex 5-hour window", provider: "openai", fraction: 0.375, resetsAt: "2026-09-11T18:00:00.000Z", measuredAt: snapshot.at },
    ]);
    expect(quotaFromRateLimits({ ...snapshot, windows: [{ id: "primary", usedPercent: 10, windowMinutes: 10080, resetsAt: null }] })[0]!.label).toBe("ChatGPT Codex weekly cap");
    expect(quotaFromRateLimits(null)).toEqual([]);
  });
});

describe("CodexAccount", () => {
  it("reports the plan and windows from the adapter snapshot without any network", async () => {
    const a = new CodexAccount({ enabled: true, pollSeconds: 60, source: () => snapshot });
    const s = await a.refresh();
    expect(s).toMatchObject({ provider: "openai", credential: "file", token: "ok", subscription: "free", lastFetch: snapshot.at, lastError: null });
    expect(s.quota).toHaveLength(2);
  });

  it("says what to do when Codex has never run", async () => {
    const s = await new CodexAccount({ enabled: true, pollSeconds: 60, source: () => null }).refresh();
    expect(s.token).toBe("missing");
    expect(s.lastError).toMatch(/codex login/);
  });
});
