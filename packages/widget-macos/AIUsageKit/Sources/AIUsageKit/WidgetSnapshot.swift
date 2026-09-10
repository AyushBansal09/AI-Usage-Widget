import Foundation

/// Mirror of the collector's `GET /api/widget` payload.
///
/// The server pre-formats labels and picks which agents matter; this side
/// only decodes and draws. Optionals are deliberate: `limit`/`fraction` are
/// nil when the user has not configured a cap, and the widget must then show
/// tokens used rather than a made-up percentage.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public var generatedAt: Date
    public var windows: [UsageWindow]
    public var activeAgents: Int
    public var agents: [AgentRow]
    public var day: DayTotals

    public init(generatedAt: Date, windows: [UsageWindow], activeAgents: Int, agents: [AgentRow], day: DayTotals) {
        self.generatedAt = generatedAt
        self.windows = windows
        self.activeAgents = activeAgents
        self.agents = agents
        self.day = day
    }

    /// The window the tray title is built from: the first configured one.
    public var primary: UsageWindow? { windows.first }
}

public struct UsageWindow: Codable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var used: Double
    public var limit: Double?
    public var fraction: Double?
    public var unit: String
    public var resetsAt: Date
    public var projectedExhaustion: Date?
    public var burnRatePerHour: Double
    /// Always true from the collector; carried so the UI cannot forget it.
    public var estimate: Bool

    public init(id: String, label: String, used: Double, limit: Double?, fraction: Double?, unit: String,
                resetsAt: Date, projectedExhaustion: Date?, burnRatePerHour: Double, estimate: Bool) {
        self.id = id
        self.label = label
        self.used = used
        self.limit = limit
        self.fraction = fraction
        self.unit = unit
        self.resetsAt = resetsAt
        self.projectedExhaustion = projectedExhaustion
        self.burnRatePerHour = burnRatePerHour
        self.estimate = estimate
    }

    public enum Severity: Sendable { case unknown, ok, warning, critical }

    /// Same thresholds as the menu bar title (`/api/tray`).
    public var severity: Severity {
        guard let f = fraction else { return .unknown }
        if f >= 0.9 { return .critical }
        if f >= 0.7 { return .warning }
        return .ok
    }

    /// Whole percent of the window still available, or nil without a limit.
    public var percentLeft: Int? {
        guard let f = fraction else { return nil }
        return Int(((1 - f) * 100).rounded())
    }
}

public struct AgentRow: Codable, Equatable, Sendable, Identifiable {
    public var agentId: String
    public var label: String
    public var model: String
    public var status: String
    public var activity: String?
    public var costUsd: Double
    public var unpriced: Bool
    public var tokens: Double
    public var lastSeen: Date

    public init(agentId: String, label: String, model: String, status: String, activity: String?,
                costUsd: Double, unpriced: Bool, tokens: Double, lastSeen: Date) {
        self.agentId = agentId
        self.label = label
        self.model = model
        self.status = status
        self.activity = activity
        self.costUsd = costUsd
        self.unpriced = unpriced
        self.tokens = tokens
        self.lastSeen = lastSeen
    }

    /// Two agents can share an id ("main") across sessions; make rows unique.
    public var id: String { "\(label)|\(agentId)|\(lastSeen.timeIntervalSince1970)" }
    public var isActive: Bool { status == "active" }
}

public struct DayTotals: Codable, Equatable, Sendable {
    public var tokens: Double
    public var costUsd: Double
    public var unpriced: Bool

    public init(tokens: Double, costUsd: Double, unpriced: Bool) {
        self.tokens = tokens
        self.costUsd = costUsd
        self.unpriced = unpriced
    }
}

extension WidgetSnapshot {
    /// ISO-8601 with fractional seconds, which is what the collector emits.
    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            if let date = withFraction.date(from: s) ?? plain.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad date: \(s)"))
        }
        return d
    }

    public static func decode(_ data: Data) throws -> WidgetSnapshot {
        try decoder().decode(WidgetSnapshot.self, from: data)
    }

    /// Placeholder shown in the widget gallery and while the first fetch runs.
    /// Clearly synthetic numbers so nobody mistakes it for their own usage.
    public static let sample = WidgetSnapshot(
        generatedAt: Date(),
        windows: [
            UsageWindow(id: "claude-5h", label: "Claude 5-hour window", used: 2_400_000, limit: 8_000_000,
                        fraction: 0.3, unit: "tokens", resetsAt: Date().addingTimeInterval(3 * 3600 + 20 * 60),
                        projectedExhaustion: nil, burnRatePerHour: 700_000, estimate: true),
            UsageWindow(id: "claude-7d", label: "Claude weekly cap", used: 9_100_000, limit: nil, fraction: nil,
                        unit: "tokens", resetsAt: Date().addingTimeInterval(4 * 86400), projectedExhaustion: nil,
                        burnRatePerHour: 200_000, estimate: true),
        ],
        activeAgents: 1,
        agents: [
            AgentRow(agentId: "main", label: "my-app", model: "claude-opus-5", status: "active",
                     activity: "Edit: src/routes/login.ts", costUsd: 0.42, unpriced: false, tokens: 310_000, lastSeen: Date()),
            AgentRow(agentId: "sub-1", label: "my-app", model: "claude-sonnet-5", status: "idle",
                     activity: "Explore: find auth middleware", costUsd: 0.05, unpriced: false, tokens: 40_000,
                     lastSeen: Date().addingTimeInterval(-900)),
        ],
        day: DayTotals(tokens: 2_400_000, costUsd: 3.18, unpriced: false)
    )
}
