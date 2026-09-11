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

## Desktop / Notification Center widget (macOS)

A native WidgetKit widget in `packages/widget-macos`: small = "41% left" for
your primary window; medium adds what each agent is doing right now. It reads
one JSON payload (`/api/widget`) from the collector over `127.0.0.1` — no
files, no accounts, loopback only. Refresh timing is up to macOS (it budgets
widget refreshes), so the medium size prints "as of HH:MM".

```bash
# prerequisites: Xcode 16+; no Apple developer account needed (signed to run locally)
pnpm --filter @ai-usage-widget/widget-macos bundle       # xcodebuild → build/Build/Products/Release/AIUsageWidget.app
pnpm --filter @ai-usage-widget/widget-macos install-app  # copy to /Applications and open once
```

Then right-click the desktop → *Edit Widgets…* → search "AI Usage". Details
and design notes in `packages/widget-macos/README.md`.

## Connect your Claude account (real quota, not an estimate)

By default every window is an *estimate* from this device's logs. If you use
Claude Code, you already have a login on this machine; one command reuses it to
read your account's real rolling-window usage — the same numbers `/usage` shows:

```bash
ai-usage-widget connect claude      # one test fetch, then switches it on in config
ai-usage-widget doctor              # shows "claude account  keychain (max): Claude 5-hour window 62%, …"
ai-usage-widget disconnect claude   # off again; nothing was stored
```

What it does and does not do:

- Reads Claude Code's OAuth token from the macOS Keychain (`Claude Code-credentials`)
  or `~/.claude/.credentials.json` and calls `https://api.anthropic.com/api/oauth/usage`
  every 2 minutes (`providers.anthropicAccount.pollSeconds`). That is the only
  network call the collector ever makes, and only after you opt in.
- **Read-only.** It never refreshes or rewrites the token, so Claude Code's own
  login is untouched. If the token has expired, the widget says so and falls
  back to the local estimate until you open `claude` again.
- The token never appears in the API, logs or config. `/api/account` exposes
  only health: where the credential was found, ok/expired/missing, last fetch.
- macOS may ask once whether `node` can read that Keychain item; *Always Allow*.

When connected, the menu bar title, the popover, the WidgetKit widget and the
dashboard all put the measured 5-hour number first, labelled
"Anthropic · HH:MM", and keep the local estimates in the secondary row. The
two are never merged: one is a measurement of your whole account, the other an
inference from one device's logs.

## Cursor

Cursor is read from its own local database
(`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`,
read-only): every agent/chat step becomes an event with the tool it ran and
what it touched, so Cursor agents show up in the agents table and the widget.
Two honest caveats, both visible in the UI:

- Cursor only records token counts on some steps (about 1 in 25 on the
  install this was built against). Steps without a count are kept for
  activity and marked `tokensReported: false`; they are not guessed.
- Cursor usually routes through its "default" auto model, so events are
  `cursor-auto` and **unpriced** unless you picked a specific model.

`ai-usage-widget connect cursor` reuses Cursor's own login (read-only) to
read your plan's quota from cursor.com. It only switches on if Cursor
reports a cap it can show; usage-based plans get "no cap" rather than a
made-up percentage.

## ChatGPT / Codex CLI

There is no local log for ChatGPT itself. The way in is the Codex CLI
(`npm i -g @openai/codex`, then `codex login` with your ChatGPT account): its
session logs under `~/.codex/sessions` carry both token usage and your plan's
rate-limit windows, so ChatGPT quota needs no extra network call.

## Configuration

First run writes `~/.ai-usage-widget/config.json` (override the directory with
`AI_USAGE_WIDGET_HOME`). Set `limit` on a window to turn the usage number into a
percentage — providers do not expose exact quotas, so this is your own estimate
(or skip that and `connect claude` above):

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
  "adapters": {},
  "providers": {
    "anthropicAccount": { "enabled": false, "pollSeconds": 120 },
    "cursorAccount": { "enabled": false, "pollSeconds": 600 }
  }
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
  adapter-cursor/       Cursor state.vscdb reader: agent steps, tool calls, token counts where recorded
  server/               Collector (adapters -> store), Hono API + SSE, CLI, serves the built dashboard
  web/                  React dashboard + compact /widget view, builds into server/public
  menubar/              Tauri menu bar app: tray title from /api/tray, popover loads /widget
  widget-macos/         Native WidgetKit widget (Swift): small/medium families fed by /api/widget over loopback
```

An adapter implements three methods — `detect()`, `backfill(emit)`,
`watch(emit)` — and emits `UsageEvent`s with ids derived from the source's own
ids, so re-reading a file is always safe. Everything else (pricing, dedupe,
windows, the UI) is shared. Adding a tool means adding one package.

## License

MIT
