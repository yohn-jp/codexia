#if canImport(UIKit) && canImport(SwiftUI)
import SwiftUI
import UIKit

/// A single TextKit 2 editing surface. UIKit owns composition, selection and undo.
public struct ManuscriptEditor: UIViewRepresentable {
    @Binding private var state: EditorState

    public init(state: Binding<EditorState>) { self._state = state }

    public func makeCoordinator() -> Coordinator { Coordinator(state: $state) }

    public func makeUIView(context: Context) -> UITextView {
        Self.makeTextView(text: state.text, coordinator: context.coordinator)
    }

    static func makeTextView(text: String, coordinator: Coordinator) -> UITextView {
        let view = UITextView(usingTextLayoutManager: true)
        view.delegate = coordinator
        view.text = text
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.accessibilityLabel = "原稿本文"
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        return view
    }

    public func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.state = $state
        // Never replace a live input session. The model rejects stale responses,
        // and the text view remains the owner of IME and selection while focused.
        guard view.markedTextRange == nil, !view.isFirstResponder,
              !view.text.utf8.elementsEqual(state.text.utf8) else { return }
        Self.applyText(state.text, to: view)
    }

    private static func applyText(_ text: String, to view: UITextView) {
        let selection = view.selectedRange
        let offset = view.contentOffset
        view.text = text
        let length = (text as NSString).length
        let location = min(selection.location, length)
        view.selectedRange = NSRange(location: location, length: min(selection.length, length - location))
        view.setContentOffset(offset, animated: false)
    }

    public final class Coordinator: NSObject, UITextViewDelegate {
        fileprivate var state: Binding<EditorState>
        init(state: Binding<EditorState>) { self.state = state }

        private func synchronize(_ textView: UITextView) {
            var current = state.wrappedValue
            if textView.markedTextRange != nil {
                current.setComposing(true)
            } else {
                current.edit(textView.text)
                current.setComposing(false)
            }
            state.wrappedValue = current
        }

        public func textViewDidChange(_ textView: UITextView) { synchronize(textView) }
        public func textViewDidChangeSelection(_ textView: UITextView) {
            if textView.markedTextRange != nil || state.wrappedValue.isComposing {
                synchronize(textView)
            }
        }
        public func textViewDidBeginEditing(_ textView: UITextView) {
            var current = state.wrappedValue
            current.setFocused(true)
            state.wrappedValue = current
        }
        public func textViewDidEndEditing(_ textView: UITextView) {
            synchronize(textView)
            var current = state.wrappedValue
            current.setFocused(false)
            // Install a deferred response before focus can return to this view.
            if textView.markedTextRange == nil, !textView.text.utf8.elementsEqual(current.text.utf8) {
                ManuscriptEditor.applyText(current.text, to: textView)
            }
            state.wrappedValue = current
        }
    }
}
#endif
