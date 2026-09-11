import { describe, it, expect } from "vitest";
import { CursorAccount, parseCursorUsage, userIdFromJwt } from "./cursor-account.js";

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

/** Shape as documented by Cursor's own settings page; SYNTHETIC until `connect cursor --raw` replaces it. */
const usage = {
  "gpt-4": { numRequests: 137, numRequestsTotal: 137, numTokens: 1_234_567, maxRequestUsage: 500, maxTokenUsage: null },
  "gpt-3.5-turbo": { numRequests: 12, numRequestsTotal: 12, numTokens: 0, maxRequestUsage: null, maxTokenUsage: null },
  "gpt-4-32k": { numRequests: 0, numRequestsTotal: 0, numTokens: 0, maxRequestUsage: 50, maxTokenUsage: null },
  startOfMonth: "2026-09-01T00:00:00.000Z",
};

describe("userIdFromJwt", () => {
  it("takes the part after the pipe in sub", () => {
    expect(userIdFromJwt(jwt({ sub: "auth0|user_01ABC" }))).toBe("user_01ABC");
    expect(userIdFromJwt(jwt({ sub: "plain" }))).toBe("plain");
    expect(userIdFromJwt("garbage")).toBeNull();
  });
});

describe("parseCursorUsage", () => {
  it("makes one window from the premium bucket with a month reset", () => {
    const q = parseCursorUsage(usage, new Date("2026-09-11T10:00:00Z"));
    expect(q).toHaveLength(1);
    expect(q[0]).toEqual({
      id: "cursor_premium_requests",
      label: "Cursor premium requests",
      provider: "cursor",
      fraction: 0.274,
      resetsAt: "2026-10-01T00:00:00.000Z",
      measuredAt: "2026-09-11T10:00:00.000Z",
    });
  });

  it("gives no window without a cap, and clamps", () => {
    expect(parseCursorUsage({ "gpt-4": { numRequests: 5, maxRequestUsage: null } })).toEqual([]);
    expect(parseCursorUsage({ "gpt-4": { numRequests: 900, maxRequestUsage: 500 } })[0]!.fraction).toBe(1);
    expect(parseCursorUsage(null)).toEqual([]);
  });
});

describe("CursorAccount", () => {
  const cred = { accessToken: jwt({ sub: "auth0|user_X" }), userId: "user_X", email: "e@x", membership: "pro" };

  it("sends the session cookie and keeps the token out of status", async () => {
    const seen: Array<{ url: string; cookie: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, cookie: (init.headers as any).cookie });
      if (url.includes("/api/auth/stripe")) return new Response(JSON.stringify({ membershipType: "pro-plus" }), { status: 200 });
      return new Response(JSON.stringify(usage), { status: 200 });
    }) as unknown as typeof fetch;
    const a = new CursorAccount({ enabled: true, pollSeconds: 600, fetchImpl, readCredential: () => cred, now: () => new Date("2026-09-11T10:00:00Z") });
    const s = await a.refresh();
    expect(seen[0]!.url).toBe("https://cursor.com/api/usage?user=user_X");
    expect(decodeURIComponent(seen[0]!.cookie)).toBe(`WorkosCursorSessionToken=user_X::${cred.accessToken}`);
    expect(s.token).toBe("ok");
    expect(s.subscription).toBe("pro-plus");
    expect(s.quota[0]!.fraction).toBe(0.274);
    expect(JSON.stringify(s)).not.toContain(cred.accessToken);
  });

  it("does nothing when disabled and reports a missing login without network", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    new CursorAccount({ enabled: false, pollSeconds: 600, fetchImpl, readCredential: () => cred }).start();
    const s = await new CursorAccount({ enabled: true, pollSeconds: 600, fetchImpl, readCredential: () => null }).refresh();
    expect(calls).toBe(0);
    expect(s.token).toBe("missing");
  });

  it("treats 401 as an expired login", async () => {
    const fetchImpl = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const s = await new CursorAccount({ enabled: true, pollSeconds: 600, fetchImpl, readCredential: () => cred }).refresh();
    expect(s.token).toBe("expired");
    expect(s.credential).toBe("database");
  });
});
