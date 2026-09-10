/**
 * Model pricing, USD per 1M tokens.
 *
 * This is a SEED table so the dashboard works offline out of the box. Prices
 * drift, and new models appear monthly, so the plan is:
 *   1. seed table (here) ->
 *   2. overridden by `~/.ai-usage-widget/pricing.json` if present ->
 *   3. optionally refreshed from LiteLLM's public pricing JSON (`pnpm pricing:sync`).
 * Unknown models are NOT priced at $0; they come back as null so the UI can
 * show "unpriced" honestly. Verify these numbers against the vendors' pages
 * before relying on the dollar figures.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** Defaults to input * 1.25 (Anthropic) or input (OpenAI) when omitted. */
  cacheWrite?: number;
  /** Defaults to input * 0.1 when omitted. */
  cacheRead?: number;
}

/** Longest-prefix / substring match, checked in order. */
const SEED: Array<[pattern: RegExp, price: ModelPrice]> = [
  // Anthropic
  [/claude-opus-4-5/, { input: 5, output: 25 }],
  [/claude-opus-4/, { input: 15, output: 75 }],
  [/claude-sonnet-4/, { input: 3, output: 15 }],
  [/claude-haiku-4/, { input: 1, output: 5 }],
  [/claude-3-5-haiku/, { input: 0.8, output: 4 }],
  // OpenAI (cached input is ~10% of input on current models)
  [/gpt-5-mini/, { input: 0.25, output: 2, cacheRead: 0.025 }],
  [/gpt-5-nano/, { input: 0.05, output: 0.4, cacheRead: 0.005 }],
  [/gpt-5/, { input: 1.25, output: 10, cacheRead: 0.125 }],
  [/gpt-4\.1-mini/, { input: 0.4, output: 1.6, cacheRead: 0.1 }],
  [/gpt-4\.1/, { input: 2, output: 8, cacheRead: 0.5 }],
  [/^o3-mini|^o4-mini/, { input: 1.1, output: 4.4, cacheRead: 0.275 }],
  [/^o3/, { input: 2, output: 8, cacheRead: 0.5 }],
  // Google
  [/gemini-2\.5-pro/, { input: 1.25, output: 10, cacheRead: 0.31 }],
  [/gemini-2\.5-flash/, { input: 0.3, output: 2.5, cacheRead: 0.075 }],
];

export class PricingTable {
  private overrides: Array<[RegExp, ModelPrice]> = [];

  constructor(overrides?: Record<string, ModelPrice>) {
    if (overrides) {
      for (const [pattern, price] of Object.entries(overrides)) {
        this.overrides.push([new RegExp(pattern), price]);
      }
    }
  }

  lookup(model: string): ModelPrice | null {
    const m = model.toLowerCase();
    for (const [re, price] of this.overrides) if (re.test(m)) return price;
    for (const [re, price] of SEED) if (re.test(m)) return price;
    return null;
  }

  /** Returns null when the model is unknown. */
  cost(
    model: string,
    tokens: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
  ): number | null {
    const p = this.lookup(model);
    if (!p) return null;
    const isAnthropic = model.toLowerCase().includes("claude");
    const cacheWrite = p.cacheWrite ?? (isAnthropic ? p.input * 1.25 : p.input);
    const cacheRead = p.cacheRead ?? p.input * 0.1;
    const usd =
      (tokens.inputTokens * p.input +
        tokens.outputTokens * p.output +
        (tokens.cacheReadTokens ?? 0) * cacheRead +
        (tokens.cacheWriteTokens ?? 0) * cacheWrite) /
      1_000_000;
    return Math.round(usd * 1e6) / 1e6;
  }
}

export function providerForModel(model: string): "anthropic" | "openai" | "google" | "other" {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (/^(gpt|o\d|codex|chatgpt|text-)/.test(m)) return "openai";
  if (m.includes("gemini")) return "google";
  return "other";
}
