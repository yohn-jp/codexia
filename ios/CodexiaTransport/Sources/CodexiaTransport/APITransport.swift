import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// HTTP policy layer for the future generated Swift OpenAPI client.
/// DTOs and operation-specific status decoding belong exclusively to generated code.
public struct APITransport: Sendable {
    public enum Failure: Error, Equatable, Sendable {
        case invalidOrigin
        case invalidPath
        case invalidMethod
        case insecureRequest
        case crossOriginRedirect
        case invalidResponse
    }

    public struct Reply: Sendable {
        public let status: Int
        public let headers: [String: String]
        public let body: Data
    }

    public let origin: URL
    private let session: URLSession

    public init(origin: URL, session: URLSession? = nil) throws {
        guard origin.scheme == "https", origin.host != nil,
              origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil,
              (origin.path.isEmpty || origin.path == "/") else {
            throw Failure.invalidOrigin
        }
        self.origin = origin
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.httpCookieAcceptPolicy = .never
            self.session = URLSession(configuration: configuration,
                                      delegate: RejectRedirects(), delegateQueue: nil)
        }
    }

    /// Performs exactly one request. Callers reconcile unknown outcomes using the
    /// same operation identity; transport never retries mutations automatically.
    public func send(method: String, path: String, bearer: String?,
                     idempotencyKey: String? = nil, ifMatch: String? = nil,
                     body: Data? = nil, contentType: String? = nil) async throws -> Reply {
        guard !method.isEmpty, method.utf8.allSatisfy({ ($0 >= 65 && $0 <= 90) || $0 == 45 }) else {
            throw Failure.invalidMethod
        }
        guard path.hasPrefix("/api/"), !path.contains("#"), !path.contains("?"),
              !path.contains("\\"), !path.contains("//"),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.scheme == origin.scheme, url.host == origin.host,
              url.port == origin.port, url.user == nil, url.password == nil else {
            throw Failure.invalidPath
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.httpBody = body
        if let bearer {
            guard !bearer.isEmpty, !bearer.contains("\r"), !bearer.contains("\n") else {
                throw Failure.insecureRequest
            }
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        if let ifMatch { request.setValue(ifMatch, forHTTPHeaderField: "If-Match") }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.invalidResponse }
        guard http.url?.scheme == origin.scheme, http.url?.host == origin.host,
              http.url?.port == origin.port else { throw Failure.crossOriginRedirect }
        let headers = Dictionary(uniqueKeysWithValues: http.allHeaderFields.compactMap { key, value -> (String, String)? in
            guard let name = key as? String, let text = value as? String else { return nil }
            return (name.lowercased(), text)
        })
        return Reply(status: http.statusCode, headers: headers, body: data)
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
