import XCTest
import CodexiaTransport
@testable import CodexiaEditor

final class JournalSaveCoordinatorTests: XCTestCase {
    func testDistantEditsInLongDraftPreserveUnchangedInterior() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let origin = URL(string: "https://api.example.test")!
        let coordinator = try JournalSaveCoordinator(authorID: "author", apiOrigin: origin,
            projectID: "project", clientID: "ios-test", journal: ProtectedDraftJournal(directory: root),
            api: APITransport(origin: origin).client)
        let interior = String(repeating: "稿😀", count: 1_500)
        let base = "始" + interior + "終"
        var editor = EditorState(documentID: "document", text: base)
        editor.edit("先" + interior + "後")

        let draft = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: "base", baseText: base)

        let changes = draft.saveRequest.changes
        XCTAssertEqual(changes.map(\.fromUtf16), [0, 4_501])
        XCTAssertEqual(changes.map(\.toUtf16), [1, 4_502])
        XCTAssertEqual(changes.map(\.insert), ["先", "後"])
    }

    func testProtectedSnapshotsSurviveJournalRecreationAndRemainAuthorScoped() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let api = try APITransport(origin: URL(string: "https://api.example.test")!).client
        let journal = try ProtectedDraftJournal(directory: root)
        let authorA = try JournalSaveCoordinator(authorID: "author-a", apiOrigin: URL(string: "https://api.example.test")!,
            projectID: "project", clientID: "ios-test", journal: journal, api: api)

        var editor = EditorState(documentID: "document", text: "基準稿")
        editor.edit("基準稿に追記😀")
        let snapshot = editor.snapshot
        let first = try await authorA.protect(snapshot: snapshot, baseRevisionID: "revision-1", baseText: "基準稿")
        let duplicate = try await authorA.protect(snapshot: snapshot, baseRevisionID: "revision-1", baseText: "基準稿")
        XCTAssertEqual(first.operationID, duplicate.operationID)
        XCTAssertEqual(first.saveRequest.changes.first?.toUtf16, Int32("基準稿".utf16.count))

        let reopened = try ProtectedDraftJournal(directory: root)
        let restoredAuthorA = try JournalSaveCoordinator(authorID: "author-a", apiOrigin: URL(string: "https://api.example.test")!,
            projectID: "project", clientID: "ios-test", journal: reopened, api: api)
        let recovered = try await restoredAuthorA.recover(documentID: "document")
        XCTAssertEqual(recovered?.text, snapshot.text)
        XCTAssertEqual(recovered?.operationID, first.operationID)
        XCTAssertEqual(recovered?.state, .protected)

        let authorB = try JournalSaveCoordinator(authorID: "author-b", apiOrigin: URL(string: "https://api.example.test")!,
            projectID: "project", clientID: "ios-test", journal: reopened, api: api)
        let otherAuthorDraft = try await authorB.recover(documentID: "document")
        XCTAssertNil(otherAuthorDraft)
    }

    func testComposingSnapshotIsRecoveredAsPendingLocalDraft() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let origin = URL(string: "https://api.example.test")!
        let journal = try ProtectedDraftJournal(directory: root)
        let coordinator = try JournalSaveCoordinator(authorID: "author", apiOrigin: origin,
            projectID: "project", clientID: "ios-test", journal: journal,
            api: APITransport(origin: origin).client)
        var editor = EditorState(documentID: "document", text: "基準稿")
        editor.updateComposition("基準稿かな")

        let protected = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: "revision-1", baseText: "基準稿")
        let reopened = try JournalSaveCoordinator(authorID: "author", apiOrigin: origin,
            projectID: "project", clientID: "ios-test", journal: ProtectedDraftJournal(directory: root),
            api: APITransport(origin: origin).client)
        let recovered = try await reopened.recover(documentID: "document")

        XCTAssertEqual(protected.text, "基準稿かな")
        XCTAssertEqual(protected.state, .protected)
        XCTAssertEqual(recovered?.text, "基準稿かな")
        XCTAssertEqual(recovered?.state, .protected)
        XCTAssertFalse(editor.canLeave)
    }

    func testUnsubmittedSnapshotsCoalesceToLatestAndRecoveryUsesAppendOrder() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let api = try APITransport(origin: URL(string: "https://api.example.test")!).client
        let journal = try ProtectedDraftJournal(directory: root)
        let coordinator = try JournalSaveCoordinator(authorID: "author", apiOrigin: URL(string: "https://api.example.test")!,
            projectID: "project", clientID: "ios-test", journal: journal, api: api)
        var editor = EditorState(documentID: "document", text: "基準稿")
        editor.edit("一度目")
        _ = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: "revision-1", baseText: "基準稿")
        let recoveredBeforeRestart = try await coordinator.recover(documentID: "document")
        let durable = try XCTUnwrap(recoveredBeforeRestart)
        var relaunchedEditor = EditorState(recoveringDocumentID: durable.documentID, text: durable.text,
            version: durable.version, sessionID: durable.sessionID)
        relaunchedEditor.edit("新しい起動後入力")
        _ = try await coordinator.protect(snapshot: relaunchedEditor.snapshot, baseRevisionID: "revision-1", baseText: "基準稿")

        let records = try await coordinator.records(documentID: "document")
        XCTAssertEqual(records.map(\.text), ["新しい起動後入力"])
        let recovered = try await coordinator.recover(documentID: "document")
        XCTAssertEqual(recovered?.text, "新しい起動後入力")
    }

    func testRecoveryRejectsModifiedDraftPayload() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let api = try APITransport(origin: URL(string: "https://api.example.test")!).client
        let journal = try ProtectedDraftJournal(directory: root)
        let coordinator = try JournalSaveCoordinator(authorID: "author", apiOrigin: URL(string: "https://api.example.test")!,
            projectID: "project", clientID: "ios-test", journal: journal, api: api)
        var editor = EditorState(documentID: "document", text: "基準稿")
        editor.edit("改変前")
        _ = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: "revision-1", baseText: "基準稿")

        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        let data = try Data(contentsOf: file)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        object[0]["text"] = "改ざん済み"
        try JSONSerialization.data(withJSONObject: object).write(to: file, options: .atomic)

        do {
            _ = try await coordinator.recover(documentID: "document")
            XCTFail("Modified draft should be rejected")
        } catch DraftJournalError.corruptRecord {
            // Expected: stored digest no longer matches the journal payload.
        }
    }

    func testOutOfOrderProtectionCannotReplaceNewerSnapshot() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let api = try APITransport(origin: URL(string: "https://api.example.test")!).client
        let journal = try ProtectedDraftJournal(directory: root)
        let coordinator = try JournalSaveCoordinator(authorID: "author-a", apiOrigin: URL(string: "https://api.example.test")!,
            projectID: "project", clientID: "ios-test", journal: journal, api: api)
        var editor = EditorState(documentID: "document", text: "base")
        editor.edit("version one")
        let older = editor.snapshot
        editor.edit("version two")
        let newer = editor.snapshot
        _ = try await coordinator.protect(snapshot: newer, baseRevisionID: "revision-1", baseText: "base")
        do {
            _ = try await coordinator.protect(snapshot: older, baseRevisionID: "revision-1", baseText: "base")
            XCTFail("A stale callback must not replace a newer protected snapshot")
        } catch DraftJournalError.staleSnapshot {
            // Expected: durable protection is monotonic within an editor session.
        }
        let recovered = try await coordinator.recover(documentID: "document")
        XCTAssertEqual(recovered?.text, "version two")
        XCTAssertEqual(recovered?.version, newer.version)
    }
}
