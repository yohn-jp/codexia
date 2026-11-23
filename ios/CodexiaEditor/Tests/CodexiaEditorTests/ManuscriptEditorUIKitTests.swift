#if canImport(UIKit) && canImport(SwiftUI)
import XCTest
import SwiftUI
import UIKit
@testable import CodexiaEditor

@MainActor
final class ManuscriptEditorUIKitTests: XCTestCase {
    private final class Box {
        var state = EditorState(documentID: "a", text: "原稿")
    }

    func testMarkedTextDoesNotReplaceCommittedTextAndBlocksLeaving() {
        let box = Box()
        let binding = Binding(get: { box.state }, set: { box.state = $0 })
        let coordinator = ManuscriptEditor.Coordinator(state: binding)
        let view = ManuscriptEditor.makeTextView(text: box.state.text, coordinator: coordinator)
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        XCTAssertTrue(view.becomeFirstResponder())
        view.selectedRange = NSRange(location: 2, length: 0)
        view.setMarkedText("かな", selectedRange: NSRange(location: 2, length: 0))
        coordinator.textViewDidChange(view)
        XCTAssertNotNil(view.markedTextRange)
        XCTAssertEqual(box.state.text, "原稿")
        XCTAssertFalse(box.state.canLeave)
        view.unmarkText()
        coordinator.textViewDidChange(view)
        XCTAssertNil(view.markedTextRange)
        XCTAssertEqual(box.state.text, "原稿かな")
        XCTAssertFalse(box.state.canLeave)
        XCTAssertEqual(view.selectedRange.location, 4)
        view.resignFirstResponder()
        window.isHidden = true
    }

    func testCancelMarkedTextKeepsCommittedText() {
        let box = Box()
        let binding = Binding(get: { box.state }, set: { box.state = $0 })
        let coordinator = ManuscriptEditor.Coordinator(state: binding)
        let view = ManuscriptEditor.makeTextView(text: box.state.text, coordinator: coordinator)
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        XCTAssertTrue(view.becomeFirstResponder())
        view.selectedRange = NSRange(location: 2, length: 0)
        view.setMarkedText("かな", selectedRange: NSRange(location: 2, length: 0))
        coordinator.textViewDidChange(view)
        view.setMarkedText("", selectedRange: NSRange(location: 0, length: 0))
        view.unmarkText()
        coordinator.textViewDidChange(view)
        XCTAssertEqual(box.state.text, "原稿")
        XCTAssertTrue(box.state.canLeave)
        view.resignFirstResponder()
        window.isHidden = true
    }

    func testFocusDefersRemoteUntilEditingEnds() {
        let box = Box()
        let request = box.state.beginRemoteRequest()
        let binding = Binding(get: { box.state }, set: { box.state = $0 })
        let coordinator = ManuscriptEditor.Coordinator(state: binding)
        let view = ManuscriptEditor.makeTextView(text: box.state.text, coordinator: coordinator)
        coordinator.textViewDidBeginEditing(view)
        XCTAssertTrue(box.state.applyRemote("新しい原稿", for: request))
        XCTAssertEqual(box.state.text, "原稿")
        coordinator.textViewDidEndEditing(view)
        XCTAssertEqual(box.state.text, "新しい原稿")
    }
}
#endif
