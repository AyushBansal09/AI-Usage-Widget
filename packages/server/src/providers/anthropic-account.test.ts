import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicAccount, parseCredentialJson, parseUsageResponse } from "./anthropic-account.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = () => JSON.parse(readFileSync(join(here, "__fixtures__", "oauth-usage.json"), "utf8"));

describe("parseUsageResponse", () => {
  it("turns each utilization object into a QuotaWindow, 5h first", () => {
    const now = new Date("2026-09-10T18:00:00Z");
    const q = parseUsageResponse(fixture(), now);
    expect(q.map((w) => w.id)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    expect(q[0]).toEqual({
      id: "five_hour",
      label: "Claude 5-hour window",
      provider: "anthropic",
      fraction: 0.62,
      resetsAt: "2026-09-10T21:00:00.000Z",
      measuredAt: now.toISOString(),
    });
    // unknown keys get a humanised label, never a guessed meaning
    expect(q[2].label).toBe("Claude weekly (Opus)");
  });

  it("ignores non-window keys and clamps", () => {
    const q = parseUsageResponse({ five_hour: { utilization: 140, resets_at: null }, extra_usage: { enabled: false }, note: "x" });
    expect(q).toHaveLength(1);
    expect(q[0].fraction).toBe(1);
    expect(q[0].resetsAt).toBeNull();
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
    expect(s.quota[0].fraction).toBe(0.62);
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
