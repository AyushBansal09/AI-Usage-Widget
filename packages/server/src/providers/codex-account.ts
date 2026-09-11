import type { AccountStatus, QuotaWindow } from "@ai-usage-widget/core";
import type { CodexRateLimits } from "@ai-usage-widget/adapter-codex";
import { emptyStatus, Poller, type AccountLink } from "./account-link.js";

/**
 * The ChatGPT account's Codex quota — with no network call at all. Codex CLI
 * writes its `rate_limits` (plan windows with used_percent and resets_at)
 * into every rollout, so the adapter already has the latest snapshot; this
 * link just turns it into QuotaWindows.
 *
 * Because the number is only as fresh as the last Codex turn, `measuredAt`
 * is the rollout line's timestamp, not "now": the widget shows "OpenAI ·
 * 13:32" and the reader can see it is from the last time Codex ran.
 */

export interface CodexAccountOptions {
  enabled: boolean;
  pollSeconds: number;
  /** The adapter's latest snapshot; injected so the link is testable. */
  source: () => CodexRateLimits | null;
  now?: () => Date;
}

function windowLabel(id: "primary" | "secondary", minutes: number | null): string {
  if (minutes === 300) return "ChatGPT Codex 5-hour window";
  if (minutes === 10080) return "ChatGPT Codex weekly cap";
  if (minutes === 43200) return "ChatGPT Codex 30-day window";
  if (minutes && minutes % 1440 === 0) return `ChatGPT Codex ${minutes / 1440}-day window`;
  if (minutes && minutes % 60 === 0) return `ChatGPT Codex ${minutes / 60}-hour window`;
  return id === "primary" ? "ChatGPT Codex window" : "ChatGPT Codex secondary window";
}

export function quotaFromRateLimits(rl: CodexRateLimits | null): QuotaWindow[] {
  if (!rl) return [];
  return rl.windows.map((w) => ({
    id: `codex_${w.id}`,
    label: windowLabel(w.id, w.windowMinutes),
    provider: "openai",
    fraction: Math.max(0, Math.min(1, w.usedPercent / 100)),
    resetsAt: w.resetsAt,
    measuredAt: rl.at,
  }));
}

export class CodexAccount implements AccountLink {
  readonly provider = "openai";
  status: AccountStatus;
  lastRaw: unknown = null;
  private readonly poller: Poller;

  constructor(private readonly opts: CodexAccountOptions) {
    this.status = emptyStatus("openai", opts.enabled);
    this.poller = new Poller(() => this.refresh(), opts.pollSeconds);
  }

  start(): void {
    if (this.opts.enabled) this.poller.start();
  }
  stop(): void {
    this.poller.stop();
  }

  async refresh(): Promise<AccountStatus> {
    const rl = this.opts.source();
    this.lastRaw = rl;
    if (!rl) {
      this.status = { ...this.status, credential: "none", token: "missing", subscription: null, lastError: "No Codex session yet. Run `codex login`, then any `codex` command." };
      return this.status;
    }
    const quota = quotaFromRateLimits(rl);
    this.status = {
      ...this.status,
      credential: "file",
      token: "ok",
      subscription: rl.planType,
      lastFetch: rl.at,
      lastError: quota.length ? null : "Codex logged usage but no rate-limit window.",
      quota,
    };
    return this.status;
  }
}
