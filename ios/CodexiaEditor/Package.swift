// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodexiaEditor",
    platforms: [.iOS(.v16)],
    products: [.library(name: "CodexiaEditor", targets: ["CodexiaEditor"])],
    targets: [
        .target(name: "CodexiaEditor"),
        .testTarget(name: "CodexiaEditorTests", dependencies: ["CodexiaEditor"]),
    ]
)
