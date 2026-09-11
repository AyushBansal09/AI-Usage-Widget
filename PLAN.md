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
- **Three doors in, so "any tool" is true rather than aspirational.** A
  built-in adapter is now the *last* resort, not the first: (1) a tool that
  writes JSON/JSONL gets a `customSources` entry — a field map in config, no
  code; (2) a tool with no logs at all pushes to `POST /api/ingest` from a
  hook, a script or CI; (3) anything needing real logic is a one-file plugin
  named in `config.plugins`, loaded at startup and skipped with a message if
  it breaks. All three surface identically in `doctor`, Sources, the agents
  table and the widget. The bundled adapters exist because those three tools
  are common, not because the core knows anything about them.
- **The tray shows the binding constraint.** With several providers connected,
  `primaryQuota()` picks the *fullest* window rather than a favoured provider:
  the number that matters is the one that stops work first. Callers must show
  the window's label, because which provider wins can change.
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

### Phase 2 — Codex CLI (= the ChatGPT path)
There is no ChatGPT desktop log; Codex CLI is how a ChatGPT account shows up.
1. **Done (2026-09-11):** parser validated against a real Codex CLI 0.154
   rollout (scrubbed fixture). 0.15x writes a `token_usage_record` per API
   response with OpenAI's `response_id` — that is the event id now; the
   `token_count` delta path is kept for older versions and never used when
   records exist (no double counting). `model` comes from `turn_context`
   (null in `session_meta`). `archived_sessions/` is scanned too. Still to
   do: subagent replay baselines, compaction, a multi-turn fixture.
2. Offset-based tailing (reuse the Claude Code tailer; extract to core).
   Today: full rescan of changed files every 10s, safe because ids are stable.
3. **Done:** ChatGPT quota from the logs, not the network. `rate_limits` on
   `token_count` (plan_type, primary/secondary window_minutes, used_percent,
   resets_at epoch) → `CodexAccount` (provider "openai"), on by default since
   it is local-only; `measuredAt` is the rollout line's time so staleness is
   visible. Free plan observed: one 30-day primary window, no secondary.

### Phase 3 — user-set budgets and API keys
1. Budgets UI (create/edit in the dashboard, persisted to config).
2. **Provider usage APIs**: optional Anthropic Admin API and OpenAI Usage API
   pulls when the user supplies an admin key — gives real org spend to sit next
   to the local estimate. Keys stored in the OS keychain, never in config.
   *(Done for the common case without any key: `connect claude` reads the
   account's 5h/7d utilisation via Claude Code's own login — see
   `packages/server/src/providers/anthropic-account.ts`, fixture captured from
   a real Pro account with `connect claude --raw`. Verified live: the local
   estimate said 41% left; the account said 80%. Still to do: per-model weekly
   windows (`seven_day_opus` etc., null on Pro) in the widget's medium family;
   the response's `limits[]` array as a forward-compatible source; the Admin
   API path for org spend; OpenAI's equivalent for Codex.)*
3. **API proxy adapter**: `ai-usage-widget proxy` exposes a local
   OpenAI/Anthropic-compatible endpoint that forwards requests and records
   usage from responses, so people's own scripts and agent frameworks show up
   by pointing `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at it. Streaming-aware.

### Phase 4 — IDE agents (Cursor, Windsurf, Copilot, Antigravity)
**Cursor: done as a local adapter (2026-09-11).** It turned out Cursor's
`state.vscdb` is a usable log: every agent step is a row with a stable id,
timestamp, tool name/args, mode, and — on some steps — `tokenCount`. See
`packages/adapter-cursor`; fixture scrubbed from a real database. Rules
that fell out of it: steps without a token count are emitted with zeros and
`meta.tokensReported=false` (activity is still worth showing); the "default"
auto-router model stays `cursor-auto`/unpriced.
`connect cursor` reuses Cursor's own login for plan quota, but the legacy
`/api/usage` endpoint now returns `maxRequestUsage: null` on current plans
(Cursor moved to usage-based pricing), so it refuses to enable a window it
cannot back. Next: find the dashboard endpoint Cursor's own settings page
uses for the current cycle's spend, capture it with `--raw`, and map it to a
`usd`-unit QuotaWindow.

Others still have no local log. Options, in order of preference:
1. Import from their usage/export pages (CSV/JSON upload in the dashboard).
2. Browser-extension or bookmarklet that scrapes the usage page on demand.
3. Session-count-only mode where we show activity but not tokens.
Antigravity (Google) keeps conversations as protobuf under
`~/.gemini/antigravity/{conversations,brain}`; a session-count adapter is
plausible once the .pb schema is understood.

### Phase 4b — universal extensibility (done 2026-09-11)
`customSources` (config-only field mapping over JSON/JSONL), `POST /api/ingest`
(push from anything), and `config.plugins` (one-file adapters). Verified
together on one collector: five sources side by side — claude-code, codex,
cursor, a config-only "mytool", a plugin, and a script that only POSTed.
The server now binds `127.0.0.1` explicitly, since it accepts writes.
Still open:
1. `ai-usage-widget proxy` (was Phase 3.3) — the last gap: tools that neither
   log nor can be modified. A local OpenAI/Anthropic-compatible endpoint that
   forwards and records usage, streaming-aware. This is the only remaining
   "any tool" case the three doors above do not cover.
2. A `customSources` generator: `ai-usage-widget sniff <file>` proposes a
   field map from a sample log, so users do not hand-write dotted paths.
3. Publish the adapter contract as a tiny `@ai-usage-widget/adapter-kit` with
   the types and a template repo.

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
