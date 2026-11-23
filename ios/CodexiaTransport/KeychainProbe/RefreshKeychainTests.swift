#if os(iOS)
import Foundation
import Testing
@testable import CodexiaTransport

@Test func refreshKeychainRotatesAndScopesCredentials() throws {
    let origin = try #require(URL(string: "https://keychain.example.test"))
    let client = UUID().uuidString
    let first = RefreshKeychain(configuration: try OAuthConfiguration(origin: origin, clientID: client))
    let other = RefreshKeychain(configuration: try OAuthConfiguration(origin: origin, clientID: client + "-other"))
    defer {
        try? first.delete()
        try? other.delete()
    }
    #expect(try first.read() == nil)
    try first.write("original.refresh")
    #expect(try first.read() == "original.refresh")
    #expect(try other.read() == nil)
    try first.write("rotated.refresh")
    #expect(try first.read() == "rotated.refresh")
    try first.delete()
    #expect(try first.read() == nil)
}
#endif
