#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { exec } from "node:child_process";
import { Collector } from "./collector.js";
import { createApp } from "./app.js";
import { buildAgentSnapshots } from "@ai-usage-widget/core";

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
      collector.stop();
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
      console.error(`Usage: ai-usage-widget [serve|backfill|doctor|agents] [--port=4321] [--no-open]`);
      process.exit(1);
  }
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} ${url}`, () => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
