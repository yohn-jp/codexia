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

    func testMarkedTextReplacementAndConversionBoundariesKeepModelCommittedOnly() {
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
        defer {
            view.resignFirstResponder()
            window.isHidden = true
        }

        view.selectedRange = NSRange(location: 2, length: 0)
        view.setMarkedText("かな", selectedRange: NSRange(location: 2, length: 2))
        coordinator.textViewDidChange(view)
        view.setMarkedText("仮名", selectedRange: NSRange(location: 2, length: 2))
        coordinator.textViewDidChange(view)

        XCTAssertNotNil(view.markedTextRange)
        XCTAssertEqual(box.state.text, "原稿")
        XCTAssertFalse(box.state.canLeave)

        view.unmarkText()
        coordinator.textViewDidChange(view)

        XCTAssertNil(view.markedTextRange)
        XCTAssertEqual(box.state.text, "原稿仮名")
        XCTAssertFalse(box.state.canLeave)
    }

    func testRemoteResponseCannotReplaceTextCommittedFromComposition() {
        let box = Box()
        let request = box.state.beginRemoteRequest()
        let binding = Binding(get: { box.state }, set: { box.state = $0 })
        let coordinator = ManuscriptEditor.Coordinator(state: binding)
        let view = ManuscriptEditor.makeTextView(text: box.state.text, coordinator: coordinator)
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        XCTAssertTrue(view.becomeFirstResponder())
        defer {
            view.resignFirstResponder()
            window.isHidden = true
        }
        coordinator.textViewDidBeginEditing(view)
        XCTAssertTrue(box.state.applyRemote("遅れて届いた本文", for: request))

        view.selectedRange = NSRange(location: 2, length: 0)
        view.setMarkedText("かな", selectedRange: NSRange(location: 2, length: 2))
        coordinator.textViewDidChange(view)
        view.unmarkText()
        coordinator.textViewDidChange(view)
        coordinator.textViewDidEndEditing(view)

        XCTAssertEqual(box.state.text, "原稿かな")
        XCTAssertFalse(box.state.canLeave)
        XCTAssertEqual(view.text, "原稿かな")
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
            let sortedInput = inputSamples.sorted()
            let sortedScroll = scrollSamples.sorted()
            let inputMedian = sortedInput[sortedInput.count / 2]
            let scrollMedian = sortedScroll[sortedScroll.count / 2]
            let inputP95 = sortedInput[Int(ceil(Double(sortedInput.count - 1) * 0.95))]
            let scrollP95 = sortedScroll[Int(ceil(Double(sortedScroll.count - 1) * 0.95))]
            print("FIXTURE_METRIC chars=\(count) samples=5 input_layout_ms[min/median/p95/max]=\(sortedInput[0])/\(inputMedian)/\(inputP95)/\(sortedInput[sortedInput.count - 1]) input_samples_ms=\(inputSamples) scroll_roundtrip_layout_ms[min/median/p95/max]=\(sortedScroll[0])/\(scrollMedian)/\(scrollP95)/\(sortedScroll[sortedScroll.count - 1]) scroll_samples_ms=\(scrollSamples) process_peak_rss_bytes_cumulative=\(memoryStatus == 0 ? usage.ru_maxrss : -1)")
            XCTAssertTrue(view.text.hasSuffix("あああああ"))
            view.resignFirstResponder()
            view.removeFromSuperview()
        }
        window.isHidden = true
    }

    func testInsertionOverSelectionAndUndoRedoKeepsModelInSync() {
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
        defer {
            view.resignFirstResponder()
            window.isHidden = true
        }
        view.selectedRange = NSRange(location: 1, length: 1)
        view.insertText("日本語😀")
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

    func testDocumentReplacementWaitsForEditingToEndWithoutCrossingBindings() {
        let oldBox = Box()
        let newBox = Box()
        newBox.state = EditorState(documentID: "b", text: "別の原稿")
        let oldBinding = Binding(get: { oldBox.state }, set: { oldBox.state = $0 })
        let newBinding = Binding(get: { newBox.state }, set: { newBox.state = $0 })
        let coordinator = ManuscriptEditor.Coordinator(state: oldBinding)
        let view = ManuscriptEditor.makeTextView(text: oldBox.state.text, coordinator: coordinator)
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        XCTAssertTrue(view.becomeFirstResponder())
        defer { window.isHidden = true }

        XCTAssertFalse(coordinator.prepareForUpdate(with: newBinding, in: view))
        view.insertText("入力中")
        coordinator.textViewDidChange(view)

        XCTAssertEqual(oldBox.state.text, "原稿入力中")
        XCTAssertEqual(newBox.state.text, "別の原稿")
        XCTAssertEqual(coordinator.documentID, "a")

        view.resignFirstResponder()

        XCTAssertEqual(coordinator.documentID, "b")
        XCTAssertEqual(view.text, "別の原稿")
        XCTAssertEqual(newBox.state.text, "別の原稿")
    }

    func testReopenedSameDocumentWaitsForEditingToEnd() {
        let oldBox = Box()
        let newBox = Box()
        newBox.state = EditorState(documentID: "a", text: "再読込した原稿")
        let oldBinding = Binding(get: { oldBox.state }, set: { oldBox.state = $0 })
        let newBinding = Binding(get: { newBox.state }, set: { newBox.state = $0 })
        let coordinator = ManuscriptEditor.Coordinator(state: oldBinding)
        let view = ManuscriptEditor.makeTextView(text: oldBox.state.text, coordinator: coordinator)
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(view)
        window.makeKeyAndVisible()
        XCTAssertTrue(view.becomeFirstResponder())
        defer { window.isHidden = true }

        XCTAssertFalse(coordinator.prepareForUpdate(with: newBinding, in: view))
        view.insertText("旧セッションの入力")
        coordinator.textViewDidChange(view)

        XCTAssertEqual(oldBox.state.text, "原稿旧セッションの入力")
        XCTAssertEqual(newBox.state.text, "再読込した原稿")
        XCTAssertNotEqual(coordinator.sessionID, newBox.state.sessionID)

        view.resignFirstResponder()

        XCTAssertEqual(coordinator.sessionID, newBox.state.sessionID)
        XCTAssertEqual(view.text, "再読込した原稿")
        XCTAssertEqual(newBox.state.text, "再読込した原稿")
    }

    func testReusedBindingCannotWriteOldTextIntoReplacementSession() {
        for replacementDocumentID in ["b", "a"] {
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

            let replacement = EditorState(documentID: replacementDocumentID, text: "新しいセッション")
            box.state = replacement
            XCTAssertFalse(coordinator.prepareForUpdate(with: binding, in: view))

            view.insertText("古い入力")
            coordinator.textViewDidChange(view)
            XCTAssertEqual(box.state.text, "新しいセッション")
            XCTAssertEqual(box.state.sessionID, replacement.sessionID)

            view.resignFirstResponder()

            XCTAssertEqual(coordinator.documentID, replacementDocumentID)
            XCTAssertEqual(coordinator.sessionID, replacement.sessionID)
            XCTAssertEqual(view.text, "新しいセッション")
            XCTAssertEqual(box.state.text, "新しいセッション")
            window.isHidden = true
        }
    }
}
#endif
