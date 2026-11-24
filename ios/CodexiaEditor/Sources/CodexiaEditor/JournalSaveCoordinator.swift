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
    public let sessionID: UUID
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
    public var conflict: Components.Schemas.SaveConflictResponse?

}

public enum SaveDisposition: Sendable {
    case saved(Components.Schemas.SaveDocumentResponse)
    case pending(DocumentSave.Uncertainty)
    case accepted
    case unauthorized
    case forbidden
    case conflict(Components.Schemas.SaveConflictResponse?)
    case preconditionFailed
    case rejected(Int)
    case nothingToSave
    case atRisk
}

public enum DraftJournalError: Error, Equatable {
    case invalidScope
    case corruptRecord
    case sessionChanged
    case staleConflict
}

private enum DocumentChangeBuilder {
    static func make(from base: String, to text: String) -> [Components.Schemas.DocumentChange] {
        let old = Array(base.unicodeScalars)
        let new = Array(text.unicodeScalars)
        var offsets = [Int32](repeating: 0, count: old.count + 1)
        for index in old.indices {
            offsets[index + 1] = offsets[index] + (old[index].value > 0xFFFF ? 2 : 1)
        }
        guard old != new else { return [] }
        if max(old.count, new.count) <= 2_048 {
            return lcsChanges(old: old, new: new, oldOffsets: offsets)
        }

        // Bound worst-case memory and time for large manuscripts. The unchanged
        // prefix and suffix remain outside the replacement span.
        var prefix = 0
        while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < old.count - prefix, suffix < new.count - prefix,
              old[old.count - suffix - 1] == new[new.count - suffix - 1] { suffix += 1 }
        return [.init(fromUtf16: offsets[prefix], toUtf16: offsets[old.count - suffix],
                      insert: scalarString(new[prefix..<(new.count - suffix)]))]
    }

    private static func lcsChanges(old: [Unicode.Scalar], new: [Unicode.Scalar], oldOffsets: [Int32])
        -> [Components.Schemas.DocumentChange] {
        let width = new.count + 1
        var table = [UInt16](repeating: 0, count: (old.count + 1) * width)
        if !old.isEmpty && !new.isEmpty {
            for i in old.indices.reversed() {
                for j in new.indices.reversed() {
                    let at = i * width + j
                    if old[i] == new[j] {
                        table[at] = table[(i + 1) * width + j + 1] + 1
                    } else {
                        table[at] = max(table[(i + 1) * width + j], table[i * width + j + 1])
                    }
                }
            }
        }

        var changes: [Components.Schemas.DocumentChange] = []
        var oldIndex = 0
        var newIndex = 0
        var hunkStart: Int?
        var hunkEnd = 0
        var inserted: [Unicode.Scalar] = []
        func flush() {
            guard let start = hunkStart else { return }
            changes.append(.init(fromUtf16: oldOffsets[start], toUtf16: oldOffsets[hunkEnd],
                                 insert: scalarString(inserted[...])))
            hunkStart = nil
            hunkEnd = oldIndex
            inserted.removeAll(keepingCapacity: true)
        }

        while oldIndex < old.count || newIndex < new.count {
            if oldIndex < old.count && newIndex < new.count && old[oldIndex] == new[newIndex] {
                flush()
                oldIndex += 1
                newIndex += 1
            } else if newIndex == new.count || (oldIndex < old.count
                && table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1]) {
                if hunkStart == nil { hunkStart = oldIndex }
                oldIndex += 1
                hunkEnd = oldIndex
            } else {
                if hunkStart == nil { hunkStart = oldIndex; hunkEnd = oldIndex }
                inserted.append(new[newIndex])
                newIndex += 1
            }
        }
        flush()
        return changes
    }

    private static func scalarString<S: Sequence>(_ scalars: S) -> String where S.Element == Unicode.Scalar {
        var view = String.UnicodeScalarView()
        for scalar in scalars { view.append(scalar) }
        return String(view)
    }
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
    private var activeScopes: Set<String> = []

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

    fileprivate func acquire(scope: JournalScope) -> Bool { activeScopes.insert(scopeKey(scope)).inserted }
    fileprivate func release(scope: JournalScope) { activeScopes.remove(scopeKey(scope)) }

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
        if let latest = current.last, latest.sessionID == record.sessionID
            && latest.contentSHA256 == record.contentSHA256
            && Data(latest.text.utf8).elementsEqual(Data(record.text.utf8))
            && latest.baseRevisionID == record.baseRevisionID { return latest }
        if let unresolved = current.last, unresolved.sessionID != record.sessionID {
            throw DraftJournalError.sessionChanged
        }
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

    @discardableResult
    fileprivate func finish(scope: JournalScope, operationID: String, state: DraftRecord.State,
                            receipt: Components.Schemas.SaveDocumentResponse? = nil,
                            conflict: Components.Schemas.SaveConflictResponse? = nil,
                            expectedAuthorID: String? = nil) throws -> Bool {
        var current = try records(scope: scope)
        guard let index = current.firstIndex(where: { $0.operationID == operationID }) else {
            throw DraftJournalError.corruptRecord
        }
        var record = current[index]
        if record.state == .committed || record.state == .conflict { return false }
        if state == .committed, let receipt {
            guard expectedAuthorID == nil || receipt.revision.authorId == expectedAuthorID else {
                record.state = .unknown
                current[index] = record
                try write(current, scope: scope)
                return false
            }
            current.remove(at: index)
            guard index < current.count, current[index].state == .protected else {
                try write(current, scope: scope)
                return true
            }
            var next = current[index]
            next.baseRevisionID = receipt.revision.id
            next.baseText = record.text
            next.saveRequest = Components.Schemas.SaveDocumentRequest(
                baseRevisionId: receipt.revision.id,
                changes: DocumentChangeBuilder.make(from: record.text, to: next.text),
                resultingSha256: next.contentSHA256, clientId: next.clientID
            )
            current[index] = next
        } else {
            record.state = state
            record.conflict = conflict
            current[index] = record
        }
        try write(current, scope: scope)
        return true
    }

    fileprivate func resolveConflict(scope: JournalScope, operationID: String, replacement: DraftRecord) throws -> DraftRecord {
        var current = try records(scope: scope)
        guard let index = current.firstIndex(where: { $0.operationID == operationID && $0.state == .conflict }),
              current[index].sessionID == replacement.sessionID else { throw DraftJournalError.staleConflict }
        guard current.filter({ $0.state == .protected }).allSatisfy({
            $0.sessionID == replacement.sessionID && $0.version <= replacement.version
        }) else { throw DraftJournalError.staleConflict }
        current.removeAll(where: { $0.state == .conflict || $0.state == .protected })
        current.append(replacement)
        try write(current, scope: scope)
        return replacement
    }

    private func fileURL(scope: JournalScope) throws -> URL {
        guard !scope.authorID.isEmpty, !scope.projectID.isEmpty, !scope.documentID.isEmpty,
              canonicalOrigin(scope.apiOrigin) == scope.apiOrigin else {
            throw DraftJournalError.invalidScope
        }
        let name = scopeKey(scope)
        return directory.appendingPathComponent(name).appendingPathExtension("json")
    }

    private func scopeKey(_ scope: JournalScope) -> String {
        Self.sha256((try? JSONEncoder().encode([scope.authorID, scope.apiOrigin, scope.projectID, scope.documentID])) ?? Data())
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
            changes: DocumentChangeBuilder.make(from: baseText, to: snapshot.text),
            resultingSha256: hash,
            clientId: clientID
        )
        let record = DraftRecord(authorID: authorID, apiOrigin: apiOrigin, projectID: projectID,
            documentID: snapshot.documentID, sessionID: snapshot.sessionID, version: snapshot.version,
            baseRevisionID: baseRevisionID,
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

    /// Replaces a conflicted operation only after the caller explicitly supplies
    /// the fetched server head and an author-approved merged editor snapshot.
    @discardableResult
    public func resolveConflict(documentID: String, expectedOperationID: String, snapshot: EditorState.Snapshot,
                                currentRevisionID: String, currentText: String) async throws -> DraftRecord {
        guard snapshot.documentID == documentID, !currentRevisionID.isEmpty,
              snapshot.text.utf16.count <= Int(Int32.max), currentText.utf16.count <= Int(Int32.max) else {
            throw DraftJournalError.invalidScope
        }
        let key = scope(documentID: documentID)
        guard let conflicted = try await journal.records(scope: key).first(where: {
            $0.operationID == expectedOperationID && $0.state == .conflict
        }), conflicted.sessionID == snapshot.sessionID else { throw DraftJournalError.staleConflict }
        if let serverRevision = conflicted.conflict?.current?.revision,
           (serverRevision.id != currentRevisionID || !Data(serverRevision.markdown.utf8).elementsEqual(Data(currentText.utf8))) {
            throw DraftJournalError.staleConflict
        }
        let hash = ProtectedDraftJournal.sha256(snapshot.text)
        let request = Components.Schemas.SaveDocumentRequest(
            baseRevisionId: currentRevisionID,
            changes: DocumentChangeBuilder.make(from: currentText, to: snapshot.text),
            resultingSha256: hash,
            clientId: clientID
        )
        let replacement = DraftRecord(authorID: authorID, apiOrigin: apiOrigin, projectID: projectID,
            documentID: documentID, sessionID: snapshot.sessionID, version: snapshot.version,
            baseRevisionID: currentRevisionID, baseText: currentText, text: snapshot.text,
            operationID: UUID().uuidString, clientID: clientID, contentSHA256: hash,
            state: .protected, saveRequest: request)
        return try await journal.resolveConflict(scope: key, operationID: expectedOperationID, replacement: replacement)
    }

    public func save(documentID: String) async -> SaveDisposition { await submit(documentID: documentID, reconcile: false) }
    public func reconcile(documentID: String) async -> SaveDisposition { await submit(documentID: documentID, reconcile: true) }

    private func submit(documentID: String, reconcile: Bool) async -> SaveDisposition {
        let key = scope(documentID: documentID)
        guard await journal.acquire(scope: key) else { return .pending(.responseLost) }
        let result: SaveDisposition
        do {
            switch try await journal.begin(scope: key, reconcile: reconcile) {
            case .nothing: result = .nothingToSave
            case .pending: result = .pending(.responseLost)
            case .conflict:
                let conflictRecord = try await journal.records(scope: key).first(where: { $0.state == .conflict })
                result = .conflict(conflictRecord?.conflict)
            case .record(let record):
                let save = try DocumentSave(projectID: projectID, documentID: documentID,
                    operationID: record.operationID, clientID: record.clientID, body: record.saveRequest)
                switch try await save.submit(using: api) {
                case .committed(let receipt):
                    let accepted = try await journal.finish(scope: key, operationID: record.operationID,
                        state: .committed, receipt: receipt, expectedAuthorID: authorID)
                    result = accepted ? .saved(receipt) : .atRisk
                case .unknown(let uncertainty):
                    try await journal.finish(scope: key, operationID: record.operationID, state: .unknown)
                    result = .pending(uncertainty)
                case .accepted:
                    try await journal.finish(scope: key, operationID: record.operationID, state: .unknown)
                    result = .accepted
                case .unauthorized:
                    try await journal.finish(scope: key, operationID: record.operationID, state: .unknown)
                    result = .unauthorized
                case .forbidden:
                    try await journal.finish(scope: key, operationID: record.operationID, state: .unknown)
                    result = .forbidden
                case .conflict(let response):
                    try await journal.finish(scope: key, operationID: record.operationID, state: .conflict, conflict: response)
                    result = .conflict(response)
                case .preconditionFailed:
                    try await journal.finish(scope: key, operationID: record.operationID, state: .conflict)
                    result = .preconditionFailed
                case .rejected(let status):
                    try await journal.finish(scope: key, operationID: record.operationID, state: .unknown)
                    result = .rejected(status)
                }
            }
        } catch OAuthError.signInRequired {
            result = .unauthorized
        } catch {
            result = .atRisk
        }
        await journal.release(scope: key)
        return result
    }

    private func scope(documentID: String) -> JournalScope {
        JournalScope(authorID: authorID, apiOrigin: apiOrigin, projectID: projectID, documentID: documentID)
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
