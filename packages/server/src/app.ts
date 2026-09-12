import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { buildAgentSnapshots, efficiency, rollingWindow, budgetWindow, timeline, formatQuotaAmount } from "@ai-usage-widget/core";
import type { Collector } from "./collector.js";

const RANGES: Record<string, number> = { "1h": 1, "5h": 5, "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };
/** Cap on one /api/ingest batch, so a runaway script cannot wedge the collector. */
const MAX_INGEST = 1000;
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
};

function sinceFor(range: string | undefined): string | undefined {
  const h = RANGES[range ?? "24h"];
  return h ? new Date(Date.now() - h * 3600000).toISOString() : undefined;
}

export function createApp(collector: Collector, webDir: string) {
  const app = new Hono();
  const { store, config } = collector;

  app.get("/api/health", (c) => c.json({ ok: true, now: new Date().toISOString() }));

  app.get("/api/summary", (c) => {
    const range = c.req.query("range") ?? "24h";
    const since = sinceFor(range);
    const inRange = store.events({ since });
    // Windows need history beyond the display range to find their anchor.
    const windowEvents = store.events({ since: new Date(Date.now() - 8 * 24 * 3600000).toISOString() });
    const monthEvents = store.events({ since: new Date(Date.now() - 32 * 24 * 3600000).toISOString() });
    return c.json({
      range,
      totals: store.totals({ since }),
      allTime: store.totals(),
      efficiency: efficiency(inRange),
      windows: config.windows.map((w) => rollingWindow(windowEvents, w)),
      quota: collector.quota(),
      accounts: collector.accountStatuses(),
      budgets: config.budgets.map((b) => budgetWindow(monthEvents, b)),
      sources: collector.sources(),
      byModel: byKey(inRange, (e) => e.model),
      bySource: byKey(inRange, (e) => e.source),
    });
  });

  app.get("/api/agents", (c) => {
    const since = sinceFor(c.req.query("range") ?? "24h");
    return c.json(buildAgentSnapshots(store.events({ since })));
  });

  app.get("/api/timeline", (c) => {
    const range = c.req.query("range") ?? "24h";
    const bucket = RANGES[range]! >= 24 * 7 ? 24 * 3600000 : RANGES[range]! >= 24 ? 3600000 : 5 * 60000;
    return c.json(timeline(store.events({ since: sinceFor(range) }), bucket));
  });

  app.get("/api/events", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const all = store.events({ since: sinceFor(c.req.query("range") ?? "24h") });
    return c.json(all.slice(-limit).reverse());
  });

  app.get("/api/config", (c) => c.json(config));

  /**
   * Tiny payload for the menu bar widget's tray title. Keeps the native side
   * dumb: it just polls this and paints `title`.
   */
  app.get("/api/tray", (c) => {
    const windowEvents = store.events({ since: new Date(Date.now() - 8 * 24 * 3600000).toISOString() });
    const primary = config.windows[0] ? rollingWindow(windowEvents, config.windows[0]) : null;
    const agents = buildAgentSnapshots(store.events({ since: new Date(Date.now() - 5 * 3600000).toISOString() }));
    const active = agents.filter((a) => a.status === "active").length;
    // A measured window from the account beats the local estimate whenever
    // we have one; the payload says which it was.
    const measured = collector.primaryQuota();
    const fraction = measured ? measured.fraction : primary?.fraction ?? null;
    let title: string;
    if (fraction !== null) title = `${Math.round((1 - fraction) * 100)}%`;
    else if (primary) title = compact(primary.used);
    else title = "—";
    if (active) title += ` · ${active}`;
    return c.json({
      title,
      measured: measured !== null,
      /** Which window the title is about — it can change provider, so never show the number alone. */
      label: measured?.label ?? primary?.label ?? null,
      provider: measured?.provider ?? null,
      /** "$70.74 of $100.00" when the provider reports real amounts, else null. */
      detail: formatQuotaAmount(measured?.amount),
      measuredAt: measured?.measuredAt ?? null,
      fractionUsed: fraction,
      used: primary?.used ?? 0,
      limit: primary?.limit ?? null,
      resetsAt: measured?.resetsAt ?? primary?.windowEnd ?? null,
      projectedExhaustion: measured ? null : primary?.projectedExhaustion ?? null,
      activeAgents: active,
      severity: fraction === null ? "none" : fraction >= 0.9 ? "critical" : fraction >= 0.7 ? "warning" : "ok",
    });
  });

  /**
   * Push usage from anything that can make an HTTP request — a shell hook, a
   * Python script, an agent framework, CI — without writing an adapter.
   * Body: one UsageEvent or an array of them. Ids are the caller's, so
   * retrying the same POST is safe (the store upserts).
   *
   * Only bound to 127.0.0.1, so the trust boundary is "processes on this
   * machine", the same as the SQLite file they could write directly.
   */
  app.post("/api/ingest", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON: one UsageEvent or an array of them." }, 400);
    }
    const list = Array.isArray(body) ? body : [body];
    if (list.length > MAX_INGEST) return c.json({ error: `At most ${MAX_INGEST} events per request.` }, 413);

    let ingested = 0;
    let duplicates = 0;
    const errors: string[] = [];
    for (const raw of list) {
      try {
        if (store.ingest(raw as never)) ingested++;
        else duplicates++;
      } catch (e) {
        // Zod's message names the offending field, which is what a script author needs.
        errors.push(((e as Error).message ?? String(e)).slice(0, 300));
      }
    }
    return c.json(
      { ingested, duplicates, rejected: errors.length, errors: errors.slice(0, 5) },
      ingested === 0 && errors.length > 0 ? 400 : 200,
    );
  });

  /** Health of every optional account link. Never includes a token. */
  app.get("/api/account", (c) => c.json(collector.accountStatuses()));

  /** The link behind the measured headline, for the widget's small status line. */
  function primaryAccount() {
    const q = collector.primaryQuota();
    const s = (q && collector.account(q.provider)?.status) ?? collector.accountStatuses().find((a) => a.enabled) ?? collector.accountStatuses()[0]!;
    return { provider: s.provider, enabled: s.enabled, token: s.token, lastFetch: s.lastFetch };
  }

  /**
   * One-shot payload for the macOS WidgetKit widget.
   *
   * A widget extension gets a small, OS-budgeted number of refreshes per day,
   * so it must never need more than one request: everything the small and the
   * medium family can draw is here. Deliberately pre-formatted (labels, short
   * strings) to keep the Swift side free of product decisions.
   *
   * Honesty rules the widget depends on:
   * - `limit: null` means the user has not told us their cap. `fraction` is
   *   then null and the widget shows tokens used, never an invented percent.
   * - `estimate: true` is always set on windows: local logs cannot see usage
   *   from other devices and providers do not publish remaining quota.
   * - `unpriced` is true when any event in range used a model missing from the
   *   pricing table, so the widget can mark cost as a floor, not a total.
   */
  app.get("/api/widget", (c) => {
    const now = Date.now();
    const windowEvents = store.events({ since: new Date(now - 8 * 24 * 3600000).toISOString() });
    const windows = config.windows.map((w) => rollingWindow(windowEvents, w));
    const recent = store.events({ since: new Date(now - 5 * 3600000).toISOString() });
    const snapshots = buildAgentSnapshots(recent);
    const rank: Record<string, number> = { active: 0, idle: 1, done: 2 };
    const agents = [...snapshots]
      .sort((a, b) => rank[a.status]! - rank[b.status]! || b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, 4)
      .map((a) => ({
        agentId: a.agentId,
        label: a.project ? a.project.split("/").filter(Boolean).pop() ?? a.project : a.agentId,
        model: a.model,
        status: a.status,
        activity: a.lastActivity ? truncate(a.lastActivity, 60) : null,
        costUsd: a.costUsd,
        unpriced: a.unpriced,
        tokens: a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens,
        lastSeen: a.lastSeen,
      }));
    const day = store.totals({ since: new Date(now - 24 * 3600000).toISOString() });
    return c.json({
      generatedAt: new Date(now).toISOString(),
      windows: windows.map((w) => ({
        id: w.id,
        label: w.label,
        used: w.used,
        limit: w.limit,
        fraction: w.fraction,
        unit: w.unit,
        resetsAt: w.windowEnd,
        projectedExhaustion: w.projectedExhaustion,
        burnRatePerHour: w.burnRatePerHour,
        /** Local logs are one device's view; never present this as measured quota. */
        estimate: true,
      })),
      /** Measured by the provider (all devices). Empty unless `connect claude` was run. */
      quota: collector.quota(),
      account: primaryAccount(),
      activeAgents: snapshots.filter((a) => a.status === "active").length,
      agents,
      day: {
        tokens: day.inputTokens + day.outputTokens + day.cacheReadTokens + day.cacheWriteTokens,
        costUsd: day.costUsd,
        unpriced: day.unpricedEvents > 0,
      },
    });
  });

  /** Server-sent events: one message per new/updated usage event, plus a heartbeat. */
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      const off = store.onEvent((e) => {
        if (alive) void stream.writeSSE({ event: "usage", data: JSON.stringify(e) });
      });
      stream.onAbort(() => { alive = false; off(); });
      while (alive) {
        await stream.writeSSE({ event: "tick", data: new Date().toISOString() });
        await stream.sleep(15000);
      }
    }),
  );

  // Static dashboard (built by packages/web into packages/server/public).
  app.get("/*", (c) => {
    const url = new URL(c.req.url);
    let file = join(webDir, url.pathname === "/" ? "index.html" : url.pathname);
    if (!existsSync(file)) file = join(webDir, "index.html");
    if (!existsSync(file)) return c.text("Dashboard not built. Run `pnpm build` first.", 503);
    return c.body(readFileSync(file), 200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  });

  return app;
}

/** One line, markdown emphasis stripped: activity strings can be prompt excerpts. */
function truncate(s: string, n: number): string {
  const one = s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "\u2026";
}

function compact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}

function byKey<T extends { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null }>(
  events: T[], key: (e: T) => string,
) {
  const m = new Map<string, { key: string; tokens: number; costUsd: number; events: number }>();
  for (const e of events) {
    const k = key(e);
    const row = m.get(k) ?? { key: k, tokens: 0, costUsd: 0, events: 0 };
    row.tokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    row.costUsd = Math.round((row.costUsd + (e.costUsd ?? 0)) * 1e4) / 1e4;
    row.events++;
    m.set(k, row);
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens);
}
