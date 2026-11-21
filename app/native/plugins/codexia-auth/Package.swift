// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CodexiaCapacitorAuth",
    platforms: [.iOS(.v15)],
    products: [.library(name: "CodexiaCapacitorAuth", targets: ["CodexiaCapacitorAuth"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.2"),
        .package(url: "https://github.com/openid/AppAuth-iOS.git", exact: "3.0.0"),
    ],
    targets: [
        .target(name: "CodexiaCapacitorAuth", dependencies: [
            .product(name: "Capacitor", package: "capacitor-swift-pm"),
            .product(name: "AppAuth", package: "AppAuth-iOS"),
        ], path: "ios"),
    ]
)
