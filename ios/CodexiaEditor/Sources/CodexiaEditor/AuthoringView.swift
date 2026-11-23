#if canImport(UIKit) && canImport(SwiftUI)
import SwiftUI

/// An in-memory editor surface; a host must supply durable protection before leaving.
public struct AuthoringView: View {
    @Binding private var state: EditorState
    private let onLeave: () -> Void
    @State private var showingProtectionNotice = false

    public init(state: Binding<EditorState>, onLeave: @escaping () -> Void) {
        self._state = state
        self.onLeave = onLeave
    }

    public var body: some View {
        VStack(spacing: 0) {
            Text(state.canLeave ? "未編集" : "未保護 — この端末にも保存されていません")
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
            ManuscriptEditor(state: $state)
        }
        .navigationTitle("原稿")
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button("戻る") {
                    if state.canLeave { onLeave() } else { showingProtectionNotice = true }
                }
            }
        }
        .alert("原稿はまだ保護されていません", isPresented: $showingProtectionNotice) {
            Button("編集を続ける", role: .cancel) { }
        } message: {
            Text("保存機能はまだ利用できません。この画面を離れると入力内容が失われる可能性があります。")
        }
    }
}
#endif
