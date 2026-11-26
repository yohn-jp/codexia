import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import CodexiaAPI
import OpenAPIRuntime

/// One immutable mutation identity. Reconciliation resends this same request
/// with its original key and body, using the server's idempotent replay contract.
public struct DocumentSave: Sendable {
    private let input: Operations.persistence_document_patch.Input
    public let operationID: String

    public init(projectID: String, documentID: String, operationID: String,
                clientID: String, body: Components.Schemas.SaveDocumentRequest) throws {
        guard !operationID.isEmpty, operationID.utf8.count <= 200,
              !clientID.isEmpty, clientID.utf8.count <= 128,
              [operationID, clientID].allSatisfy({ $0.utf8.allSatisfy { (0x21...0x7e).contains($0) } }),
              body.clientId == nil || body.clientId == clientID else {
            throw APITransportError.invalidHeader
        }
        self.operationID = operationID
        self.input = .init(
            path: .init(projectId: projectID, documentId: documentID),
            headers: .init(Idempotency_hyphen_Key: operationID, X_hyphen_Client_hyphen_Id: clientID),
            body: .json(body)
        )
    }

    public enum Outcome: Sendable {
        case committed(Components.Schemas.SaveDocumentResponse)
        case conflict(Components.Schemas.SaveConflictResponse?)
        case preconditionFailed
        case unauthorized
        case forbidden
        case accepted
        case rejected(status: Int)
        case unknown(Uncertainty)
    }

    public enum Uncertainty: Equatable, Sendable {
        case cancelled
        case offline
        case timeout
        case responseLost
        case invalidReceipt
        case serverStatus(Int)
    }

    /// Sends once. A cancelled or interrupted in-flight mutation may still have
    /// committed. Keep the operation and explicitly resubmit it to reconcile.
    public func submit(using client: any APIProtocol) async throws -> Outcome {
        try Task.checkCancellation()
        do {
            switch try await client.persistence_document_patch(input) {
            case .ok(let ok):
                let receipt = try ok.body.json
                guard matches(receipt) else { return .unknown(.invalidReceipt) }
                return .committed(receipt)
            case .conflict(let conflict):
                switch try conflict.body.json {
                case .SaveConflictResponse(let body):
                    // A 409 is definitive, but its current-document snapshot is
                    // only safe to compare when it belongs to this request.
                    return .conflict(validatedConflict(body))
                case .SaveIdempotencyConflictResponse: return .conflict(nil)
                }
            case .badRequest:
                return .rejected(status: 400)
            case .notFound:
                return .rejected(status: 404)
            case .undocumented(let status, _):
                return classify(status)
            }
        } catch {
            let clientError = error as? ClientError
            if let status = clientError?.response?.status.code {
                return status == 200 ? .unknown(.invalidReceipt) : classify(status)
            }
            let cause = clientError?.underlyingError ?? error
            if let failure = cause as? APITransportError { throw failure }
            if let failure = cause as? OAuthError { throw failure }
            if cause is CancellationError || Task.isCancelled { return .unknown(.cancelled) }
            if let network = cause as? URLError {
                switch network.code {
                case .cancelled: return .unknown(.cancelled)
                case .notConnectedToInternet: return .unknown(.offline)
                case .timedOut: return .unknown(.timeout)
                default: break
                }
            }
            return .unknown(.responseLost)
        }
    }

    private func matches(_ receipt: Components.Schemas.SaveDocumentResponse) -> Bool {
        let body: Components.Schemas.SaveDocumentRequest
        switch input.body { case .json(let value): body = value }
        return receipt.document.id == input.path.documentId
            && receipt.document.projectId == input.path.projectId
            && receipt.revision.documentId == input.path.documentId
            && receipt.revision.projectId == input.path.projectId
            && !receipt.revision.id.isEmpty
            && receipt.document.headRevisionId == receipt.revision.id
            && receipt.revision.parentRevisionId == body.baseRevisionId
            && receipt.revision.sha256 == body.resultingSha256
    }

    /// Returns a persisted or received stale-base conflict only when its
    /// current document and revision agree with this save's request identity.
    /// Journal restoration should use the same check before exposing a snapshot.
    public func validatedConflict(
        _ conflict: Components.Schemas.SaveConflictResponse?
    ) -> Components.Schemas.SaveConflictResponse? {
        guard let conflict, matchesConflict(conflict) else { return nil }
        return conflict
    }

    private func matchesConflict(_ conflict: Components.Schemas.SaveConflictResponse) -> Bool {
        guard let current = conflict.current else { return true }

        guard current.document.id == input.path.documentId,
              current.document.projectId == input.path.projectId else {
            return false
        }

        let body: Components.Schemas.SaveDocumentRequest
        switch input.body { case .json(let value): body = value }

        guard let revision = current.revision else {
            // A document without a revision cannot advertise a head revision.
            return current.document.headRevisionId == nil
        }

        return !revision.id.isEmpty
            && revision.projectId == input.path.projectId
            && revision.documentId == input.path.documentId
            && current.document.headRevisionId == revision.id
            && revision.id != body.baseRevisionId
    }

    private func classify(_ status: Int) -> Outcome {
        switch status {
        case 202: .accepted
        case 401: .unauthorized
        case 403: .forbidden
        case 409: .conflict(nil)
        case 412: .preconditionFailed
        case 400...499: .rejected(status: status)
        default: .unknown(.serverStatus(status))
        }
    }
}
