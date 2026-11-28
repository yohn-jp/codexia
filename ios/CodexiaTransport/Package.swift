// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CodexiaTransport",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CodexiaAPI", targets: ["CodexiaAPI"]),
        .library(name: "CodexiaTransport", targets: ["CodexiaTransport"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.14.4"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", exact: "1.13.4"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", exact: "1.4.0"),
        .package(url: "https://github.com/apple/swift-http-types", exact: "1.8.0"),
    ],
    targets: [
        .target(name: "CodexiaAPI", dependencies: [
            .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            .product(name: "HTTPTypes", package: "swift-http-types"),
        ]),
        .target(name: "CodexiaTransport", dependencies: [
            "CodexiaAPI",
            .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            .product(name: "HTTPTypes", package: "swift-http-types"),
        ]),
        .testTarget(name: "CodexiaTransportTests", dependencies: [
            "CodexiaTransport",
            "CodexiaAPI",
            .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            .product(name: "HTTPTypes", package: "swift-http-types"),
        ]),
    ]
)
