import type { AgentSnapshot, EfficiencyMetrics, UsageEvent, WindowStatus } from "./types.js";
import type { Config } from "./config.js";

const ACTIVE_MS = 2 * 60 * 1000; // an agent that spoke in the last 2 min is "active"
const IDLE_MS = 30 * 60 * 1000; // ... within 30 min is "idle", after that "done"

export function agentKey(e: Pick<UsageEvent, "source" | "sessionId" | "agentId">): string {
  return `${e.source}|${e.sessionId}|${e.agentId}`;
}

/** Folds events into one snapshot per (source, session, agent). Events must be time-ordered. */
export function buildAgentSnapshots(events: UsageEvent[], now = Date.now()): AgentSnapshot[] {
  const map = new Map<string, AgentSnapshot>();
  for (const e of events) {
    const k = agentKey(e);
    let s = map.get(k);
    if (!s) {
      s = {
        source: e.source,
        sessionId: e.sessionId,
        agentId: e.agentId,
        parentAgentId: e.parentAgentId,
        project: e.project,
        model: e.model,
        status: "done",
        lastSeen: e.timestamp,
        firstSeen: e.timestamp,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        unpriced: false,
        toolCallCounts: {},
      };
      map.set(k, s);
    }
    s.turns++;
    s.model = e.model;
    s.lastSeen = e.timestamp;
    if (e.activity) s.lastActivity = e.activity;
    if (e.project && !s.project) s.project = e.project;
    s.inputTokens += e.inputTokens;
    s.outputTokens += e.outputTokens;
    s.cacheReadTokens += e.cacheReadTokens;
    s.cacheWriteTokens += e.cacheWriteTokens;
    s.reasoningTokens += e.reasoningTokens;
    if (e.costUsd === null) s.unpriced = true;
    else s.costUsd += e.costUsd;
    for (const t of e.toolCalls) s.toolCallCounts[t] = (s.toolCallCounts[t] ?? 0) + 1;
  }
  for (const s of map.values()) {
    const age = now - Date.parse(s.lastSeen);
    s.status = age < ACTIVE_MS ? "active" : age < IDLE_MS ? "idle" : "done";
    s.costUsd = round(s.costUsd, 4);
  }
  return [...map.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

export function efficiency(events: UsageEvent[]): EfficiencyMetrics {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0, cost = 0, toolCalls = 0;
  for (const e of events) {
    input += e.inputTokens;
    output += e.outputTokens;
    cacheRead += e.cacheReadTokens;
    cacheWrite += e.cacheWriteTokens;
    reasoning += e.reasoningTokens;
    cost += e.costUsd ?? 0;
    toolCalls += e.toolCalls.length;
  }
  const context = input + cacheRead + cacheWrite;
  const turns = Math.max(events.length, 1);
  return {
    cacheHitRatio: context ? cacheRead / context : 0,
    outputToContextRatio: context ? output / context : 0,
    reasoningShare: output ? reasoning / output : 0,
    avgContextPerTurn: Math.round(context / turns),
    tokensPerToolCall: toolCalls ? Math.round((context + output) / toolCalls) : null,
    costPerTurn: round(cost / turns, 4),
  };
}

function countFor(e: UsageEvent, counting: "all" | "input+output" | "output"): number {
  switch (counting) {
    case "output": return e.outputTokens;
    case "input+output": return e.inputTokens + e.outputTokens;
    default: return e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
  }
}

/**
 * Provider-style rolling window: the window opens on the first message after
 * the previous window closed and lasts `hours`. This is how Claude's 5-hour
 * and 7-day limits are documented to behave, and it is the same estimate
 * ccusage-style tools use. It is an ESTIMATE: only the provider knows the
 * true anchor, and activity on other devices is invisible here.
 */
export function rollingWindow(
  events: UsageEvent[],
  win: Config["windows"][number],
  now = Date.now(),
): WindowStatus {
  const ms = win.hours * 3600 * 1000;
  const inScope = win.sources.length ? events.filter((e) => win.sources.includes(e.source)) : events;
  let start: number | null = null;
  let used = 0;
  for (const e of inScope) {
    const t = Date.parse(e.timestamp);
    if (start === null || t >= start + ms) {
      start = t;
      used = 0;
    }
    used += countFor(e, win.counting);
  }
  // No window open right now: report an empty one starting "now".
  if (start === null || now >= start + ms) {
    start = now;
    used = 0;
  }
  return finishWindow(win.id, win.label, "rolling", start, start + ms, used, win.limit, "tokens", now);
}

export function budgetWindow(
  events: UsageEvent[],
  b: Config["budgets"][number],
  now = Date.now(),
): WindowStatus {
  const d = new Date(now);
  let start: Date;
  let end: Date;
  if (b.period === "day") {
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  } else if (b.period === "week") {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  } else {
    start = new Date(d.getFullYear(), d.getMonth(), 1);
    end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  const s = start.getTime(), e = end.getTime();
  let used = 0;
  for (const ev of events) {
    if (b.sources.length && !b.sources.includes(ev.source)) continue;
    const t = Date.parse(ev.timestamp);
    if (t < s || t >= e) continue;
    used += b.unit === "usd" ? ev.costUsd ?? 0 : countFor(ev, "all");
  }
  return finishWindow(b.id, b.label, "budget", s, e, used, b.limit, b.unit, now);
}

function finishWindow(
  id: string, label: string, kind: WindowStatus["kind"],
  start: number, end: number, used: number, limit: number | null,
  unit: WindowStatus["unit"], now: number,
): WindowStatus {
  const elapsedH = Math.max((Math.min(now, end) - start) / 3600000, 1 / 60);
  const burn = used / elapsedH;
  let projected: string | null = null;
  if (limit !== null && burn > 0 && used < limit) {
    const at = now + ((limit - used) / burn) * 3600000;
    if (at < end) projected = new Date(at).toISOString();
  } else if (limit !== null && used >= limit) {
    projected = new Date(now).toISOString();
  }
  return {
    id, label, kind,
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(end).toISOString(),
    used: unit === "usd" ? round(used, 4) : used,
    limit,
    fraction: limit ? Math.min(used / limit, 1) : null,
    burnRatePerHour: unit === "usd" ? round(burn, 4) : Math.round(burn),
    projectedExhaustion: projected,
    unit,
  };
}

/** Per-hour buckets for the timeline chart. */
export function timeline(events: UsageEvent[], bucketMs = 3600000) {
  const buckets = new Map<number, { t: string; input: number; output: number; cache: number; costUsd: number }>();
  for (const e of events) {
    const b = Math.floor(Date.parse(e.timestamp) / bucketMs) * bucketMs;
    let row = buckets.get(b);
    if (!row) {
      row = { t: new Date(b).toISOString(), input: 0, output: 0, cache: 0, costUsd: 0 };
      buckets.set(b, row);
    }
    row.input += e.inputTokens;
    row.output += e.outputTokens;
    row.cache += e.cacheReadTokens + e.cacheWriteTokens;
    row.costUsd = round(row.costUsd + (e.costUsd ?? 0), 4);
  }
  return [...buckets.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
}

function round(n: number, places: number) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
