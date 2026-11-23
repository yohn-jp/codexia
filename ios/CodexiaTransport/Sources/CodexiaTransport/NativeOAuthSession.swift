#if os(iOS)
import CryptoKit
import Foundation
import Security

/// Authorizes the installed app as a Better Auth public client. Server-side
/// admission still resolves account ownership and permission on every request.
public actor NativeOAuthSession {
    public enum Revocation: Sendable { case noCredentials, confirmed, unconfirmed }

    private let configuration: OAuthConfiguration
    private let session: URLSession
    private let keychain: RefreshKeychain
    private var grant: OAuthGrant?
    private var authorizing = false
    private var revoking = false
    private var refreshTask: Task<OAuthGrant, any Error>?

    public init(configuration: OAuthConfiguration) {
        self.init(configuration: configuration, session: isolatedSession())
    }

    init(configuration: OAuthConfiguration, session: URLSession) {
        self.configuration = configuration
        self.session = session
        self.keychain = RefreshKeychain(configuration: configuration)
    }

    public nonisolated func makeTransport() throws -> APITransport {
        try APITransport(origin: configuration.origin) {
            try await self.accessToken()
        }
    }

    /// The app target registers jp.yohn.codexia as a URL scheme and supplies its
    /// active scene window via the presentation context.
    @discardableResult
    public func signIn(presentation: OAuthPresentation) async throws -> String {
        try await signIn(authorize: { try await presentation.authorize($0) })
    }

    func signIn(authorize: @MainActor @Sendable (URL) async throws -> URL) async throws -> String {
        guard !authorizing, !revoking, refreshTask == nil else { throw OAuthError.sessionBusy }
        // Explicit sign-out is required before changing the authenticated account.
        guard grant == nil, try keychain.read() == nil else { throw OAuthError.sessionBusy }
        authorizing = true
        defer { authorizing = false }

        try await validateMetadata()
        let verifier = try randomValue()
        let state = try randomValue()
        let nonce = try randomValue()
        let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let url = try configuration.authorizationURL(state: state, nonce: nonce, challenge: challenge)
        let callback = try await authorize(url)
        try Task.checkCancellation()
        let code = try configuration.code(from: callback, expectedState: state)
        let response = try await exchange([
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", OAuthConfiguration.redirectURI),
            ("code_verifier", verifier),
        ])
        let verified = try await verify(response, nonce: nonce)
        guard let refresh = response.refresh_token, validBearer(refresh) else { throw OAuthError.invalidToken }
        try Task.checkCancellation()
        try keychain.write(refresh)
        grant = verified
        return verified.subject
    }

    /// Obtains a verified subject for local draft scoping, including after app restart.
    public func subject() async throws -> String {
        try await currentGrant().subject
    }

    public func signOut() async throws -> Revocation {
        guard !authorizing, !revoking, refreshTask == nil else { throw OAuthError.sessionBusy }
        revoking = true
        defer { revoking = false }
        let access = grant?.accessToken
        let refresh = try keychain.read()
        grant = nil
        try keychain.delete()
        guard access != nil || refresh != nil else { return .noCredentials }

        var confirmed = true
        for (token, hint) in [(refresh, "refresh_token"), (access, "access_token")] {
            guard let token else { continue }
            do {
                let (_, status) = try await post(configuration.revocationEndpoint, [
                    ("token", token), ("token_type_hint", hint), ("client_id", configuration.clientID),
                ])
                if status != 200 { confirmed = false }
            } catch {
                confirmed = false
            }
        }
        return confirmed ? .confirmed : .unconfirmed
    }

    private func accessToken() async throws -> String {
        try await currentGrant().accessToken
    }

    private func currentGrant() async throws -> OAuthGrant {
        try Task.checkCancellation()
        guard !revoking, !authorizing else { throw OAuthError.sessionBusy }
        if let grant, grant.expiresAt.timeIntervalSinceNow > 15 { return grant }
        if let refreshTask { return try await refreshTask.value }
        let task = Task { try await self.refresh() }
        refreshTask = task
        defer { refreshTask = nil }
        let fresh = try await task.value
        try Task.checkCancellation()
        return fresh
    }

    private func refresh() async throws -> OAuthGrant {
        guard let saved = try keychain.read() else { throw OAuthError.signInRequired }
        try await validateMetadata()
        let response: OAuthTokenResponse
        do {
            response = try await exchange([("grant_type", "refresh_token"), ("refresh_token", saved)])
        } catch OAuthError.signInRequired {
            grant = nil
            try keychain.delete()
            throw OAuthError.signInRequired
        }
        let verified = try await verify(response, nonce: nil)
        if let grant, grant.subject != verified.subject { throw OAuthError.invalidToken }
        if let rotated = response.refresh_token {
            guard validBearer(rotated) else { throw OAuthError.invalidToken }
            try keychain.write(rotated)
        }
        grant = verified
        return verified
    }

    private func validateMetadata() async throws {
        let metadata: OAuthMetadata = try await get(configuration.metadataEndpoint)
        try metadata.validate(for: configuration)
    }

    private func verify(_ response: OAuthTokenResponse, nonce: String?) async throws -> OAuthGrant {
        let keys: OAuthSigningKeys = try await get(configuration.jwksEndpoint)
        return try OAuthGrant(response: response, keys: keys, config: configuration, nonce: nonce)
    }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, status) = try await requestData(request)
        guard status == 200 else { throw OAuthError.endpointRejected(status: status) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func exchange(_ parameters: [(String, String)]) async throws -> OAuthTokenResponse {
        let (data, status) = try await post(configuration.tokenEndpoint, parameters + [
            ("client_id", configuration.clientID), ("resource", configuration.resource.absoluteString),
        ])
        guard status == 200 else {
            struct Failure: Decodable { let error: String }
            if status == 400, (try? JSONDecoder().decode(Failure.self, from: data))?.error == "invalid_grant" {
                throw OAuthError.signInRequired
            }
            throw OAuthError.endpointRejected(status: status)
        }
        return try JSONDecoder().decode(OAuthTokenResponse.self, from: data)
    }

    private func post(_ url: URL, _ parameters: [(String, String)]) async throws -> (Data, Int) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(parameters.map { "\(formEncode($0.0))=\(formEncode($0.1))" }.joined(separator: "&").utf8)
        return try await requestData(request)
    }

    private func requestData(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url == request.url, data.count <= 256 * 1024 else {
            throw OAuthError.invalidMetadata
        }
        return (data, http.statusCode)
    }
}

private func formEncode(_ value: String) -> String {
    value.utf8.map { byte in
        switch byte {
        case 65...90, 97...122, 48...57, 42, 45, 46, 95: String(UnicodeScalar(byte))
        case 32: "+"
        default: String(format: "%%%02X", byte)
        }
    }.joined()
}

private func randomValue() throws -> String {
    var bytes = Data(count: 32)
    let status = bytes.withUnsafeMutableBytes { buffer in
        SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    guard status == errSecSuccess else { throw OAuthError.keychain(status: status) }
    return base64URL(bytes)
}
#endif
