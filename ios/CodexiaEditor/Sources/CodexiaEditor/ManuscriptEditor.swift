#if canImport(UIKit) && canImport(SwiftUI)
import SwiftUI
import UIKit

/// A single TextKit 2 editing surface. UIKit owns composition, selection and undo.
public struct ManuscriptEditor: UIViewRepresentable {
    @Binding private var state: EditorState

    public init(state: Binding<EditorState>) { self._state = state }

    public func makeCoordinator() -> Coordinator { Coordinator(state: $state) }

    public func makeUIView(context: Context) -> UITextView {
        let view = UITextView(usingTextLayoutManager: true)
        view.delegate = context.coordinator
        view.text = state.text
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
              view.text != state.text else { return }
        let selection = view.selectedRange
        let offset = view.contentOffset
        view.text = state.text
        let length = (state.text as NSString).length
        let location = min(selection.location, length)
        view.selectedRange = NSRange(location: location, length: min(selection.length, length - location))
        view.setContentOffset(offset, animated: false)
    }

    public final class Coordinator: NSObject, UITextViewDelegate {
        fileprivate var state: Binding<EditorState>
        fileprivate init(state: Binding<EditorState>) { self.state = state }
        public func textViewDidChange(_ textView: UITextView) {
            state.wrappedValue.edit(textView.text)
        }
    }
}
#endif
