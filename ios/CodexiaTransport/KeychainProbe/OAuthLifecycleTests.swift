import CryptoKit
import Foundation
import os
import Testing
@testable import CodexiaTransport

@Test func nativeOAuthExchangesCodeRestoresRotatesAndRevokes() async throws {
    let origin = try #require(URL(string: "https://oauth-\(UUID().uuidString.lowercased()).example.test"))
    let config = try OAuthConfiguration(origin: origin, clientID: "registered-ios")
    let fixture = OAuthLifecycleFixture(config: config)
    let session = LifecycleProtocol.install(fixture)
    let keychain = RefreshKeychain(configuration: config)
    defer {
        session.invalidateAndCancel()
        LifecycleProtocol.remove(fixture)
        try? keychain.delete()
    }

    let original = NativeOAuthSession(configuration: config, session: session)
    let subject = try await original.signIn { try fixture.authorize($0) }
    #expect(subject == "fixture-author")
    #expect(try keychain.read() == "fixture.refresh.initial")
    #expect(try await original.subject() == subject)

    let restored = NativeOAuthSession(configuration: config, session: session)
    async let first = restored.subject()
    async let second = restored.subject()
    let subjects = try await [first, second]
    #expect(subjects == [subject, subject])
    #expect(fixture.refreshCount == 1)
    #expect(try keychain.read() == "fixture.refresh.rotated")

    let revoked = try await restored.signOut()
    guard case .confirmed = revoked else {
        Issue.record("Expected the provider to accept both revocations")
        return
    }
    #expect(fixture.revokedTokenKinds == ["refresh_token", "access_token"])
    #expect(try keychain.read() == nil)
    await #expect(throws: OAuthError.signInRequired) { try await restored.subject() }
}

private final class OAuthLifecycleFixture: Sendable {
    enum Failure: Error { case unexpectedRequest }
    private struct State {
        let key = P256.Signing.PrivateKey()
        var challenge: String?
        var refreshCount = 0
        var issuedAccessToken: String?
        var revokedTokenKinds: [String] = []
    }

    let config: OAuthConfiguration
    private let state = OSAllocatedUnfairLock(uncheckedState: State())
    private let scope = "codexia:api offline_access"

    init(config: OAuthConfiguration) { self.config = config }
    var refreshCount: Int { state.withLock { $0.refreshCount } }
    var revokedTokenKinds: [String] { state.withLock { $0.revokedTokenKinds } }

    func authorize(_ url: URL) throws -> URL {
        guard url.path == config.authorizationEndpoint.path,
              let fields = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { throw Failure.unexpectedRequest }
        let query = Dictionary(uniqueKeysWithValues: fields.compactMap { field in field.value.map { (field.name, $0) } })
        guard query["client_id"] == config.clientID, query["response_type"] == "code",
              query["resource"] == config.resource.absoluteString, query["code_challenge_method"] == "S256",
              query["redirect_uri"] == OAuthConfiguration.redirectURI, query["scope"] == "codexia:api offline_access openid",
              let challenge = query["code_challenge"], let expectedState = query["state"],
              query["nonce"]?.isEmpty == false else { throw Failure.unexpectedRequest }
        state.withLock { $0.challenge = challenge }
        return URL(string: "\(OAuthConfiguration.redirectURI)?code=fixture-code&state=\(expectedState)")!
    }

    func respond(to request: URLRequest) throws -> Data {
        guard let url = request.url, request.value(forHTTPHeaderField: "Cookie") == nil else {
            throw Failure.unexpectedRequest
        }
        return try state.withLock { state in
            switch (request.httpMethod, url.path) {
            case ("GET", config.metadataEndpoint.path):
                return try json([
                    "issuer": config.issuer.absoluteString,
                    "authorization_endpoint": config.authorizationEndpoint.absoluteString,
                    "token_endpoint": config.tokenEndpoint.absoluteString,
                    "revocation_endpoint": config.revocationEndpoint.absoluteString,
                    "jwks_uri": config.jwksEndpoint.absoluteString,
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                    "scopes_supported": ["codexia:api", "openid", "offline_access"],
                ])
            case ("GET", config.jwksEndpoint.path):
                let bytes = state.key.publicKey.x963Representation
                return try json(["keys": [["kid": "fixture", "kty": "EC", "crv": "P-256", "alg": "ES256",
                                           "x": base64URL(bytes[1..<33]), "y": base64URL(bytes[33..<65])]]])
            case ("POST", config.tokenEndpoint.path):
                let fields = try form(request)
                guard fields["client_id"] == config.clientID,
                      fields["resource"] == config.resource.absoluteString, fields["client_secret"] == nil else {
                    throw Failure.unexpectedRequest
                }
                let refresh: String
                switch fields["grant_type"] {
                case "authorization_code":
                    guard fields["code"] == "fixture-code", fields["redirect_uri"] == OAuthConfiguration.redirectURI,
                          let verifier = fields["code_verifier"],
                          base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))) == state.challenge else {
                        throw Failure.unexpectedRequest
                    }
                    refresh = "fixture.refresh.initial"
                case "refresh_token":
                    guard fields["refresh_token"] == "fixture.refresh.initial" else { throw Failure.unexpectedRequest }
                    state.refreshCount += 1
                    refresh = "fixture.refresh.rotated"
                default:
                    throw Failure.unexpectedRequest
                }
                let access = try bearer(using: state.key, includeUserInfo: fields["grant_type"] == "authorization_code")
                state.issuedAccessToken = access
                return try json(["access_token": access, "refresh_token": refresh, "token_type": "Bearer",
                                 "scope": scope, "expires_in": 300])
            case ("POST", config.revocationEndpoint.path):
                let fields = try form(request)
                guard fields["client_id"] == config.clientID, let hint = fields["token_type_hint"],
                      let token = fields["token"],
                      (hint == "refresh_token" && token == "fixture.refresh.rotated")
                        || (hint == "access_token" && token == state.issuedAccessToken) else {
                    throw Failure.unexpectedRequest
                }
                state.revokedTokenKinds.append(hint)
                return Data()
            default:
                throw Failure.unexpectedRequest
            }
        }
    }

    private func bearer(using key: P256.Signing.PrivateKey, includeUserInfo: Bool) throws -> String {
        let now = Int(Date().timeIntervalSince1970)
        let header = try json(["alg": "ES256", "typ": "at+jwt", "kid": "fixture"])
        let resource = config.resource.absoluteString
        let audience: Any = includeUserInfo ? [resource, config.issuer.appending(path: "oauth2/userinfo").absoluteString] : resource
        let payload = try json(["iss": config.issuer.absoluteString, "aud": audience,
                                "client_id": config.clientID, "sub": "fixture-author", "jti": UUID().uuidString,
                                "scope": scope, "iat": now, "exp": now + 300])
        let signed = "\(base64URL(header)).\(base64URL(payload))"
        return "\(signed).\(base64URL(try key.signature(for: Data(signed.utf8)).rawRepresentation))"
    }

    private func form(_ request: URLRequest) throws -> [String: String] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream, data.isEmpty {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let size = stream.read(&buffer, maxLength: buffer.count)
                guard size >= 0 else { throw Failure.unexpectedRequest }
                if size == 0 { break }
                data.append(contentsOf: buffer.prefix(size))
            }
        }
        var parts = URLComponents()
        parts.percentEncodedQuery = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "+", with: "%20")
        return Dictionary(uniqueKeysWithValues: (parts.queryItems ?? []).compactMap { item in
            item.value.map { (item.name, $0) }
        })
    }

    private func json(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value)
    }
}

private final class LifecycleProtocol: URLProtocol {
    private static let fixtures = OSAllocatedUnfairLock(initialState: [String: OAuthLifecycleFixture]())

    static func install(_ fixture: OAuthLifecycleFixture) -> URLSession {
        Self.fixtures.withLock { $0[fixture.config.origin.host!] = fixture }
        return isolatedSession(protocolClasses: [Self.self])
    }

    static func remove(_ fixture: OAuthLifecycleFixture) {
        Self.fixtures.withLock { _ = $0.removeValue(forKey: fixture.config.origin.host!) }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        guard let host = request.url?.host else { return false }
        return fixtures.withLock { $0[host] != nil }
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let url = request.url, let host = url.host,
                  let fixture = Self.fixtures.withLock({ $0[host] }) else {
                throw URLError(.unsupportedURL)
            }
            let data = try fixture.respond(to: request)
            let http = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
