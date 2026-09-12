import { EventStore, PricingTable, dbPath, loadConfig, type Adapter, type Config, type AdapterDetection } from "@ai-usage-widget/core";
import { ClaudeCodeAdapter } from "@ai-usage-widget/adapter-claude-code";
import { CodexAdapter } from "@ai-usage-widget/adapter-codex";
import { CursorAdapter } from "@ai-usage-widget/adapter-cursor";
import { CustomAdapter, type CustomSource } from "@ai-usage-widget/adapter-custom";
import { loadPlugins } from "./plugins.js";
import { AnthropicAccount } from "./providers/anthropic-account.js";
import { CursorAccount } from "./providers/cursor-account.js";
import { CodexAccount } from "./providers/codex-account.js";
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
  private pluginsLoaded = false;

  constructor(opts: { config?: Config; storePath?: string; adapters?: Adapter[] } = {}) {
    this.config = opts.config ?? loadConfig();
    this.store = new EventStore(opts.storePath ?? dbPath(), new PricingTable(this.config.pricing));
    const codex = new CodexAdapter(this.config.adapters["codex"] as any);
    this.adapters = opts.adapters ?? [
      new ClaudeCodeAdapter({
        ...(this.config.adapters["claude-code"] as any),
        state: {
          get: (k) => this.store.getState("claude-code", k),
          set: (k, v) => this.store.setState("claude-code", k, v),
        },
      }),
      codex,
      new CursorAdapter(this.config.adapters["cursor"] as any),
      // User-declared tools: no code, just a field map in config.json.
      ...this.config.customSources.map((s) => new CustomAdapter(s as CustomSource, s.pollMs)),
    ];
    // The Codex link reads the adapter's rate-limit snapshot; if a custom
    // adapter list was passed it may not include Codex, in which case the
    // link simply reports "no session".
    const codexInList = this.adapters.find((a): a is CodexAdapter => a instanceof CodexAdapter) ?? null;
    this.accounts = [
      new AnthropicAccount(this.config.providers.anthropicAccount),
      new CodexAccount({ ...this.config.providers.codexAccount, source: () => codexInList?.rateLimits() ?? null }),
      new CursorAccount(this.config.providers.cursorAccount),
    ];
  }

  /**
   * Load `config.plugins` into the adapter list. Idempotent, and separate
   * from start() so read-only commands like `doctor` list plugin adapters
   * too — a plugin the user installed should be as visible as a built-in.
   */
  async ensurePlugins(): Promise<void> {
    if (this.pluginsLoaded || this.config.plugins.length === 0) return;
    this.pluginsLoaded = true;
    const { adapters, errors } = await loadPlugins(this.config.plugins);
    for (const e of errors) console.error(`[plugin] ${e}`);
    this.adapters.push(...adapters);
  }

  async start(opts: { watch?: boolean } = { watch: true }) {
    await this.ensurePlugins();
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
    // Last known quota, so a restart shows your numbers immediately instead
    // of blanking until the next successful poll — which can be hours when a
    // provider is rate-limiting us. Stale figures keep their original
    // measuredAt, so the UI still shows how old they are.
    for (const a of this.accounts) this.restoreQuota(a);
    if (opts.watch) {
      for (const a of this.accounts) {
        a.start();
        this.stops.push(() => a.stop());
      }
      const save = setInterval(() => this.saveQuota(), 60_000);
      save.unref?.();
      this.stops.push(() => {
        clearInterval(save);
        this.saveQuota();
      });
    }
  }

  private quotaStateKey(provider: string): string {
    return `quota:${provider}`;
  }

  private restoreQuota(link: AccountLink): void {
    const raw = this.store.getState("account", this.quotaStateKey(link.provider));
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { quota?: QuotaWindow[]; lastFetch?: string | null };
      if (Array.isArray(saved.quota) && saved.quota.length) link.seed(saved.quota, saved.lastFetch ?? null);
    } catch {
      /* a corrupt cache is not worth a crash; the next poll replaces it */
    }
  }

  private saveQuota(): void {
    for (const a of this.accounts) {
      if (!a.status.quota.length) continue;
      this.store.setState("account", this.quotaStateKey(a.provider), JSON.stringify({ quota: a.status.quota, lastFetch: a.status.lastFetch }));
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

  /**
   * The window the tray title is built from.
   *
   * Not "the first provider": with several providers connected the number
   * that matters is the one that will stop work first, so the fullest window
   * wins. Picking by provider order once put Codex's untouched 30-day window
   * ("100% left") in the tray while Claude's 5-hour window was the real
   * constraint. Ties break toward Anthropic's 5-hour window. Callers must
   * show the window's label, since which provider wins can change.
   */
  primaryQuota(): QuotaWindow | null {
    const all = this.quota();
    if (all.length === 0) return null;
    return all.reduce((best, q) => (q.fraction > best.fraction ? q : best), all[0]!);
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
