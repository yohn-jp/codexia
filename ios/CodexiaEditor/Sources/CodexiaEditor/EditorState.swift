import Foundation

/// In-memory editing state. Protection is acknowledged only by a future journal owner.
public struct EditorState {
    public struct Snapshot: Equatable {
        fileprivate let session: UUID
        public let documentID: String
        public let version: UInt64
    }

    public let documentID: String
    public private(set) var text: String
    private let session = UUID()
    private var version: UInt64 = 0
    private var protectedVersion: UInt64 = 0

    public init(documentID: String, text: String) {
        self.documentID = documentID
        self.text = text
    }

    public var snapshot: Snapshot { Snapshot(session: session, documentID: documentID, version: version) }
    public var canLeave: Bool { version == protectedVersion }

    public mutating func edit(_ text: String) {
        guard self.text != text else { return }
        self.text = text
        version += 1
    }

    @discardableResult
    public mutating func applyRemote(_ text: String, for request: Snapshot) -> Bool {
        guard request == snapshot, canLeave else { return false }
        self.text = text
        return true
    }

    /// Call only after durable local protection of this exact snapshot succeeds.
    public mutating func markProtected(_ snapshot: Snapshot) {
        guard snapshot.session == session, snapshot.documentID == documentID,
              snapshot.version <= version else { return }
        protectedVersion = max(protectedVersion, snapshot.version)
    }
}
