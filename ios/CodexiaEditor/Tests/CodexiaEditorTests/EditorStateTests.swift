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
        state.setComposing(true)
        XCTAssertFalse(state.canLeave)
        XCTAssertEqual(state.text, "original")
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
}
