# AI Usage Widget

A macOS menu bar widget (plus a local dashboard) for people who run AI coding
agents all day. The menu bar shows how much of your Claude window is left and
how many agents are active; click it for burn rate, time-to-exhaustion, and
what each agent is doing right now. Connect the tools you already use and see,
in one place:

- **Tokens left** — your Claude 5-hour and weekly windows (estimated from local
  logs, the same way `ccusage` does it), plus any daily/weekly/monthly budgets
  you set yourself, with burn rate and projected time-to-exhaustion.
- **What each agent is working on** — every session and subagent, live, with
  its last tool call or prompt, model, turns, and cost.
- **How efficiently tokens are being spent** — cache hit ratio, context growth
  per turn, thinking share, tokens per tool call. Every number is reproducible
  from the raw events.

Nothing leaves your machine. There are no accounts. The whole history is a
SQLite file you can open with any client.

## Status

Early foundation. Working today:

| Piece | State |
|---|---|
| Claude Code adapter (`~/.claude/projects/**/*.jsonl`) | Working, tested against real transcripts, live tailing |
| Codex CLI adapter (`~/.codex/sessions`) | Skeleton from the documented format; needs a real rollout fixture |
| Rolling windows, budgets, efficiency metrics | Working, unit-tested |
| Dashboard (React, SSE live updates, light/dark) | Working |
| Menu bar widget (Tauri, macOS) | Built and compile-checked; needs a first `tauri build` run on a Mac |
| Cursor / Windsurf / Copilot | Not started (see plan) |
| API-key proxy for your own scripts | Not started (see plan) |
| Provider usage APIs (Anthropic / OpenAI admin) | Not started (see plan) |

See [PLAN.md](./PLAN.md) for the roadmap and architecture.

## Quick start

```bash
pnpm install
pnpm build
node packages/server/dist/cli.js serve      # opens http://localhost:4321
```

Other commands:

```bash
node packages/server/dist/cli.js doctor     # which tools were detected
node packages/server/dist/cli.js backfill   # ingest history, print source stats
node packages/server/dist/cli.js agents     # text view of the agents table
```

Development (server with hot reload on 4321, Vite dashboard on 5173 proxying `/api`):

```bash
pnpm dev                              # terminal 1
pnpm --filter @ai-usage-widget/web dev  # terminal 2
```

## Menu bar widget (macOS)

The widget is a small Tauri app in `packages/menubar`. It draws a tray item
(`33% · 2` = window left, active agents), and clicking it opens a popover that
loads the compact `/widget` view from the local collector, so the dashboard and
the widget are one React codebase. It starts the collector itself if nothing is
listening on the port (looks for a global `ai-usage-widget` install; override
with `AI_USAGE_WIDGET_BIN`, port with `AI_USAGE_WIDGET_PORT`).

```bash
# prerequisites: Rust (https://rustup.rs) and Xcode command line tools
pnpm build                                          # dashboard + collector
npm link ./packages/server                          # puts `ai-usage-widget` on PATH for the widget to spawn
pnpm --filter @ai-usage-widget/menubar dev          # run it
pnpm --filter @ai-usage-widget/menubar bundle       # .app + .dmg in packages/menubar/src-tauri/target/release/bundle
```

Right-click the tray item for *Open dashboard*, *Refresh now*, *Quit*.

## Configuration

First run writes `~/.ai-usage-widget/config.json` (override the directory with
`AI_USAGE_WIDGET_HOME`). Set `limit` on a window to turn the usage number into a
percentage — providers do not expose exact quotas, so this is your own estimate:

```jsonc
{
  "port": 4321,
  "windows": [
    { "id": "claude-5h", "label": "Claude 5-hour window", "sources": ["claude-code"], "hours": 5, "limit": 8000000, "counting": "all" },
    { "id": "claude-7d", "label": "Claude weekly cap", "sources": ["claude-code"], "hours": 168, "limit": null, "counting": "all" }
  ],
  "budgets": [
    { "id": "daily-usd", "label": "Daily spend", "unit": "usd", "sources": [], "period": "day", "limit": 20 }
  ],
  "pricing": { "claude-fable-5-1": { "input": 0, "output": 0 } },
  "adapters": {}
}
```

Unknown models are shown as **unpriced** rather than $0; add them under
`pricing` (regex → USD per 1M tokens).

## Architecture

```
packages/
  core/                 UsageEvent schema, SQLite store, pricing, aggregation (windows, budgets, efficiency)
  adapter-claude-code/  Transcript parser + offset-based tailer
  adapter-codex/        Rollout parser (skeleton)
  server/               Collector (adapters -> store), Hono API + SSE, CLI, serves the built dashboard
  web/                  React dashboard + compact /widget view, builds into server/public
  menubar/              Tauri menu bar app: tray title from /api/tray, popover loads /widget
```

An adapter implements three methods — `detect()`, `backfill(emit)`,
`watch(emit)` — and emits `UsageEvent`s with ids derived from the source's own
ids, so re-reading a file is always safe. Everything else (pricing, dedupe,
windows, the UI) is shared. Adding a tool means adding one package.

## License

MIT
