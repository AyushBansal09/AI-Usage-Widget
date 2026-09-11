#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { exec } from "node:child_process";
import { Collector } from "./collector.js";
import { createApp } from "./app.js";
import { buildAgentSnapshots, loadConfig, saveConfig, configPath } from "@ai-usage-widget/core";
import { AnthropicAccount, credentialsFilePath } from "./providers/anthropic-account.js";
import { CursorAccount, defaultCursorDb } from "./providers/cursor-account.js";
import type { AccountLink } from "./providers/account-link.js";

/** `connect <name>` / `disconnect <name>`: how each link is built and where its login lives. */
const LINKS: Record<string, { key: "anthropicAccount" | "cursorAccount"; label: string; make: (o: { enabled: boolean; pollSeconds: number }) => AccountLink; where: () => string; signIn: string }> = {
  claude: {
    key: "anthropicAccount", label: "Claude account",
    make: (o) => new AnthropicAccount(o),
    where: () => `the macOS Keychain "Claude Code-credentials" or ${credentialsFilePath()}`,
    signIn: "Run `claude`, sign in, then try again.",
  },
  cursor: {
    key: "cursorAccount", label: "Cursor account",
    make: (o) => new CursorAccount(o),
    where: () => defaultCursorDb(),
    signIn: "Open Cursor, sign in, then try again.",
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(here, "..", "public");

const [cmd = "serve", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const portFlag = rest.find((a) => a.startsWith("--port="));

async function main() {
  switch (cmd) {
    case "serve": {
      const collector = new Collector();
      const port = portFlag ? Number(portFlag.split("=")[1]) : collector.config.port;
      await collector.start({ watch: true });
      const app = createApp(collector, WEB_DIR);
      serve({ fetch: app.fetch, port }, () => {
        const url = `http://localhost:${port}`;
        console.error(`ai-usage-widget dashboard: ${url}`);
        if (!flags.has("--no-open")) openBrowser(url);
      });
      process.on("SIGINT", () => { collector.stop(); process.exit(0); });
      break;
    }
    case "backfill": {
      const collector = new Collector();
      await collector.start({ watch: false });
      console.log(JSON.stringify(collector.sources(), null, 2));
      collector.stop();
      break;
    }
    case "doctor": {
      const collector = new Collector();
      for (const a of collector.adapters) {
        const d = await a.detect();
        console.log(`${d.available ? "✔" : "✘"} ${a.name}  ${d.location ?? ""} ${d.reason ?? ""}`);
      }
      for (const [name, link] of Object.entries(LINKS)) {
        const acct = collector.account(link.make({ enabled: false, pollSeconds: 60 }).provider);
        if (acct?.status.enabled) {
          const s = await acct.refresh();
          console.log(`${s.token === "ok" && !s.lastError ? "✔" : "✘"} ${name} account  ${describeAccount(s)}`);
        } else {
          console.log(`· ${name} account  off (run \`ai-usage-widget connect ${name}\` to show real quota)`);
        }
      }
      collector.stop();
      break;
    }
    case "connect": {
      // `connect claude|cursor`: reuse a login the user already has to read
      // the account's real quota. One test fetch first, so the config is only
      // switched on when it actually works. Prints percentages, never a token.
      const link = LINKS[rest[0] ?? ""];
      if (!link) return usage();
      const cfg = loadConfig();
      const acct = link.make({ ...cfg.providers[link.key], enabled: true });
      const s = await acct.refresh();
      if (s.token === "missing") {
        console.error(`✘ No ${link.label} login found (looked in ${link.where()}).`);
        console.error(`  ${link.signIn}`);
        process.exit(1);
      }
      if (s.token === "expired" || s.lastError) {
        console.error(`✘ ${s.lastError}`);
        if (flags.has("--raw") && acct.lastRaw) console.log(JSON.stringify(acct.lastRaw, null, 2));
        process.exit(1);
      }
      if (flags.has("--raw")) {
        // The response body as received. Contains usage only, never a token;
        // this is how test fixtures are captured.
        console.log(JSON.stringify(acct.lastRaw, null, 2));
      }
      cfg.providers[link.key].enabled = true;
      saveConfig(cfg);
      console.log(`✔ Connected to your ${link.label} via its existing login (${s.credential}${s.subscription ? `, ${s.subscription} plan` : ""}).`);
      for (const w of s.quota) {
        console.log(`  ${w.label.padEnd(26)} ${Math.round(w.fraction * 100)}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ""}`);
      }
      console.log(`\nSaved to ${configPath()}. The collector polls every ${cfg.providers[link.key].pollSeconds}s; restart \`serve\` (or the menu bar app) to pick it up.`);
      console.log(`Undo with \`ai-usage-widget disconnect ${rest[0]}\`.`);
      break;
    }
    case "disconnect": {
      const link = LINKS[rest[0] ?? ""];
      if (!link) return usage();
      const cfg = loadConfig();
      cfg.providers[link.key].enabled = false;
      saveConfig(cfg);
      console.log(`✔ ${link.label} link off. Nothing was stored; the widget is back to local estimates.`);
      break;
    }
    case "agents": {
      const collector = new Collector();
      await collector.start({ watch: false });
      const snaps = buildAgentSnapshots(collector.store.events({ since: new Date(Date.now() - 86400000).toISOString() }));
      for (const s of snaps) {
        console.log(`[${s.status}] ${s.source} ${s.sessionId.slice(0, 8)}/${s.agentId} ${s.model}  turns=${s.turns} out=${s.outputTokens} cacheRead=${s.cacheReadTokens} $${s.costUsd}${s.unpriced ? " (unpriced)" : ""}\n    ${s.lastActivity ?? ""}`);
      }
      collector.stop();
      break;
    }
    default:
      usage();
  }
}

function usage(): never {
  console.error(`Usage: ai-usage-widget [serve|backfill|doctor|agents|connect <claude|cursor>|disconnect <claude|cursor>] [--port=4321] [--no-open] [--raw]`);
  process.exit(1);
}

function describeAccount(s: { credential: string; token: string; subscription: string | null; lastError: string | null; quota: Array<{ label: string; fraction: number }> }): string {
  if (s.lastError) return s.lastError;
  const q = s.quota.map((w) => `${w.label} ${Math.round(w.fraction * 100)}%`).join(", ");
  return `${s.credential}${s.subscription ? ` (${s.subscription})` : ""}: ${q}`;
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} ${url}`, () => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
