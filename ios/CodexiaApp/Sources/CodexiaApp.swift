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
        .navigationTitle("サンプル作品")
    }
}

private struct FixtureListView: View {
    @State private var editor: EditorState?

    var body: some View {
        List {
            ForEach([10_000, 100_000, 500_000], id: \.self) { count in
                Button("\(count.formatted()) 文字のサンプル") {
                    editor = EditorState(documentID: "fixture-\(count)", text: manuscriptFixture(characterCount: count))
                }
            }
        }
        .navigationTitle("構成と原稿")
        .navigationDestination(isPresented: Binding(
            get: { editor != nil },
            set: { if !$0, editor?.canLeave == true { editor = nil } }
        )) {
            if editor != nil {
                AuthoringView(state: Binding(
                    get: { editor! },
                    set: { editor = $0 }
                ), onLeave: { editor = nil })
            }
        }
    }

}
