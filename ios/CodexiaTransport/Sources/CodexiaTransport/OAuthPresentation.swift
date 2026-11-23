#if os(iOS)
import AuthenticationServices
import Foundation

@MainActor
public final class OAuthPresentation: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    private var flow: ASWebAuthenticationSession?
    private var result: CheckedContinuation<URL, any Error>?

    public init(anchor: ASPresentationAnchor) { self.anchor = anchor }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }

    func authorize(_ url: URL) async throws -> URL {
        guard flow == nil else { throw OAuthError.sessionBusy }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                result = continuation
                let next = ASWebAuthenticationSession(url: url, callbackURLScheme: "jp.yohn.codexia") {
                    [weak self] callback, error in
                    Task { @MainActor in
                        if let callback, error == nil { self?.finish(.success(callback)) }
                        else { self?.finish(.failure(error ?? OAuthError.invalidCallback)) }
                    }
                }
                next.presentationContextProvider = self
                flow = next
                if !next.start() { finish(.failure(OAuthError.presentationFailed)) }
            }
        } onCancel: {
            Task { @MainActor in
                self.flow?.cancel()
                self.finish(.failure(CancellationError()))
            }
        }
    }

    private func finish(_ outcome: Result<URL, any Error>) {
        let callback = result
        result = nil
        flow = nil
        callback?.resume(with: outcome)
    }
}
#endif
