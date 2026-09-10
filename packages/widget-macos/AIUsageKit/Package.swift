// swift-tools-version: 5.9
import PackageDescription

// Everything the widget and its host app share: the /api/widget payload
// model, the localhost client and the number formatting. Kept as a plain
// package so the logic is testable with `swift test` and no Xcode project.
let package = Package(
    name: "AIUsageKit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "AIUsageKit", targets: ["AIUsageKit"]),
    ],
    targets: [
        .target(name: "AIUsageKit"),
        .testTarget(
            name: "AIUsageKitTests",
            dependencies: ["AIUsageKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
