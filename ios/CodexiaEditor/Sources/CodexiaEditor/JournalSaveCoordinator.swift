import Foundation
import CryptoKit
import CodexiaAPI
import CodexiaTransport

/// A recoverable local edit. The journal is pending work; a server receipt is
/// the only evidence that a manuscript revision was committed.
public struct DraftRecord: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable { case protected, inFlight, unknown, conflict, committed }

    public let authorID: String
    public let apiOrigin: String
    public let projectID: String
    public let documentID: String
    public let version: UInt64
    public var baseRevisionID: String
    public var baseText: String
    public let text: String
    public let operationID: String
    public let clientID: String
    public let contentSHA256: String
    public var state: State
    public var saveRequest: Components.Schemas.SaveDocumentRequest
    public var receipt: Components.Schemas.SaveDocumentResponse?

}

public enum SaveDisposition: Sendable {
    case saved(Components.Schemas.SaveDocumentResponse)
    case pending(DocumentSave.Uncertainty)
    case accepted
    case unauthorized
    case forbidden
    case conflict
    case preconditionFailed
    case rejected(Int)
    case nothingToSave
    case atRisk
}

public enum DraftJournalError: Error, Equatable {
    case invalidScope
    case corruptRecord
}

fileprivate enum JournalBegin {
    case record(DraftRecord)
    case nothing
    case pending
    case conflict
}

/// Atomic, author/API/project/document scoped storage under Application Support.
/// Keychain is deliberately not involved: this stores manuscript drafts only.
public actor ProtectedDraftJournal {
    public let directory: URL
    private let fileManager: FileManager
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(directory: URL? = nil, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        if let directory {
            self.directory = directory
        } else {
            guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
                throw DraftJournalError.invalidScope
            }
            self.directory = support.appendingPathComponent("Codexia/Drafts", isDirectory: true)
        }
        try fileManager.createDirectory(at: self.directory, withIntermediateDirectories: true)
        #if os(iOS)
        try fileManager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: self.directory.path)
        #endif
    }

    fileprivate func records(scope: JournalScope) throws -> [DraftRecord] {
        let url = try fileURL(scope: scope)
        guard fileManager.fileExists(atPath: url.path) else { return [] }
        do {
            let records = try decoder.decode([DraftRecord].self, from: Data(contentsOf: url))
            guard records.allSatisfy({ $0.authorID == scope.authorID && $0.apiOrigin == scope.apiOrigin
                && $0.projectID == scope.projectID && $0.documentID == scope.documentID
                && $0.contentSHA256 == Self.sha256($0.text)
                && $0.saveRequest.resultingSha256 == $0.contentSHA256
                && $0.saveRequest.baseRevisionId == $0.baseRevisionID }) else {
                throw DraftJournalError.corruptRecord
            }
            return records
        }
        catch { throw DraftJournalError.corruptRecord }
    }

    fileprivate func write(_ records: [DraftRecord], scope: JournalScope) throws {
        let url = try fileURL(scope: scope)
        let data = try encoder.encode(records)
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        try data.write(to: url, options: options)
    }

    fileprivate func insert(_ record: DraftRecord, scope: JournalScope) throws -> DraftRecord {
        var current = try records(scope: scope)
        if let existing = current.first(where: { $0.version == record.version && $0.text == record.text
            && $0.baseRevisionID == record.baseRevisionID }) { return existing }
        // Keep the submitted operation immutable, but coalesce all unsubmitted
        // typing to the newest snapshot so the journal stays bounded.
        current.removeAll(where: { $0.state == .protected })
        current.append(record)
        try write(current, scope: scope)
        return record
    }

    fileprivate func begin(scope: JournalScope, reconcile: Bool) throws -> JournalBegin {
        var current = try records(scope: scope)
        guard let index = current.firstIndex(where: { $0.state != .committed }) else { return .nothing }
        var record = current[index]
        if record.state == .conflict { return .conflict }
        if (record.state == .unknown || record.state == .inFlight) && !reconcile { return .pending }
        record.state = .inFlight
        current[index] = record
        try write(current, scope: scope)
        return .record(record)
    }

    fileprivate func finish(scope: JournalScope, operationID: String, state: DraftRecord.State,
                            receipt: Components.Schemas.SaveDocumentResponse? = nil) throws {
        var current = try records(scope: scope)
        guard let index = current.firstIndex(where: { $0.operationID == operationID }) else {
            throw DraftJournalError.corruptRecord
        }
        var record = current[index]
        if record.state == .committed || record.state == .conflict { return }
        if state == .committed, let receipt {
            current.remove(at: index)
            guard index < current.count, current[index].state == .protected else {
                try write(current, scope: scope)
                return
            }
            var next = current[index]
            next.baseRevisionID = receipt.revision.id
            next.baseText = record.text
            next.saveRequest = Components.Schemas.SaveDocumentRequest(
                baseRevisionId: receipt.revision.id,
                changes: [.init(fromUtf16: 0, toUtf16: Int32(record.text.utf16.count), insert: next.text)],
                resultingSha256: next.contentSHA256, clientId: next.clientID
            )
            current[index] = next
        } else {
            record.state = state
            current[index] = record
        }
        try write(current, scope: scope)
    }

    private func fileURL(scope: JournalScope) throws -> URL {
        guard !scope.authorID.isEmpty, !scope.projectID.isEmpty, !scope.documentID.isEmpty,
              canonicalOrigin(scope.apiOrigin) == scope.apiOrigin else {
            throw DraftJournalError.invalidScope
        }
        let name = Self.sha256(try JSONEncoder().encode([scope.authorID, scope.apiOrigin, scope.projectID, scope.documentID]))
        return directory.appendingPathComponent(name).appendingPathExtension("json")
    }

    fileprivate static func sha256(_ text: String) -> String { sha256(Data(text.utf8)) }
    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

fileprivate struct JournalScope: Sendable {
    let authorID: String
    let apiOrigin: String
    let projectID: String
    let documentID: String
}

/// Serializes protection and save reconciliation. Each mutation's body and
/// operation ID are durable before the first network request.
public actor JournalSaveCoordinator {
    private let authorID: String
    private let apiOrigin: String
    private let projectID: String
    private let clientID: String
    private let journal: ProtectedDraftJournal
    private let api: any APIProtocol
    private var inFlightScopes: Set<String> = []

    public init(authorID: String, apiOrigin: URL, projectID: String, clientID: String,
                journal: ProtectedDraftJournal, api: any APIProtocol) throws {
        guard !authorID.isEmpty, !projectID.isEmpty, !clientID.isEmpty,
              let canonical = canonicalOrigin(apiOrigin.absoluteString) else {
            throw DraftJournalError.invalidScope
        }
        self.authorID = authorID
        self.apiOrigin = canonical
        self.projectID = projectID
        self.clientID = clientID
        self.journal = journal
        self.api = api
    }

    /// Persist this immutable editor snapshot before the caller marks it protected.
    @discardableResult
    public func protect(snapshot: EditorState.Snapshot, baseRevisionID: String, baseText: String) async throws -> DraftRecord {
        guard !baseRevisionID.isEmpty, snapshot.text.utf16.count <= Int(Int32.max),
              baseText.utf16.count <= Int(Int32.max) else { throw DraftJournalError.invalidScope }
        let scope = scope(documentID: snapshot.documentID)
        let hash = ProtectedDraftJournal.sha256(snapshot.text)
        let request = Components.Schemas.SaveDocumentRequest(
            baseRevisionId: baseRevisionID,
            changes: [.init(fromUtf16: 0, toUtf16: Int32(baseText.utf16.count), insert: snapshot.text)],
            resultingSha256: hash,
            clientId: clientID
        )
        let record = DraftRecord(authorID: authorID, apiOrigin: apiOrigin, projectID: projectID,
            documentID: snapshot.documentID, version: snapshot.version, baseRevisionID: baseRevisionID,
            baseText: baseText, text: snapshot.text, operationID: UUID().uuidString, clientID: clientID,
            contentSHA256: hash, state: .protected, saveRequest: request)
        return try await journal.insert(record, scope: scope)
    }

    public func recover(documentID: String) async throws -> DraftRecord? {
        try await journal.records(scope: scope(documentID: documentID))
            .last(where: { $0.state != .committed })
    }

    public func records(documentID: String) async throws -> [DraftRecord] {
        try await journal.records(scope: scope(documentID: documentID)).filter { $0.state != .committed }
    }

    public func save(documentID: String) async -> SaveDisposition { await submit(documentID: documentID, reconcile: false) }
    public func reconcile(documentID: String) async -> SaveDisposition { await submit(documentID: documentID, reconcile: true) }

    private func submit(documentID: String, reconcile: Bool) async -> SaveDisposition {
        let key = scope(documentID: documentID)
        let gate = scopeKey(key)
        guard inFlightScopes.insert(gate).inserted else { return .pending(.responseLost) }
        defer { inFlightScopes.remove(gate) }
        do {
            let record: DraftRecord
            switch try await journal.begin(scope: key, reconcile: reconcile) {
            case .nothing: return .nothingToSave
            case .pending: return .pending(.responseLost)
            case .conflict: return .conflict
            case .record(let inFlight): record = inFlight
            }
            let save = try DocumentSave(projectID: projectID, documentID: documentID,
                operationID: record.operationID, clientID: clientID, body: record.saveRequest)
            switch try await save.submit(using: api) {
            case .committed(let receipt):
                try await journal.finish(scope: key, operationID: record.operationID, state: .committed, receipt: receipt)
                return .saved(receipt)
            case .unknown(let uncertainty):
                try await journal.finish(scope: key, operationID: record.operationID, state: .unknown)
                return .pending(uncertainty)
            case .accepted: try await journal.finish(scope: key, operationID: record.operationID, state: .unknown); return .accepted
            case .unauthorized: try await journal.finish(scope: key, operationID: record.operationID, state: .protected); return .unauthorized
            case .forbidden: try await journal.finish(scope: key, operationID: record.operationID, state: .protected); return .forbidden
            case .conflict: try await journal.finish(scope: key, operationID: record.operationID, state: .conflict); return .conflict
            case .preconditionFailed: try await journal.finish(scope: key, operationID: record.operationID, state: .conflict); return .preconditionFailed
            case .rejected(let status): try await journal.finish(scope: key, operationID: record.operationID, state: .protected); return .rejected(status)
            }
        } catch OAuthError.signInRequired {
            return .unauthorized
        } catch {
            return .atRisk
        }
    }

    private func scope(documentID: String) -> JournalScope {
        JournalScope(authorID: authorID, apiOrigin: apiOrigin, projectID: projectID, documentID: documentID)
    }

    private func scopeKey(_ scope: JournalScope) -> String {
        let data = (try? JSONEncoder().encode([scope.authorID, scope.apiOrigin, scope.projectID, scope.documentID])) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

private func canonicalOrigin(_ value: String) -> String? {
    guard var parts = URLComponents(string: value), parts.scheme?.lowercased() == "https",
          let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
          parts.query == nil, parts.fragment == nil,
          parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/" else { return nil }
    parts.scheme = "https"
    parts.host = host.lowercased()
    if parts.port == 443 { parts.port = nil }
    parts.percentEncodedPath = ""
    return parts.string
}
