import XCTest
import CodexiaTransport
@testable import CodexiaEditor
#if os(Linux)
import Glibc
#elseif os(macOS)
import Darwin
#endif

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

        let otherProject = try JournalSaveCoordinator(authorID: "author-a", apiOrigin: URL(string: "https://api.example.test")!,
            projectID: "another-project", clientID: "ios-test", journal: reopened, api: api)
        let otherProjectDraft = try await otherProject.recover(documentID: "document")
        XCTAssertNil(otherProjectDraft)
    }

#if os(Linux) || os(macOS)
    func testForcedProcessTerminationRecoversTheSameOperation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        process.arguments = ["CodexiaEditorTests.JournalSaveCoordinatorTests/testForcedKillProbe"]
        var environment = ProcessInfo.processInfo.environment
        environment["CODEXIA_JOURNAL_CRASH_PROBE_DIRECTORY"] = root.path
        process.environment = environment
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationReason, .uncaughtSignal)
        XCTAssertEqual(process.terminationStatus, SIGKILL)

        let origin = URL(string: "https://api.example.test")!
        let restarted = try JournalSaveCoordinator(authorID: "author", apiOrigin: origin,
            projectID: "project", clientID: "ios-test", journal: ProtectedDraftJournal(directory: root),
            api: APITransport(origin: origin).client)
        let recovered = try await restarted.recover(documentID: "document")
        XCTAssertEqual(recovered?.text, "durable before process death")
        XCTAssertEqual(recovered?.state, .protected)
        let expectedOperationID = try String(contentsOf: root.appendingPathComponent("expected-operation-id"), encoding: .utf8)
        XCTAssertEqual(recovered?.operationID, expectedOperationID)
    }

    /// Invoked in a child XCTest process. SIGKILL proves recovery survives loss
    /// of process memory immediately after the atomic journal write returns.
    func testForcedKillProbe() async throws {
        guard let path = ProcessInfo.processInfo.environment["CODEXIA_JOURNAL_CRASH_PROBE_DIRECTORY"] else { return }
        let root = URL(fileURLWithPath: path, isDirectory: true)
        let origin = URL(string: "https://api.example.test")!
        let coordinator = try JournalSaveCoordinator(authorID: "author", apiOrigin: origin,
            projectID: "project", clientID: "ios-test", journal: ProtectedDraftJournal(directory: root),
            api: APITransport(origin: origin).client)
        var editor = EditorState(documentID: "document", text: "base")
        editor.edit("durable before process death")
        let protected = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: "revision-1", baseText: "base")
        try Data(protected.operationID.utf8).write(to: root.appendingPathComponent("expected-operation-id"))
        _ = kill(getpid(), SIGKILL)
        XCTFail("The child process should be terminated by SIGKILL")
    }
#endif

    func testNonASCIIContentDigestAndScopeFilenameStayStable() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let origin = URL(string: "https://api.example.test")!
        let coordinator = try JournalSaveCoordinator(authorID: "作者😀", apiOrigin: origin,
            projectID: "案件", clientID: "ios-test", journal: ProtectedDraftJournal(directory: root), api: APITransport(origin: origin).client)
        var editor = EditorState(documentID: "文書", text: "base")
        editor.edit("本文😀")

        let record = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: "revision-1", baseText: "base")
        XCTAssertEqual(record.contentSHA256, "253a6340aa6b23d9b592d5db134b6f64785df16e4d72f02b7f0413bd8d5de7ab")
        let files = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertEqual(files, ["d1cb08607a3894ef234923814bd9b515d617af2518034abc29a237de5ef4e2b6.json"])
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
        guard case .nothingToSave = await reopened.save(documentID: "document") else {
            return XCTFail("A marked-text entry must stay local even if the journal is asked to save")
        }
        let stillProtected = try await reopened.recover(documentID: "document")
        XCTAssertEqual(stillProtected?.operationID, protected.operationID)

        editor.edit("基準稿かな")
        editor.setComposing(false)
        let confirmed = try await reopened.protect(snapshot: editor.snapshot, baseRevisionID: "revision-1", baseText: "基準稿")
        XCTAssertNotEqual(confirmed.operationID, protected.operationID)
        XCTAssertEqual(confirmed.text, protected.text)
    }

    func testCanceledCompositionClearsTheLocalDraftWithoutSendingARevision() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let origin = URL(string: "https://api.example.test")!
        let coordinator = try JournalSaveCoordinator(authorID: "author", apiOrigin: origin,
            projectID: "project", clientID: "ios-test", journal: ProtectedDraftJournal(directory: root),
            api: APITransport(origin: origin).client)
        var editor = EditorState(documentID: "document", text: "基準稿")
        editor.updateComposition("基準稿かな")
        let markedText = editor.snapshot
        try await coordinator.protect(snapshot: markedText, baseRevisionID: "revision-1", baseText: "基準稿")
        editor.setComposing(false)
        try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: "revision-1", baseText: "基準稿")

        do {
            try await coordinator.protect(snapshot: markedText, baseRevisionID: "revision-1", baseText: "基準稿")
            XCTFail("A delayed write must not restore canceled marked text")
        } catch DraftJournalError.staleSnapshot {
            // The base-matching record still guards the journal version.
        }
        let recovered = try await coordinator.recover(documentID: "document")
        XCTAssertNil(recovered)
        let baseline = try await coordinator.records(documentID: "document", includeLocalBaseline: true)
        XCTAssertEqual(baseline.last?.version, editor.snapshot.version)
        XCTAssertEqual(baseline.last?.sessionID, editor.snapshot.sessionID)
        guard case .nothingToSave = await coordinator.save(documentID: "document") else {
            return XCTFail("Canceling marked text must not produce an identical server revision")
        }
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
