import { useCallback, useEffect, useState } from "react";
import { api, fmt, subscribe, type AgentSnapshot, type Summary, type TimelineBucket, type WindowStatus } from "./api.js";
import { Timeline } from "./Timeline.js";

const RANGES = ["1h", "5h", "24h", "7d", "30d"];

export function App() {
  const [range, setRange] = useState(() => {
    try { return localStorage.getItem("range") ?? "24h"; } catch { return "24h"; }
  });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [timeline, setTimeline] = useState<TimelineBucket[]>([]);
  const [live, setLive] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, a, t] = await Promise.all([api.summary(range), api.agents(range), api.timeline(range)]);
      setSummary(s); setAgents(a); setTimeline(t); setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [range]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => subscribe(() => void refresh(), setLive), [refresh]);
  useEffect(() => {
    const t = setInterval(() => void refresh(), 30000); // keeps "ago" and windows fresh
    return () => clearInterval(t);
  }, [refresh]);

  const pick = (r: string) => { setRange(r); try { localStorage.setItem("range", r); } catch {} };

  return (
    <div className="wrap">
      <header>
        <h1>ai-usage-widget <small>local · nothing leaves this machine</small></h1>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <span className={"live" + (live ? "" : " off")}>{live ? "live" : "reconnecting"}</span>
          <div className="range" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r} aria-pressed={r === range} onClick={() => pick(r)}>{r}</button>
            ))}
          </div>
        </div>
      </header>

      {err && <div className="card" style={{ borderColor: "var(--critical)" }}>Could not reach the collector: {err}</div>}
      {!summary ? <div className="empty">Loading…</div> : (
        <>
          <h2>Tokens left</h2>
          <div className="grid">
            {[...summary.windows, ...summary.budgets].map((w) => <WindowCard key={w.id} w={w} />)}
            {!summary.windows.length && !summary.budgets.length && (
              <div className="card empty">No windows or budgets configured. Edit ~/.ai-usage-widget/config.json.</div>
            )}
          </div>

          <h2>Last {summary.range}</h2>
          <div className="grid">
            <Stat label="Total tokens" value={fmt.tokens(total(summary))}
              sub={`${fmt.tokens(summary.totals.inputTokens)} in · ${fmt.tokens(summary.totals.outputTokens)} out · ${fmt.tokens(summary.totals.cacheReadTokens + summary.totals.cacheWriteTokens)} cache`} />
            <Stat label="Estimated cost" value={summary.totals.unpricedEvents === summary.totals.events && summary.totals.events > 0 ? "—" : fmt.usd(summary.totals.costUsd)}
              sub={summary.totals.unpricedEvents ? `${summary.totals.unpricedEvents} unpriced turns (unknown model)` : `${summary.totals.events} turns`} />
            <Stat label="Cache hit ratio" value={fmt.pct(summary.efficiency.cacheHitRatio)} sub="share of context served from cache — higher is cheaper" />
            <Stat label="Context per turn" value={fmt.tokens(summary.efficiency.avgContextPerTurn)} sub="avg tokens re-read each turn — watch this grow" />
            <Stat label="Thinking share" value={fmt.pct(summary.efficiency.reasoningShare)} sub="of output tokens spent reasoning" />
            <Stat label="Tokens per tool call" value={summary.efficiency.tokensPerToolCall === null ? "—" : fmt.tokens(summary.efficiency.tokensPerToolCall)} sub="lower = more work per token" />
          </div>

          <h2>Timeline</h2>
          <Timeline data={timeline} />

          <h2>Agents</h2>
          <AgentsTable agents={agents} />

          <h2>By model</h2>
          <div className="tableWrap">
            <table>
              <thead><tr><th>Model</th><th className="num">Tokens</th><th className="num">Turns</th><th className="num">Cost</th></tr></thead>
              <tbody>
                {summary.byModel.map((m) => (
                  <tr key={m.key}><td className="mono">{m.key}</td><td className="num">{fmt.tokens(m.tokens)}</td><td className="num">{m.events}</td><td className="num">{fmt.usd(m.costUsd)}</td></tr>
                ))}
                {!summary.byModel.length && <tr><td colSpan={4} className="empty">Nothing yet</td></tr>}
              </tbody>
            </table>
          </div>

          <h2>Sources</h2>
          <div className="sources">
            {summary.sources.map((s) => (
              <span key={s.name} className={s.available ? "" : "off"} title={s.location ?? s.reason}>
                {s.name} · {s.events} events
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function total(s: Summary) {
  const t = s.totals;
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function WindowCard({ w }: { w: WindowStatus }) {
  const used = w.unit === "usd" ? fmt.usd(w.used) : fmt.tokens(w.used);
  const limit = w.limit === null ? null : w.unit === "usd" ? fmt.usd(w.limit) : fmt.tokens(w.limit);
  const cls = w.fraction === null ? "" : w.fraction >= 0.9 ? "crit" : w.fraction >= 0.7 ? "warn" : "";
  return (
    <div className="card">
      <div className="label">{w.label}</div>
      <div className="value">{w.fraction === null ? used : fmt.pct(w.fraction)}</div>
      <div className="sub">
        {limit ? `${used} of ${limit}` : "no limit set — showing usage only"} · resets in {fmt.until(w.windowEnd)}
      </div>
      <div className="sub">
        burn {w.unit === "usd" ? fmt.usd(w.burnRatePerHour) : fmt.tokens(w.burnRatePerHour)}/h
        {w.projectedExhaustion && ` · ⚠ runs out in ${fmt.until(w.projectedExhaustion)}`}
      </div>
      {w.fraction !== null && <div className="meter"><div className={cls} style={{ width: `${w.fraction * 100}%` }} /></div>}
    </div>
  );
}

function AgentsTable({ agents }: { agents: AgentSnapshot[] }) {
  if (!agents.length) return <div className="card empty">No agent activity in this range.</div>;
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Status</th><th>Agent</th><th>Working on</th><th>Model</th>
            <th className="num">Turns</th><th className="num">Context</th><th className="num">Output</th><th className="num">Cache hit</th><th className="num">Cost</th><th className="num">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const ctx = a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens;
            const hit = ctx ? a.cacheReadTokens / ctx : 0;
            return (
              <tr key={`${a.source}|${a.sessionId}|${a.agentId}`}>
                <td><span className={`status ${a.status}`}>{a.status}</span></td>
                <td>
                  <div className="mono">{a.source} · {a.sessionId.slice(0, 8)}{a.agentId !== "main" ? ` › ${a.agentId}` : ""}</div>
                  <div className="activity" title={a.project}>{a.project?.split("/").slice(-2).join("/")}</div>
                </td>
                <td className="activity" title={a.lastActivity}>{a.lastActivity ?? "—"}</td>
                <td className="mono">{a.model}</td>
                <td className="num">{a.turns}</td>
                <td className="num">{fmt.tokens(ctx)}</td>
                <td className="num">{fmt.tokens(a.outputTokens)}</td>
                <td className="num">{fmt.pct(hit)}</td>
                <td className="num">{a.unpriced ? "—" : fmt.usd(a.costUsd)}</td>
                <td className="num">{fmt.ago(a.lastSeen)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
