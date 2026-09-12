import Foundation

/// Number/time formatting shared by the widget families. Pure functions so
/// they can be unit-tested without WidgetKit.
public enum Format {
    /// 4_688_770 -> "4.7M", 12_400 -> "12k", 800 -> "800". Matches the
    /// collector's `compact()` so the tray and the widget agree.
    public static func compactTokens(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return "\(Int((n / 1_000).rounded()))k" }
        return "\(Int(n.rounded()))"
    }

    /// "$3.18", or "≥ $3.18" when some events were unpriced (a floor, not a total).
    public static func usd(_ v: Double, unpriced: Bool) -> String {
        let s = v < 0.01 && v > 0 ? "<$0.01" : String(format: "$%.2f", v)
        return unpriced ? "≥ \(s)" : s
    }

    /// "3h 12m" / "42m" / "now". Never negative: a window that already ended
    /// reads as "now", which is what the next refresh will show anyway.
    public static func countdown(to date: Date, from now: Date = Date()) -> String {
        let secs = max(0, Int(date.timeIntervalSince(now)))
        if secs < 60 { return "now" }
        let h = secs / 3600
        let m = (secs % 3600) / 60
        if h >= 48 { return "\(h / 24)d \(h % 24)h" }
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }

    /// Headline for a window: "41% left" with a limit, "4.7M used" without.
    public static func headline(for w: UsageWindow) -> String {
        if let p = w.percentLeft { return "\(p)% left" }
        return "\(compactTokens(w.used)) used"
    }

    /// One-line caveat every window carries, since it is an estimate.
    public static func caveat(for w: UsageWindow) -> String {
        w.limit == nil ? "no limit set · est." : "est. · this device"
    }

    /// Headline for a provider-measured window: always a percent, it is one.
    public static func headline(for q: QuotaWindow) -> String {
        "\(q.percentLeft)% left"
    }

    /// The measured caveat is *when*, not *whether*: "Anthropic · 13:28".
    /// When the provider reports real amounts, those replace the provider
    /// name: "$70.74 of $100 · 13:28" says more in the same space.
    public static func caveat(for q: QuotaWindow) -> String {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        let when = f.string(from: q.measuredAt)
        if let a = amount(q.amount) { return "\(a) · \(when)" }
        return "\(q.provider.capitalized) · \(when)"
    }

    /// "$70.74 of $100.00", "137 of 500 requests", or nil.
    /// Mirrors `formatQuotaAmount` in core so the surfaces agree.
    public static func amount(_ a: QuotaAmount?) -> String? {
        guard let a else { return nil }
        func one(_ n: Double) -> String {
            if a.unit == "usd" {
                let f = NumberFormatter()
                f.numberStyle = .currency
                f.currencyCode = a.currency ?? "USD"
                f.maximumFractionDigits = 2
                return f.string(from: NSNumber(value: n)) ?? String(format: "%.2f", n)
            }
            return NumberFormatter.localizedString(from: NSNumber(value: n), number: .decimal)
        }
        let noun = a.unit == "requests" ? " requests" : ""
        guard let limit = a.limit else { return "\(one(a.used))\(noun) used" }
        return "\(one(a.used)) of \(one(limit))\(noun)"
    }

    /// Short model label: "claude-opus-5" -> "opus 5", "gpt-5-codex" -> "gpt-5-codex".
    public static func shortModel(_ model: String) -> String {
        var m = model
        if m.hasPrefix("claude-") { m.removeFirst("claude-".count) }
        // drop trailing date stamps like -20251001
        if let r = m.range(of: #"-\d{8}$"#, options: .regularExpression) { m.removeSubrange(r) }
        return m.replacingOccurrences(of: "-", with: " ")
    }
}
