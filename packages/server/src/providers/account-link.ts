import type { AccountStatus } from "@ai-usage-widget/core";

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
