# ai-usage-widget — plan

Goal: an open-source, local-first menu bar widget (backed by a dashboard) that shows how many tokens you have
left, what each of your AI agents is working on, and how efficiently they use
tokens — across whichever AI tools you use day to day.

## Design decisions (settled)

- **Local-first, TypeScript.** One `npx ai-usage-widget` command runs a collector
  and a dashboard on localhost. No accounts, no telemetry, data stays in
  `~/.ai-usage-widget/events.sqlite`. Hosted/team sync is a later, optional layer.
- **One event shape for everything.** Every source is reduced to a `UsageEvent`
  (model, tokens by kind, cost, session, agent, tool calls, activity). Adapters
  only parse; the store, aggregation, and UI are shared. This is the contract
  that makes "connect any tool" tractable.
- **Idempotent ingestion.** Event ids come from the source's own ids (Claude
  message id + request id, Codex thread id + line). Re-reading a log is always
  safe, which makes tailing and restarts trivial.
- **Honest numbers.** Unknown models are "unpriced", never $0. Rolling windows
  are labelled as estimates: providers do not expose exact remaining quota, and
  activity on other devices is invisible to local logs.
- **Measured beats estimated, and the two never merge.** Anthropic *does*
  expose per-window utilisation to a logged-in Claude Code (the `/usage`
  endpoint). `connect claude` reuses that login read-only and surfaces the
  result as `QuotaWindow`, a separate type from the local `WindowStatus`.
  Every surface shows the measured 5h number first when present, labelled with
  the provider and the fetch time; local estimates move to the secondary row.
  Opt-in, loopback-plus-one-host, token never stored, never refreshed by us
  (refresh tokens rotate and would log Claude Code out).
- **Two native surfaces, one payload each.** The menu bar item polls
  `/api/tray`; the WidgetKit widget polls `/api/widget`. Both are deliberately
  dumb clients of the collector. The widget talks HTTP to `127.0.0.1` rather
  than reading the SQLite file because widget extensions are sandboxed and App
  Groups need a paid Apple team; loopback needs only `network.client`. WidgetKit
  decides refresh timing, so the widget is a "few minutes stale" glance, the
  tray is the live one.
- **Prior art acknowledged.** `ccusage` already parses most of these log formats
  for CLI reports. This project differs in being a live dashboard (agents view,
  burn-down, efficiency) and in the pluggable adapter model. Where their parsers
  document format quirks, we borrow the knowledge, not the code.

## What exists now (foundation)

- `@ai-usage-widget/core`: `UsageEvent` (zod), SQLite store with upsert-on-id,
  seed pricing table with overrides, rolling-window / budget / efficiency /
  timeline aggregation. Unit-tested.
- `@ai-usage-widget/adapter-claude-code`: parser that merges the per-content-block
  lines of one API response into one event (a real gotcha — naive counting
  multiplies usage by the number of blocks), tracks subagents, extracts
  "working on" from tool calls, strips system reminders from prompts. Offset-
  based tailer with persisted cursors. Verified on live transcripts.
- `@ai-usage-widget/adapter-codex`: parser skeleton from the documented rollout
  format. Needs a real, scrubbed fixture to validate.
- `@ai-usage-widget/server`: Collector, Hono API (`/api/summary`, `/api/agents`,
  `/api/timeline`, `/api/events`, `/api/stream` SSE), CLI (`serve`, `doctor`,
  `backfill`, `agents`).
- `@ai-usage-widget/menubar`: Tauri 2 tray app. Tray title comes from
  `/api/tray`; left-click toggles a frameless always-on-top popover positioned
  under the tray that loads `/widget`; right-click menu has Open dashboard /
  Refresh / Quit; hides on blur; runs as an Accessory app (no Dock icon);
  spawns the collector if it is not running. `cargo check` passes on macOS
  (needs the `macos-private-api` Cargo feature for the transparent popover);
  first interactive run still to be confirmed.
- `@ai-usage-widget/widget-macos`: native WidgetKit widget (Swift, Xcode
  project + `AIUsageKit` package). Small family = headline number for the
  primary window; medium adds up to three agents with their current activity
  and an "as of" time. Fed by one `GET /api/widget` per refresh over loopback.
  Builds and registers with `pluginkit` using ad-hoc signing; `swift test`
  covers decoding a scrubbed real payload and the formatting rules.
- `@ai-usage-widget/web`: React dashboard — tokens-left cards, efficiency tiles,
  stacked timeline with hover, agents table, by-model table, sources. Light and
  dark themes. Live via SSE.

## Roadmap

### Phase 1 — solid Claude Code experience (next)
1. Real fixtures: commit scrubbed transcripts from 2–3 Claude Code versions
   (including a `subagents/` layout and a compaction) as parser tests.
2. Window calibration: let the user record "I hit the limit at time T" so the
   5h/7d `limit` can be inferred from observed usage, instead of guessed.
3. Subagent tree in the agents table (parent → children, collapsed by default).
4. Per-session drill-down page: turn-by-turn context growth, tool mix, and a
   "why is this expensive" panel (largest context jumps, retried tools).
5. Menu bar widget polish: first run on macOS, notarised .dmg via GitHub Actions, launch-at-login, notification when a window crosses 80%/95%.
6. WidgetKit widget polish: an accent/background colour asset, a large family
   with the 7-day window next to the 5-hour one, and an App Intent to pick
   which window the small widget shows. Ship it inside the same .dmg as the
   menu bar app (one bundle id family) once signing is sorted out.
7. `npm publish` as a single `ai-usage-widget` package; GitHub Actions for
   typecheck + tests on macOS/Linux/Windows.

### Phase 2 — Codex CLI
1. Validate the rollout parser against real logs; handle `archived_sessions`,
   subagent replay baselines, compaction.
2. Offset-based tailing (reuse the Claude Code tailer; extract to core).
3. OpenAI plan windows (ChatGPT Plus/Pro Codex quotas) as configured windows.

### Phase 3 — user-set budgets and API keys
1. Budgets UI (create/edit in the dashboard, persisted to config).
2. **Provider usage APIs**: optional Anthropic Admin API and OpenAI Usage API
   pulls when the user supplies an admin key — gives real org spend to sit next
   to the local estimate. Keys stored in the OS keychain, never in config.
   *(Done for the common case without any key: `connect claude` reads the
   account's 5h/7d utilisation via Claude Code's own login — see
   `packages/server/src/providers/anthropic-account.ts`. Still to do: the
   fixture is synthetic until a real `connect claude` run replaces it; a
   `seven_day_opus`-style per-model window in the widget's medium family;
   the Admin API path for org spend; OpenAI's equivalent for Codex.)*
3. **API proxy adapter**: `ai-usage-widget proxy` exposes a local
   OpenAI/Anthropic-compatible endpoint that forwards requests and records
   usage from responses, so people's own scripts and agent frameworks show up
   by pointing `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at it. Streaming-aware.

### Phase 4 — IDE agents (Cursor, Windsurf, Copilot)
These do not write usable local usage logs. Options, in order of preference:
1. Import from their usage/export pages (CSV/JSON upload in the dashboard).
2. Browser-extension or bookmarklet that scrapes the usage page on demand.
3. Session-count-only mode where we show activity but not tokens.
Decide per tool once we have a contributor who uses it daily.

### Phase 5 — optional hosted/team layer
A tiny sync agent that ships `UsageEvent`s to a self-hostable server with team
views. Only after the local product is good; must stay optional.

## Open questions

Answered in the first session: tools (all four groups), meaning of "tokens
left" (windows + budgets + provider APIs), stack (local-first TypeScript),
location (GitHub repo). Still open:

1. Project name — `ai-usage-widget` is a placeholder; the npm name should be
   checked for availability.
2. Which Claude plan does Ayush use, and what limit does `/usage` show? Needed to
   calibrate the default window `limit` and to sanity-check the "all tokens"
   counting rule against Anthropic's meter.
3. (Answered: the menu bar widget is the primary surface; the dashboard is the drill-down.)
4. Where should scrubbed fixture transcripts come from — Ayush's own sessions
   (fast) or synthetic ones (safer for a public repo)?
5. License stays MIT?
