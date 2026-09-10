import Database from "better-sqlite3";
import { UsageEventSchema, type UsageEvent, type UsageEventInput, type TokenTotals } from "./types.js";
import type { PricingTable } from "./pricing.js";

/**
 * SQLite-backed event store. Single table, append-only, idempotent on
 * event id. Everything the dashboard shows is a query over this table, so
 * the whole history is inspectable with any SQLite client.
 */
export class EventStore {
  readonly db: Database.Database;
  private insertStmt: Database.Statement;
  private listeners = new Set<(e: UsageEvent) => void>();

  constructor(path: string, private pricing: PricingTable) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
    this.insertStmt = this.db.prepare(`
      INSERT INTO events (
        id, source, provider, model, ts, session_id, agent_id, parent_agent_id, project,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        cost_usd, tool_calls, activity, meta
      ) VALUES (
        @id, @source, @provider, @model, @ts, @sessionId, @agentId, @parentAgentId, @project,
        @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @reasoningTokens,
        @costUsd, @toolCalls, @activity, @meta
      )
      ON CONFLICT(id) DO UPDATE SET
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cost_usd = excluded.cost_usd,
        tool_calls = excluded.tool_calls,
        activity = excluded.activity,
        meta = excluded.meta
      WHERE excluded.output_tokens != events.output_tokens
         OR excluded.tool_calls != events.tool_calls
         OR COALESCE(excluded.activity,'') != COALESCE(events.activity,'')
    `);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        ts TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        parent_agent_id TEXT,
        project TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        tool_calls TEXT NOT NULL DEFAULT '[]',
        activity TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE INDEX IF NOT EXISTS events_session ON events (source, session_id, agent_id, ts);
      CREATE TABLE IF NOT EXISTS adapter_state (
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (source, key)
      );
    `);
  }

  /** Validates, prices, and inserts. Returns the stored event, or null if it was a duplicate. */
  ingest(input: UsageEventInput): UsageEvent | null {
    const parsed = UsageEventSchema.parse(input);
    if (parsed.costUsd === null) {
      parsed.costUsd = this.pricing.cost(parsed.model, parsed);
    }
    const res = this.insertStmt.run({
      ...parsed,
      ts: parsed.timestamp,
      parentAgentId: parsed.parentAgentId ?? null,
      project: parsed.project ?? null,
      activity: parsed.activity ?? null,
      toolCalls: JSON.stringify(parsed.toolCalls),
      meta: parsed.meta ? JSON.stringify(parsed.meta) : null,
    });
    if (res.changes === 0) return null;
    for (const l of this.listeners) l(parsed);
    return parsed;
  }

  ingestMany(inputs: UsageEventInput[]): number {
    const tx = this.db.transaction((rows: UsageEventInput[]) => {
      let n = 0;
      for (const r of rows) if (this.ingest(r)) n++;
      return n;
    });
    return tx(inputs);
  }

  onEvent(fn: (e: UsageEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Adapters can persist cursors (file offsets etc.) here. */
  getState(source: string, key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM adapter_state WHERE source = ? AND key = ?")
      .get(source, key) as { value: string } | undefined;
    return row?.value;
  }

  setState(source: string, key: string, value: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO adapter_state (source, key, value) VALUES (?, ?, ?)")
      .run(source, key, value);
  }

  events(opts: { since?: string; until?: string; source?: string; limit?: number } = {}): UsageEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.since) { where.push("ts >= ?"); params.push(opts.since); }
    if (opts.until) { where.push("ts < ?"); params.push(opts.until); }
    if (opts.source) { where.push("source = ?"); params.push(opts.source); }
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts ASC ${opts.limit ? "LIMIT " + Number(opts.limit) : ""}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToEvent);
  }

  totals(opts: { since?: string; until?: string; source?: string } = {}): TokenTotals {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.since) { where.push("ts >= ?"); params.push(opts.since); }
    if (opts.until) { where.push("ts < ?"); params.push(opts.until); }
    if (opts.source) { where.push("source = ?"); params.push(opts.source); }
    const row = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(input_tokens),0) AS inputTokens,
          COALESCE(SUM(output_tokens),0) AS outputTokens,
          COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
          COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
          COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
          COALESCE(SUM(cost_usd),0) AS costUsd,
          COUNT(*) AS events,
          SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedEvents
         FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
      )
      .get(...params) as TokenTotals;
    return row;
  }

  close() {
    this.db.close();
  }
}

interface Row {
  id: string; source: string; provider: UsageEvent["provider"]; model: string; ts: string;
  session_id: string; agent_id: string; parent_agent_id: string | null; project: string | null;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  reasoning_tokens: number; cost_usd: number | null; tool_calls: string; activity: string | null; meta: string | null;
}

function rowToEvent(r: Row): UsageEvent {
  return {
    id: r.id,
    source: r.source,
    provider: r.provider,
    model: r.model,
    timestamp: r.ts,
    sessionId: r.session_id,
    agentId: r.agent_id,
    parentAgentId: r.parent_agent_id ?? undefined,
    project: r.project ?? undefined,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
    costUsd: r.cost_usd,
    toolCalls: JSON.parse(r.tool_calls),
    activity: r.activity ?? undefined,
    meta: r.meta ? JSON.parse(r.meta) : undefined,
  };
}
