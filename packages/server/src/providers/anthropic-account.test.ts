import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatQuotaAmount } from "@ai-usage-widget/core";
import { AnthropicAccount, parseCredentialJson, parseUsageResponse, spendAmount } from "./anthropic-account.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = () => JSON.parse(readFileSync(join(here, "__fixtures__", "oauth-usage.json"), "utf8"));

describe("parseUsageResponse", () => {
  /** Real Pro-plan response: 5h and weekly windows, extra-usage spend, lots of nulls, one unknown key. */
  it("turns each known utilization object into a QuotaWindow, 5h first", () => {
    const now = new Date("2026-09-10T18:00:00Z");
    const q = parseUsageResponse(fixture(), now);
    expect(q.map((w) => w.id)).toEqual(["five_hour", "seven_day", "extra_usage"]);
    expect(q[0]).toEqual({
      id: "five_hour",
      label: "Claude 5-hour window",
      provider: "anthropic",
      fraction: 0.2,
      // microsecond timestamps normalise to ms ISO
      resetsAt: "2026-09-10T19:50:00.192Z",
      measuredAt: now.toISOString(),
    });
    expect(q[1].fraction).toBe(0.07);
    expect(q[2]).toMatchObject({ label: "Extra usage (spend cap)", fraction: 0.393, resetsAt: null });
  });

  it("carries the real credit amounts for the extra-usage cap, not just a percentage", () => {
    const extra = parseUsageResponse(fixture()).find((w) => w.id === "extra_usage")!;
    // minor units with decimal_places: 3930 -> $39.30 of 10000 -> $100.00
    expect(extra.amount).toEqual({ used: 39.3, limit: 100, unit: "usd", currency: "USD" });
    expect(formatQuotaAmount(extra.amount)).toBe("$39.30 of $100.00");
    expect(extra.fraction).toBeCloseTo(0.393, 5);
  });

  it("leaves rolling windows without an amount — Anthropic reports no number for them", () => {
    const q = parseUsageResponse(fixture());
    expect(q.find((w) => w.id === "five_hour")!.amount).toBeUndefined();
    expect(q.find((w) => w.id === "seven_day")!.amount).toBeUndefined();
  });

  it("drops null windows and keys it has no label for (nimbus_quill, limits, spend)", () => {
    const ids = parseUsageResponse(fixture()).map((w) => w.id);
    expect(ids).not.toContain("nimbus_quill");
    expect(ids).not.toContain("seven_day_opus");
    expect(ids).not.toContain("limits");
    expect(ids).not.toContain("spend");
  });

  it("labels per-model weekly windows when a plan has them, and clamps", () => {
    const q = parseUsageResponse({ five_hour: { utilization: 140, resets_at: null }, seven_day_opus: { utilization: 9 }, note: "x" });
    expect(q.map((w) => w.id)).toEqual(["five_hour", "seven_day_opus"]);
    expect(q[0].fraction).toBe(1);
    expect(q[0].resetsAt).toBeNull();
    expect(q[1].label).toBe("Claude weekly (Opus)");
  });

  it("accepts a 0..1 ratio as well as a percent", () => {
    expect(parseUsageResponse({ five_hour: { utilization: 0.25 } })[0].fraction).toBe(0.25);
    expect(parseUsageResponse({ five_hour: { utilization: 25 } })[0].fraction).toBe(0.25);
  });

  it("is empty for garbage", () => {
    expect(parseUsageResponse(null)).toEqual([]);
    expect(parseUsageResponse("nope")).toEqual([]);
    expect(parseUsageResponse({ five_hour: { utilization: "62" } })).toEqual([]);
  });
});

describe("spendAmount", () => {
  it("prefers extra_usage, falls back to the spend object, and gives up rather than guessing", () => {
    expect(spendAmount({ used_credits: 500, monthly_limit: 2000, decimal_places: 2, currency: "USD" })).toEqual({ used: 5, limit: 20, unit: "usd", currency: "USD" });
    expect(spendAmount(undefined, { used: { amount_minor: 250, exponent: 2, currency: "EUR" }, limit: { amount_minor: 1000, exponent: 2 } }))
      .toEqual({ used: 2.5, limit: 10, unit: "usd", currency: "EUR" });
    // spend with no cap: report what was spent, no fake limit
    expect(spendAmount({ used_credits: 1234, decimal_places: 2, monthly_limit: 0 })).toEqual({ used: 12.34, limit: null, unit: "usd" });
    expect(spendAmount(undefined, undefined)).toBeUndefined();
    expect(spendAmount({ used_credits: "lots" })).toBeUndefined();
  });

  it("respects decimal_places other than 2", () => {
    expect(spendAmount({ used_credits: 1500, monthly_limit: 100000, decimal_places: 3 })).toMatchObject({ used: 1.5, limit: 100 });
  });

  it("formats an uncapped amount and an unknown currency without throwing", () => {
    expect(formatQuotaAmount({ used: 12.34, limit: null, unit: "usd" })).toBe("$12.34 used");
    expect(formatQuotaAmount({ used: 1, limit: 2, unit: "usd", currency: "XYZ" })).toMatch(/1\.00/);
    expect(formatQuotaAmount({ used: 137, limit: 500, unit: "requests" })).toBe("137 of 500 requests");
    expect(formatQuotaAmount(undefined)).toBeNull();
  });
});

describe("parseCredentialJson", () => {
  it("reads Claude Code's shape and never needs the refresh token", () => {
    const c = parseCredentialJson(JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-x", refreshToken: "sk-ant-ort01-y", expiresAt: 1789061298000, scopes: ["user:inference"], subscriptionType: "max" },
    }), "file");
    expect(c).toEqual({ accessToken: "sk-ant-oat01-x", expiresAt: 1789061298000, subscription: "max", from: "file" });
    expect(JSON.stringify(c)).not.toContain("ort01");
  });

  it("tolerates seconds and missing fields, rejects junk", () => {
    expect(parseCredentialJson(JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: 1789061298 } }), "keychain")?.expiresAt).toBe(1789061298000);
    expect(parseCredentialJson("{}", "file")).toBeNull();
    expect(parseCredentialJson("not json", "file")).toBeNull();
  });
});

describe("AnthropicAccount", () => {
  const cred = { accessToken: "sk-ant-oat01-SECRET", expiresAt: Date.now() + 3600_000, subscription: "max", from: "keychain" as const };

  it("does nothing on the network when disabled or when the token is expired", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    const a = new AnthropicAccount({ enabled: false, pollSeconds: 60, fetchImpl, readCredential: async () => cred });
    a.start();
    expect(calls).toBe(0);

    const b = new AnthropicAccount({ enabled: true, pollSeconds: 60, fetchImpl, readCredential: async () => ({ ...cred, expiresAt: 1 }) });
    const s = await b.refresh();
    expect(calls).toBe(0);
    expect(s.token).toBe("expired");
    expect(s.credential).toBe("keychain");
    expect(s.lastError).toMatch(/expired/);
  });

  it("sends the bearer token with the oauth beta header and stores quota", async () => {
    let seen: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
      return new Response(JSON.stringify(fixture()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const a = new AnthropicAccount({ enabled: true, pollSeconds: 60, fetchImpl, readCredential: async () => cred, now: () => new Date("2026-09-10T18:00:00Z") });
    const s = await a.refresh();
    expect(seen.authorization).toBe("Bearer sk-ant-oat01-SECRET");
    expect(seen["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(s.token).toBe("ok");
    expect(s.lastFetch).toBe("2026-09-10T18:00:00.000Z");
    expect(s.quota[0].fraction).toBe(0.2);
    expect(JSON.stringify(s)).not.toContain("SECRET");
  });

  it("marks a 401 as expired and keeps the last good quota", async () => {
    let status = 200;
    const fetchImpl = (async () => new Response(status === 200 ? JSON.stringify(fixture()) : "", { status })) as unknown as typeof fetch;
    const a = new AnthropicAccount({ enabled: true, pollSeconds: 60, fetchImpl, readCredential: async () => cred });
    await a.refresh();
    status = 401;
    const s = await a.refresh();
    expect(s.token).toBe("expired");
    expect(s.quota).toHaveLength(3);
  });

  it("reports a missing login without touching the network", async () => {
    const fetchImpl = (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch;
    const a = new AnthropicAccount({ enabled: true, pollSeconds: 60, fetchImpl, readCredential: async () => null });
    const s = await a.refresh();
    expect(s.token).toBe("missing");
    expect(s.credential).toBe("none");
  });
});
