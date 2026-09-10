import Foundation

/// Fetches `/api/widget` from the local collector.
///
/// Why HTTP to localhost rather than reading `~/.ai-usage-widget` directly:
/// a widget extension is sandboxed, so it cannot open files in the home
/// directory, and sharing a container via App Groups needs a paid Apple team.
/// A loopback request only needs the `network.client` entitlement, keeps the
/// widget dumb, and reuses the collector's aggregation. Nothing leaves the
/// machine: the URL is hard-wired to 127.0.0.1.
public struct UsageClient: Sendable {
    public enum Failure: Error, Equatable, Sendable {
        /// Nothing answered on the port: the collector is not running.
        case offline
        /// Answered, but not with a payload we understand (version skew).
        case badPayload(String)
    }

    public let port: Int

    /// Port comes from the bundle's `AIUsageWidgetPort` Info.plist key so a
    /// non-default collector port only needs a plist edit, not a code change.
    public init(port: Int? = nil, bundle: Bundle = .main) {
        if let port { self.port = port; return }
        if let s = bundle.object(forInfoDictionaryKey: "AIUsageWidgetPort") as? String, let p = Int(s) {
            self.port = p
        } else if let p = bundle.object(forInfoDictionaryKey: "AIUsageWidgetPort") as? Int {
            self.port = p
        } else {
            self.port = 4321
        }
    }

    public var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }
    /// Where a tap on the widget goes: the full dashboard.
    public var dashboardURL: URL { URL(string: "http://localhost:\(port)")! }

    public func fetch() async -> Result<WidgetSnapshot, Failure> {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/widget"))
        req.timeoutInterval = 3
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return .failure(.badPayload("HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)"))
            }
            return .success(try WidgetSnapshot.decode(data))
        } catch let e as DecodingError {
            return .failure(.badPayload(String(describing: e)))
        } catch {
            return .failure(.offline)
        }
    }
}
