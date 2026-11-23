// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodexiaTransport",
    platforms: [.iOS(.v17)],
    products: [.library(name: "CodexiaTransport", targets: ["CodexiaTransport"])],
    targets: [
        .target(name: "CodexiaTransport"),
        .testTarget(name: "CodexiaTransportTests", dependencies: ["CodexiaTransport"]),
    ]
)
