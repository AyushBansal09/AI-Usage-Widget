import { EventStore, PricingTable, dbPath, loadConfig, type Adapter, type Config, type AdapterDetection } from "@ai-usage-widget/core";
import { ClaudeCodeAdapter } from "@ai-usage-widget/adapter-claude-code";
import { CodexAdapter } from "@ai-usage-widget/adapter-codex";
import { AnthropicAccount } from "./providers/anthropic-account.js";

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
  /** Optional, opt-in: the account's real quota from Anthropic. */
  readonly account: AnthropicAccount;
  private stops: Array<() => void> = [];
  private detections = new Map<string, AdapterDetection>();

  constructor(opts: { config?: Config; storePath?: string; adapters?: Adapter[] } = {}) {
    this.config = opts.config ?? loadConfig();
    this.account = new AnthropicAccount(this.config.providers.anthropicAccount);
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
      this.account.start();
      this.stops.push(() => this.account.stop());
    }
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
