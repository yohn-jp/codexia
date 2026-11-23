import Foundation
import Testing
@testable import CodexiaTransport

private let config = try! OAuthConfiguration(origin: URL(string: "https://api.example.test")!, clientID: "registered-ios")

@Test func buildsPKCEAuthorizationAndChecksExactRedirectStateAndIssuer() throws {
    let url = try config.authorizationURL(state: "state", nonce: "nonce", challenge: "challenge")
    let parts = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
    let fields = Dictionary(uniqueKeysWithValues: try #require(parts.queryItems).map { ($0.name, $0.value) })
    #expect(parts.path == "/api/auth/oauth2/authorize")
    #expect(fields["code_challenge_method"] == "S256")
    #expect(fields["code_challenge"] == "challenge")
    #expect(fields["nonce"] == "nonce")
    #expect(fields["resource"] == "https://api.example.test/api")
    #expect(fields["redirect_uri"] == OAuthConfiguration.redirectURI)
    #expect(fields["scope"] == "codexia:api offline_access openid")
    #expect(try config.code(from: URL(string: "jp.yohn.codexia:/oauth2redirect?state=state&code=issued")!,
                           expectedState: "state") == "issued")
    for url in [
        "jp.yohn.codexia://other/oauth2redirect?state=state&code=issued",
        "jp.yohn.codexia:/other?state=state&code=issued",
        "jp.yohn.codexia:/oauth2redirect?state=wrong&code=issued",
        "jp.yohn.codexia:/oauth2redirect?state=state&state=wrong&code=issued",
        "jp.yohn.codexia:/oauth2redirect?state=state&code=issued&code=duplicate",
        "jp.yohn.codexia:/oauth2redirect?state=state&code=issued&iss=https://wrong.example.test",
        "jp.yohn.codexia:/oauth2redirect?state=state&code=issued#error",
    ] {
        #expect(throws: OAuthError.invalidCallback) {
            try config.code(from: URL(string: url)!, expectedState: "state")
        }
    }
}

@Test func authorizationURLPreservesAnOpaqueClientID() throws {
    let plusClient = try OAuthConfiguration(origin: config.origin, clientID: "registered+ios")
    let url = try plusClient.authorizationURL(state: "state", nonce: "nonce", challenge: "challenge")
    #expect(url.absoluteString.contains("client_id=registered%2Bios"))
}

@Test func rejectsUntrustedProviderMetadata() throws {
    let metadata = """
        {"issuer":"https://api.example.test/api/auth",        "authorization_endpoint":"https://api.example.test/api/auth/oauth2/authorize",        "token_endpoint":"https://api.example.test/api/auth/oauth2/token",        "jwks_uri":"https://api.example.test/api/auth/jwks",        "response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],        "code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],        "scopes_supported":["codexia:api","openid","offline_access"]}
        """
    let decoder = JSONDecoder()
    try decoder.decode(OAuthMetadata.self, from: Data(metadata.utf8)).validate(for: config)
    for (from, to) in [("/oauth2/token", "/oauth2/other"), ("S256", "plain"), ("offline_access", "email")] {
        let invalid = metadata.replacingOccurrences(of: from, with: to)
        #expect(throws: OAuthError.invalidMetadata) {
            try decoder.decode(OAuthMetadata.self, from: Data(invalid.utf8)).validate(for: config)
        }
    }
}

#if canImport(CryptoKit)
import CryptoKit

@Test func accessTokenMustBeSignedForAPIResourceAndClient() throws {
    let now = Date(timeIntervalSince1970: 2_000)
    let key = P256.Signing.PrivateKey()
    let keys = signingKeys(key)
    let claims: [String: any Sendable] = [
        "iss": config.issuer.absoluteString, "aud": config.resource.absoluteString,
        "client_id": config.clientID, "sub": "author", "iat": 1_990, "exp": 2_300, "jti": "id",
        "scope": "codexia:api offline_access",
    ]
    func check(_ jwt: String) throws -> OAuthGrant {
        let token = OAuthTokenResponse(access_token: jwt, refresh_token: "rotation", id_token: nil,
                                       token_type: "Bearer", scope: "codexia:api offline_access", expires_in: 300)
        return try OAuthGrant(response: token, keys: keys, config: config, nonce: "nonce", now: now)
    }
    #expect(try check(signedJWT(type: "at+jwt", claims: claims, key: key)).subject == "author")

    let userInfo = config.issuer.appending(path: "oauth2/userinfo").absoluteString
    var withUserInfo = claims
    withUserInfo["aud"] = [userInfo, config.resource.absoluteString]
    #expect(try check(signedJWT(type: "at+jwt", claims: withUserInfo, key: key)).subject == "author")
    for audiences in [[userInfo], [config.resource.absoluteString, "https://foreign.example.test"],
                      [config.resource.absoluteString, config.resource.absoluteString]] {
        var altered = claims
        altered["aud"] = audiences
        #expect(throws: OAuthError.invalidToken) {
            try check(signedJWT(type: "at+jwt", claims: altered, key: key))
        }
    }
    for (name, value) in [("aud", "untrusted"), ("client_id", "other"), ("scope", "mcp:read"), ("iss", "wrong")] {
        var altered = claims
        altered[name] = value
        #expect(throws: OAuthError.invalidToken) {
            try check(signedJWT(type: "at+jwt", claims: altered, key: key))
        }
    }
    #expect(throws: OAuthError.invalidToken) {
        try check(signedJWT(type: "JWT", claims: claims, key: key))
    }
    #expect(throws: OAuthError.invalidToken) {
        try check(signedJWT(type: "at+jwt", claims: claims, key: P256.Signing.PrivateKey()))
    }
}

@Test func downstreamIdentityTokenMustMatchNonceAndAccessToken() throws {
    let now = Date(timeIntervalSince1970: 2_000)
    let key = P256.Signing.PrivateKey()
    let keys = signingKeys(key)
    let common: [String: any Sendable] = ["iss": config.issuer.absoluteString, "sub": "author", "iat": 1_990, "exp": 2_300]
    var accessClaims = common
    accessClaims["aud"] = config.resource.absoluteString
    accessClaims["client_id"] = config.clientID
    accessClaims["scope"] = "codexia:api offline_access openid"
    accessClaims["jti"] = "id"
    let access = try signedJWT(type: "at+jwt", claims: accessClaims, key: key)
    var identity = common
    identity["aud"] = config.clientID
    identity["nonce"] = "nonce"
    identity["at_hash"] = base64URL(Data(SHA256.hash(data: Data(access.utf8)).prefix(16)))
    let id = try signedJWT(type: "JWT", claims: identity, key: key)
    let token = OAuthTokenResponse(access_token: access, refresh_token: "rotation", id_token: id, token_type: "Bearer",
                                   scope: "codexia:api offline_access openid", expires_in: 300)
    #expect(try OAuthGrant(response: token, keys: keys, config: config, nonce: "nonce", now: now).accessToken == access)
    #expect(throws: OAuthError.invalidToken) {
        try OAuthGrant(response: token, keys: keys, config: config, nonce: "other", now: now)
    }
}

private func signingKeys(_ key: P256.Signing.PrivateKey) -> OAuthSigningKeys {
    let bytes = key.publicKey.x963Representation
    return .init(keys: [.init(kid: "kid", alg: "ES256", use: "sig", kty: "EC", crv: "P-256",
                             x: base64URL(bytes[1..<33]), y: base64URL(bytes[33..<65]))])
}

private func signedJWT(type: String, claims: [String: any Sendable], key: P256.Signing.PrivateKey) throws -> String {
    let header = try JSONSerialization.data(withJSONObject: ["typ": type, "alg": "ES256", "kid": "kid"])
    let body = try JSONSerialization.data(withJSONObject: claims)
    let signed = "\(base64URL(header)).\(base64URL(body))"
    let signature = try key.signature(for: Data(signed.utf8)).rawRepresentation
    return "\(signed).\(base64URL(signature))"
}
#endif
