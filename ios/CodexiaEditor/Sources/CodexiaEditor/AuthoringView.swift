#if canImport(UIKit) && canImport(SwiftUI)
import SwiftUI

private enum ReferenceScreen: String, CaseIterable, Identifiable {
    case reading, history, review, knowledge, settings
    var id: String { rawValue }
    var title: String {
        switch self {
        case .reading: return "読む"
        case .history: return "履歴"
        case .review: return "レビュー"
        case .knowledge: return "知識"
        case .settings: return "設定"
        }
    }
}

/// An in-memory editor surface; a host must supply durable protection before leaving.
public struct AuthoringView: View {
    @Binding private var state: EditorState
    private let onLeave: () -> Void
    @State private var showingProtectionNotice = false
    @State private var reference: ReferenceScreen?

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
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu("参照") {
                    ForEach(ReferenceScreen.allCases) { screen in
                        Button(screen.title) { reference = screen }
                    }
                }
                .disabled(state.isComposing)
            }
            ToolbarItem(placement: .navigationBarLeading) {
                Button("戻る") {
                    if state.canLeave { onLeave() } else { showingProtectionNotice = true }
                }
            }
        }
        .accessibilityIdentifier("screen.writing")
        .sheet(item: $reference) { screen in
            NavigationStack {
                ScrollView {
                    if screen == .reading {
                        Text(state.text).frame(maxWidth: .infinity, alignment: .leading).padding()
                    } else {
                        Text("この画面はまだ接続されていません。原稿には変更を加えません。")
                            .frame(maxWidth: .infinity, alignment: .leading).padding()
                    }
                }
                .accessibilityIdentifier("screen.\(screen.rawValue)")
                .navigationTitle(screen.title)
                .toolbar { Button("閉じる") { reference = nil } }
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
