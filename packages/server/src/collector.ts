import { EventStore, PricingTable, dbPath, loadConfig, type Adapter, type Config, type AdapterDetection } from "@ai-usage-widget/core";
import { ClaudeCodeAdapter } from "@ai-usage-widget/adapter-claude-code";
import { CodexAdapter } from "@ai-usage-widget/adapter-codex";
import { CursorAdapter } from "@ai-usage-widget/adapter-cursor";
import { AnthropicAccount } from "./providers/anthropic-account.js";
import { CursorAccount } from "./providers/cursor-account.js";
import type { AccountLink } from "./providers/account-link.js";
import type { AccountStatus, QuotaWindow } from "@ai-usage-widget/core";

export interface SourceStatus extends AdapterDetection {
  name: string;
  events: number;
}

/**
 * Wires adapters to the store. Backfills once, then tails. The dashboard
 * server reads from the same store and subscribes to store.onEvent.
 */
export class Collector {
  readonly config: Config;
  readonly store: EventStore;
  readonly adapters: Adapter[];
  /** Optional, opt-in provider-account links (real quota, not estimates). */
  readonly accounts: AccountLink[];
  private stops: Array<() => void> = [];
  private detections = new Map<string, AdapterDetection>();

  constructor(opts: { config?: Config; storePath?: string; adapters?: Adapter[] } = {}) {
    this.config = opts.config ?? loadConfig();
    this.accounts = [
      new AnthropicAccount(this.config.providers.anthropicAccount),
      new CursorAccount(this.config.providers.cursorAccount),
    ];
    this.store = new EventStore(opts.storePath ?? dbPath(), new PricingTable(this.config.pricing));
    this.adapters = opts.adapters ?? [
      new ClaudeCodeAdapter({
        ...(this.config.adapters["claude-code"] as any),
        state: {
          get: (k) => this.store.getState("claude-code", k),
          set: (k, v) => this.store.setState("claude-code", k, v),
        },
      }),
      new CodexAdapter(this.config.adapters["codex"] as any),
      new CursorAdapter(this.config.adapters["cursor"] as any),
    ];
  }

  async start(opts: { watch?: boolean } = { watch: true }) {
    for (const a of this.adapters) {
      const det = await a.detect();
      this.detections.set(a.name, det);
      if (!det.available) continue;
      const emit = (e: any) => {
        try {
          this.store.ingest(e);
        } catch (err) {
          console.error(`[${a.name}] bad event`, err);
        }
      };
      const t0 = Date.now();
      await a.backfill(emit);
      console.error(`[${a.name}] backfill done in ${Date.now() - t0}ms from ${det.location}`);
      if (opts.watch) this.stops.push(await a.watch(emit));
    }
    if (opts.watch) {
      for (const a of this.accounts) {
        a.start();
        this.stops.push(() => a.stop());
      }
    }
  }

  account(provider: string): AccountLink | undefined {
    return this.accounts.find((a) => a.provider === provider);
  }

  accountStatuses(): AccountStatus[] {
    return this.accounts.map((a) => a.status);
  }

  /** Every measured window from every enabled link, Anthropic's 5h first. */
  quota(): QuotaWindow[] {
    const all = this.accounts.flatMap((a) => a.status.quota);
    const rank = (q: QuotaWindow) => (q.provider === "anthropic" && q.id === "five_hour" ? 0 : q.provider === "anthropic" ? 1 : 2);
    return all.sort((a, b) => rank(a) - rank(b));
  }

  /** The window the tray title is built from, when any link is on. */
  primaryQuota(): QuotaWindow | null {
    return this.quota()[0] ?? null;
  }

  sources(): SourceStatus[] {
    return this.adapters.map((a) => {
      const det = this.detections.get(a.name) ?? { available: false };
      const n = (this.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = ?").get(a.name) as any).n as number;
      return { name: a.name, events: n, ...det };
    });
  }

  stop() {
    for (const s of this.stops) s();
    this.store.close();
  }
}
