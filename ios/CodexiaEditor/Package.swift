// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CodexiaEditor",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "CodexiaEditor", targets: ["CodexiaEditor"])],
    dependencies: [
        .package(path: "../CodexiaTransport"),
    ],
    targets: [
        .target(name: "CodexiaEditor", dependencies: [
            .product(name: "CodexiaAPI", package: "CodexiaTransport"),
            .product(name: "CodexiaTransport", package: "CodexiaTransport"),
        ]),
        .testTarget(name: "CodexiaEditorTests", dependencies: [
            "CodexiaEditor",
            .product(name: "CodexiaAPI", package: "CodexiaTransport"),
            .product(name: "CodexiaTransport", package: "CodexiaTransport"),
        ]),
    ]
)
