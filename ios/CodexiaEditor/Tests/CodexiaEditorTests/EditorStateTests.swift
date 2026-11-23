import XCTest
@testable import CodexiaEditor

final class EditorStateTests: XCTestCase {
    func testResponseCannotOverwriteNewerInput() {
        var state = EditorState(documentID: "a", text: "initial")
        let request = state.snapshot
        state.edit("new input")
        XCTAssertFalse(state.applyRemote("old response", for: request))
        XCTAssertEqual(state.text, "new input")
        XCTAssertFalse(state.canLeave)
    }

    func testOlderResponseCannotOverwriteNewerResponse() {
        var state = EditorState(documentID: "a", text: "initial")
        let first = state.snapshot
        let second = state.snapshot
        XCTAssertTrue(state.applyRemote("newer response", for: second))
        XCTAssertFalse(state.applyRemote("older response", for: first))
        XCTAssertEqual(state.text, "newer response")
    }

    func testResponseCannotOverwriteAnotherDocument() {
        var state = EditorState(documentID: "a", text: "first")
        let request = state.snapshot
        state = EditorState(documentID: "b", text: "second")
        XCTAssertFalse(state.applyRemote("old response", for: request))
        XCTAssertEqual(state.text, "second")
    }

    func testProtectedVersionDoesNotProtectLaterEdits() {
        var state = EditorState(documentID: "a", text: "initial")
        state.edit("first")
        let protected = state.snapshot
        state.edit("second")
        state.markProtected(protected)
        XCTAssertFalse(state.canLeave)
        state.markProtected(state.snapshot)
        XCTAssertTrue(state.canLeave)
    }
}
