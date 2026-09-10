import WidgetKit
import AIUsageKit

struct UsageEntry: TimelineEntry {
    enum State {
        /// Gallery preview / first paint: synthetic numbers, never real usage.
        case placeholder
        case loaded(WidgetSnapshot)
        /// Nothing on the port. The host app or `npx ai-usage-widget` fixes it.
        case offline
        /// The collector answered with something we could not decode.
        case error(String)
    }

    let date: Date
    let state: State
}

/// One request per refresh. WidgetKit decides when refreshes actually happen
/// (it budgets them per day), so `.after` is a request, not a promise: the
/// number on screen can be a few minutes stale, and the view says so.
struct UsageProvider: TimelineProvider {
    static let refreshInterval: TimeInterval = 5 * 60

    func placeholder(in context: Context) -> UsageEntry {
        UsageEntry(date: Date(), state: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        if context.isPreview {
            completion(UsageEntry(date: Date(), state: .loaded(.sample)))
            return
        }
        Task { completion(await load()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        Task {
            let entry = await load()
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(Self.refreshInterval))))
        }
    }

    private func load() async -> UsageEntry {
        switch await UsageClient().fetch() {
        case .success(let snap): return UsageEntry(date: Date(), state: .loaded(snap))
        case .failure(.offline): return UsageEntry(date: Date(), state: .offline)
        case .failure(.badPayload(let why)): return UsageEntry(date: Date(), state: .error(why))
        }
    }
}
