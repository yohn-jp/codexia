#if os(iOS)
import AuthenticationServices
import Foundation

@MainActor
public final class OAuthPresentation: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    private var flow: ASWebAuthenticationSession?
    private var flowID: UUID?
    private var result: CheckedContinuation<URL, any Error>?

    public init(anchor: ASPresentationAnchor) { self.anchor = anchor }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }

    func authorize(_ url: URL) async throws -> URL {
        guard flow == nil else { throw OAuthError.sessionBusy }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                result = continuation
                flowID = id
                let next = ASWebAuthenticationSession(url: url, callbackURLScheme: "jp.yohn.codexia") {
                    [weak self] callback, error in
                    Task { @MainActor in
                        if let callback, error == nil { self?.finish(.success(callback), for: id) }
                        else { self?.finish(.failure(error ?? OAuthError.invalidCallback), for: id) }
                    }
                }
                next.presentationContextProvider = self
                flow = next
                if !next.start() { finish(.failure(OAuthError.presentationFailed), for: id) }
            }
        } onCancel: {
            Task { @MainActor in
                guard self.flowID == id else { return }
                self.flow?.cancel()
                self.finish(.failure(CancellationError()), for: id)
            }
        }
    }

    private func finish(_ outcome: Result<URL, any Error>, for id: UUID) {
        guard flowID == id else { return }
        let callback = result
        result = nil
        flowID = nil
        flow = nil
        callback?.resume(with: outcome)
    }
}
#endif
