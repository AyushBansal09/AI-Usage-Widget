import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountStatus, QuotaWindow } from "@ai-usage-widget/core";
import { emptyStatus, Poller, type AccountLink } from "./account-link.js";

/**
 * Cursor's plan quota (premium requests used / included) via the login
 * Cursor itself keeps in state.vscdb (`cursorAuth/accessToken`).
 *
 * Same boundaries as the Anthropic link: opt-in, read-only on the token, the
 * token only ever goes to cursor.com in a cookie, never into status or logs.
 * The endpoint is the one Cursor's own settings page calls; it is not a
 * published API, so the parser is defensive and `connect cursor --raw`
 * exists to capture the real shape when it drifts.
 */

const USAGE_URL = "https://cursor.com/api/usage";
const AUTH_URL = "https://cursor.com/api/auth/stripe";

export interface CursorCredential {
  accessToken: string;
  /** Cursor's user id from the JWT `sub` ("auth0|user_…" -> "user_…"). */
  userId: string;
  email: string | null;
  membership: string | null;
}

export function defaultCursorDb(): string {
  const home = homedir();
  const base =
    process.platform === "darwin" ? join(home, "Library", "Application Support", "Cursor", "User")
    : process.platform === "win32" ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User")
    : join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Cursor", "User");
  return join(base, "globalStorage", "state.vscdb");
}

/** Pull the id out of a JWT without verifying it; we only need `sub`. */
export function userIdFromJwt(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    if (!sub) return null;
    return sub.includes("|") ? sub.split("|").pop()! : sub;
  } catch {
    return null;
  }
}

export function readCursorCredential(dbPath = defaultCursorDb()): CursorCredential | null {
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/cachedEmail','cursorAuth/stripeMembershipType')").all() as Array<{ key: string; value: string | null }>;
    const get = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
    const accessToken = get("cursorAuth/accessToken");
    if (!accessToken) return null;
    const userId = userIdFromJwt(accessToken);
    if (!userId) return null;
    return { accessToken, userId, email: get("cursorAuth/cachedEmail"), membership: get("cursorAuth/stripeMembershipType") };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Observed shape (Cursor settings page):
 * `{ "gpt-4": { numRequests, numRequestsTotal, maxRequestUsage, numTokens, maxTokenUsage },
 *    "gpt-3.5-turbo": {...}, "gpt-4-32k": {...}, "startOfMonth": "2026-09-01T00:00:00.000Z" }`
 * "gpt-4" is the premium-request bucket regardless of the model actually used.
 * Only a bucket with a numeric `maxRequestUsage` becomes a window: without
 * a cap there is no honest fraction.
 */
export function parseCursorUsage(body: unknown, now: Date = new Date()): QuotaWindow[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, any>;
  const out: QuotaWindow[] = [];
  const start = typeof b.startOfMonth === "string" && Number.isFinite(Date.parse(b.startOfMonth)) ? new Date(b.startOfMonth) : null;
  const resetsAt = start ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes())).toISOString() : null;
  const premium = b["gpt-4"];
  if (premium && typeof premium === "object" && typeof premium.maxRequestUsage === "number" && premium.maxRequestUsage > 0) {
    const used = typeof premium.numRequests === "number" ? premium.numRequests : 0;
    out.push({
      id: "cursor_premium_requests",
      label: "Cursor premium requests",
      provider: "cursor",
      fraction: Math.max(0, Math.min(1, used / premium.maxRequestUsage)),
      resetsAt,
      measuredAt: now.toISOString(),
    });
  }
  return out;
}

export interface CursorAccountOptions {
  enabled: boolean;
  pollSeconds: number;
  fetchImpl?: typeof fetch;
  readCredential?: () => CursorCredential | null;
  now?: () => Date;
}

export class CursorAccount implements AccountLink {
  readonly provider = "cursor";
  status: AccountStatus;
  lastRaw: unknown = null;
  private readonly opts: Required<CursorAccountOptions>;
  private readonly poller: Poller;

  constructor(opts: CursorAccountOptions) {
    this.opts = { fetchImpl: fetch, readCredential: () => readCursorCredential(), now: () => new Date(), ...opts };
    this.status = emptyStatus("cursor", opts.enabled);
    this.poller = new Poller(() => this.refresh(), this.opts.pollSeconds);
  }

  start(): void {
    if (this.opts.enabled) this.poller.start();
  }
  stop(): void {
    this.poller.stop();
  }

  async refresh(): Promise<AccountStatus> {
    const now = this.opts.now();
    const cred = this.opts.readCredential();
    if (!cred) {
      this.set({ credential: "none", token: "missing", subscription: null, lastError: "No Cursor login found. Sign in to Cursor, then try again." });
      return this.status;
    }
    // Cursor's session cookie is "<userId>::<accessToken>", URL-encoded.
    const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${cred.userId}::${cred.accessToken}`)}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await this.opts.fetchImpl(`${USAGE_URL}?user=${encodeURIComponent(cred.userId)}`, {
        headers: { cookie, accept: "application/json", "user-agent": "ai-usage-widget" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 401 || res.status === 403) {
        this.set({ credential: "database", token: "expired", subscription: cred.membership, lastError: `Cursor rejected the login (HTTP ${res.status}). Open Cursor once to refresh it.` });
        return this.status;
      }
      if (!res.ok) {
        this.set({ credential: "database", token: "ok", subscription: cred.membership, lastError: `Cursor usage endpoint returned HTTP ${res.status}.` });
        return this.status;
      }
      const body = await res.json();
      this.lastRaw = body;
      const quota = parseCursorUsage(body, now);
      // Membership from the auth endpoint is nicer than the cached one, but optional.
      let subscription = cred.membership;
      try {
        const m = await this.opts.fetchImpl(AUTH_URL, { method: "POST", headers: { cookie, accept: "application/json", "user-agent": "ai-usage-widget" }, signal: AbortSignal.timeout(5000) });
        if (m.ok) {
          const j = await m.json();
          if (typeof j?.membershipType === "string") subscription = j.membershipType;
        }
      } catch { /* cosmetic */ }
      this.set({
        credential: "database", token: "ok", subscription, lastFetch: now.toISOString(),
        lastError: quota.length ? null : "Cursor answered, but without a request cap we can show; plan may be usage-based.",
        quota: quota.length ? quota : this.status.quota,
      });
    } catch (e: any) {
      this.set({ credential: "database", token: "ok", subscription: cred.membership, lastError: e?.name === "AbortError" || e?.name === "TimeoutError" ? "Timed out talking to cursor.com." : String(e?.message ?? e) });
    }
    return this.status;
  }

  private set(patch: Partial<AccountStatus>): void {
    this.status = { ...this.status, ...patch };
  }
}
