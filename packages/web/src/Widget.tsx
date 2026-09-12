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

  // The account's own numbers (via `connect claude`) take the hero slot when
  // present; local estimates drop to the mini row so both stay visible but
  // are never confused for each other.
  const quota = summary?.quota ?? []; // server orders these: Anthropic 5h first
  const measured = quota[0] ?? null;
  const measuredAccount = measured ? summary?.accounts?.find((a) => a.provider === measured.provider) : undefined;
  const primary = measured ? null : summary?.windows[0] ?? null;
  const others = summary ? [...(measured ? summary.windows : summary.windows.slice(1)), ...summary.budgets] : [];
  const otherQuota = quota.filter((q) => q !== measured);
  const unhealthy = (summary?.accounts ?? []).filter((a) => a.enabled && a.token !== "ok");

  return (
    <div className="widget">
      {err && <div className="w-err">Collector not reachable. Start it with <code>ai-usage-widget serve</code>.</div>}
      {summary && (
        <>
          {measured ? <Measured q={measured} account={measuredAccount} /> : primary ? <Primary w={primary} /> : <div className="w-err">No window configured.</div>}
          {unhealthy.map((a) => (
            <div className="w-err" key={a.provider}>{a.lastError ?? `${a.provider} account link needs attention.`}</div>
          ))}
          {(others.length > 0 || otherQuota.length > 0) && (
            <div className="w-others">
              {otherQuota.map((q) => <MiniQuota key={q.id} q={q} />)}
              {others.map((w) => <Mini key={w.id} w={w} />)}
            </div>
          )}
          <div className="glass">
            <div className="w-section">
              <span>Agents</span>
              <span className="w-muted">{agents.filter((a) => a.status === "active").length} active</span>
            </div>
            {agents.length === 0 && <div className="w-muted w-pad">Nothing running right now.</div>}
            <div className="w-list">
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
            </div>
          </div>
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
    <div className="glass w-primary">
      <div className="w-primary-top">
        <div>
          <div className="w-label">{w.label}</div>
          <div className="w-hero">{left === null ? fmt.tokens(w.used) : `${fmt.pct(left)} left`}</div>
        </div>
        <div className="w-right">
          <div>resets in <b>{fmt.until(w.windowEnd)}</b></div>
          <div>{w.unit === "usd" ? fmt.usd(w.burnRatePerHour) : fmt.tokens(w.burnRatePerHour)}/h</div>
          {w.fraction !== null && w.fraction >= 1
            ? <div className="w-warn">limit reached</div>
            : w.projectedExhaustion && <div className="w-warn">runs out in {fmt.until(w.projectedExhaustion)}</div>}
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

/** Hero card for a provider-measured window: no burn rate or projection, those are ours, not theirs. */
function Measured({ q, account }: { q: Summary["quota"][number]; account: Summary["accounts"][number] | undefined }) {
  const cls = q.fraction >= 0.9 ? "crit" : q.fraction >= 0.7 ? "warn" : "";
  return (
    <div className="glass w-primary">
      <div className="w-primary-top">
        <div>
          <div className="w-label">{q.label}</div>
          <div className="w-hero">{fmt.pct(1 - q.fraction)} left</div>
        </div>
        <div className="w-right">
          {q.resetsAt && <div>resets in <b>{fmt.until(q.resetsAt)}</b></div>}
          {fmt.amount(q.amount) && <div><b>{fmt.amount(q.amount)}</b></div>}
          <div className="w-muted">{q.provider.charAt(0).toUpperCase() + q.provider.slice(1)} · {fmt.ago(q.measuredAt)}{account?.subscription ? ` · ${account.subscription}` : ""}</div>
          {q.fraction >= 1 && <div className="w-warn">limit reached</div>}
        </div>
      </div>
      <div className="meter"><div className={cls} style={{ width: `${q.fraction * 100}%` }} /></div>
    </div>
  );
}

function MiniQuota({ q }: { q: Summary["quota"][number] }) {
  const amount = fmt.amount(q.amount);
  return (
    <div className="glass w-mini" title={amount ?? undefined}>
      <span className="w-muted">{q.label}</span>
      <b>{fmt.pct(1 - q.fraction)} left</b>
      {amount && <span className="w-muted">{amount}</span>}
    </div>
  );
}

function Mini({ w }: { w: WindowStatus }) {
  const v = w.fraction === null ? (w.unit === "usd" ? fmt.usd(w.used) : fmt.tokens(w.used)) : fmt.pct(1 - w.fraction) + " left";
  return (
    <div className="glass w-mini">
      <span className="w-muted">{w.label}</span>
      <b>{v}</b>
    </div>
  );
}
