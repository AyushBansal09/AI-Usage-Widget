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
(`npm i -g @openai/codex`, then `codex login` with your ChatGPT account). Its
rollouts under `~/.codex/sessions` are read like Claude Code's transcripts:
one event per API response, keyed by OpenAI's `response_id`, with cached
input split out so totals never double count (`input − cached + output` is
exactly the "tokens used" Codex prints).

The same rollouts carry your plan's **rate limits** (`plan_type`, window
length, `used_percent`, `resets_at`), so ChatGPT quota shows up as a measured
window — "ChatGPT Codex 30-day window · 0% used" — with **no network call**.
It is on by default (`providers.codexAccount`) because it only reads local
files; the number is as fresh as your last Codex turn and is captioned with
that time. Validated against Codex CLI 0.154 with a scrubbed real rollout.

## Add any other AI tool

Claude Code, Codex and Cursor are built in, but nothing about the design is
specific to them: every source reduces to the same `UsageEvent`, so the
dashboard, the windows and the widget work the same for a tool nobody has
heard of. There are three ways in, cheapest first — pick by what your tool
leaves behind.

### 1. It writes JSON or JSONL logs → describe them in config, write no code

Add a `customSources` entry to `~/.ai-usage-widget/config.json`. `map` says
where each field lives (dotted paths, `[0]` for arrays); only `timestamp` is
required.

```jsonc
"customSources": [{
  "name": "mytool",                       // becomes the source name everywhere
  "provider": "openai",                   // anthropic | openai | google | other
  "files": "~/.mytool/logs/**/*.jsonl",   // ~ expanded, ** crosses directories
  "format": "jsonl",                      // or "json" (+ "recordsAt": "data")
  "where": { "kind": "completion" },      // skip other lines; `true` = "must be present"
  "map": {
    "id": "response.id",                  // omit and it falls back to file+line
    "timestamp": "created",               // ISO, epoch seconds or epoch millis
    "model": "response.model",
    "sessionId": "thread",
    "project": "meta.cwd",
    "activity": "prompt",
    "inputTokens": "response.usage.prompt_tokens",
    "outputTokens": "response.usage.completion_tokens"
  },
  "defaults": { "model": "gpt-5" }        // used only where the log is silent
}]
```

JSONL files are tailed by byte offset, so only new lines are read. Unmapped
token fields stay 0 and cost stays null rather than being guessed — an unknown
model shows as **unpriced**, never as $0.

### 2. It has no logs → push events over HTTP

Anything that can make a request can report usage. One event or an array:

```bash
curl -s localhost:4321/api/ingest -H 'content-type: application/json' -d '{
  "id": "my-script:42", "source": "my-script", "provider": "anthropic",
  "model": "claude-opus-4-5", "timestamp": "2026-09-11T18:30:00Z",
  "sessionId": "cron", "agentId": "main",
  "inputTokens": 2000, "outputTokens": 300, "activity": "nightly summary job"
}'
# {"ingested":1,"duplicates":0,"rejected":0,"errors":[]}
```

Ids are yours, so retries are safe — the same id upserts instead of double
counting. The endpoint is bound to `127.0.0.1` only. Good for shell hooks,
CI jobs, agent frameworks, and languages other than JavaScript.

### 3. It needs real logic → drop in a plugin file

One file, no build step, no package to publish:

```js
// ~/.ai-usage-widget/plugins/my-tool.mjs
export default {
  name: "my-tool",
  async detect() { return { available: true, location: "~/.mytool" }; },
  async backfill(emit) { emit({ /* a UsageEvent */ }); },
  async watch(emit) { const t = setInterval(() => {}, 5000); return () => clearInterval(t); },
};
```

```jsonc
"plugins": ["~/.ai-usage-widget/plugins/my-tool.mjs"]   // or an npm package name
```

A default export may be the object, a factory returning one, or a class. Give
events ids derived from your source's own ids so re-reading is idempotent. A
plugin that fails to load is reported and skipped — it can't take the
collector down with it.

All three show up in `ai-usage-widget doctor`, in the Sources panel, in the
agents table and in the widget, exactly like a built-in adapter.

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
    "cursorAccount": { "enabled": false, "pollSeconds": 600 },
    "codexAccount": { "enabled": true, "pollSeconds": 30 }
  },
  "customSources": [],
  "plugins": []
}
```

Unknown models are shown as **unpriced** rather than $0; add them under
`pricing` (regex → USD per 1M tokens).

## Architecture

```
packages/
  core/                 UsageEvent schema, SQLite store, pricing, aggregation (windows, budgets, efficiency)
  adapter-claude-code/  Transcript parser + offset-based tailer
  adapter-codex/        Codex CLI rollout parser (token_usage_record + rate_limits), validated on 0.154
  adapter-cursor/       Cursor state.vscdb reader: agent steps, tool calls, token counts where recorded
  adapter-custom/       Config-driven reader for any JSON/JSONL log ("customSources"), no code required
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
