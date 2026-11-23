#if canImport(UIKit) && canImport(SwiftUI)
import XCTest
import SwiftUI
import UIKit
import QuartzCore
import Darwin
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

    func testFixtureInputLayoutScrollAndMemoryObservation() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        for count in [10_000, 100_000, 500_000] {
            let box = Box()
            box.state = EditorState(documentID: "fixture-\(count)", text: manuscriptFixture(characterCount: count))
            let binding = Binding(get: { box.state }, set: { box.state = $0 })
            let coordinator = ManuscriptEditor.Coordinator(state: binding)
            let view = ManuscriptEditor.makeTextView(text: box.state.text, coordinator: coordinator)
            view.frame = controller.view.bounds
            controller.view.addSubview(view)
            XCTAssertTrue(view.becomeFirstResponder())
            view.selectedRange = NSRange(location: (view.text as NSString).length, length: 0)
            var inputSamples: [Double] = []
            var scrollSamples: [Double] = []
            for _ in 0..<5 {
                let start = CACurrentMediaTime()
                view.insertText("あ")
                view.setNeedsLayout()
                view.layoutIfNeeded()
                inputSamples.append((CACurrentMediaTime() - start) * 1000)
                let scrollStart = CACurrentMediaTime()
                view.setContentOffset(.zero, animated: false)
                view.layoutIfNeeded()
                view.setContentOffset(CGPoint(x: 0, y: max(0, view.contentSize.height - view.bounds.height)), animated: false)
                view.layoutIfNeeded()
                scrollSamples.append((CACurrentMediaTime() - scrollStart) * 1000)
            }
            var usage = rusage()
            let memoryStatus = getrusage(RUSAGE_SELF, &usage)
            print("FIXTURE_METRIC chars=\(count) samples=5 input_layout_ms=\(inputSamples) scroll_roundtrip_layout_ms=\(scrollSamples) process_peak_rss_bytes=\(memoryStatus == 0 ? usage.ru_maxrss : -1)")
            XCTAssertTrue(view.text.hasSuffix("あああああ"))
            view.resignFirstResponder()
            view.removeFromSuperview()
        }
        window.isHidden = true
    }

    func testPasteOverSelectionAndUndoRedoKeepsModelInSync() {
        let box = Box()
        let binding = Binding(get: { box.state }, set: { box.state = $0 })
        let coordinator = ManuscriptEditor.Coordinator(state: binding)
        let view = ManuscriptEditor.makeTextView(text: box.state.text, coordinator: coordinator)
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        window.rootViewController = controller
        view.frame = controller.view.bounds
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        XCTAssertTrue(view.becomeFirstResponder())
        let pasteboard = UIPasteboard.general
        let previousItems = pasteboard.items
        defer {
            pasteboard.items = previousItems
            view.resignFirstResponder()
            window.isHidden = true
        }
        view.selectedRange = NSRange(location: 1, length: 1)
        pasteboard.string = "日本語😀"
        view.paste(nil)
        XCTAssertEqual(view.text, "原日本語😀")
        XCTAssertEqual(box.state.text, "原日本語😀")
        XCTAssertFalse(box.state.canLeave)
        guard let undo = view.undoManager else { return XCTFail("Undo manager unavailable") }
        XCTAssertTrue(undo.canUndo)
        undo.undo()
        XCTAssertEqual(view.text, "原稿")
        XCTAssertEqual(box.state.text, "原稿")
        XCTAssertTrue(undo.canRedo)
        undo.redo()
        XCTAssertEqual(view.text, "原日本語😀")
        XCTAssertEqual(box.state.text, "原日本語😀")
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
        XCTAssertEqual(view.text, "新しい原稿")
    }
}
#endif
