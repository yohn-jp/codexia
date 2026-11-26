import Foundation

/// In-memory editing state. Durable protection is acknowledged by the journal owner.
public struct EditorState {
    public struct Snapshot: Equatable, Sendable {
        let sessionID: UUID
        public let documentID: String
        public let version: UInt64
        /// Immutable manuscript contents captured at `version` for durable protection.
        /// Later edits to `EditorState` never change this payload.
        public let text: String
        let isComposing: Bool
        let compositionBaseText: String?
    }

    public struct RemoteRequest {
        fileprivate let snapshot: Snapshot
        fileprivate let generation: UInt64
    }

    public let documentID: String
    public private(set) var text: String
    private let session: UUID
    private var version: UInt64 = 0
    private var protectedVersion: UInt64 = 0
    private var committedVersion: UInt64? = 0
    private var focused = false
    public private(set) var isComposing = false
    private var pendingRemote: (String, RemoteRequest)?
    private var requestGeneration: UInt64 = 0
    private var compositionText: String?
    public private(set) var recoveredComposition: String?
    private var recoveredCompositionBase: String?

    public init(documentID: String, text: String) {
        self.documentID = documentID
        self.text = text
        self.session = UUID()
    }

    /// Restore the durable version, optionally using the freshly read confirmed manuscript.
    public init(recoveringDocumentID documentID: String, text: String, version: UInt64, sessionID: UUID,
                alreadyCommitted: Bool = false) {
        self.documentID = documentID
        self.text = text
        self.session = sessionID
        self.version = version
        self.protectedVersion = version
        self.committedVersion = alreadyCommitted ? version : nil
    }

    init(recoveringComposition record: DraftRecord) {
        self.init(recoveringDocumentID: record.documentID, text: record.compositionBaseText ?? record.text,
                  version: record.version, sessionID: record.sessionID)
        isComposing = true
        compositionText = record.text
        recoveredComposition = record.text
        recoveredCompositionBase = record.compositionBaseText
    }

    public var canDiscardRecoveredComposition: Bool { recoveredCompositionBase != nil }

    /// Legacy entries have no pre-composition body. Preserve their complete
    /// text until the author confirms it and can make any desired edits.
    public mutating func resolveRecoveredComposition(keepingText: Bool) {
        guard let recoveredComposition,
              keepingText || canDiscardRecoveredComposition else { return }
        self.recoveredComposition = nil
        recoveredCompositionBase = nil
        if keepingText { edit(recoveredComposition) }
        setComposing(false)
    }

    /// Stable identity for this in-memory editing session; a reopened document gets a new value.
    var sessionID: UUID { session }

    public var snapshot: Snapshot {
        let priorText = recoveredComposition == nil ? text : recoveredCompositionBase
        return Snapshot(sessionID: session, documentID: documentID, version: version, text: compositionText ?? text,
                        isComposing: isComposing, compositionBaseText: isComposing ? priorText : nil)
    }
    public var canLeave: Bool { version == protectedVersion && !isComposing }
    public var isCurrentVersionProtected: Bool {
        version == protectedVersion && (!isComposing || compositionText != nil)
    }
    public var hasLocalEdits: Bool { version != committedVersion }

    public func isCurrent(_ snapshot: Snapshot) -> Bool {
        snapshot.sessionID == session && snapshot.documentID == documentID
    }

    public mutating func edit(_ text: String) {
        guard recoveredComposition == nil, !self.text.utf8.elementsEqual(text.utf8) else { return }
        compositionText = nil
        self.text = text
        version += 1
        pendingRemote = nil
    }

    /// Capture UIKit's marked-text buffer for local protection without committing it as manuscript state.
    public mutating func updateComposition(_ text: String) {
        guard recoveredComposition == nil else { return }
        isComposing = true
        if let current = compositionText, current.utf8.elementsEqual(text.utf8) { return }
        compositionText = text
        version += 1
        pendingRemote = nil
    }

    public mutating func setComposing(_ active: Bool) {
        guard recoveredComposition == nil else { return }
        isComposing = active
        if !active, compositionText != nil {
            // Cancellation must replace any previously protected marked text.
            compositionText = nil
            version += 1
        }
        applyPendingIfPossible()
    }

    public mutating func setFocused(_ active: Bool) {
        focused = active
        applyPendingIfPossible()
    }

    private mutating func applyPendingIfPossible() {
        guard !focused, !isComposing, let pending = pendingRemote else { return }
        pendingRemote = nil
        _ = applyRemote(pending.0, for: pending.1)
    }

    public mutating func beginRemoteRequest() -> RemoteRequest {
        requestGeneration += 1
        pendingRemote = nil
        return RemoteRequest(snapshot: snapshot, generation: requestGeneration)
    }

    @discardableResult
    public mutating func applyRemote(_ text: String, for request: RemoteRequest) -> Bool {
        guard request.snapshot == snapshot, request.generation == requestGeneration,
              version == committedVersion else { return false }
        if focused || isComposing {
            pendingRemote = (text, request)
            return true
        }
        self.text = text
        version += 1
        protectedVersion = version
        committedVersion = version
        return true
    }

    /// Call only after durable local protection of this exact snapshot succeeds.
    public mutating func markProtected(_ snapshot: Snapshot) {
        guard snapshot.sessionID == session, snapshot.documentID == documentID,
              snapshot.version <= version else { return }
        protectedVersion = max(protectedVersion, snapshot.version)
    }

    /// Acknowledge bytes already confirmed at the base or by a validated save receipt.
    public mutating func markCommitted(_ snapshot: Snapshot) {
        guard snapshot.sessionID == session, snapshot.documentID == documentID,
              snapshot.version <= version, !snapshot.isComposing else { return }
        if let committedVersion {
            self.committedVersion = max(committedVersion, snapshot.version)
        } else {
            committedVersion = snapshot.version
        }
    }
}
