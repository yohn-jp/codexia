#if canImport(Darwin)
import Foundation
import OpenAPIRuntime
import Testing
@testable import CodexiaTransport

@Test func AppleTransportStreamsBeforeEOFAndCancelsSubscription() async throws {
    let transport = try APITransport(origin: URL(string: "https://events.example.test")!, accessToken: { "fixture.events" })
    let session = isolatedSession(protocolClasses: [OpenEventStream.self])
    let (events, received) = AsyncStream<ServerSentEvent>.makeStream()
    let subscriber = Task {
        try await transport.consumeProjectEvents(using: session) { event in
            received.yield(event)
            return true
        }
    }
    defer { subscriber.cancel() }
    let first = try await withThrowingTaskGroup(of: ServerSentEvent.self) { tasks in
        tasks.addTask {
            for await event in events { return event }
            throw CancellationError()
        }
        tasks.addTask {
            try await Task.sleep(for: .seconds(8))
            throw URLError(.timedOut)
        }
        defer { tasks.cancelAll() }
        return try #require(try await tasks.next())
    }
    #expect(first.event == "changed")
    #expect(first.data == "原稿")
    subscriber.cancel()
    switch await subscriber.result {
    case .success:
        Issue.record("The open subscription finished without cancellation")
    case .failure(let error):
        #expect(error is CancellationError || (error as? URLError)?.code == .cancelled)
    }
}

private final class OpenEventStream: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "events.example.test" }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let allowed = request.url?.path == "/api/projects/events"
            && request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture.events"
            && request.value(forHTTPHeaderField: "Accept")?.contains("text/event-stream") == true
        let response = HTTPURLResponse(
            url: request.url!, statusCode: allowed ? 200 : 401, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if allowed {
            client?.urlProtocol(self, didLoad: Data("event: changed\ndata: 原".utf8))
            client?.urlProtocol(self, didLoad: Data("稿\n\n".utf8))
            // An infinite SSE response has no EOF until the subscriber stops.
        } else {
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
#endif
