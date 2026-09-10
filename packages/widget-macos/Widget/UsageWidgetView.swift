import SwiftUI
import WidgetKit
import AIUsageKit

struct UsageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageEntry

    var body: some View {
        switch entry.state {
        case .placeholder:
            SnapshotView(snapshot: .sample, family: family, generatedAt: entry.date).redacted(reason: .placeholder)
        case .loaded(let snap):
            SnapshotView(snapshot: snap, family: family, generatedAt: snap.generatedAt)
        case .offline:
            EmptyStateView(title: "Collector offline",
                           detail: "Open AI Usage Widget or run\nnpx ai-usage-widget")
        case .error:
            EmptyStateView(title: "Can't read collector",
                           detail: "Widget and collector versions differ.\nUpdate both.")
        }
    }
}

private struct SnapshotView: View {
    let snapshot: WidgetSnapshot
    let family: WidgetFamily
    let generatedAt: Date

    var body: some View {
        if family == .systemMedium {
            HStack(alignment: .top, spacing: 12) {
                WindowColumn(window: snapshot.primary, measured: snapshot.measured, activeAgents: snapshot.activeAgents, day: snapshot.day)
                    .frame(width: 128, alignment: .leading)
                Divider()
                AgentsColumn(agents: snapshot.agents, activeAgents: snapshot.activeAgents, generatedAt: generatedAt)
            }
        } else {
            WindowColumn(window: snapshot.primary, measured: snapshot.measured, activeAgents: snapshot.activeAgents, day: snapshot.day)
        }
    }
}

/// The headline number. Same rules as the menu bar title: a percent only
/// when the user has set a limit, otherwise raw tokens used.
private struct WindowColumn: View {
    let window: UsageWindow?
    /// Account-reported; shown instead of `window` when present.
    let measured: QuotaWindow?
    let activeAgents: Int
    let day: DayTotals

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text("AI Usage").font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if activeAgents > 0 {
                    Circle().fill(.green).frame(width: 6, height: 6)
                    Text("\(activeAgents)").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if let q = measured {
                Text(Format.headline(for: q))
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(tint(q.severity))
                    .lineLimit(1).minimumScaleFactor(0.6)
                Text(q.resetsAt.map { "\(shortLabel(q.label)) · resets \(Format.countdown(to: $0))" } ?? shortLabel(q.label))
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                ProgressView(value: q.fraction).tint(tint(q.severity)).progressViewStyle(.linear)
                Text(Format.caveat(for: q)).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            } else if let w = window {
                Text(Format.headline(for: w))
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(tint(w.severity))
                    .lineLimit(1).minimumScaleFactor(0.6)
                Text("\(shortLabel(w.label)) · resets \(Format.countdown(to: w.resetsAt))")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                if let f = w.fraction {
                    ProgressView(value: f).tint(tint(w.severity)).progressViewStyle(.linear)
                }
                Text(Format.caveat(for: w)).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            } else {
                Text("No window").font(.title3).fontWeight(.semibold)
                Text("Configure one in the dashboard").font(.caption2).foregroundStyle(.secondary)
            }
            Text("24h: \(Format.compactTokens(day.tokens)) · \(Format.usd(day.costUsd, unpriced: day.unpriced))")
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private func tint(_ s: UsageWindow.Severity) -> Color {
        switch s {
        case .critical: return .red
        case .warning: return .orange
        case .ok: return .primary
        case .unknown: return .primary
        }
    }

    /// "Claude 5-hour window" -> "Claude 5h"; keeps the column narrow.
    private func shortLabel(_ label: String) -> String {
        label
            .replacingOccurrences(of: "-hour window", with: "h")
            .replacingOccurrences(of: " weekly cap", with: " 7d")
    }
}

private struct AgentsColumn: View {
    let agents: [AgentRow]
    let activeAgents: Int
    let generatedAt: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(activeAgents > 0 ? "\(activeAgents) active" : "Agents").font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                Spacer()
                Text("as of \(generatedAt, style: .time)").font(.caption2).foregroundStyle(.tertiary)
            }
            if agents.isEmpty {
                Spacer(minLength: 0)
                Text("Nothing in the last 5 hours").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else {
                ForEach(agents.prefix(3)) { a in
                    HStack(alignment: .top, spacing: 6) {
                        Circle()
                            .fill(a.isActive ? Color.green : Color.secondary.opacity(0.4))
                            .frame(width: 6, height: 6).padding(.top, 4)
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 4) {
                                Text(a.label).font(.caption).fontWeight(.medium).lineLimit(1)
                                Text(Format.shortModel(a.model)).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                                Spacer(minLength: 0)
                                Text(Format.usd(a.costUsd, unpriced: a.unpriced)).font(.caption2).foregroundStyle(.secondary)
                            }
                            Text(a.activity ?? "—").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

private struct EmptyStateView: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("AI Usage").font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(title).font(.headline)
            Text(detail).font(.caption2).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
    }
}

#Preview("Small", as: .systemSmall) {
    AIUsageWidget()
} timeline: {
    UsageEntry(date: .now, state: .loaded(.sample))
    UsageEntry(date: .now, state: .offline)
}

#Preview("Medium", as: .systemMedium) {
    AIUsageWidget()
} timeline: {
    UsageEntry(date: .now, state: .loaded(.sample))
}
