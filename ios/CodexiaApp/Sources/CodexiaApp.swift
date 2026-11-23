import Combine
import SwiftUI

@main
struct CodexiaApp: App {
    var body: some Scene {
        WindowGroup { LibraryView() }
    }
}

private struct LibraryView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("原稿エディターの検証") {
                    NavigationLink("サンプル作品") { FixtureProjectView() }
                }
                Section {
                    Text("作品の読み込みと保存はまだ利用できません。サンプルの編集内容は終了時に失われます。")
                }
            }
            .accessibilityIdentifier("screen.library")
            .navigationTitle("ライブラリ")
        }
    }
}

private struct FixtureProjectView: View {
    var body: some View {
        List {
            Section("執筆") {
                NavigationLink("構成と原稿") { FixtureListView() }
            }
            Section("未接続") {
                Text("履歴、レビュー、知識と設定はまだ利用できません。")
            }
        }
        .accessibilityIdentifier("screen.project")
        .navigationTitle("サンプル作品")
    }
}

private struct FixtureListView: View {
    @State private var editor: FixtureEditingSession?

    var body: some View {
        List {
            ForEach([10_000, 100_000, 500_000], id: \.self) { count in
                Button("\(count.formatted()) 文字のサンプル") {
                    editor = FixtureEditingSession(characterCount: count)
                }
                .accessibilityIdentifier("fixture.\(count)")
            }
        }
        .accessibilityIdentifier("screen.outline")
        .navigationTitle("構成と原稿")
        .navigationDestination(isPresented: Binding(
            get: { editor != nil },
            set: { if !$0, editor?.state.canLeave == true { editor = nil } }
        )) {
            if let session = editor {
                FixtureEditorDestination(session: session) {
                    if editor === session { editor = nil }
                }
            }
        }
    }
}

private final class FixtureEditingSession: ObservableObject {
    @Published var state: EditorState

    init(characterCount: Int) {
        state = EditorState(
            documentID: "fixture-\(characterCount)",
            text: manuscriptFixture(characterCount: characterCount)
        )
    }
}

private struct FixtureEditorDestination: View {
    @ObservedObject var session: FixtureEditingSession
    let onLeave: () -> Void

    var body: some View {
        AuthoringView(state: $session.state, onLeave: onLeave)
    }
}
