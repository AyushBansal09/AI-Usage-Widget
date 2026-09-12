import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuotaWindow } from "@ai-usage-widget/core";
import { Collector } from "./collector.js";
import { seedStatus, emptyStatus } from "./providers/account-link.js";

let dir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "auw-quota-"));
  storePath = join(dir, "events.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const window = (over: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: "extra_usage",
  label: "Extra usage (spend cap)",
  provider: "anthropic",
  fraction: 0.707,
  resetsAt: null,
  measuredAt: "2026-09-11T22:00:15.737Z",
  amount: { used: 70.74, limit: 100, unit: "usd", currency: "USD" },
  ...over,
});

describe("seedStatus", () => {
  it("fills in only while nothing live has arrived", () => {
    const empty = emptyStatus("anthropic", true);
    const seeded = seedStatus(empty, [window()], "2026-09-11T22:00:15.737Z");
    expect(seeded.quota).toHaveLength(1);
    expect(seeded.lastFetch).toBe("2026-09-11T22:00:15.737Z");

    // A live fetch must never be overwritten by a stale cache.
    const live = { ...empty, quota: [window({ fraction: 0.1 })], lastFetch: "2026-09-12T00:00:00.000Z" };
    expect(seedStatus(live, [window()], "2026-09-11T22:00:15.737Z")).toBe(live);
    expect(seedStatus(empty, [], null)).toBe(empty);
  });

  it("keeps the original measuredAt so a stale figure stays visibly stale", () => {
    const seeded = seedStatus(emptyStatus("anthropic", true), [window()], null);
    expect(seeded.quota[0]!.measuredAt).toBe("2026-09-11T22:00:15.737Z");
  });
});

describe("Collector quota persistence", () => {
  /** A link that never reaches the network, so only the cache can supply numbers. */
  const offlineLink = (provider: string) => {
    let status = emptyStatus(provider, true);
    return {
      provider,
      get status() { return status; },
      lastRaw: null,
      start() {},
      stop() {},
      async refresh() { return status; },
      seed(q: QuotaWindow[], at: string | null) { status = seedStatus(status, q, at); },
      /** test helper */
      set(q: QuotaWindow[]) { status = { ...status, quota: q, lastFetch: "2026-09-11T22:00:15.737Z" }; },
    };
  };

  it("saves on stop and restores on the next start", async () => {
    const first = new Collector({ storePath, adapters: [] });
    const link = offlineLink("anthropic");
    (first as unknown as { accounts: unknown[] }).accounts = [link];
    await first.start({ watch: true });
    link.set([window()]); // as if a poll had succeeded
    first.stop();         // stop() flushes

    const second = new Collector({ storePath, adapters: [] });
    const fresh = offlineLink("anthropic");
    (second as unknown as { accounts: unknown[] }).accounts = [fresh];
    await second.start({ watch: false });
    expect(fresh.status.quota).toHaveLength(1);
    expect(fresh.status.quota[0]!.amount).toEqual({ used: 70.74, limit: 100, unit: "usd", currency: "USD" });
    expect(second.primaryQuota()?.label).toBe("Extra usage (spend cap)");
    second.stop();
  });

  it("ignores a corrupt cache instead of crashing", async () => {
    const seeder = new Collector({ storePath, adapters: [] });
    seeder.store.setState("account", "quota:anthropic", "{not json");
    seeder.stop();

    const c = new Collector({ storePath, adapters: [] });
    const link = offlineLink("anthropic");
    (c as unknown as { accounts: unknown[] }).accounts = [link];
    await expect(c.start({ watch: false })).resolves.toBeUndefined();
    expect(link.status.quota).toEqual([]);
    c.stop();
  });

  it("does not cache an empty quota over a good one", async () => {
    const first = new Collector({ storePath, adapters: [] });
    const link = offlineLink("anthropic");
    (first as unknown as { accounts: unknown[] }).accounts = [link];
    await first.start({ watch: true });
    link.set([window()]);
    first.stop();

    const second = new Collector({ storePath, adapters: [] });
    const empty = offlineLink("anthropic");
    (second as unknown as { accounts: unknown[] }).accounts = [empty];
    await second.start({ watch: true });
    empty.set([]);   // provider now returns nothing
    second.stop();   // must not overwrite the cache with []

    const third = new Collector({ storePath, adapters: [] });
    const restored = offlineLink("anthropic");
    (third as unknown as { accounts: unknown[] }).accounts = [restored];
    await third.start({ watch: false });
    expect(restored.status.quota).toHaveLength(1);
    third.stop();
  });
});
