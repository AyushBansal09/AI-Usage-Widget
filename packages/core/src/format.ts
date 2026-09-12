import type { QuotaAmount } from "./types.js";

/**
 * How a spend/request amount is written wherever it appears (tray tooltip,
 * popover, dashboard). One implementation so the surfaces cannot disagree
 * about the user's money.
 */
export function formatQuotaAmount(a: QuotaAmount | undefined): string | null {
  if (!a) return null;
  const fmt = a.unit === "usd" ? (n: number) => money(n, a.currency) : (n: number) => n.toLocaleString("en-US");
  const noun = a.unit === "requests" ? " requests" : "";
  return a.limit === null ? `${fmt(a.used)}${noun} used` : `${fmt(a.used)} of ${fmt(a.limit)}${noun}`;
}

function money(n: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    // An unknown ISO code must not break a tray title.
    return `${n.toFixed(2)} ${currency}`;
  }
}
