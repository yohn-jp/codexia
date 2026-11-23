import Foundation

public enum OAuthError: Error, Equatable, Sendable {
    case invalidConfiguration
    case invalidMetadata
    case invalidCallback
    case authorizationDenied
    case presentationFailed
    case sessionBusy
    case signInRequired
    case invalidToken
    case endpointRejected(status: Int)
    case keychain(status: Int32)
}

public struct OAuthConfiguration: Sendable {
    public static let redirectURI = "jp.yohn.codexia:/oauth2redirect"
    static let scopes: Set<String> = ["openid", "codexia:api", "offline_access"]

    public let origin: URL
    public let clientID: String
    public let resource: URL
    let issuer: URL
    let authorizationEndpoint: URL
    let tokenEndpoint: URL
    let revocationEndpoint: URL
    let jwksEndpoint: URL
    let metadataEndpoint: URL

    public init(origin: URL, clientID: String, resource: URL? = nil) throws {
        self.origin = try canonicalOrigin(origin)
        guard !clientID.isEmpty, clientID.utf8.allSatisfy({ (0x21...0x7e).contains($0) }) else {
            throw OAuthError.invalidConfiguration
        }
        self.clientID = clientID
        let audience = resource ?? self.origin.appending(path: "api")
        guard let parts = URLComponents(url: audience, resolvingAgainstBaseURL: true),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.percentEncodedPath == "/api", let absoluteURL = parts.url else {
            throw OAuthError.invalidConfiguration
        }
        self.resource = absoluteURL
        issuer = self.origin.appending(path: "api/auth")
        authorizationEndpoint = issuer.appending(path: "oauth2/authorize")
        tokenEndpoint = issuer.appending(path: "oauth2/token")
        revocationEndpoint = issuer.appending(path: "oauth2/revoke")
        jwksEndpoint = issuer.appending(path: "jwks")
        metadataEndpoint = self.origin.appending(path: ".well-known/oauth-authorization-server/api/auth")
    }

    func authorizationURL(state: String, nonce: String, challenge: String) throws -> URL {
        guard var parts = URLComponents(url: authorizationEndpoint, resolvingAgainstBaseURL: false) else {
            throw OAuthError.invalidConfiguration
        }
        parts.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: clientID),
            .init(name: "redirect_uri", value: Self.redirectURI),
            .init(name: "scope", value: Self.scopes.sorted().joined(separator: " ")),
            .init(name: "resource", value: resource.absoluteString),
            .init(name: "state", value: state),
            .init(name: "nonce", value: nonce),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
        ]
        guard let url = parts.url else { throw OAuthError.invalidConfiguration }
        return url
    }

    func code(from callback: URL, expectedState: String) throws -> String {
        guard var parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              let fields = parts.queryItems, parts.fragment == nil else { throw OAuthError.invalidCallback }
        parts.query = nil
        guard parts.string == Self.redirectURI else { throw OAuthError.invalidCallback }
        let values = Dictionary(grouping: fields, by: \.name)
        guard values.values.allSatisfy({ $0.count == 1 }),
              values["state"]?.first?.value == expectedState,
              values["iss"] == nil || values["iss"]?.first?.value == issuer.absoluteString else {
            throw OAuthError.invalidCallback
        }
        if values["error"] != nil, values["code"] == nil { throw OAuthError.authorizationDenied }
        guard values["error"] == nil, let code = values["code"]?.first?.value, !code.isEmpty else {
            throw OAuthError.invalidCallback
        }
        return code
    }
}

struct OAuthMetadata: Decodable {
    let issuer: URL
    let authorization_endpoint: URL
    let token_endpoint: URL
    let revocation_endpoint: URL?
    let jwks_uri: URL
    let response_types_supported: [String]
    let grant_types_supported: [String]
    let code_challenge_methods_supported: [String]
    let token_endpoint_auth_methods_supported: [String]
    let scopes_supported: [String]

    func validate(for config: OAuthConfiguration) throws {
        guard issuer == config.issuer, authorization_endpoint == config.authorizationEndpoint,
              token_endpoint == config.tokenEndpoint, jwks_uri == config.jwksEndpoint,
              revocation_endpoint == nil || revocation_endpoint == config.revocationEndpoint,
              response_types_supported.contains("code"),
              Set(grant_types_supported).isSuperset(of: ["authorization_code", "refresh_token"]),
              code_challenge_methods_supported.contains("S256"),
              token_endpoint_auth_methods_supported.contains("none"),
              Set(scopes_supported).isSuperset(of: OAuthConfiguration.scopes) else {
            throw OAuthError.invalidMetadata
        }
    }
}
