// Thin typed client. Types mirror @ai-usage-widget/core; duplicated here so the
// web bundle does not pull in Node-only code (better-sqlite3).

export interface Totals {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  reasoningTokens: number; costUsd: number; events: number; unpricedEvents: number;
}
export interface Efficiency {
  cacheHitRatio: number; outputToContextRatio: number; reasoningShare: number;
  avgContextPerTurn: number; tokensPerToolCall: number | null; costPerTurn: number;
}
export interface WindowStatus {
  id: string; label: string; kind: "rolling" | "fixed" | "budget"; windowStart: string; windowEnd: string;
  used: number; limit: number | null; fraction: number | null; burnRatePerHour: number;
  projectedExhaustion: string | null; unit: "tokens" | "usd";
}
export interface SourceStatus { name: string; available: boolean; location?: string; reason?: string; events: number }
/** Reported by the provider for the whole account — a measurement, unlike WindowStatus. */
export interface QuotaAmount { used: number; limit: number | null; unit: "usd" | "requests"; currency?: string }
export interface QuotaWindow {
  id: string; label: string; provider: string; fraction: number; resetsAt: string | null; measuredAt: string;
  /** Real amounts behind the ratio, when the provider reports them. */
  amount?: QuotaAmount;
}
export interface AccountStatus {
  provider: string; enabled: boolean; credential: "keychain" | "file" | "database" | "none"; token: "ok" | "expired" | "missing";
  subscription: string | null; lastFetch: string | null; lastError: string | null; quota: QuotaWindow[];
}
export interface Summary {
  range: string; totals: Totals; allTime: Totals; efficiency: Efficiency;
  windows: WindowStatus[]; quota: QuotaWindow[]; accounts: AccountStatus[]; budgets: WindowStatus[]; sources: SourceStatus[];
  byModel: Array<{ key: string; tokens: number; costUsd: number; events: number }>;
  bySource: Array<{ key: string; tokens: number; costUsd: number; events: number }>;
}
export interface AgentSnapshot {
  source: string; sessionId: string; agentId: string; parentAgentId?: string; project?: string; model: string;
  status: "active" | "idle" | "done"; lastActivity?: string; lastSeen: string; firstSeen: string; turns: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  costUsd: number; unpriced: boolean; toolCallCounts: Record<string, number>;
}
export interface TimelineBucket { t: string; input: number; output: number; cache: number; costUsd: number }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export const api = {
  summary: (range: string) => get<Summary>(`/api/summary?range=${range}`),
  agents: (range: string) => get<AgentSnapshot[]>(`/api/agents?range=${range}`),
  timeline: (range: string) => get<TimelineBucket[]>(`/api/timeline?range=${range}`),
};

/** Subscribes to the SSE stream; calls onChange on every new usage event. */
export function subscribe(onChange: () => void, onStatus: (ok: boolean) => void): () => void {
  const es = new EventSource("/api/stream");
  let t: number | undefined;
  es.addEventListener("usage", () => {
    // coalesce bursts (one API response can update several rows)
    clearTimeout(t);
    t = window.setTimeout(onChange, 300);
  });
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  return () => es.close();
}

export const fmt = {
  tokens(n: number): string {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  },
  usd(n: number): string {
    return "$" + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));
  },
  /** "$70.74 of $100.00" / "137 of 500 requests" — matches core's formatQuotaAmount. */
  amount(a: QuotaAmount | undefined): string | null {
    if (!a) return null;
    const one = (n: number) =>
      a.unit === "usd"
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: a.currency ?? "USD", maximumFractionDigits: 2 }).format(n)
        : n.toLocaleString("en-US");
    const noun = a.unit === "requests" ? " requests" : "";
    return a.limit === null ? `${one(a.used)}${noun} used` : `${one(a.used)} of ${one(a.limit)}${noun}`;
  },
  pct(n: number): string {
    if (n <= 0) return "0%";
    return (n * 100).toFixed(n >= 0.1 ? 0 : 1) + "%";
  },
  ago(iso: string): string {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  },
  until(iso: string): string {
    const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  },
};
