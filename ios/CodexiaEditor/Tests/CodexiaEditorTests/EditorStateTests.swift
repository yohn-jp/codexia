import XCTest
@testable import CodexiaEditor

final class EditorStateTests: XCTestCase {
    func testCanonicallyEquivalentEditPreservesRawSourceAndIsDirty() {
        var state = EditorState(documentID: "a", text: "が")
        state.edit("か\u{3099}")
        XCTAssertEqual(Array(state.text.utf8), Array("か\u{3099}".utf8))
        XCTAssertFalse(state.canLeave)
    }

    func testResponseCannotOverwriteNewerInput() {
        var state = EditorState(documentID: "a", text: "initial")
        let request = state.beginRemoteRequest()
        state.edit("new input")
        XCTAssertFalse(state.applyRemote("old response", for: request))
        XCTAssertEqual(state.text, "new input")
        XCTAssertFalse(state.canLeave)
    }

    func testOlderResponseCannotOverwriteNewerResponse() {
        var state = EditorState(documentID: "a", text: "initial")
        let first = state.beginRemoteRequest()
        let second = state.beginRemoteRequest()
        XCTAssertFalse(state.applyRemote("older response", for: first))
        XCTAssertTrue(state.applyRemote("newer response", for: second))
        XCTAssertFalse(state.applyRemote("older response", for: first))
        XCTAssertEqual(state.text, "newer response")
    }

    func testResponseCannotOverwriteAnotherDocument() {
        var state = EditorState(documentID: "a", text: "first")
        let request = state.beginRemoteRequest()
        state = EditorState(documentID: "b", text: "second")
        XCTAssertFalse(state.applyRemote("old response", for: request))
        XCTAssertEqual(state.text, "second")
    }

    func testResponseCannotOverwriteReopenedSessionForSameDocument() {
        var state = EditorState(documentID: "a", text: "first session")
        let request = state.beginRemoteRequest()
        state = EditorState(documentID: "a", text: "reopened session")

        XCTAssertFalse(state.applyRemote("late first-session response", for: request))
        XCTAssertEqual(state.text, "reopened session")
    }

    func testCompositionBlocksLeavingWithoutChangingCommittedText() {
        var state = EditorState(documentID: "a", text: "original")
        state.updateComposition("originalかな")
        XCTAssertFalse(state.canLeave)
        XCTAssertEqual(state.text, "original")
        XCTAssertEqual(state.snapshot.text, "originalかな")
        let protectedComposition = state.snapshot
        state.markProtected(protectedComposition)
        XCTAssertTrue(state.isCurrentVersionProtected)
        state.updateComposition("originalかも")
        XCTAssertFalse(state.isCurrentVersionProtected)
        state.setComposing(false)
        XCTAssertTrue(state.canLeave)
    }

    func testFocusedRemoteIsDeferredAndCannotOverwriteTyping() {
        var state = EditorState(documentID: "a", text: "original")
        let request = state.beginRemoteRequest()
        state.setFocused(true)
        XCTAssertTrue(state.applyRemote("remote", for: request))
        XCTAssertEqual(state.text, "original")
        state.edit("typed")
        state.setFocused(false)
        XCTAssertEqual(state.text, "typed")
    }

    func testFocusedRemoteAppliesAfterFocusEndsWhenNoTypingOccurs() {
        var state = EditorState(documentID: "a", text: "original")
        let request = state.beginRemoteRequest()
        state.setFocused(true)
        XCTAssertTrue(state.applyRemote("remote", for: request))
        state.setFocused(false)
        XCTAssertEqual(state.text, "remote")
    }

    func testProtectedVersionDoesNotProtectLaterEdits() {
        var state = EditorState(documentID: "a", text: "initial")
        state.edit("first")
        let protected = state.snapshot
        XCTAssertEqual(protected.text, "first")
        state.edit("second")
        XCTAssertEqual(protected.text, "first", "A protection write must retain the captured body while typing continues")
        state.markProtected(protected)
        XCTAssertFalse(state.canLeave)
        state.markProtected(state.snapshot)
        XCTAssertTrue(state.canLeave)
    }

    func testSnapshotCapturesInitialTextAndVersion() {
        var state = EditorState(documentID: "a", text: "draft")
        let snapshot = state.snapshot

        state.edit("draft plus input")

        XCTAssertEqual(snapshot.documentID, "a")
        XCTAssertEqual(snapshot.version, 0)
        XCTAssertEqual(snapshot.text, "draft")
        XCTAssertEqual(state.snapshot.text, "draft plus input")
    }

    func testSnapshotSessionCanBeValidatedAfterAsyncProtection() {
        var state = EditorState(documentID: "a", text: "draft")
        let snapshot = state.snapshot
        XCTAssertEqual(snapshot.sessionID, state.sessionID)
        XCTAssertTrue(state.isCurrent(snapshot))

        state.edit("draft plus input")
        XCTAssertTrue(state.isCurrent(snapshot), "Later typing remains in the same document session")

        let reopened = EditorState(documentID: "a", text: "new session")
        XCTAssertFalse(reopened.isCurrent(snapshot))
    }

    func testProtectedDraftDoesNotAppearCommittedAndRejectsRemoteReplacement() {
        var state = EditorState(documentID: "a", text: "server text")
        state.edit("local draft")
        let draft = state.snapshot
        state.markProtected(draft)

        XCTAssertTrue(state.canLeave)
        XCTAssertTrue(state.hasLocalEdits)

        let request = state.beginRemoteRequest()
        XCTAssertFalse(state.applyRemote("stale remote text", for: request))
        XCTAssertEqual(state.text, "local draft")
        XCTAssertTrue(state.hasLocalEdits)

        state.markCommitted(draft)
        XCTAssertFalse(state.hasLocalEdits)
    }

    func testCommitReceiptOnlyCommitsItsVersion() {
        var state = EditorState(documentID: "a", text: "server text")
        state.edit("first local edit")
        let first = state.snapshot
        state.markProtected(first)
        state.edit("later local edit")

        state.markCommitted(first)

        XCTAssertEqual(state.text, "later local edit")
        XCTAssertTrue(state.hasLocalEdits)
        XCTAssertFalse(state.canLeave)
    }

    func testRecoveredDraftIsProtectedButStillPendingUntilReceipt() {
        let sessionID = UUID()
        var state = EditorState(
            recoveringDocumentID: "a",
            text: "recovered pending draft",
            version: 0,
            sessionID: sessionID
        )
        let snapshot = state.snapshot

        XCTAssertEqual(snapshot.sessionID, sessionID)
        XCTAssertTrue(state.canLeave)
        XCTAssertTrue(state.hasLocalEdits)
        let request = state.beginRemoteRequest()
        XCTAssertFalse(state.applyRemote("stale remote", for: request))
        XCTAssertEqual(state.text, "recovered pending draft")

        state.markCommitted(snapshot)
        XCTAssertFalse(state.hasLocalEdits)
    }
}
