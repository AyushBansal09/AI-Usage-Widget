import XCTest
@testable import AIUsageKit

final class SnapshotDecodingTests: XCTestCase {
    private func fixture() throws -> WidgetSnapshot {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "widget", withExtension: "json", subdirectory: "Fixtures"))
        return try WidgetSnapshot.decode(try Data(contentsOf: url))
    }

    /// Scrubbed copy of a real `/api/widget` response from the collector.
    func testDecodesRealPayload() throws {
        let s = try fixture()
        XCTAssertEqual(s.windows.count, 2)
        XCTAssertEqual(s.activeAgents, 1)
        XCTAssertEqual(s.agents.count, 2)
        XCTAssertEqual(s.day.tokens, 4_688_770)
        XCTAssertTrue(s.day.unpriced)

        let primary = try XCTUnwrap(s.primary)
        XCTAssertEqual(primary.id, "claude-5h")
        XCTAssertEqual(primary.limit, 8_000_000)
        XCTAssertEqual(primary.percentLeft, 41)
        XCTAssertEqual(primary.severity, .ok)
        XCTAssertTrue(primary.estimate)
        XCTAssertNotNil(primary.projectedExhaustion)
    }

    /// A window without a user-configured limit must not produce a percentage.
    func testNoLimitMeansNoPercent() throws {
        let weekly = try fixture().windows[1]
        XCTAssertNil(weekly.limit)
        XCTAssertNil(weekly.fraction)
        XCTAssertNil(weekly.percentLeft)
        XCTAssertEqual(weekly.severity, .unknown)
        XCTAssertEqual(Format.headline(for: weekly), "4.7M used")
        XCTAssertEqual(Format.caveat(for: weekly), "no limit set · est.")
    }

    func testDatesWithAndWithoutFractionalSeconds() throws {
        let json = """
        {"generatedAt":"2026-09-10T17:28:18Z","windows":[],"activeAgents":0,"agents":[],
         "day":{"tokens":0,"costUsd":0,"unpriced":false}}
        """
        let s = try WidgetSnapshot.decode(Data(json.utf8))
        XCTAssertEqual(Int(s.generatedAt.timeIntervalSince1970), 1_789_061_298)
        XCTAssertNil(s.primary)
    }

    /// With the account link on, the measured 5h window wins the headline.
    func testMeasuredQuotaWinsOverEstimate() throws {
        let s = try fixture()
        let q = try XCTUnwrap(s.measured)
        XCTAssertEqual(q.id, "five_hour")
        XCTAssertEqual(q.percentLeft, 80)
        XCTAssertEqual(q.severity, .ok)
        XCTAssertEqual(Format.headline(for: q), "80% left")
        XCTAssertNil(s.quota?.first { $0.id == "extra_usage" }?.resetsAt)
        XCTAssertTrue(Format.caveat(for: q).hasPrefix("Anthropic · "))
        XCTAssertEqual(s.account?.token, "ok")
    }

    /// A spend cap must show the money, not only a percentage.
    func testSpendCapCarriesRealAmounts() throws {
        let extra = try XCTUnwrap(try fixture().quota?.first { $0.id == "extra_usage" })
        XCTAssertEqual(extra.amount, QuotaAmount(used: 39.3, limit: 100, unit: "usd", currency: "USD"))
        XCTAssertEqual(Format.amount(extra.amount), "$39.30 of $100.00")
        // The caveat line prefers the amount over the provider name.
        XCTAssertTrue(Format.caveat(for: extra).hasPrefix("$39.30 of $100.00 · "))
        // Rolling windows have no amount and keep the provider caption.
        let fiveHour = try XCTUnwrap(try fixture().measured)
        XCTAssertNil(fiveHour.amount)
        XCTAssertTrue(Format.caveat(for: fiveHour).hasPrefix("Anthropic · "))
    }

    func testAmountFormatting() {
        XCTAssertEqual(Format.amount(QuotaAmount(used: 137, limit: 500, unit: "requests")), "137 of 500 requests")
        XCTAssertEqual(Format.amount(QuotaAmount(used: 12.34, limit: nil, unit: "usd")), "$12.34 used")
        XCTAssertNil(Format.amount(nil))
    }

    /// An older collector without `quota` still decodes, and falls back to the estimate.
    func testQuotaIsOptional() throws {
        let json = """
        {"generatedAt":"2026-09-10T17:28:18Z","windows":[],"activeAgents":0,"agents":[],
         "day":{"tokens":0,"costUsd":0,"unpriced":false}}
        """
        let s = try WidgetSnapshot.decode(Data(json.utf8))
        XCTAssertNil(s.quota)
        XCTAssertNil(s.measured)
        let empty = try WidgetSnapshot.decode(Data(json.replacingOccurrences(of: "\"windows\":[]", with: "\"windows\":[],\"quota\":[]").utf8))
        XCTAssertNil(empty.measured)
    }

    func testAgentRowsStayDistinctWhenIdsCollide() throws {
        let s = try fixture()
        // Both rows have agentId "main"; the Identifiable id must still differ.
        XCTAssertNotEqual(s.agents[0].id, s.agents[1].id)
        XCTAssertTrue(s.agents[0].isActive)
        XCTAssertFalse(s.agents[1].isActive)
    }
}

final class FormatTests: XCTestCase {
    func testCompactTokens() {
        XCTAssertEqual(Format.compactTokens(4_688_770), "4.7M")
        XCTAssertEqual(Format.compactTokens(12_400), "12k")
        XCTAssertEqual(Format.compactTokens(999), "999")
        XCTAssertEqual(Format.compactTokens(0), "0")
    }

    func testUsdMarksUnpricedAsFloor() {
        XCTAssertEqual(Format.usd(3.180507, unpriced: false), "$3.18")
        XCTAssertEqual(Format.usd(3.180507, unpriced: true), "≥ $3.18")
        XCTAssertEqual(Format.usd(0.004, unpriced: false), "<$0.01")
        XCTAssertEqual(Format.usd(0, unpriced: false), "$0.00")
    }

    func testCountdown() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(Format.countdown(to: now.addingTimeInterval(3 * 3600 + 12 * 60), from: now), "3h 12m")
        XCTAssertEqual(Format.countdown(to: now.addingTimeInterval(42 * 60), from: now), "42m")
        XCTAssertEqual(Format.countdown(to: now.addingTimeInterval(30), from: now), "now")
        XCTAssertEqual(Format.countdown(to: now.addingTimeInterval(-500), from: now), "now")
        XCTAssertEqual(Format.countdown(to: now.addingTimeInterval(3 * 86400 + 5 * 3600), from: now), "3d 5h")
    }

    func testSeverityThresholdsMatchTray() {
        func w(_ f: Double?) -> UsageWindow {
            UsageWindow(id: "x", label: "x", used: 0, limit: f == nil ? nil : 1, fraction: f, unit: "tokens",
                        resetsAt: Date(), projectedExhaustion: nil, burnRatePerHour: 0, estimate: true)
        }
        XCTAssertEqual(w(nil).severity, .unknown)
        XCTAssertEqual(w(0.69).severity, .ok)
        XCTAssertEqual(w(0.7).severity, .warning)
        XCTAssertEqual(w(0.9).severity, .critical)
        XCTAssertEqual(w(1.0).percentLeft, 0)
    }

    func testShortModel() {
        XCTAssertEqual(Format.shortModel("claude-opus-5"), "opus 5")
        XCTAssertEqual(Format.shortModel("claude-haiku-4-5-20251001"), "haiku 4 5")
        XCTAssertEqual(Format.shortModel("gpt-5-codex"), "gpt 5 codex")
    }
}
