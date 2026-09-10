# @ai-usage-widget/widget-macos

A native macOS **WidgetKit** widget: add it to the desktop or Notification
Center and see how much of your Claude window is left and what each agent is
doing, without opening anything.

It is a second surface next to the menu bar app (`packages/menubar`). Both are
thin: every number comes from the local collector's HTTP API.

```
┌ AI Usage ──────── ● 1 ┐   ┌ AI Usage ──── ● 1 ┃ 1 active     as of 13:28 ┐
│                       │   │                    ┃ ● ai-usage-widget opus 5  │
│ 41% left              │   │ 41% left           ┃   Bash: run the tests…    │
│ Claude 5h · resets 4h │   │ Claude 5h · 4h 12m ┃ ○ example-project sonnet  │
│ ████████░░░░          │   │ ████████░░░░       ┃   Edit: src/login.ts      │
│ est. · this device    │   │ est. · this device ┃                           │
│ 24h: 4.7M · ≥ $3.18   │   │ 24h: 4.7M · $3.18  ┃                           │
└───────────────────────┘   └────────────────────┻───────────────────────────┘
        systemSmall                              systemMedium
```

## How it works

- The extension calls `GET http://127.0.0.1:4321/api/widget` once per refresh
  and draws the result. Nothing else: no files, no keychain, no network beyond
  loopback. The entitlements are `app-sandbox` + `network.client`, that's all.
- **Why HTTP and not the SQLite file:** widget extensions are sandboxed and
  cannot read `~/.ai-usage-widget`. Sharing a container via App Groups needs a
  paid Apple developer team. Loopback needs neither.
- **Refresh cadence is the OS's call.** The provider asks for a refresh every
  5 minutes; WidgetKit budgets refreshes per day and may deliver fewer. The
  medium widget prints "as of HH:MM" so a stale number is visibly stale.
  Opening the host app (or clicking "Refresh widgets" in it) forces a reload.
- **Honest numbers, same rules as the tray:** a percentage only appears when
  the user has set a window `limit`; otherwise the widget shows tokens used and
  "no limit set". Every window is labelled `est.` because local logs only see
  this device. Cost shows `≥ $x` when any model in range is unpriced.
- Tapping the widget opens the dashboard at `http://localhost:4321`.

## Build

Requires Xcode 16+ (macOS 14 SDK). No Apple developer account: the project is
set to "Sign to Run Locally" (ad-hoc), which is enough for widgets on your own
machine.

```sh
pnpm --filter @ai-usage-widget/widget-macos test     # swift test on AIUsageKit
pnpm --filter @ai-usage-widget/widget-macos bundle   # xcodebuild → build/Build/Products/Release/AIUsageWidget.app
pnpm --filter @ai-usage-widget/widget-macos install-app   # copies to /Applications and opens it
```

If `xcodebuild` complains that a plug-in failed to load, run
`xcodebuild -runFirstLaunch` once (no sudo needed).

Then: right-click the desktop → **Edit Widgets…**, search "AI Usage", drag the
small or medium size out. The collector must be running
(`npx ai-usage-widget`, or let the menu bar app start it).

Non-default collector port: edit `AIUsageWidgetPort` in
`Config/Widget-Info.plist` and `Config/App-Info.plist`, rebuild.

## Layout

```
AIUsageKit/              Swift package: payload model, loopback client, formatting. `swift test`.
  Tests/…/Fixtures/      Scrubbed real /api/widget response used by the tests.
Widget/                  WidgetKit extension: provider (timeline), views (small/medium).
App/                     Host app (required to ship an extension): status, "Refresh widgets", instructions.
Config/                  Info.plists and entitlements for both targets.
AIUsageWidget.xcodeproj  Hand-written; uses synchronized folders, so new files in App/ and Widget/ are picked up automatically.
```
