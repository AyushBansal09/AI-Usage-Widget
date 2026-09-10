import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const BudgetSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** What the budget counts. */
  unit: z.enum(["tokens", "usd"]).default("tokens"),
  /** Which sources count against it; empty = all. */
  sources: z.array(z.string()).default([]),
  period: z.enum(["day", "week", "month"]).default("day"),
  limit: z.number().positive(),
});

export const ConfigSchema = z.object({
  /** Port for the local dashboard. */
  port: z.number().int().default(4321),
  /**
   * Subscription-style rolling windows. Providers do not expose exact
   * remaining quota, so `limit` is the user's own estimate of their cap in
   * tokens. Leave null to only show usage + burn rate without a percentage.
   */
  windows: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        sources: z.array(z.string()).default([]),
        hours: z.number().positive(),
        limit: z.number().positive().nullable().default(null),
        /**
         * Which tokens count. Anthropic's plan limits are widely understood to
         * weigh all token kinds, but nobody outside Anthropic knows the exact
         * formula; "all" is the conservative default.
         */
        counting: z.enum(["all", "input+output", "output"]).default("all"),
      }),
    )
    .default([
      { id: "claude-5h", label: "Claude 5-hour window", sources: ["claude-code"], hours: 5, limit: null, counting: "all" },
      { id: "claude-7d", label: "Claude weekly cap", sources: ["claude-code"], hours: 24 * 7, limit: null, counting: "all" },
    ]),
  budgets: z.array(BudgetSchema).default([]),
  /** Pricing overrides: regex -> price per 1M tokens. */
  pricing: z
    .record(
      z.object({
        input: z.number(),
        output: z.number(),
        cacheWrite: z.number().optional(),
        cacheRead: z.number().optional(),
      }),
    )
    .default({}),
  /** Per-adapter settings; adapters read their own key. */
  adapters: z.record(z.record(z.unknown())).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function dataDir(): string {
  const dir = process.env.AI_USAGE_WIDGET_HOME ?? join(homedir(), ".ai-usage-widget");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(): Config {
  const file = join(dataDir(), "config.json");
  if (!existsSync(file)) {
    const cfg = ConfigSchema.parse({});
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    return cfg;
  }
  return ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function dbPath(): string {
  return join(dataDir(), "events.sqlite");
}
