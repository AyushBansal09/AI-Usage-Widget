import { z } from "zod";

/**
 * The one shape every adapter must produce. Everything downstream (store,
 * aggregation, dashboard) only ever sees UsageEvents, so adding a new AI tool
 * means writing one adapter and nothing else.
 */
export const UsageEventSchema = z.object({
  /** Globally unique, stable across re-parses. Adapters build it from the
   *  source's own ids (e.g. `claude-code:<messageId>:<requestId>`), which is
   *  what makes re-reading a growing log file idempotent. */
  id: z.string().min(1),
  /** Which adapter produced the event. */
  source: z.string().min(1),
  /** Model vendor, for pricing and grouping. */
  provider: z.enum(["anthropic", "openai", "google", "other"]),
  model: z.string().min(1),
  /** ISO-8601, UTC. */
  timestamp: z.string().datetime({ offset: true }),

  /** A conversation/session as the source tool defines it. */
  sessionId: z.string().min(1),
  /** One session may run several agents (main thread + subagents). */
  agentId: z.string().min(1),
  parentAgentId: z.string().optional(),
  /** Working directory / repo the agent was operating in, when known. */
  project: z.string().optional(),

  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  /** Reasoning/thinking tokens, if the provider reports them separately.
   *  They are already included in outputTokens; this is a breakdown. */
  reasoningTokens: z.number().int().nonnegative().default(0),

  /** USD, computed from the pricing table at ingest time. Null when the
   *  model is unknown so the dashboard can flag "unpriced" instead of
   *  silently showing $0. */
  costUsd: z.number().nullable().default(null),

  /** Tool names invoked in this message, e.g. ["Bash", "Edit"]. */
  toolCalls: z.array(z.string()).default([]),
  /** Short, human-readable description of what the agent was doing at
   *  this moment (a tool description, an edited path, a prompt excerpt). */
  activity: z.string().optional(),
  /** Free-form per-source extras that the dashboard may surface. */
  meta: z.record(z.unknown()).optional(),
});

export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type UsageEventInput = z.input<typeof UsageEventSchema>;

/**
 * An adapter turns some external data source (a log directory, an API, a
 * proxy) into a stream of UsageEvents. Adapters are deliberately dumb: no
 * aggregation, no pricing, no persistence. They just parse and emit.
 */
export interface Adapter {
  /** Stable identifier, also used as UsageEvent.source. */
  readonly name: string;
  /** Cheap check: is this tool even installed / configured on this machine? */
  detect(): Promise<AdapterDetection>;
  /** One full pass over historical data. Must be idempotent. */
  backfill(emit: EmitFn): Promise<void>;
  /** Start tailing for new data. Returns a stop function. */
  watch(emit: EmitFn): Promise<() => void>;
}

export interface AdapterDetection {
  available: boolean;
  /** Where the adapter is reading from, for the dashboard's "Sources" panel. */
  location?: string;
  reason?: string;
}

export type EmitFn = (event: UsageEventInput) => void;

/** Live view of one agent, derived from its most recent events. */
export interface AgentSnapshot {
  source: string;
  sessionId: string;
  agentId: string;
  parentAgentId?: string;
  project?: string;
  model: string;
  status: "active" | "idle" | "done";
  lastActivity?: string;
  lastSeen: string;
  firstSeen: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  unpriced: boolean;
  toolCallCounts: Record<string, number>;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  events: number;
  unpricedEvents: number;
}

/**
 * Efficiency metrics. All ratios are 0..1 unless noted.
 * These are intentionally simple and explainable; every number on the
 * dashboard should be reproducible by hand from the events.
 */
export interface EfficiencyMetrics {
  /** cacheRead / (input + cacheRead + cacheWrite). Higher is cheaper. */
  cacheHitRatio: number;
  /** output / (input + cacheRead + cacheWrite). How much the model produces per token it reads. */
  outputToContextRatio: number;
  /** reasoning / output. Share of output spent on hidden thinking. */
  reasoningShare: number;
  /** Total context tokens (input + cache) per turn. Grows as sessions bloat. */
  avgContextPerTurn: number;
  /** Total tokens per tool call. Lower means more work per token. */
  tokensPerToolCall: number | null;
  /** USD per turn. */
  costPerTurn: number;
}

/** A rolling window (e.g. Claude's 5-hour session, weekly cap) or a budget. */
export interface WindowStatus {
  id: string;
  label: string;
  kind: "rolling" | "fixed" | "budget";
  windowStart: string;
  windowEnd: string;
  /** Tokens counted against this window (per the window's counting rule). */
  used: number;
  /** User-configured or estimated limit; null when unknown. */
  limit: number | null;
  /** used/limit, null when limit unknown. */
  fraction: number | null;
  /** Tokens per hour over the window so far. */
  burnRatePerHour: number;
  /** Projected exhaustion time given burn rate; null when not exhausting. */
  projectedExhaustion: string | null;
  unit: "tokens" | "usd";
}

/**
 * A quota window as *reported by the provider*, e.g. Anthropic's own "5-hour
 * 62% used, resets at T". Unlike WindowStatus this is a measurement, not an
 * inference from local logs: it covers every device on the account and uses
 * the provider's own counting rule. A separate type on purpose, so the UI can
 * never present one as the other.
 */
export interface QuotaWindow {
  /** Provider's key for the window, e.g. "five_hour", "seven_day". */
  id: string;
  label: string;
  provider: "anthropic";
  /** 0..1 used, as the provider reports it. */
  fraction: number;
  resetsAt: string | null;
  /** When we fetched it; exact as of this instant only. */
  measuredAt: string;
}

/** Health of an optional provider-account connection. Never carries a token. */
export interface AccountStatus {
  provider: "anthropic";
  enabled: boolean;
  /** Where a credential was found. */
  credential: "keychain" | "file" | "none";
  token: "ok" | "expired" | "missing";
  subscription: string | null;
  lastFetch: string | null;
  lastError: string | null;
  quota: QuotaWindow[];
}
