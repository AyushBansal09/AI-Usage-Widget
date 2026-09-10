import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { buildAgentSnapshots, efficiency, rollingWindow, budgetWindow, timeline } from "@ai-usage-widget/core";
import type { Collector } from "./collector.js";

const RANGES: Record<string, number> = { "1h": 1, "5h": 5, "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };
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
