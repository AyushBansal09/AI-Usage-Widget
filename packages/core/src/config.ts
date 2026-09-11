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
  /**
   * Bring your own tool, with no code: point at its log files and say where
   * the fields are. Each entry becomes its own source in the dashboard.
   */
  customSources: z
    .array(
      z.object({
        /** Becomes UsageEvent.source. */
        name: z.string().min(1),
        provider: z.enum(["anthropic", "openai", "google", "other"]).default("other"),
        /** Glob over the tool's logs; `~` is expanded, `**` crosses directories. */
        files: z.string().min(1),
        format: z.enum(["jsonl", "json"]).default("jsonl"),
        /** For `json`: dotted path to the array of records inside the file. */
        recordsAt: z.string().optional(),
        /** Keep a record only if every path matches (`true` = just be present). */
        where: z.record(z.unknown()).optional(),
        /** Event field -> dotted path in the record. `timestamp` is required. */
        map: z.record(z.string()).refine((m) => typeof m.timestamp === "string" && m.timestamp.length > 0, {
          message: "customSources[].map.timestamp is required — without a time an event cannot be placed in any window",
        }),
        /** Static fallbacks used only where the log is silent, e.g. { model: "gpt-4o" }. */
        defaults: z.record(z.union([z.string(), z.number()])).optional(),
        pollMs: z.number().int().min(500).default(5000),
      }),
    )
    .default([]),
  /**
   * Adapter plugins: npm package names or paths to a local .mjs/.js file.
   * Each must export (default) an Adapter object, or a factory returning one.
   * A plugin that fails to load is reported and skipped, never fatal.
   */
  plugins: z.array(z.string().min(1)).default([]),
  /**
   * Optional provider-account connections. Off by default: the only network
   * call the collector makes is one the user switched on (`connect claude`).
   */
  providers: z
    .object({
      /**
       * Reuse Claude Code's own login (its OAuth token in the macOS Keychain or
       * ~/.claude/.credentials.json) to read the account's real rolling-window
       * usage from Anthropic. Read-only: the token is never refreshed or
       * written, so Claude Code's login cannot be disturbed.
       */
      anthropicAccount: z
        .object({
          enabled: z.boolean().default(false),
          pollSeconds: z.number().int().min(30).default(120),
        })
        .default({}),
      /**
       * Reuse Cursor's own login (the access token in its state.vscdb) to read
       * the plan's request quota from cursor.com. Same rules: read-only,
       * never refreshed, off until `connect cursor`.
       */
      cursorAccount: z
        .object({
          enabled: z.boolean().default(false),
          pollSeconds: z.number().int().min(60).default(600),
        })
        .default({}),
      /**
       * ChatGPT/Codex plan windows, read from Codex CLI's own rollout logs
       * (they carry `rate_limits`). No network call, so on by default; the
       * numbers are as fresh as the last Codex turn and labelled with it.
       */
      codexAccount: z
        .object({
          enabled: z.boolean().default(true),
          pollSeconds: z.number().int().min(10).default(30),
        })
        .default({}),
    })
    .default({}),
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

export function configPath(): string {
  return join(dataDir(), "config.json");
}

/** Validate and persist. */
export function saveConfig(cfg: Config): void {
  writeFileSync(configPath(), JSON.stringify(ConfigSchema.parse(cfg), null, 2) + "\n");
}

export function dbPath(): string {
  return join(dataDir(), "events.sqlite");
}
