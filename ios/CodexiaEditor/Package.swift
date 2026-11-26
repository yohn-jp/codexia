// swift-tools-version: 6.2
import PackageDescription

#if os(Linux)
let cryptoPackages: [Package.Dependency] = [.package(url: "https://github.com/apple/swift-crypto", exact: "3.12.3")]
let cryptoProducts: [Target.Dependency] = [.product(name: "Crypto", package: "swift-crypto")]
#else
let cryptoPackages: [Package.Dependency] = []
let cryptoProducts: [Target.Dependency] = []
#endif

let package = Package(
    name: "CodexiaEditor",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "CodexiaEditor", targets: ["CodexiaEditor"])],
    dependencies: [
        .package(path: "../CodexiaTransport"),
    ] + cryptoPackages + [
        .package(url: "https://github.com/apple/swift-http-types", exact: "1.7.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", exact: "1.13.4"),
    ],
    targets: [
        .target(name: "CodexiaEditor", dependencies: [
            .product(name: "CodexiaAPI", package: "CodexiaTransport"),
            .product(name: "CodexiaTransport", package: "CodexiaTransport"),
        ] + cryptoProducts),
        .testTarget(name: "CodexiaEditorTests", dependencies: [
            "CodexiaEditor",
            .product(name: "CodexiaAPI", package: "CodexiaTransport"),
            .product(name: "CodexiaTransport", package: "CodexiaTransport"),
            .product(name: "HTTPTypes", package: "swift-http-types"),
            .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
        ]),
    ]
)
