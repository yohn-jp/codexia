import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
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
    public let expectedReceiptAuthorID: String
    public let contentSHA256: String
    let isComposing: Bool?
    let compositionBaseText: String?
    public var state: State
    public var saveRequest: Components.Schemas.SaveDocumentRequest
    public var receipt: Components.Schemas.SaveDocumentResponse?
    public var conflict: Components.Schemas.SaveConflictResponse?

    fileprivate func saveOperation() throws -> DocumentSave {
        try DocumentSave(projectID: projectID, documentID: documentID,
            operationID: operationID, clientID: clientID, body: saveRequest)
    }

    // Keep the cancellation version on disk so a delayed marked-text write cannot restore it.
    public var isLocalBaseline: Bool {
        state == .protected && isComposing != true && text.utf8.elementsEqual(baseText.utf8)
    }

    public func restoreEditor(confirmedText: String? = nil) -> EditorState {
        if isComposing == true { return EditorState(recoveringComposition: self) }
        return EditorState(recoveringDocumentID: documentID, text: confirmedText ?? text,
                           version: version, sessionID: sessionID, alreadyCommitted: confirmedText != nil)
    }
}

public enum SaveDisposition: Sendable {
    case saved(Components.Schemas.SaveDocumentResponse, snapshot: EditorState.Snapshot)
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
    case staleSnapshot
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
        var prefix = 0
        while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < old.count - prefix, suffix < new.count - prefix,
              old[old.count - suffix - 1] == new[new.count - suffix - 1] { suffix += 1 }
        let oldMiddle = old[prefix..<(old.count - suffix)]
        let newMiddle = new[prefix..<(new.count - suffix)]
        if !oldMiddle.isEmpty && !newMiddle.isEmpty
            && (max(oldMiddle.count, newMiddle.count) <= 2_048
                || withinEditDistance(128, old: oldMiddle, new: newMiddle)) {
            return changes(old: oldMiddle, new: newMiddle, offsets: offsets)
        }
        return [.init(fromUtf16: offsets[prefix], toUtf16: offsets[oldMiddle.endIndex],
                      insert: scalarString(newMiddle))]
    }

    /// Bound the standard-library diff on large inputs by first finding a
    /// short insertion/deletion path. Equal interior passages then stay outside
    /// the encoded hunks even when the manuscript is hundreds of pages long.
    private static func withinEditDistance(_ limit: Int, old: ArraySlice<Unicode.Scalar>,
                                           new: ArraySlice<Unicode.Scalar>) -> Bool {
        guard abs(old.count - new.count) <= limit else { return false }
        let center = limit + 1
        var furthest = [Int](repeating: 0, count: center * 2 + 1)
        for distance in 0...limit {
            for diagonal in stride(from: -distance, through: distance, by: 2) {
                let slot = center + diagonal
                let insertion = diagonal == -distance
                    || (diagonal != distance && furthest[slot - 1] < furthest[slot + 1])
                var x = insertion ? furthest[slot + 1] : furthest[slot - 1] + 1
                var y = x - diagonal
                while x < old.count, y < new.count, old[old.startIndex + x] == new[new.startIndex + y] {
                    x += 1
                    y += 1
                }
                furthest[slot] = x
                if x >= old.count, y >= new.count { return true }
            }
        }
        return false
    }

    private static func changes(old: ArraySlice<Unicode.Scalar>, new: ArraySlice<Unicode.Scalar>, offsets: [Int32])
        -> [Components.Schemas.DocumentChange] {
        let difference = new.difference(from: old)
        let removals = Set(difference.removals.map { change in
            if case .remove(let offset, _, _) = change { return old.startIndex + offset }
            preconditionFailure("Unexpected insertion in removals")
        })
        let insertions = Set(difference.insertions.map { change in
            if case .insert(let offset, _, _) = change { return new.startIndex + offset }
            preconditionFailure("Unexpected removal in insertions")
        })
        var changes: [Components.Schemas.DocumentChange] = []
        var oldIndex = old.startIndex
        var newIndex = new.startIndex
        while oldIndex < old.endIndex || newIndex < new.endIndex {
            let oldStart = oldIndex
            let newStart = newIndex
            while removals.contains(oldIndex) { oldIndex += 1 }
            while insertions.contains(newIndex) { newIndex += 1 }
            if oldIndex == oldStart, newIndex == newStart {
                oldIndex += 1
                newIndex += 1
            } else {
                changes.append(.init(fromUtf16: offsets[oldStart], toUtf16: offsets[oldIndex],
                                     insert: scalarString(new[newStart..<newIndex])))
            }
        }
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

private struct DraftCommitReceipt: Codable {
    let operationID: String
    let sessionID: UUID?
    let version: UInt64?
    let baseRevisionID: String
    let revisionID: String
    let contentSHA256: String
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
                && $0.saveRequest.baseRevisionId == $0.baseRevisionID
                && !$0.expectedReceiptAuthorID.isEmpty }) else {
                throw DraftJournalError.corruptRecord
            }
            return records.map { stored in
                guard let conflict = stored.conflict else { return stored }
                // Older versions stored the 409 comparison before checking its identity.
                var record = stored
                record.conflict = (try? record.saveOperation())?.validatedConflict(conflict)
                return record
            }
        }
        catch { throw DraftJournalError.corruptRecord }
    }

    fileprivate func acquire(scope: JournalScope) -> Bool { activeScopes.insert(scopeKey(scope)).inserted }
    fileprivate func release(scope: JournalScope) { activeScopes.remove(scopeKey(scope)) }

    fileprivate func write(_ records: [DraftRecord], scope: JournalScope) throws {
        try writeProtected(encoder.encode(records), to: fileURL(scope: scope))
    }

    private func writeProtected(_ data: Data, to url: URL) throws {
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        try data.write(to: url, options: options)
    }

    fileprivate func insert(_ record: DraftRecord, scope: JournalScope) throws -> DraftRecord {
        var current = try records(scope: scope)
        let receiptURL = try receiptURL(scope: scope)
        if let data = try? Data(contentsOf: receiptURL),
           let receipt = try? decoder.decode(DraftCommitReceipt.self, from: data),
           receipt.sessionID == record.sessionID, let version = receipt.version,
           !current.contains(where: { $0.operationID == receipt.operationID }),
           record.version <= version || record.baseRevisionID == receipt.baseRevisionID {
            throw DraftJournalError.staleSnapshot
        }
        if let latest = current.last, latest.sessionID == record.sessionID, record.version < latest.version {
            throw DraftJournalError.staleSnapshot
        }
        if let latest = current.last, latest.sessionID == record.sessionID
            && (latest.version == record.version || latest.state != .protected)
            && (latest.isComposing == true) == (record.isComposing == true)
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
        guard record.isComposing != true, !record.isLocalBaseline else { return .nothing }
        if record.state == .protected && reconcile { return .nothing }
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
            guard (expectedAuthorID == nil || receipt.revision.authorId == expectedAuthorID),
                  record.text.utf8.elementsEqual(receipt.revision.markdown.utf8) else {
                record.state = .unknown
                current[index] = record
                try write(current, scope: scope)
                return false
            }
            try writeProtected(encoder.encode(DraftCommitReceipt(
                operationID: record.operationID,
                sessionID: record.sessionID,
                version: record.version,
                baseRevisionID: record.baseRevisionID,
                revisionID: receipt.revision.id,
                contentSHA256: record.contentSHA256
            )), to: receiptURL(scope: scope))
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

    private func receiptURL(scope: JournalScope) throws -> URL {
        try fileURL(scope: scope).deletingPathExtension().appendingPathExtension("receipt.json")
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
    private let expectedReceiptAuthorID: String
    private let journal: ProtectedDraftJournal
    private let api: any APIProtocol

    public init(authorID: String, apiOrigin: URL, projectID: String, clientID: String, expectedReceiptAuthorID: String = "owner",
                journal: ProtectedDraftJournal, api: any APIProtocol) throws {
        guard !authorID.isEmpty, !projectID.isEmpty, !clientID.isEmpty, !expectedReceiptAuthorID.isEmpty,
              let canonical = canonicalOrigin(apiOrigin.absoluteString) else {
            throw DraftJournalError.invalidScope
        }
        self.authorID = authorID
        self.apiOrigin = canonical
        self.projectID = projectID
        self.clientID = clientID
        self.expectedReceiptAuthorID = expectedReceiptAuthorID
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
            expectedReceiptAuthorID: expectedReceiptAuthorID, contentSHA256: hash,
            isComposing: snapshot.isComposing ? true : nil,
            compositionBaseText: snapshot.compositionBaseText,
            state: .protected, saveRequest: request)
        return try await journal.insert(record, scope: scope)
    }

    public func recover(documentID: String) async throws -> DraftRecord? {
        try await records(documentID: documentID).last
    }

    public func records(documentID: String, includeLocalBaseline: Bool = false) async throws -> [DraftRecord] {
        let pending = try await journal.records(scope: scope(documentID: documentID)).filter { $0.state != .committed }
        if !includeLocalBaseline, pending.count == 1, pending.first?.isLocalBaseline == true { return [] }
        return pending
    }

    /// Replaces a conflicted operation only after the caller explicitly supplies
    /// the fetched server head and an author-approved merged editor snapshot.
    @discardableResult
    public func resolveConflict(documentID: String, expectedOperationID: String, snapshot: EditorState.Snapshot,
                                currentRevisionID: String, currentText: String) async throws -> DraftRecord {
        guard snapshot.documentID == documentID, !snapshot.isComposing, !currentRevisionID.isEmpty,
              snapshot.text.utf16.count <= Int(Int32.max), currentText.utf16.count <= Int(Int32.max) else {
            throw DraftJournalError.invalidScope
        }
        let key = scope(documentID: documentID)
        guard let conflicted = try await journal.records(scope: key).first(where: {
            $0.operationID == expectedOperationID && $0.state == .conflict
        }), conflicted.sessionID == snapshot.sessionID else { throw DraftJournalError.staleConflict }
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
            operationID: UUID().uuidString, clientID: clientID, expectedReceiptAuthorID: expectedReceiptAuthorID,
            contentSHA256: hash,
            isComposing: nil, compositionBaseText: nil, state: .protected, saveRequest: request)
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
                switch try await record.saveOperation().submit(using: api) {
                case .committed(let receipt):
                    let accepted = try await journal.finish(scope: key, operationID: record.operationID,
                        state: .committed, receipt: receipt, expectedAuthorID: record.expectedReceiptAuthorID)
                    let snapshot = EditorState.Snapshot(sessionID: record.sessionID, documentID: record.documentID,
                        version: record.version, text: record.text, isComposing: false, compositionBaseText: nil)
                    result = accepted ? .saved(receipt, snapshot: snapshot) : .atRisk
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
