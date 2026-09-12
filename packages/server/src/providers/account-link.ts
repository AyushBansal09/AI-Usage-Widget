import type { AccountStatus, QuotaWindow } from "@ai-usage-widget/core";

/**
 * A provider-account connection: something that polls a provider for the
 * account's own quota using a login the user already has on this machine.
 * Implementations must be read-only on the credential and must never put
 * the token in `status`, logs or errors.
 */
export interface AccountLink {
  readonly provider: string;
  readonly status: AccountStatus;
  /** Last response body, in memory only, for `connect <x> --raw` fixture capture. */
  readonly lastRaw: unknown;
  start(): void;
  stop(): void;
  refresh(): Promise<AccountStatus>;
  /**
   * Restore the last quota this link saw in a previous run, so a restart does
   * not blank the numbers until the next successful poll — which can be a
   * long wait if the provider is rate-limiting us. Ignored once a live fetch
   * has produced anything; `measuredAt` still carries the original time, so a
   * stale figure stays visibly stale.
   */
  seed(quota: QuotaWindow[], lastFetch: string | null): void;
}

/** Default `seed` behaviour: fill in only while we have nothing live. */
export function seedStatus(status: AccountStatus, quota: QuotaWindow[], lastFetch: string | null): AccountStatus {
  if (status.quota.length > 0 || quota.length === 0) return status;
  return { ...status, quota, lastFetch: status.lastFetch ?? lastFetch };
}

export function emptyStatus(provider: string, enabled: boolean): AccountStatus {
  return { provider, enabled, credential: "none", token: "missing", subscription: null, lastFetch: null, lastError: null, quota: [] };
}

/** Shared polling loop so every link behaves the same way. */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly fn: () => Promise<unknown>, private readonly seconds: number) {}
  start(): void {
    if (this.timer) return;
    void this.fn();
    this.timer = setInterval(() => void this.fn(), this.seconds * 1000);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
