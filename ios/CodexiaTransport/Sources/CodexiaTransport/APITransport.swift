import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import CodexiaAPI
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

public enum APITransportError: Error, Equatable, Sendable {
    case invalidOrigin
    case invalidPath
    case invalidHeader
    case streamingUnavailable
}

/// Connects the generated client to one API origin and an in-memory token provider.
public struct APITransport: ClientTransport {
    public typealias AccessToken = @Sendable () async throws -> String

    public let origin: URL
    let accessToken: AccessToken?
    private let transport: any ClientTransport

    public init(origin: URL, accessToken: AccessToken? = nil) throws {
        try self.init(
            origin: origin,
            accessToken: accessToken,
            transport: URLSessionTransport(configuration: .init(session: isolatedSession()))
        )
    }

    init(origin: URL, accessToken: AccessToken?, transport: any ClientTransport) throws {
        self.origin = try canonicalOrigin(origin)
        self.accessToken = accessToken
        self.transport = transport
    }

    public var client: Client {
        Client(serverURL: origin, configuration: .init(dateTranscoder: APIDates()), transport: self)
    }

    public func send(
        _ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
    ) async throws -> (HTTPResponse, HTTPBody?) {
        try Task.checkCancellation()
        guard try canonicalOrigin(baseURL) == origin,
              let target = request.path.flatMap(validatedTarget) else {
            throw APITransportError.invalidPath
        }
        guard request.headerFields.allSatisfy({ validHeader($0.value) }),
              request.headerFields[.authorization] == nil,
              request.headerFields[.cookie] == nil,
              request.authority == nil, request.scheme == nil,
              request.headerFields.allSatisfy({ $0.name.canonicalName != "host" }),
              request.headerFields[.proxyAuthorization] == nil else {
            throw APITransportError.invalidHeader
        }
        #if !canImport(Darwin)
        if request.headerFields[.accept]?.contains("text/event-stream") == true {
            throw APITransportError.streamingUnavailable
        }
        #endif

        var authenticated = request
        if let accessToken, target.hasPrefix("/api/"),
           !target.hasPrefix("/api/auth/"), !target.hasPrefix("/api/console/"),
           !target.hasPrefix("/api/public/") {
            let bearer = try await accessToken()
            guard validBearer(bearer) else { throw APITransportError.invalidHeader }
            authenticated.headerFields[.authorization] = "Bearer \(bearer)"
        }
        try Task.checkCancellation()
        return try await transport.send(authenticated, body: body, baseURL: origin, operationID: operationID)
    }
}

func canonicalOrigin(_ url: URL) throws -> URL {
    guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: true),
          parts.scheme == "https", let host = parts.host, !host.isEmpty,
          parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
          parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/" else {
        throw APITransportError.invalidOrigin
    }
    parts.host = host.lowercased()
    if parts.port == 443 { parts.port = nil }
    parts.percentEncodedPath = ""
    guard let origin = parts.url else { throw APITransportError.invalidOrigin }
    return origin
}

private func validatedTarget(_ path: String) -> String? {
    guard path.hasPrefix("/"), !path.hasPrefix("//"),
          let parts = URLComponents(string: path),
          parts.scheme == nil, parts.host == nil, parts.fragment == nil,
          !parts.percentEncodedPath.contains("//") else { return nil }
    let segments = parts.percentEncodedPath.split(separator: "/")
    for segment in segments {
        guard let decoded = segment.removingPercentEncoding,
              decoded != ".", decoded != "..",
              !decoded.contains(where: { "/\\%".contains($0) }),
              decoded.utf8.allSatisfy({ $0 >= 0x20 && $0 != 0x7f }) else { return nil }
    }
    let decoded = parts.path
    guard decoded.hasPrefix("/api/") || decoded.hasPrefix("/health/") || decoded == "/mcp" else {
        return nil
    }
    return decoded
}

private func validHeader(_ value: String) -> Bool {
    value.utf8.allSatisfy { $0 == 0x09 || ($0 >= 0x20 && $0 != 0x7f) }
}

func validBearer(_ value: String) -> Bool {
    let token = value.dropLast(value.reversed().prefix { $0 == "=" }.count)
    return !token.isEmpty && token.utf8.allSatisfy {
        (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
            || [45, 46, 95, 126, 43, 47].contains($0)
    }
}

func isolatedSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.httpCookieAcceptPolicy = .never
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 300
    if let protocolClasses { configuration.protocolClasses = protocolClasses }
    return URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        #if canImport(Darwin)
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        #endif
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}

private struct APIDates: DateTranscoder {
    private let wholeSeconds: ISO8601DateTranscoder = .iso8601
    private let fractionalSeconds: ISO8601DateTranscoder = .iso8601WithFractionalSeconds

    func encode(_ date: Date) throws -> String { try fractionalSeconds.encode(date) }

    func decode(_ text: String) throws -> Date {
        if let date = try? fractionalSeconds.decode(text) { return date }
        return try wholeSeconds.decode(text)
    }
}

// CI-only probe of native-owned verification admission; no runtime behavior change.
