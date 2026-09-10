#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { exec } from "node:child_process";
import { Collector } from "./collector.js";
import { createApp } from "./app.js";
import { buildAgentSnapshots, loadConfig, saveConfig, configPath } from "@ai-usage-widget/core";
import { AnthropicAccount, credentialsFilePath } from "./providers/anthropic-account.js";

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
      const acct = collector.config.providers.anthropicAccount;
      if (acct.enabled) {
        const s = await collector.account.refresh();
        console.log(`${s.token === "ok" && !s.lastError ? "✔" : "✘"} claude account  ${describeAccount(s)}`);
      } else {
        console.log(`· claude account  off (run \`ai-usage-widget connect claude\` to show real quota)`);
      }
      collector.stop();
      break;
    }
    case "connect": {
      // `connect claude`: reuse Claude Code's login to read the account's real
      // quota. One test fetch first, so the config is only switched on when it
      // actually works. Prints percentages, never the token.
      if (rest[0] !== "claude") return usage();
      const cfg = loadConfig();
      const acct = new AnthropicAccount({ ...cfg.providers.anthropicAccount, enabled: true });
      const s = await acct.refresh();
      if (s.token === "missing") {
        console.error(`✘ No Claude Code login found (looked in the macOS Keychain "Claude Code-credentials" and ${credentialsFilePath()}).`);
        console.error(`  Run \`claude\`, sign in, then try again.`);
        process.exit(1);
      }
      if (s.token === "expired") {
        console.error(`✘ ${s.lastError}`);
        process.exit(1);
      }
      if (s.lastError) {
        console.error(`✘ ${s.lastError}`);
        process.exit(1);
      }
      cfg.providers.anthropicAccount.enabled = true;
      saveConfig(cfg);
      console.log(`✔ Connected to your Claude account via Claude Code's login (${s.credential}${s.subscription ? `, ${s.subscription} plan` : ""}).`);
      for (const w of s.quota) {
        console.log(`  ${w.label.padEnd(24)} ${Math.round(w.fraction * 100)}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ""}`);
      }
      console.log(`\nSaved to ${configPath()}. The collector polls every ${cfg.providers.anthropicAccount.pollSeconds}s; restart \`serve\` (or the menu bar app) to pick it up.`);
      console.log(`Undo with \`ai-usage-widget disconnect claude\`.`);
      break;
    }
    case "disconnect": {
      if (rest[0] !== "claude") return usage();
      const cfg = loadConfig();
      cfg.providers.anthropicAccount.enabled = false;
      saveConfig(cfg);
      console.log(`✔ Claude account link off. Nothing was stored; the widget is back to local estimates.`);
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
  console.error(`Usage: ai-usage-widget [serve|backfill|doctor|agents|connect claude|disconnect claude] [--port=4321] [--no-open]`);
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
