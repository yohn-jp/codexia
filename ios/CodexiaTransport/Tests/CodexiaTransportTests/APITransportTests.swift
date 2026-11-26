import CodexiaAPI
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession
import Testing
@testable import CodexiaTransport

private let origin = URL(string: "https://api.example.test")!
private let idempotency = HTTPField.Name("Idempotency-Key")!
private let clientID = HTTPField.Name("X-Client-Id")!

private actor FixtureTransport: ClientTransport {
    struct Exchange: Sendable {
        let request: HTTPRequest
        let operation: String
        let payload: Data?
    }

    var exchanges: [Exchange] = []
    var answer: @Sendable () async throws -> (HTTPResponse, HTTPBody?)

    init(_ answer: @escaping @Sendable () async throws -> (HTTPResponse, HTTPBody?) = { (.init(status: .ok), nil) }) {
        self.answer = answer
    }

    func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String)
        async throws -> (HTTPResponse, HTTPBody?) {
        let payload = try await body.mapData()
        exchanges.append(.init(request: request, operation: operationID, payload: payload))
        return try await answer()
    }

    func respond(_ answer: @escaping @Sendable () async throws -> (HTTPResponse, HTTPBody?)) {
        self.answer = answer
    }
}

private extension Optional where Wrapped == HTTPBody {
    func mapData() async throws -> Data? {
        guard let body = self else { return nil }
        return try await Data(collecting: body, upTo: 1024 * 1024)
    }
}

@Test func requiresExactHTTPSOrigin() throws {
    for url in ["http://api.example.test", "https://u:p@api.example.test",
                "https://api.example.test/other", "https://api.example.test/?x=1"] {
        #expect(throws: APITransportError.invalidOrigin) { try APITransport(origin: URL(string: url)!) }
    }
    let client = try APITransport(origin: URL(string: "https://API.example.test:443/")!)
    #expect(client.origin == origin)
}

@Test func rejectsUntrustedTargetsAndHeadersBeforeAskingForCredentials() async throws {
    let fixture = FixtureTransport()
    let transport = try APITransport(origin: origin, accessToken: {
        Issue.record("Credentials were requested before validation")
        return "fixture.token"
    }, transport: fixture)
    for path in ["https://evil.test/api/projects", "//evil.test/api/projects", "/api/../admin",
                 "/api/%2e%2e/admin", "/api/a%2fb", "/api/a%252fb", "/api/a%5cb", "/api/a#frag", "/oauth/login"] {
        await #expect(throws: APITransportError.invalidPath) {
            try await transport.send(.init(method: .get, scheme: nil, authority: nil, path: path),
                                     body: nil, baseURL: origin, operationID: "test")
        }
    }
    await #expect(throws: APITransportError.invalidPath) {
        try await transport.send(.init(method: .get, scheme: nil, authority: nil, path: "/api/session"),
                                 body: nil, baseURL: URL(string: "https://wrong.example.test")!, operationID: "test")
    }
    for field in [HTTPField(name: .authorization, value: "Bearer foreign"),
                  HTTPField(name: .cookie, value: "session=foreign"),
                  HTTPField(name: HTTPField.Name("Host")!, value: "foreign.example")] {
        var request = HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/session")
        request.headerFields.append(field)
        await #expect(throws: APITransportError.invalidHeader) {
            try await transport.send(request, body: nil, baseURL: origin, operationID: "test")
        }
    }
    #expect(await fixture.exchanges.isEmpty)
}

@Test func confinesBearerAndPreservesEncodedPathQueryAndPrecondition() async throws {
    let fixture = FixtureTransport()
    let transport = try APITransport(origin: origin, accessToken: { "fixture.token" }, transport: fixture)
    let scopedPath = "/api/projects/%E5%8E%9F%E7%A8%BF?query=%E6%97%A5%E6%9C%AC"
    var request = HTTPRequest(method: .get, scheme: nil, authority: nil, path: scopedPath)
    request.headerFields[.ifMatch] = "\"draft-12\""
    _ = try await transport.send(request, body: nil, baseURL: origin, operationID: "test")
    for path in ["/api/auth/oauth2/get-consents", "/api/console/backups/config", "/api/public/reader", "/health/live", "/mcp"] {
        _ = try await transport.send(.init(method: .get, scheme: nil, authority: nil, path: path),
                                     body: nil, baseURL: origin, operationID: "test")
    }
    let exchanges = await fixture.exchanges
    let first = try #require(exchanges.first)
    #expect(first.request.path == scopedPath)
    #expect(first.request.headerFields[.authorization] == "Bearer fixture.token")
    #expect(first.request.headerFields[.ifMatch] == "\"draft-12\"")
    #expect(exchanges.dropFirst().allSatisfy { $0.request.headerFields[.authorization] == nil })
}

@Test func generatedClientUsesAppleURLSession() async throws {
    let session = isolatedSession(protocolClasses: [SessionFixture.self])
    defer { session.invalidateAndCancel() }
    let apple = URLSessionTransport(configuration: .init(session: session, httpBodyProcessingMode: .buffered))
    let transport = try APITransport(origin: origin, accessToken: { "fixture.token" }, transport: apple)
    let response = try await transport.client.api_session_get()
    let sessionBody = try response.ok.body.json
    #expect(sessionBody.authenticated == true)
    #expect(sessionBody.authorScope == "owner")
}

private final class SessionFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "api.example.test"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let accepted = request.url?.path == "/api/session" && request.url?.scheme == "https"
            && request.httpMethod == "GET" && request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture.token"
            && request.value(forHTTPHeaderField: "Cookie") == nil
        let response = HTTPURLResponse(url: request.url!, statusCode: accepted ? 200 : 403, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"authenticated":true,"authorScope":"owner"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private let digest = String(repeating: "a", count: 64)
private let write = Components.Schemas.SaveDocumentRequest(
    baseRevisionId: "rev-base", changes: [.init(fromUtf16: 0, toUtf16: 0, insert: "原稿")], resultingSha256: digest
)
private let receipt = """
    {"document":{"id":"document","projectId":"project","parentId":null,"kind":"scene","title":"原稿",    "orderKey":"0","headRevisionId":"rev-new","version":2,"createdAt":"2026-11-23T00:00:00.123Z","updatedAt":"2026-11-23T00:00:00Z"},    "revision":{"id":"rev-new","projectId":"project","documentId":"document","parentRevisionId":"rev-base",    "markdown":"原稿","sha256":"\(digest)","authorId":"author","createdAt":"2026-11-23T00:00:00.123Z"},"replayed":true}
    """
private let conflict = """
    {"code":"PERSISTENCE_CONFLICT","error":"Revision changed","details":null,"current":null}
    """
private let conflictWithCurrent = """
    {"code":"PERSISTENCE_CONFLICT","error":"Revision changed","details":{"currentRevisionId":"rev-current"},"current":{"document":{"id":"document","projectId":"project","parentId":null,"kind":"scene","title":"原稿","orderKey":"0","headRevisionId":"rev-current","version":2,"createdAt":"2026-11-23T00:00:00Z","updatedAt":"2026-11-23T00:00:00Z"},"revision":{"id":"rev-current","projectId":"project","documentId":"document","parentRevisionId":"rev-base","markdown":"server version","sha256":"\(digest)","authorId":"author","createdAt":"2026-11-23T00:00:00Z"}}}
    """

private func json(_ status: Int, _ content: String) -> (HTTPResponse, HTTPBody?) {
    (.init(status: .init(code: status), headerFields: [.contentType: "application/json"]), HTTPBody(content))
}

private func save() throws -> DocumentSave {
    try DocumentSave(projectID: "project", documentID: "document", operationID: "operation-1", clientID: "ios-test", body: write)
}

@Test func lostReplyReconcilesWithSameGeneratedPatchAndValidatesReceipt() async throws {
    let fixture = FixtureTransport { throw URLError(.networkConnectionLost) }
    let client = try APITransport(origin: origin, accessToken: { "fixture.token" }, transport: fixture).client
    let operation = try save()
    guard case .unknown(.responseLost) = try await operation.submit(using: client) else {
        Issue.record("Expected an unknown result after the connection was lost"); return
    }
    #expect(await fixture.exchanges.count == 1)
    await fixture.respond { json(200, receipt) }
    guard case .committed(let confirmed) = try await operation.submit(using: client) else {
        Issue.record("Expected a typed replay receipt"); return
    }
    #expect(confirmed.replayed)
    #expect(confirmed.document.parentId == nil)
    #expect(confirmed.revision.parentRevisionId == write.baseRevisionId)

    let exchanges = await fixture.exchanges
    #expect(exchanges.count == 2)
    let original = try #require(exchanges.first)
    let replay = try #require(exchanges.last)
    #expect(original.request == replay.request)
    #expect(original.payload == replay.payload)
    #expect(original.operation == Operations.persistence_document_patch.id)
    #expect(original.request.method == .patch)
    #expect(original.request.path == "/api/v1/persistence/projects/project/documents/document")
    #expect(original.request.headerFields[idempotency] == operation.operationID)
    #expect(original.request.headerFields[clientID] == "ios-test")
    #expect(try JSONDecoder().decode(Components.Schemas.SaveDocumentRequest.self, from: #require(original.payload)) == write)
}

@Test func statusAndMalformedReceiptNeverReportASavedRevision() async throws {
    let fixture = FixtureTransport()
    let client = try APITransport(origin: origin, accessToken: nil, transport: fixture).client
    let operation = try save()
    let cases = [
        (202, "accepted"), (400, "rejected"), (401, "unauthorized"), (403, "forbidden"), (404, "rejected"),
        (409, "conflict"), (412, "preconditionFailed"), (415, "rejected"), (503, "server"), (200, "invalidReceipt"),
    ]
    for (status, expected) in cases {
        await fixture.respond {
            json(status, status == 409 ? conflict : #"{"code":"FAILURE","error":"fixture","details":null}"#)
        }
        let outcome = try await operation.submit(using: client)
        let state: String
        switch outcome {
        case .accepted: state = "accepted"
        case .rejected(let code) where code == status: state = "rejected"
        case .unauthorized: state = "unauthorized"
        case .forbidden: state = "forbidden"
        case .conflict(let reply) where reply?.code == .PERSISTENCE_CONFLICT: state = "conflict"
        case .preconditionFailed: state = "preconditionFailed"
        case .unknown(.serverStatus(let code)) where code == status: state = "server"
        case .unknown(.invalidReceipt): state = "invalidReceipt"
        default: state = "unexpected"
        }
        #expect(state == expected, "Status \(status)")
    }
    await fixture.respond { json(200, receipt.replacingOccurrences(of: digest, with: "wrong")) }
    guard case .unknown(.invalidReceipt) = try await operation.submit(using: client) else {
        Issue.record("A mismatched digest is an unknown outcome"); return
    }
}

@Test func reusedSaveKeyDecodesAsAConflictWithoutACurrentRevision() async throws {
    let message = "The save key identifies another operation"
    let payload = #"{"code":"IDEMPOTENCY_CONFLICT","error":"The save key identifies another operation"}"#
    let body = try JSONDecoder().decode(Components.Schemas.SaveDocumentConflictResponse.self, from: Data(payload.utf8))
    guard case .SaveIdempotencyConflictResponse(let reusedKey) = body else {
        Issue.record("Expected the generated idempotency conflict variant"); return
    }
    #expect(reusedKey.error == message)

    let fixture = FixtureTransport { json(409, payload) }
    let client = try APITransport(origin: origin, accessToken: nil, transport: fixture).client
    guard case .conflict(nil) = try await save().submit(using: client) else {
        Issue.record("Expected a conflict with no current revision"); return
    }
}

@Test func staleBaseConflictPreservesOnlyCurrentComparisonDataForTheRequestedDocument() async throws {
    let fixture = FixtureTransport { json(409, conflictWithCurrent) }
    let client = try APITransport(origin: origin, accessToken: nil, transport: fixture).client
    guard case .conflict(let valid) = try await save().submit(using: client),
          let valid, let current = valid.current, let revision = current.revision else {
        Issue.record("Expected the matching current document and revision"); return
    }
    #expect(current.document.id == "document")
    #expect(current.document.projectId == "project")
    #expect(current.document.headRevisionId == revision.id)
    #expect(revision.id == "rev-current")
    #expect(revision.projectId == "project")
    #expect(revision.documentId == "document")

    let mismatchedResponses = [
        conflictWithCurrent.replacingOccurrences(of: #""id":"document""#, with: #""id":"other-document""#),
        conflictWithCurrent.replacingOccurrences(of: #""projectId":"project""#, with: #""projectId":"other-project""#),
        conflictWithCurrent.replacingOccurrences(of: #""documentId":"document""#, with: #""documentId":"other-document""#),
        conflictWithCurrent.replacingOccurrences(of: #""projectId":"project","documentId":"document""#, with: #""projectId":"other-project","documentId":"document""#),
        conflictWithCurrent.replacingOccurrences(of: #""headRevisionId":"rev-current""#, with: #""headRevisionId":"other-revision""#),
        conflictWithCurrent.replacingOccurrences(of: #""id":"rev-current""#, with: #""id":"other-revision""#),
        conflictWithCurrent.replacingOccurrences(of: #""id":"rev-current","projectId":"project""#, with: #""id":"rev-current","projectId":"other-project""#),
    ]
    for payload in mismatchedResponses {
        await fixture.respond { json(409, payload) }
        guard case .conflict(nil) = try await save().submit(using: client) else {
            Issue.record("A mismatched comparison response must remain a conflict without exposing its data")
            return
        }
    }
}

@Test func cancellationAndOfflineNeverRetryAutomatically() async throws {
    let fixture = FixtureTransport { throw URLError(.notConnectedToInternet) }
    let client = try APITransport(origin: origin, accessToken: nil, transport: fixture).client
    let operation = try save()
    guard case .unknown(.offline) = try await operation.submit(using: client) else {
        Issue.record("Expected offline uncertainty"); return
    }
    await fixture.respond { throw URLError(.timedOut) }
    guard case .unknown(.timeout) = try await operation.submit(using: client) else {
        Issue.record("Expected timeout uncertainty"); return
    }
    let (started, marker) = AsyncStream<Void>.makeStream()
    await fixture.respond {
        marker.yield()
        try await Task.sleep(for: .seconds(30))
        return json(200, receipt)
    }
    let sending = Task { try await operation.submit(using: client) }
    var events = started.makeAsyncIterator()
    _ = await events.next()
    sending.cancel()
    guard case .unknown(.cancelled) = try await sending.value else {
        Issue.record("An in-flight cancellation leaves the result unknown"); return
    }
    #expect(await fixture.exchanges.count == 3)
}
