import CodexiaAPI
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import OpenAPIRuntime
import OpenAPIURLSession

public enum ProjectEventsError: Error, Equatable, Sendable {
    case rejected(status: Int)
}

extension APITransport {
    /// Reads the native project event stream incrementally. Returning false
    /// from the consumer or cancelling this task closes this subscription.
    public func consumeProjectEvents(
        _ consume: @Sendable (ServerSentEvent) async throws -> Bool
    ) async throws {
        try await consumeProjectEvents(using: isolatedSession(), consume)
    }

    func consumeProjectEvents(
        using session: URLSession, _ consume: @Sendable (ServerSentEvent) async throws -> Bool
    ) async throws {
        defer { session.invalidateAndCancel() }
        let streaming = try APITransport(
            origin: origin, accessToken: accessToken,
            transport: URLSessionTransport(configuration: .init(session: session))
        )
        try await withTaskCancellationHandler {
            let output = try await streaming.client.project_events_get()
            switch output {
            case .ok(let reply):
                let body = try reply.body.text_event_hyphen_stream
                for try await event in body.asDecodedServerSentEvents(while: { _ in true }) {
                    try Task.checkCancellation()
                    if try await !consume(event) { break }
                }
                try Task.checkCancellation()
            case .serviceUnavailable:
                throw ProjectEventsError.rejected(status: 503)
            case .undocumented(let status, _):
                throw ProjectEventsError.rejected(status: status)
            }
        } onCancel: {
            session.invalidateAndCancel()
        }
    }
}
