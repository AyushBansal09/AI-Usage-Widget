import SwiftUI
import WidgetKit
import AIUsageKit

@main
struct AIUsageWidgetBundle: WidgetBundle {
    var body: some Widget {
        AIUsageWidget()
    }
}

/// The one widget: "how much of my window is left, and what are my agents
/// doing". Small = the number; medium = the number plus the agents.
struct AIUsageWidget: Widget {
    static let kind = "dev.ayushbansal.AIUsageWidget.usage"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: UsageProvider()) { entry in
            UsageWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(UsageClient().dashboardURL)
        }
        .configurationDisplayName("AI Usage")
        .description("Tokens left in your Claude window and what each agent is doing. Reads only from the local ai-usage-widget collector.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
