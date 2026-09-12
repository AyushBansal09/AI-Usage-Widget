import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AccountStatus, QuotaAmount, QuotaWindow } from "@ai-usage-widget/core";
import { seedStatus, type AccountLink } from "./account-link.js";

/**
 * Reads the account's real rolling-window usage from Anthropic, using the
 * login Claude Code already has on this machine.
 *
 * Boundaries, in order of importance:
 * - Opt-in. Nothing here runs unless `providers.anthropicAccount.enabled`.
 * - Read-only on the credential. We read Claude Code's access token and use
 *   it as-is; we never call the token-refresh endpoint (refresh tokens rotate,
 *   and rotating one under Claude Code would log it out). If the token has
 *   expired we say so and fall back to the local estimate until the user runs
 *   `claude` again, which refreshes it.
 * - The token never leaves this process except in the Authorization header
 *   to api.anthropic.com, and never appears in logs, status, or the API.
 * - The response is a measurement of the whole account (all devices), which
 *   is why it is exposed as QuotaWindow, not merged into the local estimates.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Claude Code sends this beta header on its OAuth calls; the endpoint 401s without it. */
const OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Keys we understand. Anything else in the response is kept out of the UI:
 * a real account answers with keys like `nimbus_quill` (0%, no reset) whose
 * meaning we do not know, and "nimbus quill 100% left" in a widget would be
 * noise dressed up as information.
 */
const LABELS: Record<string, string> = {
  five_hour: "Claude 5-hour window",
  seven_day: "Claude weekly cap",
  seven_day_opus: "Claude weekly (Opus)",
  seven_day_sonnet: "Claude weekly (Sonnet)",
  /** Share of the pay-as-you-go extra-usage cap spent; not a rolling window. */
  extra_usage: "Extra usage (spend cap)",
};

const execFileP = promisify(execFile);

export interface Credential {
  accessToken: string;
  /** ms since epoch, or null if the file did not say. */
  expiresAt: number | null;
  subscription: string | null;
  from: "keychain" | "file";
}

/** Claude Code stores `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, subscriptionType, ... } }`. */
export function parseCredentialJson(raw: string, from: Credential["from"]): Credential | null {
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  const o = j?.claudeAiOauth ?? j;
  if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null;
  const exp = typeof o.expiresAt === "number" ? o.expiresAt : Number.isFinite(Date.parse(o.expiresAt)) ? Date.parse(o.expiresAt) : null;
  return {
    accessToken: o.accessToken,
    // Claude Code writes ms; tolerate seconds just in case.
    expiresAt: exp !== null && exp < 1e12 ? exp * 1000 : exp,
    subscription: typeof o.subscriptionType === "string" ? o.subscriptionType : null,
    from,
  };
}

export function credentialsFilePath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
}

/** File first (Linux, and macOS installs that opted out of Keychain), then Keychain. */
export async function readCredential(): Promise<Credential | null> {
  const file = credentialsFilePath();
  if (existsSync(file)) {
    const c = parseCredentialJson(readFileSync(file, "utf8"), "file");
    if (c) return c;
  }
  if (process.platform === "darwin") {
    try {
      // `-w` prints only the secret. macOS may show a one-time "node wants to
      // use your confidential information" prompt; Always Allow is safe here.
      const { stdout } = await execFileP("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { timeout: 10_000 });
      const c = parseCredentialJson(stdout.trim(), "keychain");
      if (c) return c;
    } catch {
      /* not present, or user denied the prompt */
    }
  }
  return null;
}

/**
 * The usage endpoint answers with one object per window, e.g.
 * `{ five_hour: { utilization: 62, resets_at: "..." }, seven_day: {...}, ... }`.
 * Parsed defensively: a top-level object with a numeric `utilization` and a
 * key we have a label for becomes a window; anything else is ignored, so new
 * keys on Anthropic's side neither break us nor get invented meanings.
 */
export function parseUsageResponse(body: unknown, now: Date = new Date()): QuotaWindow[] {
  if (!body || typeof body !== "object") return [];
  const out: QuotaWindow[] = [];
  for (const [key, v] of Object.entries(body as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || !(key in LABELS)) continue;
    const u = (v as any).utilization;
    if (typeof u !== "number" || !Number.isFinite(u)) continue;
    // Percent (0..100) in observed responses; accept a 0..1 ratio too.
    const fraction = Math.max(0, Math.min(1, u > 1 ? u / 100 : u));
    const r = (v as any).resets_at ?? (v as any).resetsAt ?? null;
    const resetsAt = typeof r === "string" && Number.isFinite(Date.parse(r)) ? new Date(r).toISOString() : null;
    const amount = key === "extra_usage" ? spendAmount(v, (body as any).spend) : undefined;
    out.push({
      id: key,
      label: LABELS[key]!,
      provider: "anthropic",
      fraction,
      resetsAt,
      measuredAt: now.toISOString(),
      ...(amount ? { amount } : {}),
    });
  }
  // Stable order: 5h first, then weekly, then the rest as sent.
  const rank = (id: string) => (id === "five_hour" ? 0 : id === "seven_day" ? 1 : 2);
  return out.sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Real money behind the extra-usage percentage.
 *
 * Anthropic reports it twice and in minor units: `extra_usage`
 * ({used_credits, monthly_limit, decimal_places, currency}) and `spend`
 * ({used,limit}.{amount_minor, exponent, currency}). Either is enough;
 * `extra_usage` is preferred because it is the object the percentage came
 * from, so the two can never disagree. Returns undefined rather than
 * guessing when neither carries usable numbers.
 */
export function spendAmount(extraUsage: any, spend?: any): QuotaAmount | undefined {
  const scale = (minor: unknown, places: unknown): number | null =>
    typeof minor === "number" && Number.isFinite(minor) ? minor / 10 ** (typeof places === "number" ? places : 2) : null;

  const used = scale(extraUsage?.used_credits, extraUsage?.decimal_places) ?? scale(spend?.used?.amount_minor, spend?.used?.exponent);
  if (used === null) return undefined;
  const limit = scale(extraUsage?.monthly_limit, extraUsage?.decimal_places) ?? scale(spend?.limit?.amount_minor, spend?.limit?.exponent);
  const currency = typeof extraUsage?.currency === "string" ? extraUsage.currency : typeof spend?.used?.currency === "string" ? spend.used.currency : undefined;
  return { used, limit: limit !== null && limit > 0 ? limit : null, unit: "usd", ...(currency ? { currency } : {}) };
}

export interface AnthropicAccountOptions {
  enabled: boolean;
  pollSeconds: number;
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  readCredential?: () => Promise<Credential | null>;
  now?: () => Date;
}

export class AnthropicAccount implements AccountLink {
  readonly provider = "anthropic";
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: Required<AnthropicAccountOptions>;
  status: AccountStatus;
  /** Last response body, in memory only, for `connect claude --raw` (fixture capture). Token-free by nature. */
  lastRaw: unknown = null;
  /** Epoch ms before which we must not call the endpoint again (HTTP 429). */
  private retryAfter = 0;
  private listeners = new Set<(s: AccountStatus) => void>();

  constructor(opts: AnthropicAccountOptions) {
    this.opts = {
      fetchImpl: fetch,
      readCredential,
      now: () => new Date(),
      ...opts,
    };
    this.status = {
      provider: "anthropic",
      enabled: opts.enabled,
      credential: "none",
      token: "missing",
      subscription: null,
      lastFetch: null,
      lastError: null,
      quota: [],
    };
  }

  seed(quota: QuotaWindow[], lastFetch: string | null): void {
    this.status = seedStatus(this.status, quota, lastFetch);
  }

  onChange(fn: (s: AccountStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (!this.opts.enabled || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.pollSeconds * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One fetch. Never throws; the outcome lands in `status`. */
  async refresh(): Promise<AccountStatus> {
    const now = this.opts.now();
    if (this.retryAfter && now.getTime() < this.retryAfter) return this.status;
    const cred = await this.opts.readCredential();
    if (!cred) {
      this.set({ credential: "none", token: "missing", subscription: null, lastError: "No Claude Code login found. Run `claude` and sign in." });
      return this.status;
    }
    if (cred.expiresAt !== null && cred.expiresAt <= now.getTime()) {
      // Keep the last good quota so the UI degrades to "stale", not "gone".
      this.set({ credential: cred.from, token: "expired", subscription: cred.subscription, lastError: "Claude Code's login token has expired. Open `claude` once to refresh it." });
      return this.status;
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await this.opts.fetchImpl(USAGE_URL, {
        headers: {
          authorization: `Bearer ${cred.accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
          "user-agent": "ai-usage-widget",
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 429) {
        // Back off rather than hammering: honour Retry-After when given,
        // otherwise wait a few polls. The last good quota stays on screen.
        const after = Number(res.headers.get("retry-after"));
        this.retryAfter = now.getTime() + (Number.isFinite(after) && after > 0 ? after * 1000 : 10 * 60_000);
        this.set({ credential: cred.from, token: "ok", subscription: cred.subscription, lastError: `Anthropic rate-limited the usage endpoint; retrying after ${new Date(this.retryAfter).toISOString()}.` });
        return this.status;
      }
      if (res.status === 401 || res.status === 403) {
        this.set({ credential: cred.from, token: "expired", subscription: cred.subscription, lastError: `Anthropic rejected the token (HTTP ${res.status}). Open \`claude\` once to refresh it.` });
        return this.status;
      }
      if (!res.ok) {
        this.set({ credential: cred.from, token: "ok", subscription: cred.subscription, lastError: `Usage endpoint returned HTTP ${res.status}.` });
        return this.status;
      }
      const body = await res.json();
      this.lastRaw = body;
      const quota = parseUsageResponse(body, now);
      this.retryAfter = 0;
      this.set({
        credential: cred.from, token: "ok", subscription: cred.subscription,
        lastFetch: now.toISOString(), lastError: quota.length ? null : "Usage endpoint answered, but with no windows we recognise.",
        quota: quota.length ? quota : this.status.quota,
      });
    } catch (e: any) {
      this.set({ credential: cred.from, token: "ok", subscription: cred.subscription, lastError: e?.name === "AbortError" ? "Timed out talking to api.anthropic.com." : String(e?.message ?? e) });
    }
    return this.status;
  }

  private set(patch: Partial<AccountStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }
}
