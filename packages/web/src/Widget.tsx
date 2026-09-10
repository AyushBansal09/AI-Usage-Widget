import { useCallback, useEffect, useState } from "react";
import { api, fmt, subscribe, type AgentSnapshot, type Summary, type WindowStatus } from "./api.js";

/**
 * Compact view for the menu bar popover (~340px wide). Same data as the
 * dashboard, cut down to what you check before starting a task:
 * window left, burn rate / time-to-exhaustion, and who is doing what.
 */
export function Widget() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [live, setLive] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.summary("5h"), api.agents("5h")]);
      setSummary(s); setAgents(a.filter((x) => x.status !== "done")); setErr(null);
    } catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => subscribe(() => void refresh(), setLive), [refresh]);
  useEffect(() => { const t = setInterval(() => void refresh(), 20000); return () => clearInterval(t); }, [refresh]);

  const primary = summary?.windows[0] ?? null;
  const others = summary ? [...summary.windows.slice(1), ...summary.budgets] : [];

  return (
    <div className="widget">
      {err && <div className="w-err">Collector not reachable. Start it with <code>ai-usage-widget serve</code>.</div>}
      {summary && (
        <>
          {primary ? <Primary w={primary} /> : <div className="w-err">No window configured.</div>}
          {others.length > 0 && (
            <div className="w-others">
              {others.map((w) => <Mini key={w.id} w={w} />)}
            </div>
          )}
          <div className="w-section">
            <span>Agents</span>
            <span className="w-muted">{agents.filter((a) => a.status === "active").length} active</span>
          </div>
          {agents.length === 0 && <div className="w-muted w-pad">Nothing running right now.</div>}
          {agents.slice(0, 6).map((a) => (
            <div className="w-agent" key={`${a.source}|${a.sessionId}|${a.agentId}`}>
              <span className={`status ${a.status}`} />
              <div className="w-agent-body">
                <div className="w-agent-title">
                  <span>{a.project ? a.project.split("/").pop() : a.source}{a.agentId !== "main" ? ` › ${a.agentId}` : ""}</span>
                  <span className="w-muted">{fmt.ago(a.lastSeen)}</span>
                </div>
                <div className="w-agent-act" title={a.lastActivity}>{a.lastActivity ?? "—"}</div>
              </div>
            </div>
          ))}
          <div className="w-foot">
            <span className={"live" + (live ? "" : " off")}>{live ? "live" : "reconnecting"}</span>
            <span className="w-muted">
              {fmt.tokens(summary.totals.inputTokens + summary.totals.outputTokens + summary.totals.cacheReadTokens + summary.totals.cacheWriteTokens)} in 5h
              {summary.totals.unpricedEvents < summary.totals.events && ` · ${fmt.usd(summary.totals.costUsd)}`}
            </span>
            <a href="/" target="_blank" rel="noreferrer">Dashboard ↗</a>
          </div>
        </>
      )}
    </div>
  );
}

function Primary({ w }: { w: WindowStatus }) {
  const left = w.fraction === null ? null : 1 - w.fraction;
  const cls = w.fraction === null ? "" : w.fraction >= 0.9 ? "crit" : w.fraction >= 0.7 ? "warn" : "";
  return (
    <div className="w-primary">
      <div className="w-primary-top">
        <div>
          <div className="w-label">{w.label}</div>
          <div className="w-hero">{left === null ? fmt.tokens(w.used) : `${fmt.pct(left)} left`}</div>
        </div>
        <div className="w-right">
          <div>resets in <b>{fmt.until(w.windowEnd)}</b></div>
          <div>{w.unit === "usd" ? fmt.usd(w.burnRatePerHour) : fmt.tokens(w.burnRatePerHour)}/h</div>
          {w.projectedExhaustion && <div className="w-warn">runs out in {fmt.until(w.projectedExhaustion)}</div>}
        </div>
      </div>
      {w.fraction !== null ? (
        <div className="meter"><div className={cls} style={{ width: `${w.fraction * 100}%` }} /></div>
      ) : (
        <div className="w-muted">Set a limit in config to see a percentage.</div>
      )}
    </div>
  );
}

function Mini({ w }: { w: WindowStatus }) {
  const v = w.fraction === null ? (w.unit === "usd" ? fmt.usd(w.used) : fmt.tokens(w.used)) : fmt.pct(1 - w.fraction) + " left";
  return (
    <div className="w-mini">
      <span className="w-muted">{w.label}</span>
      <b>{v}</b>
    </div>
  );
}
