import AppAuth
import Capacitor
import Foundation
import Security

@objc(CodexiaAuthPlugin)
public final class CodexiaAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CodexiaAuthPlugin"
    public let jsName = "CodexiaAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "accessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "apiRequest", returnType: CAPPluginReturnPromise),
    ]

    private var serviceConfigurations: [String: OIDServiceConfiguration] = [:]
    private var currentAuthorizationFlow: OIDExternalUserAgentSession?
    private var accessToken: String?
    private var accessTokenExpiresAt: Date?
    private var accessRequestInProgress = false
    private var accessRequestKey: String?
    private var accessRequestWaiters: [CAPPluginCall] = []
    private var pendingSignOutCall: CAPPluginCall?
    private var sessionGeneration = 0
    private var openURLObserver: NSObjectProtocol?
    private var authURLSession: URLSession?

    @objc override public func load() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: NativeNoRedirectDelegate(), delegateQueue: nil)
        authURLSession = session
        OIDURLSessionProvider.setSession(session)

        openURLObserver = NotificationCenter.default.addObserver(
            forName: .capacitorOpenURL,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let values = notification.object as? [String: Any],
                  let url = values["url"] as? URL else { return }
            guard let self, let flow = self.currentAuthorizationFlow else { return }
            do {
                try flow.resumeExternalUserAgentFlow(url)
            } catch {
                // AppAuth rejects URLs that do not match the pending redirect/state.
            }
        }
    }

    deinit {
        if let openURLObserver {
            NotificationCenter.default.removeObserver(openURLObserver)
        }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in self?.signIn(call) }
            return
        }
        guard let config = NativeAuthConfig(call: call), let presenter = bridge?.viewController else {
            call.reject("Native OAuth configuration is invalid or unavailable")
            return
        }
        guard !accessRequestInProgress, pendingSignOutCall == nil else {
            call.reject("Wait for the current native session operation to finish")
            return
        }
        guard currentAuthorizationFlow == nil else {
            call.reject("A native sign-in is already in progress")
            return
        }
        let generation = sessionGeneration
        loadServiceConfiguration(for: config) { [weak self] service, error in
            guard let self else { return }
            guard generation == self.sessionGeneration else {
                call.reject("Sign-in was cancelled", "reauthenticationRequired")
                return
            }
            guard let service else {
                call.reject(error?.localizedDescription ?? "OAuth provider metadata is unavailable")
                return
            }

            let request = OIDAuthorizationRequest(
                configuration: service,
                clientId: config.clientId,
                scopes: config.scopes,
                redirectURL: config.redirectURL,
                responseType: OIDResponseTypeCode,
                additionalParameters: ["resource": config.apiAudience]
            )
            self.currentAuthorizationFlow = OIDAuthState.authState(byPresenting: request, presenting: presenter) { [weak self] state, authError in
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.currentAuthorizationFlow = nil
                    guard generation == self.sessionGeneration else {
                        call.reject("Sign-in was cancelled", "reauthenticationRequired")
                        return
                    }
                    guard let state, let response = state.lastTokenResponse,
                          let bearer = self.validBearer(from: response),
                          let refreshToken = response.refreshToken,
                          let expiry = response.accessTokenExpirationDate, expiry > Date() else {
                        call.reject(authError?.localizedDescription ?? "The provider did not issue an API access token and refresh token")
                        return
                    }
                    guard self.saveRefreshToken(refreshToken, for: config) else {
                        call.reject("Could not store the refresh token in Keychain")
                        return
                    }
                    self.accessToken = bearer
                    self.accessTokenExpiresAt = expiry
                    call.resolve(["accessToken": bearer])
                }
            }
        }
    }

    @objc func accessToken(_ call: CAPPluginCall) {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in self?.accessToken(call) }
            return
        }
        guard let config = NativeAuthConfig(call: call) else {
            call.reject("Native OAuth configuration is invalid")
            return
        }
        if let accessToken, let expiry = accessTokenExpiresAt, expiry.timeIntervalSinceNow > 60 {
            call.resolve(["accessToken": accessToken])
            return
        }
        guard pendingSignOutCall == nil else {
            call.reject("Sign-out is in progress", "reauthenticationRequired")
            return
        }
        if accessRequestInProgress {
            guard accessRequestKey == config.keychainAccount else {
                call.reject("A different native OAuth client is refreshing")
                return
            }
            accessRequestWaiters.append(call)
            return
        }
        accessRequestInProgress = true
        accessRequestKey = config.keychainAccount
        accessRequestWaiters = [call]
        guard let refreshToken = loadRefreshToken(for: config) else {
            finishAccessRequest(error: "Sign-in is required", code: "reauthenticationRequired")
            return
        }
        let generation = sessionGeneration
        loadServiceConfiguration(for: config) { [weak self] service, error in
            guard let self else { return }
            guard generation == self.sessionGeneration else {
                self.finishAccessRequest(error: "Sign-in is required", code: "reauthenticationRequired")
                return
            }
            guard let service else {
                self.finishAccessRequest(error: error?.localizedDescription ?? "OAuth provider metadata is unavailable")
                return
            }
            self.refresh(config: config, service: service, refreshToken: refreshToken, generation: generation)
        }
    }

    @objc func signOut(_ call: CAPPluginCall) {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in self?.signOut(call) }
            return
        }
        guard let config = NativeAuthConfig(call: call) else {
            call.reject("Native OAuth configuration is invalid")
            return
        }
        if accessRequestInProgress {
            guard pendingSignOutCall == nil else {
                call.reject("Sign-out is already in progress")
                return
            }
            pendingSignOutCall = call
            return
        }
        performSignOut(config: config, call: call)
    }

    private func performSignOut(config: NativeAuthConfig, call: CAPPluginCall) {
        sessionGeneration += 1
        currentAuthorizationFlow?.cancel()
        currentAuthorizationFlow = nil
        let refreshToken = loadRefreshToken(for: config)
        let localCredentialsCleared = deleteRefreshToken(for: config)
        accessToken = nil
        accessTokenExpiresAt = nil
        finishAccessRequest(error: "Sign-in is required", code: "reauthenticationRequired")
        guard let refreshToken else {
            // The Keychain entry is gone, so the server-side outcome can no longer be checked here.
            call.resolve(["localCredentialsCleared": localCredentialsCleared, "revoked": false])
            return
        }
        revoke(refreshToken, config: config, localCredentialsCleared: localCredentialsCleared, call: call)
    }

    private func approvedApiPath(_ url: URL, rawURL: String) -> Bool {
        guard let encodedPath = URLComponents(string: rawURL)?.percentEncodedPath else { return false }
        let lower = encodedPath.lowercased()
        // Reject direct and encoded traversal, including repeated proxy decoding.
        guard !lower.contains("%2e"), !lower.contains("%2f"),
              !lower.contains("%5c"), !lower.contains("%25"),
              !lower.contains("\\"),
              !encodedPath.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
            return false
        }
        let normalized = url.standardized.path
        return url.path == normalized && normalized.hasPrefix("/api/") && !normalized.hasPrefix("/api/auth/")
    }

    @objc func apiRequest(_ call: CAPPluginCall) {
        guard let apiOriginValue = call.getString("apiOrigin"),
              let apiOrigin = URL(string: apiOriginValue), apiOrigin.scheme == "https",
              apiOrigin.path == "/", apiOrigin.query == nil, apiOrigin.fragment == nil,
              apiOrigin.user == nil, apiOrigin.password == nil,
              let urlString = call.getString("url"),
              let url = URL(string: urlString),
              sameHttpsOrigin(url, apiOrigin),
              approvedApiPath(url, rawURL: urlString),
              url.user == nil, url.password == nil, url.fragment == nil,
              let methodValue = call.getString("method") else {
            call.reject("Native API request URL is not allowed", "nativeApiRequestDenied")
            return
        }
        let method = methodValue.uppercased()
        guard ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(method) else {
            call.reject("Native API request method is not allowed", "nativeApiRequestDenied")
            return
        }
        let rawHeaders = call.getObject("headers") ?? [:]
        guard rawHeaders.allSatisfy({ $0.value is String }) else {
            call.reject("Native API request headers are invalid", "nativeApiRequestDenied")
            return
        }
        let allowedHeaders: Set<String> = [
            "accept", "authorization", "content-type", "if-match", "if-none-match",
            "idempotency-key", "x-client-id", "x-codexia-recent-activity-order",
        ]
        var headers = [String: String]()
        for (name, value) in rawHeaders {
            let lowered = name.lowercased()
            guard allowedHeaders.contains(lowered),
                  let text = value as? String,
                  !text.contains("\r"), !text.contains("\n") else {
                call.reject("Native API request headers are not allowed", "nativeApiRequestDenied")
                return
            }
            headers[name] = text
        }
        if let authorization = headers.first(where: { $0.key.lowercased() == "authorization" })?.value,
           !authorization.lowercased().hasPrefix("bearer ") {
            call.reject("Native API requests accept Bearer authorization only", "nativeApiRequestDenied")
            return
        }
        let bodyValue = call.options["body"]
        guard bodyValue == nil || bodyValue is String else {
            call.reject("Native API request body must be a JSON string", "nativeApiRequestDenied")
            return
        }
        performApiRequest(url: url, method: method, headers: headers, body: bodyValue as? String, call: call)
    }

    private func performApiRequest(url: URL, method: String, headers: [String: String], body: String?, call: CAPPluginCall) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 60
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let body { request.httpBody = body.data(using: .utf8) }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: NativeNoRedirectDelegate(), delegateQueue: nil)
        session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }
            guard let error else {
                guard let response = response as? HTTPURLResponse else {
                    DispatchQueue.main.async { call.reject("Native API returned an invalid HTTP response", "nativeApiResponseInvalid") }
                    return
                }
                var responseHeaders = [String: String]()
                for (name, value) in response.allHeaderFields {
                    guard let key = name as? String, key.lowercased() != "set-cookie" else { continue }
                    responseHeaders[key] = String(describing: value)
                }
                let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                DispatchQueue.main.async {
                    call.resolve(["status": response.statusCode, "headers": responseHeaders, "body": body])
                }
                return
            }
            DispatchQueue.main.async { call.reject(error.localizedDescription, "nativeApiTransportFailed") }
        }.resume()
    }

    private func loadServiceConfiguration(
        for config: NativeAuthConfig,
        completion: @escaping (OIDServiceConfiguration?, Error?) -> Void
    ) {
        if let cached = serviceConfigurations[config.issuer] {
            completion(cached, nil)
            return
        }
        OIDAuthorizationService.discoverConfiguration(forIssuer: config.issuerURL) { [weak self] service, error in
                DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard let service, self.validate(service: service, for: config) else {
                    completion(nil, error ?? NativeOAuthError.invalidMetadata)
                    return
                }
                self.serviceConfigurations[config.issuer] = service
                completion(service, nil)
                }
        }
    }

    private func validate(service: OIDServiceConfiguration, for config: NativeAuthConfig) -> Bool {
        guard let discovery = service.discoveryDocument,
              discovery.issuer.absoluteString == config.issuer,
              service.authorizationEndpoint.absoluteString == config.authorizationEndpoint,
              service.tokenEndpoint.absoluteString == config.tokenEndpoint,
              discovery.jwksURL.absoluteString == config.jwksEndpoint,
              sameHttpsOrigin(service.authorizationEndpoint, config.apiOriginURL),
              sameHttpsOrigin(service.tokenEndpoint, config.apiOriginURL),
              sameHttpsOrigin(discovery.jwksURL, config.apiOriginURL),
              discovery.responseTypesSupported.contains(OIDResponseTypeCode),
              discovery.grantTypesSupported?.contains(OIDGrantTypeAuthorizationCode) == true,
              discovery.grantTypesSupported?.contains(OIDGrantTypeRefreshToken) == true,
              discovery.tokenEndpointAuthMethodsSupported?.contains("none") == true,
              (discovery.discoveryDictionary["code_challenge_methods_supported"] as? [String])?.contains("S256") == true else {
            return false
        }
        return true
    }

    private func refresh(
        config: NativeAuthConfig,
        service: OIDServiceConfiguration,
        refreshToken: String,
        generation: Int
    ) {
        let request = OIDTokenRequest(
            configuration: service,
            grantType: OIDGrantTypeRefreshToken,
            authorizationCode: nil,
            redirectURL: nil,
            clientID: config.clientId,
            clientSecret: nil,
            scopes: config.scopes,
            refreshToken: refreshToken,
            codeVerifier: nil,
            additionalParameters: ["resource": config.apiAudience]
        )
        OIDAuthorizationService.perform(request) { [weak self] response, error in
                DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard generation == self.sessionGeneration else {
                    self.finishAccessRequest(error: "Sign-in is required", code: "reauthenticationRequired")
                    return
                }
                guard let response, let bearer = self.validBearer(from: response),
                      let expiry = response.accessTokenExpirationDate, expiry > Date() else {
                    if self.isInvalidRefreshToken(error) {
                        self.deleteRefreshToken(for: config)
                        self.finishAccessRequest(error: "Sign-in is required", code: "reauthenticationRequired")
                    } else {
                        self.finishAccessRequest(error: error?.localizedDescription ?? "Could not refresh the API access token")
                    }
                    return
                }
                if let rotated = response.refreshToken, !self.saveRefreshToken(rotated, for: config) {
                    self.finishAccessRequest(error: "Could not rotate the refresh token in Keychain")
                    return
                }
                self.accessToken = bearer
                self.accessTokenExpiresAt = expiry
                self.finishAccessRequest(accessToken: bearer)
                }
        }
    }

    private func validBearer(from response: OIDTokenResponse) -> String? {
        guard let token = response.accessToken, !token.isEmpty,
              response.tokenType?.caseInsensitiveCompare("Bearer") == .orderedSame else { return nil }
        return token
    }

    private func isInvalidRefreshToken(_ error: Error?) -> Bool {
        guard let error else { return false }
        let nsError = error as NSError
        guard nsError.domain == OIDOAuthTokenErrorDomain,
              let response = nsError.userInfo[OIDOAuthErrorResponseErrorKey] as? [String: Any] else { return false }
        return response[OIDOAuthErrorFieldError] as? String == "invalid_grant"
    }

    private func finishAccessRequest(accessToken: String? = nil, error: String? = nil, code: String? = nil) {
        let waiters = accessRequestWaiters
        let signOutCall = pendingSignOutCall
        accessRequestWaiters = []
        accessRequestKey = nil
        accessRequestInProgress = false
        pendingSignOutCall = nil
        if let signOutCall {
            for waiter in waiters {
                waiter.reject("Sign-out is in progress", "reauthenticationRequired")
            }
            guard let config = NativeAuthConfig(call: signOutCall) else {
                signOutCall.reject("Native OAuth configuration is invalid")
                return
            }
            performSignOut(config: config, call: signOutCall)
            return
        }
        for waiter in waiters {
            if let accessToken {
                waiter.resolve(["accessToken": accessToken])
            } else {
                waiter.reject(error ?? "Sign-in is required", code)
            }
        }
    }

    private func revoke(_ refreshToken: String, config: NativeAuthConfig, localCredentialsCleared: Bool, call: CAPPluginCall) {
        var request = URLRequest(url: config.revocationURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        var body = URLComponents()
        body.queryItems = [
            URLQueryItem(name: "token", value: refreshToken),
            URLQueryItem(name: "token_type_hint", value: "refresh_token"),
            URLQueryItem(name: "client_id", value: config.clientId),
        ]
        request.httpBody = body.percentEncodedQuery?.data(using: .utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: NativeNoRedirectDelegate(), delegateQueue: nil)
        session.dataTask(with: request) { _, response, error in
            defer { session.finishTasksAndInvalidate() }
            let status = (response as? HTTPURLResponse)?.statusCode
            DispatchQueue.main.async {
                call.resolve(["localCredentialsCleared": localCredentialsCleared, "revoked": error == nil && status == 200])
            }
        }.resume()
    }

    private func keychainQuery(for config: NativeAuthConfig) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "jp.yohn.codexia.oauth.refresh",
            kSecAttrAccount as String: config.keychainAccount,
        ]
    }

    private func saveRefreshToken(_ token: String, for config: NativeAuthConfig) -> Bool {
        guard let data = token.data(using: .utf8) else { return false }
        let query = keychainQuery(for: config)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insertion = query
            insertion.merge(attributes) { _, new in new }
            return SecItemAdd(insertion as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }

    private func loadRefreshToken(for config: NativeAuthConfig) -> String? {
        var query = keychainQuery(for: config)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    private func deleteRefreshToken(for config: NativeAuthConfig) -> Bool {
        let status = SecItemDelete(keychainQuery(for: config) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

private struct NativeAuthConfig {
    let apiOrigin: String
    let apiAudience: String
    let issuer: String
    let authorizationEndpoint: String
    let tokenEndpoint: String
    let clientId: String
    let redirectUri: String
    let scopes: [String]

    var apiOriginURL: URL { URL(string: apiOrigin)! }
    var issuerURL: URL { URL(string: issuer)! }
    var redirectURL: URL { URL(string: redirectUri)! }
    var jwksEndpoint: String { URL(string: "/api/auth/jwks", relativeTo: apiOriginURL)!.absoluteURL.absoluteString }
    var revocationURL: URL { URL(string: "/api/auth/oauth2/revoke", relativeTo: apiOriginURL)!.absoluteURL }
    var keychainAccount: String { "\(issuer)|\(clientId)|\(apiAudience)" }

    init?(call: CAPPluginCall) {
        guard let apiOrigin = call.getString("apiOrigin"),
              let apiAudience = call.getString("apiAudience"),
              let issuer = call.getString("issuer"),
              let authorizationEndpoint = call.getString("authorizationEndpoint"),
              let tokenEndpoint = call.getString("tokenEndpoint"),
              let clientId = call.getString("clientId"),
              let redirectUri = call.getString("redirectUri"),
              let scopes = call.getArray("scopes", String.self) else { return nil }
        let values = [apiOrigin, apiAudience, issuer, authorizationEndpoint, tokenEndpoint]
        let requiredScopes = Set(["openid", "codexia:api", "offline_access"])
        guard values.allSatisfy({ value in
            guard let url = URL(string: value) else { return false }
            return url.scheme == "https" && url.host != nil && url.user == nil && url.password == nil && url.fragment == nil
        }), !clientId.isEmpty, redirectUri == "jp.yohn.codexia:/oauth2redirect",
              Set(scopes) == requiredScopes, scopes.count == requiredScopes.count,
              let apiURL = URL(string: apiOrigin), apiURL.path == "/", apiURL.query == nil,
              issuer == URL(string: "/api/auth", relativeTo: apiURL)!.absoluteURL.absoluteString,
              authorizationEndpoint == URL(string: "/api/auth/oauth2/authorize", relativeTo: apiURL)!.absoluteURL.absoluteString,
              tokenEndpoint == URL(string: "/api/auth/oauth2/token", relativeTo: apiURL)!.absoluteURL.absoluteString else { return nil }
        self.apiOrigin = apiOrigin
        self.apiAudience = apiAudience
        self.issuer = issuer
        self.authorizationEndpoint = authorizationEndpoint
        self.tokenEndpoint = tokenEndpoint
        self.clientId = clientId
        self.redirectUri = redirectUri
        self.scopes = scopes
    }
}

private func sameHttpsOrigin(_ endpoint: URL, _ origin: URL) -> Bool {
    endpoint.scheme == "https" && endpoint.host == origin.host && endpoint.port == origin.port
}

private enum NativeOAuthError: Error {
    case invalidMetadata
}

private final class NativeNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
