import XCTest
import Foundation
import CodexiaAPI
import CodexiaTransport
import HTTPTypes
import OpenAPIRuntime
@testable import CodexiaEditor

private actor JournalSaveFixture: ClientTransport {
    enum Action: Sendable {
        case status(Int, Data?)
        case offline
    }

    struct Exchange: Sendable {
        let request: HTTPRequest
        let payload: Data?
        let operationID: String
    }

    private var actions: [Action] = []
    private var holdNext = false
    private var held: CheckedContinuation<(HTTPResponse, HTTPBody?), any Error>?
    private var exchanges: [Exchange] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func append(_ action: Action) { actions.append(action) }
    func holdNextResponse() { holdNext = true }
    func recordedExchanges() -> [Exchange] { exchanges }

    func waitForRequestCount(_ count: Int) async {
        if exchanges.count >= count { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release(status: Int, body: Data?) {
        guard let held else { return }
        self.held = nil
        held.resume(returning: makeResponse(status: status, data: body))
    }

    func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String)
        async throws -> (HTTPResponse, HTTPBody?) {
        let payload: Data?
        if let body { payload = try await Data(collecting: body, upTo: 2_000_000) }
        else { payload = nil }
        exchanges.append(.init(request: request, payload: payload, operationID: operationID))
        let ready = waiters
        waiters.removeAll()
        ready.forEach { $0.resume() }

        if holdNext {
            holdNext = false
            return try await withCheckedThrowingContinuation { held = $0 }
        }
        guard !actions.isEmpty else { return makeResponse(status: 500, data: nil) }
        switch actions.removeFirst() {
        case .offline: throw URLError(.notConnectedToInternet)
        case .status(let status, let data): return makeResponse(status: status, data: data)
        }
    }
}

private func makeResponse(status: Int, data: Data?) -> (HTTPResponse, HTTPBody?) {
    var fields = HTTPFields()
    if data != nil { fields[.contentType] = "application/json" }
    return (.init(status: .init(code: status), headerFields: fields), data.map { HTTPBody($0) })
}

private func responseJSON(_ object: [String: Any]?) -> Data? {
    guard let object else { return nil }
    return try? JSONSerialization.data(withJSONObject: object)
}

private func makeReceipt(markdown: String, sha256: String, parent: String, revision: String, authorID: String = "owner") -> Data {
    let now = "2026-11-23T00:00:00Z"
    let value: [String: Any] = [
        "document": ["id": "document", "projectId": "project", "parentId": NSNull(), "kind": "scene",
                     "title": "稿", "orderKey": "0", "headRevisionId": revision, "version": 2,
                     "createdAt": now, "updatedAt": now],
        "revision": ["id": revision, "projectId": "project", "documentId": "document",
                     "parentRevisionId": parent, "markdown": markdown, "sha256": sha256,
                     "authorId": authorID, "createdAt": now],
        "replayed": false,
    ]
    return responseJSON(value)!
}

private let baseRevision = "revision-base"
private let origin = URL(string: "https://api.example.test")!

final class JournalSaveBehaviorTests: XCTestCase {
    private func makeCoordinator(journal: ProtectedDraftJournal, clientID: String = "ios-test",
                                 transport: JournalSaveFixture) throws -> JournalSaveCoordinator {
        let api = Client(serverURL: origin, transport: transport)
        return try JournalSaveCoordinator(authorID: "author", apiOrigin: origin, projectID: "project",
            clientID: clientID, journal: journal, api: api)
    }

    func testInFlightTypingQueuesAndRebasesThenReceiptsCommit() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = JournalSaveFixture()
        let firstReceipt = makeReceipt(markdown: "first", sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e", parent: baseRevision, revision: "revision-first")
        let secondReceipt = makeReceipt(markdown: "second", sha256: "16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4", parent: "revision-first", revision: "revision-second")
        await fixture.holdNextResponse()
        await fixture.append(.status(200, secondReceipt))
        let journal = try ProtectedDraftJournal(directory: root)
        let coordinator = try makeCoordinator(journal: journal, transport: fixture)

        var editor = EditorState(documentID: "document", text: "base")
        editor.edit("first")
        _ = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: baseRevision, baseText: "base")
        let saving = Task { await coordinator.save(documentID: "document") }
        await fixture.waitForRequestCount(1)
        let secondCoordinator = try makeCoordinator(journal: journal, transport: fixture)
        guard case .pending(.responseLost) = await secondCoordinator.reconcile(documentID: "document") else {
            return XCTFail("The shared journal gate must prevent concurrent replay")
        }
        editor.edit("second")
        let queued = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: baseRevision, baseText: "base")
        let whileInFlight = try await coordinator.records(documentID: "document")
        XCTAssertEqual(whileInFlight.count, 2)
        XCTAssertEqual(whileInFlight.first?.state, .inFlight)
        XCTAssertEqual(whileInFlight.last?.text, "second")

        await fixture.release(status: 200, body: firstReceipt)
        guard case .saved(_) = await saving.value else { return XCTFail("First save should match the server receipt") }
        let rebased = try await coordinator.records(documentID: "document")
        XCTAssertEqual(rebased.count, 1)
        XCTAssertEqual(rebased[0].text, "second")
        XCTAssertEqual(rebased[0].baseRevisionID, "revision-first")
        XCTAssertEqual(rebased[0].baseText, "first")
        XCTAssertFalse(rebased[0].saveRequest.changes.isEmpty)
        XCTAssertEqual(apply(rebased[0].saveRequest.changes, to: "first"), "second")
        XCTAssertEqual(rebased[0].operationID, queued.operationID)

        guard case .saved(_) = await coordinator.save(documentID: "document") else { return XCTFail("Queued save should commit") }
        let remaining = try await coordinator.records(documentID: "document")
        XCTAssertTrue(remaining.isEmpty)
        let exchanges = await fixture.recordedExchanges()
        XCTAssertEqual(exchanges.count, 2)
    }

    func testStatusesRemainDistinctAndNeverBecomeSaved() async throws {
        let cases: [(Int?, Data?, String)] = [
            (202, nil, "accepted"), (401, nil, "unauthorized"), (403, nil, "forbidden"),
            (409, responseJSON(["code": "PERSISTENCE_CONFLICT", "error": "stale", "details": NSNull(), "current": NSNull()]), "conflict"),
            (412, nil, "precondition"), (nil, nil, "offline"),
        ]
        for (status, body, expected) in cases {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let fixture = JournalSaveFixture()
            if let status { await fixture.append(.status(status, body)) } else { await fixture.append(.offline) }
            let journal = try ProtectedDraftJournal(directory: root)
            let coordinator = try makeCoordinator(journal: journal, transport: fixture)
            var editor = EditorState(documentID: "document", text: "base")
            editor.edit("draft")
            _ = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: baseRevision, baseText: "base")
            let disposition = await coordinator.save(documentID: "document")
            switch (expected, disposition) {
            case ("accepted", .accepted), ("unauthorized", .unauthorized), ("forbidden", .forbidden),
                 ("conflict", .conflict(_)), ("precondition", .preconditionFailed),
                 ("offline", .pending(.offline)):
                break
            default: XCTFail("Unexpected disposition for \(expected): \(disposition)")
            }
            let retained = try await coordinator.recover(documentID: "document")
            XCTAssertNotNil(retained)
            if expected != "conflict" && expected != "precondition" {
                XCTAssertEqual(retained?.state, .unknown)
            } else {
                XCTAssertEqual(retained?.state, .conflict)
            }
        }
    }

    func testUnknownReplayAfterRestartUsesSameOperationAndStoredClientID() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = JournalSaveFixture()
        await fixture.append(.offline)
        let digest = "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e"
        await fixture.append(.status(200, makeReceipt(markdown: "first", sha256: digest, parent: baseRevision, revision: "revision-first")))
        let firstJournal = try ProtectedDraftJournal(directory: root)
        let firstCoordinator = try makeCoordinator(journal: firstJournal, clientID: "old-client", transport: fixture)
        var editor = EditorState(documentID: "document", text: "base")
        editor.edit("first")
        let protected = try await firstCoordinator.protect(snapshot: editor.snapshot, baseRevisionID: baseRevision, baseText: "base")
        guard case .pending(.offline) = await firstCoordinator.save(documentID: "document") else {
            return XCTFail("Offline response should remain unknown")
        }

        let secondJournal = try ProtectedDraftJournal(directory: root)
        let restarted = try makeCoordinator(journal: secondJournal, clientID: "new-client", transport: fixture)
        guard case .pending = await restarted.save(documentID: "document") else {
            return XCTFail("An unknown operation needs explicit reconciliation after restart")
        }
        guard case .saved(_) = await restarted.reconcile(documentID: "document") else {
            return XCTFail("The same operation should reconcile through its stored receipt")
        }
        let exchanges = await fixture.recordedExchanges()
        XCTAssertEqual(exchanges.count, 2)
        XCTAssertEqual(exchanges[0].request.headerFields[HTTPField.Name("Idempotency-Key")!], protected.operationID)
        XCTAssertEqual(exchanges[1].request.headerFields[HTTPField.Name("Idempotency-Key")!], protected.operationID)
        XCTAssertEqual(exchanges[0].request.headerFields[HTTPField.Name("X-Client-Id")!], "old-client")
        XCTAssertEqual(exchanges[1].request.headerFields[HTTPField.Name("X-Client-Id")!], "old-client")
        XCTAssertEqual(exchanges[0].payload, exchanges[1].payload)
    }

    func testRecoveryHidesForeignComparisonFromLegacyConflictRecord() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = JournalSaveFixture()
        let remote = try JSONSerialization.jsonObject(with: makeReceipt(
            markdown: "first", sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
            parent: baseRevision, revision: "head-at-conflict"
        ))
        let conflict = responseJSON(["code": "PERSISTENCE_CONFLICT", "error": "stale", "details": NSNull(), "current": remote])
        await fixture.append(.status(409, conflict))
        let coordinator = try makeCoordinator(journal: ProtectedDraftJournal(directory: root), transport: fixture)
        var editor = EditorState(documentID: "document", text: "base")
        editor.edit("local")
        let original = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: baseRevision, baseText: "base")
        guard case .conflict(let response) = await coordinator.save(documentID: "document") else {
            return XCTFail("Expected a stale-base conflict")
        }
        XCTAssertEqual(response?.current?.revision?.id, "head-at-conflict")

        let reopened = try makeCoordinator(journal: ProtectedDraftJournal(directory: root), transport: fixture)
        let valid = try await reopened.recover(documentID: "document")
        XCTAssertEqual(valid?.conflict?.current?.revision?.id, "head-at-conflict")
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        var records = try JSONDecoder().decode([DraftRecord].self, from: Data(contentsOf: file))
        records[0].conflict?.current?.revision?.projectId = "foreign-project"
        try JSONEncoder().encode(records).write(to: file, options: .atomic)

        let recovered = try await reopened.recover(documentID: "document")
        XCTAssertEqual(recovered?.text, "local")
        XCTAssertEqual(recovered?.operationID, original.operationID)
        XCTAssertEqual(recovered?.state, .conflict)
        XCTAssertNil(recovered?.conflict)
        guard case .conflict(nil) = await reopened.reconcile(documentID: "document") else {
            return XCTFail("The conflict must still require resolution without rejected comparison data")
        }
        let exchanges = await fixture.recordedExchanges()
        XCTAssertEqual(exchanges.count, 1)
    }

    func testConflictRequiresExplicitFreshHeadResolution() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = JournalSaveFixture()
        let observedAtConflict = try JSONSerialization.jsonObject(with: makeReceipt(
            markdown: "first", sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
            parent: baseRevision, revision: "head-at-conflict"
        ))
        let conflict = responseJSON(["code": "PERSISTENCE_CONFLICT", "error": "stale", "details": NSNull(), "current": observedAtConflict])
        await fixture.append(.status(409, conflict))
        await fixture.append(.status(200, makeReceipt(markdown: "merged", sha256: "3f8f09c8e09f712b362183db69f4f061bd948d7a61e7663b585d723602c559b1", parent: "server-head", revision: "saved")))
        let journal = try ProtectedDraftJournal(directory: root)
        let coordinator = try makeCoordinator(journal: journal, transport: fixture)
        var editor = EditorState(documentID: "document", text: "base")
        editor.edit("local")
        let original = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: baseRevision, baseText: "base")
        guard case .conflict(let response) = await coordinator.save(documentID: "document"),
              response?.current?.revision?.id == "head-at-conflict" else {
            return XCTFail("A stale base must remain a conflict")
        }
        editor.edit("merged")
        let approved = editor.snapshot
        let resolved = try await coordinator.resolveConflict(documentID: "document", expectedOperationID: original.operationID,
            snapshot: approved, currentRevisionID: "server-head", currentText: "server text")
        XCTAssertNotEqual(resolved.operationID, original.operationID)
        XCTAssertEqual(resolved.saveRequest.baseRevisionId, "server-head")
        guard case .saved(_) = await coordinator.save(documentID: "document") else {
            return XCTFail("The explicit merged result should save against the fetched head")
        }
    }

    func testReceiptForDifferentAuthorIsNeverCommittedLocally() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = JournalSaveFixture()
        let wrongReceipt = makeReceipt(markdown: "first", sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e", parent: baseRevision, revision: "foreign", authorID: "other")
        await fixture.append(.status(200, wrongReceipt))
        let journal = try ProtectedDraftJournal(directory: root)
        let coordinator = try makeCoordinator(journal: journal, transport: fixture)
        var editor = EditorState(documentID: "document", text: "base")
        editor.edit("first")
        _ = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: baseRevision, baseText: "base")
        guard case .atRisk = await coordinator.save(documentID: "document") else {
            return XCTFail("A receipt scoped to a different author must not be saved")
        }
        let retained = try await coordinator.recover(documentID: "document")
        XCTAssertEqual(retained?.state, .unknown)
    }

    func testReconcileDoesNotSubmitFreshProtectedOperation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = JournalSaveFixture()
        let journal = try ProtectedDraftJournal(directory: root)
        let coordinator = try makeCoordinator(journal: journal, transport: fixture)
        var editor = EditorState(documentID: "document", text: "base")
        editor.edit("protected")
        _ = try await coordinator.protect(snapshot: editor.snapshot, baseRevisionID: baseRevision, baseText: "base")
        guard case .nothingToSave = await coordinator.reconcile(documentID: "document") else {
            return XCTFail("Only explicit save may submit a fresh operation")
        }
        let exchanges = await fixture.recordedExchanges()
        XCTAssertTrue(exchanges.isEmpty)
    }

    func testUTF16DiffPreservesAppendPrefixAndSeparatesDistantEdits() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = JournalSaveFixture()
        let journal = try ProtectedDraftJournal(directory: root)
        let coordinator = try makeCoordinator(journal: journal, transport: fixture)

        let base = "猫😀alpha 中間 beta"
        var appendEditor = EditorState(documentID: "append", text: base)
        appendEditor.edit(base + "追記")
        let append = try await coordinator.protect(snapshot: appendEditor.snapshot, baseRevisionID: baseRevision, baseText: base)
        XCTAssertEqual(append.saveRequest.changes.count, 1)
        XCTAssertEqual(append.saveRequest.changes[0].fromUtf16, Int32(base.utf16.count))
        XCTAssertEqual(append.saveRequest.changes[0].toUtf16, Int32(base.utf16.count))

        let distantBase = "猫😀alpha--middle--omega🐶"
        let distantText = "猫😀ALPHA--middle--OMEGA🐶"
        var distantEditor = EditorState(documentID: "distant", text: distantBase)
        distantEditor.edit(distantText)
        let distant = try await coordinator.protect(snapshot: distantEditor.snapshot, baseRevisionID: baseRevision, baseText: distantBase)
        XCTAssertEqual(distant.saveRequest.changes.count, 2)
        XCTAssertEqual(apply(distant.saveRequest.changes, to: distantBase), distantText)
    }
}

private func apply(_ changes: [Components.Schemas.DocumentChange], to source: String) -> String {
    let value = source as NSString
    var cursor = 0
    var result = ""
    for change in changes {
        let start = Int(change.fromUtf16)
        let end = Int(change.toUtf16)
        result += value.substring(with: NSRange(location: cursor, length: start - cursor))
        result += change.insert
        cursor = end
    }
    result += value.substring(from: cursor)
    return result
}
