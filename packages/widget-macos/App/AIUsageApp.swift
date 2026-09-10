import SwiftUI
import WidgetKit
import AIUsageKit

/// The host app exists because macOS only loads widget extensions that ship
/// inside an app bundle. It does three small things: shows whether the local
/// collector is reachable, lets you poke WidgetKit to refresh, and explains
/// how to add the widget. The real UI is the widget and the dashboard.
@main
struct AIUsageApp: App {
    var body: some Scene {
        WindowGroup("AI Usage Widget") {
            ContentView()
                .frame(minWidth: 420, minHeight: 300)
        }
        .windowResizability(.contentSize)
    }
}

struct ContentView: View {
    private let client = UsageClient()
    @State private var status: Status = .checking

    enum Status { case checking, online(WidgetSnapshot), offline }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("AI Usage Widget").font(.title2).bold()

            HStack(spacing: 8) {
                Circle().fill(dot).frame(width: 8, height: 8)
                Text(statusText)
                Spacer()
                Button("Check again") { Task { await check() } }
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Add the widget").font(.headline)
                Text("Right-click the desktop → Edit Widgets… (or open Notification Center and click Edit Widgets), search for “AI Usage”, and drag the small or medium size out.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("The widget only talks to the collector on 127.0.0.1:\(client.port). Numbers are estimates from this device’s local logs; other devices are invisible.")
                    .font(.callout).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            HStack {
                Button("Refresh widgets") { WidgetCenter.shared.reloadAllTimelines() }
                Link("Open dashboard", destination: client.dashboardURL)
                Spacer()
                Text("Collector: `npx ai-usage-widget`").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .task { await check() }
    }

    private var dot: Color {
        switch status {
        case .checking: return .gray
        case .online: return .green
        case .offline: return .red
        }
    }

    private var statusText: String {
        switch status {
        case .checking: return "Checking collector…"
        case .online(let s):
            if let w = s.primary { return "Collector online · \(Format.headline(for: w)) (\(Format.caveat(for: w)))" }
            return "Collector online"
        case .offline: return "Collector offline on port \(client.port)"
        }
    }

    private func check() async {
        status = .checking
        switch await client.fetch() {
        case .success(let s):
            status = .online(s)
            WidgetCenter.shared.reloadAllTimelines()
        case .failure:
            status = .offline
        }
    }
}
