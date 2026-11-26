#if canImport(UIKit) && canImport(SwiftUI)
import SwiftUI

public typealias EditorProtectionHandler = @Sendable (EditorState.Snapshot) async throws -> Void

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
    var uxControlID: String? {
        switch self {
        case .reading: return "CTRL-WRT-01.B"
        case .history, .review, .knowledge, .settings: return nil
        }
    }
}

/// An editor surface that delegates durable protection to its host before leaving.
public struct AuthoringView: View {
    @Binding private var state: EditorState
    private let onLeave: () -> Void
    private let onProtect: EditorProtectionHandler?
    @State private var showingProtectionNotice = false
    @State private var reference: ReferenceScreen?
    @State private var isProtecting = false
    @State private var protectionAlertTitle = "原稿はまだ保護されていません"
    @State private var protectionAlertMessage = "保存機能はまだ利用できません。この画面を離れると入力内容が失われる可能性があります。"

    public init(
        state: Binding<EditorState>,
        onLeave: @escaping () -> Void,
        onProtect: EditorProtectionHandler? = nil
    ) {
        self._state = state
        self.onLeave = onLeave
        self.onProtect = onProtect
    }

    public var body: some View {
        VStack(spacing: 0) {
            Text(protectionStatus)
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .accessibilityIdentifier("editor.protection-status")
            if let recovered = state.recoveredComposition {
                VStack(spacing: 8) {
                    ScrollView {
                        Text(recovered).frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    Button("復元した入力を確定") { state.resolveRecoveredComposition(keepingText: true) }
                    if state.canDiscardRecoveredComposition {
                        Button("復元した変換を取り消す", role: .destructive) {
                            state.resolveRecoveredComposition(keepingText: false)
                        }
                    }
                }
                .padding()
            } else {
                ManuscriptEditor(state: $state)
            }
        }
        .navigationTitle("原稿")
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu("参照") {
                    ForEach(ReferenceScreen.allCases) { screen in
                        Button(screen.title) { reference = screen }
                            .accessibilityIdentifier(screen.uxControlID ?? "reference.\(screen.rawValue)")
                    }
                }
                .disabled(state.isComposing)
            }
            ToolbarItem(placement: .navigationBarLeading) {
                Button("戻る") {
                    leaveOrProtect()
                }
                .disabled(isProtecting)
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                if onProtect != nil {
                    Button("保護") { protectCurrentSnapshot(thenLeave: false) }
                        .disabled(state.isCurrentVersionProtected || isProtecting)
                        .accessibilityIdentifier("editor.protect")
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
        .alert(protectionAlertTitle, isPresented: $showingProtectionNotice) {
            Button("編集を続ける", role: .cancel) { }
        } message: {
            Text(protectionAlertMessage)
        }
    }

    private func leaveOrProtect() {
        if state.canLeave {
            onLeave()
        } else if state.isComposing {
            showProtectionNotice(
                title: "日本語入力が確定していません",
                message: "変換中の文字を確定または取り消してから、原稿を保護してください。"
            )
        } else if onProtect != nil {
            protectCurrentSnapshot(thenLeave: true)
        } else {
            showProtectionNotice(
                title: "原稿はまだ保護されていません",
                message: "保存機能はまだ利用できません。この画面を離れると入力内容が失われる可能性があります。"
            )
        }
    }

    private var protectionStatus: String {
        if isProtecting { return "端末に保護中…" }
        if state.isComposing {
            return state.isCurrentVersionProtected
                ? "変換中の原稿を端末に保護済み — サーバー保存は入力確定後に行います"
                : "日本語入力中 — この端末には未保護です"
        }
        if state.hasLocalEdits {
            return state.canLeave
                ? "端末に保護済み — サーバー未確定"
                : "未保護 — この端末にも保存されていません"
        }
        return onProtect == nil ? "未編集" : "保存済み"
    }

    private func protectCurrentSnapshot(thenLeave: Bool) {
        guard let onProtect else { return }
        let snapshot = state.snapshot
        isProtecting = true
        Task { @MainActor in
            defer { isProtecting = false }
            do {
                try await onProtect(snapshot)
                guard state.isCurrent(snapshot) else {
                    showProtectionNotice(
                        title: "別の原稿が開かれています",
                        message: "保護処理が完了しましたが、現在の原稿は変わっています。現在の原稿を確認してください。"
                    )
                    return
                }
                var current = state
                current.markProtected(snapshot)
                state = current
                if thenLeave {
                    if current.canLeave {
                        onLeave()
                    } else {
                        showProtectionNotice(
                            title: "追加の入力があります",
                            message: "保護処理中に追加された入力が残っています。もう一度保護してから移動してください。"
                        )
                    }
                }
            } catch {
                showProtectionNotice(
                    title: "原稿を保護できませんでした",
                    message: error.localizedDescription
                )
            }
        }
    }

    private func showProtectionNotice(title: String, message: String) {
        protectionAlertTitle = title
        protectionAlertMessage = message
        showingProtectionNotice = true
    }
}
#endif
