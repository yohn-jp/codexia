#!/usr/bin/env swift
import Foundation
import Darwin

struct Failure: Error, CustomStringConvertible {
    let description: String
}

func run(_ executable: String, _ arguments: [String]) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let output = Pipe()
    let errors = Pipe()
    process.standardOutput = output
    process.standardError = errors
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let errorData = errors.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw Failure(description: String(decoding: errorData, as: UTF8.self))
    }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

func runData(_ executable: String, _ arguments: [String]) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let output = Pipe()
    let errors = Pipe()
    process.standardOutput = output
    process.standardError = errors
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let errorData = errors.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw Failure(description: String(decoding: errorData, as: UTF8.self))
    }
    return data
}

func fileHash(_ url: URL) throws -> String {
    _ = try Data(contentsOf: url)
    return try run("/usr/bin/shasum", ["-a", "256", url.path]).split(separator: " ").first.map(String.init) ?? ""
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw Failure(description: message) }
}

func main() throws {
    let arguments = CommandLine.arguments
    guard arguments.count == 7 else {
        throw Failure(description: "Usage: package-unsigned-ipa.swift APP OUT_DIR SOURCE_SHA XCODE_VERSION SWIFT_VERSION PACKAGE_RESOLVED")
    }
    let app = URL(fileURLWithPath: arguments[1]).standardizedFileURL
    let output = URL(fileURLWithPath: arguments[2]).standardizedFileURL
    let expectedSourceSHA = arguments[3]
    let xcodeVersion = arguments[4]
    let swiftVersion = arguments[5]
    let resolved = URL(fileURLWithPath: arguments[6]).standardizedFileURL

    try require(app.pathExtension == "app", "APP must point to the archived .app bundle")
    try require(FileManager.default.fileExists(atPath: app.path), "The archived .app bundle is missing")
    let sourceSHA = try run("/usr/bin/git", ["rev-parse", "HEAD"])
    try require(sourceSHA == expectedSourceSHA, "Source SHA mismatch: expected \(expectedSourceSHA), found \(sourceSHA)")

    let infoURL = app.appendingPathComponent("Info.plist")
    let infoData = try Data(contentsOf: infoURL)
    guard let info = try PropertyListSerialization.propertyList(from: infoData, format: nil) as? [String: Any] else {
        throw Failure(description: "The app Info.plist is invalid")
    }
    let bundleID = info["CFBundleIdentifier"] as? String ?? ""
    let minimumOS = info["MinimumOSVersion"].map { String(describing: $0) } ?? ""
    let platformName = info["DTPlatformName"] as? String ?? ""
    let platformVersion = info["DTPlatformVersion"].map { String(describing: $0) } ?? ""
    let apiOrigin = info["CodexiaAPIOrigin"] as? String ?? ""
    let oauthClientID = info["CodexiaOAuthClientID"] as? String ?? ""
    let executableName = info["CFBundleExecutable"] as? String ?? ""
    let executable = app.appendingPathComponent(executableName)
    try require(bundleID == "jp.yohn.codexia", "Unexpected bundle identifier: \(bundleID)")
    try require(minimumOS == "27.0", "Expected minimum iOS 27.0, found \(minimumOS)")
    try require(platformName == "iphoneos", "Expected an iPhoneOS device archive, found \(platformName)")
    try require(platformVersion.hasPrefix("27."), "Expected iOS SDK 27.x, found \(platformVersion)")
    try require(FileManager.default.fileExists(atPath: executable.path), "The app executable is missing")
    let architectures = try run("/usr/bin/lipo", ["-archs", executable.path]).split(separator: " ").map(String.init)
    try require(architectures == ["arm64"], "Expected an ARM64-only executable, found \(architectures)")
    let buildVersion = try run("/usr/bin/xcrun", ["vtool", "-show-build", executable.path])
    try require(buildVersion.range(of: #"(?m)^\s*platform IOS\s*$"#, options: .regularExpression) != nil,
                "The Mach-O platform is not iOS")
    try require(buildVersion.range(of: #"(?m)^\s*minos 27\.0\s*$"#, options: .regularExpression) != nil,
                "The Mach-O minimum iOS version is not 27.0")
    let loadCommands = try run("/usr/bin/otool", ["-l", executable.path])
    try require(!loadCommands.contains("LC_CODE_SIGNATURE"), "The executable contains a code signature or entitlements")
    if let appFiles = FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil) {
        for case let file as URL in appFiles {
            let name = file.lastPathComponent
            try require(name != "_CodeSignature" && name != "CodeResources" && name != "embedded.mobileprovision" && name != "archived-expanded-entitlements.xcent",
                        "Unsigned app unexpectedly contains signing material: \(file.path)")
        }
    }
    try require(FileManager.default.fileExists(atPath: resolved.path), "The committed Swift package lock is missing")
    let lockData = try Data(contentsOf: resolved)
    guard let lock = try JSONSerialization.jsonObject(with: lockData) as? [String: Any],
          lock["version"] as? Int == 3,
          let pins = lock["pins"] as? [[String: Any]], !pins.isEmpty else {
        throw Failure(description: "The committed Swift package lock is invalid or empty")
    }

    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let ipa = output.appendingPathComponent("Codexia-native-unsigned.ipa")
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("codexia-ipa-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: temporary) }
    let payload = temporary.appendingPathComponent("Payload", isDirectory: true)
    try FileManager.default.createDirectory(at: payload, withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: app, to: payload.appendingPathComponent(app.lastPathComponent))
    _ = try run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", payload.path, ipa.path])

    let entries = try run("/usr/bin/unzip", ["-Z1", ipa.path]).split(separator: "\n").map(String.init)
    let prefix = "Payload/\(app.lastPathComponent)/"
    try require(entries.contains(where: { $0.hasPrefix(prefix) }), "The IPA is missing its Payload app")
    try require(entries.allSatisfy { $0 == "Payload/" || $0.hasPrefix(prefix) }, "The IPA contains unexpected payload entries")
    try require(!entries.contains(where: { $0.hasSuffix("embedded.mobileprovision") || $0.contains("/_CodeSignature/") || $0.hasSuffix("CodeResources") || $0.hasSuffix("archived-expanded-entitlements.xcent") }), "The IPA contains signing material")
    let packagedInfoData = try runData("/usr/bin/unzip", ["-p", ipa.path, "Payload/\(app.lastPathComponent)/Info.plist"])
    guard let packaged = try PropertyListSerialization.propertyList(from: packagedInfoData, format: nil) as? [String: Any] else {
        throw Failure(description: "The IPA's packaged Info.plist is invalid")
    }
    try require((packaged["CFBundleIdentifier"] as? String) == bundleID, "The packaged bundle identifier changed")
    try require((packaged["DTPlatformName"] as? String) == "iphoneos", "The IPA does not contain an iPhoneOS device build")
    try require(packagedInfoData == infoData, "The packaged device settings changed")
    let environment = ProcessInfo.processInfo.environment
    try require(apiOrigin == (environment["EXPECTED_API_ORIGIN"] ?? "")
                && oauthClientID == (environment["EXPECTED_OAUTH_CLIENT_ID"] ?? ""),
                "The archived public OAuth configuration does not match the requested build")
    let configured = !apiOrigin.isEmpty

    let manifest: [String: Any] = [
        "artifact": ipa.lastPathComponent,
        "artifact_sha256": try fileHash(ipa),
        "source_sha": sourceSHA,
        "xcode_version": xcodeVersion,
        "swift_version": swiftVersion,
        "bundle_identifier": bundleID,
        "minimum_ios": minimumOS,
        "platform": platformName,
        "sdk_version": platformVersion,
        "architectures": architectures,
        "mach_o_build": buildVersion,
        "product_configuration": configured ? "configured" : "unconfigured verification artifact",
        "api_origin": apiOrigin,
        "oauth_client_id": oauthClientID,
        "signing": "unsigned; no embedded provisioning profile or code signature",
        "signed_entitlements": [],
        "resolved_dependencies_sha256": try fileHash(resolved),
        "ipa_entries": entries,
    ]
    let manifestURL = output.appendingPathComponent("manifest.json")
    let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
    try (manifestData + Data([0x0A])).write(to: manifestURL)
    print(String(decoding: manifestData, as: UTF8.self))
}

do {
    try main()
} catch {
    fputs("IPA validation failed: \(error)\n", stderr)
    exit(EXIT_FAILURE)
}
