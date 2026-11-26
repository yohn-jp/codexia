import AuthenticationServices
import CodexiaAPI
import CodexiaTransport
import SwiftUI
import UIKit

@main
struct CodexiaApp: App {
    var body: some Scene {
        WindowGroup {
            LibraryView()
        }
    }
}

@MainActor
private final class AccountSession: ObservableObject {
    enum Status: Equatable {
        case checking
        case signedOut
        case signingIn
        case signedIn(subject: String)
        case reauthenticationRequired
        case unavailable(String)

        var isSignedIn: Bool {
            if case .signedIn = self { return true }
            return false
        }
    }

    @Published private(set) var status: Status = .checking
    @Published private(set) var projects: [Components.Schemas.Project] = []
    @Published private(set) var projectLoadMessage: String?
    @Published private(set) var accountNotice: String?
    @Published var pendingProjectID: String?

    private let config: OAuthConfiguration?
    private let session: NativeOAuthSession?
    private let journal: ProtectedDraftJournal?
    private var coordinators: [String: JournalSaveCoordinator] = [:]
    private var activeSessionOperations = 0
    private var closingSession = false
    private var pendingDeepLink: NativeDeepLink?
    private var authenticatedSubject: String?
    private var sessionGeneration: UInt64 = 0
    private var activeEditorGuard: (id: UUID, protect: @MainActor () async throws -> Void)?

    init() {
        let values = Bundle.main.infoDictionary ?? [:]
        if let originText = values["CodexiaAPIOrigin"] as? String,
           let origin = URL(string: originText),
           let clientID = values["CodexiaOAuthClientID"] as? String,
           let config = try? OAuthConfiguration(origin: origin, clientID: clientID) {
            self.config = config
            session = NativeOAuthSession(configuration: config)
            journal = try? ProtectedDraftJournal()
        } else {
            config = nil
            session = nil
            journal = nil
            status = .unavailable("このアプリには接続先が設定されていません。")
        }
    }

    func restoreSession() async {
        guard let session else { return }
        do {
            let subject = try await session.subject()
            authenticatedSubject = subject
            status = .signedIn(subject: subject)
            await loadProjects()
            await resolvePendingDeepLink()
        } catch OAuthError.signInRequired {
            status = .signedOut
        } catch {
            status = .reauthenticationRequired
        }
    }

    func signIn() async {
        guard activeSessionOperations == 0, !closingSession else {
            accountNotice = "処理中のAPI操作が完了してから再認証してください。"
            return
        }
        guard let session, let anchor = Self.presentationAnchor() else {
            status = .unavailable("システム認証画面を開けませんでした。")
            return
        }
        let requiresReauthentication: Bool
        if case .reauthenticationRequired = status { requiresReauthentication = true }
        else { requiresReauthentication = false }
        if requiresReauthentication {
            do { try await activeEditorGuard?.protect() }
            catch {
                accountNotice = "再認証前に、最新の入力を端末へ保護できませんでした。"
                return
            }
            guard activeSessionOperations == 0 else {
                accountNotice = "保護またはAPI操作が完了してから再認証してください。"
                return
            }
        }
        status = .signingIn
        projects = []
        projectLoadMessage = nil
        do {
            if requiresReauthentication {
                closingSession = true
                _ = try await session.signOut()
                coordinators.removeAll()
                authenticatedSubject = nil
                sessionGeneration &+= 1
                closingSession = false
            }
            let subject = try await session.signIn(presentation: OAuthPresentation(anchor: anchor))
            authenticatedSubject = subject
            status = .signedIn(subject: subject)
            await loadProjects()
            await resolvePendingDeepLink()
        } catch is CancellationError {
            closingSession = false
            status = .signedOut
        } catch OAuthError.authorizationDenied {
            closingSession = false
            status = .signedOut
        } catch {
            closingSession = false
            status = .unavailable("認証を完了できませんでした。接続を確認してもう一度お試しください。")
        }
    }

    /// Logout never deletes a local draft. A caller must run the authoring
    /// coordinator's draft-protection guard before reaching this method.
    func signOut() async {
        guard activeSessionOperations == 0, !closingSession else {
            accountNotice = "処理中の保護またはAPI操作が終わるまでサインアウトできません。"
            return
        }
        do { try await activeEditorGuard?.protect() }
        catch {
            accountNotice = "サインアウト前に、最新の入力を端末へ保護できませんでした。"
            return
        }
        guard activeSessionOperations == 0 else {
            accountNotice = "保護またはAPI操作が終わるまでサインアウトできません。"
            return
        }
        guard let session else { status = .signedOut; return }
        closingSession = true
        defer { closingSession = false }
        do {
            let revocation = try await session.signOut()
            projects = []
            projectLoadMessage = nil
            coordinators.removeAll()
            authenticatedSubject = nil
            sessionGeneration &+= 1
            status = .signedOut
            if case .unconfirmed = revocation {
                accountNotice = "サインアウトしました。サーバー側のtoken失効は確認できませんでした。"
            } else {
                accountNotice = nil
            }
        } catch {
            status = .reauthenticationRequired
            accountNotice = "セッションを安全に終了できませんでした。未送信の下書きは保持されています。"
        }
    }

    func loadProjects() async {
        do {
            let output = try await withTransport { transport in
                try await transport.client.projects_list_get(.init(query: .init(limit: 100)))
            }
            switch output {
            case .ok(let response):
                projects = try response.body.json.projects
                projectLoadMessage = projects.isEmpty ? "作品はまだありません。" : nil
            case .undocumented(statusCode: 401, _):
                projects = []
                projectLoadMessage = "セッションの再認証が必要です。"
                status = .reauthenticationRequired
            case .undocumented(statusCode: 403, _):
                projects = []
                projectLoadMessage = "このアカウントから作品を読み込めません。"
            default:
                projects = []
                projectLoadMessage = "作品を読み込めませんでした。時間をおいて再試行してください。"
            }
        } catch {
            projects = []
            projectLoadMessage = "APIに接続できません。接続を確認して再試行してください。"
        }
    }

    func loadProjectDocuments(projectID: String) async throws -> [Components.Schemas.PersistenceDocument] {
        let output = try await withTransport { transport in
            try await transport.client.persistence_documents_get(.init(
                path: .init(projectId: projectID), query: .init(limit: 1000)
            ))
        }
        switch output {
        case .ok(let response): return try response.body.json.documents
        case .undocumented(statusCode: 401, _):
            status = .reauthenticationRequired
            throw OAuthError.signInRequired
        default: throw ProductAPIError.unexpectedResponse
        }
    }

    func loadDocument(projectID: String, documentID: String) async throws -> LoadedSceneDocument {
        let output = try await withTransport { transport in
            try await transport.client.persistence_document_get(.init(
                path: .init(projectId: projectID, documentId: documentID)
            ))
        }
        switch output {
        case .ok(let response):
            let payload = try response.body.json
            let document = payload.document
            guard document.id == documentID, document.projectId == projectID,
                  document.kind == "scene", let revision = payload.revision,
                  document.headRevisionId == revision.id,
                  revision.projectId == projectID, revision.documentId == documentID,
                  !revision.id.isEmpty else { throw ProductAPIError.unexpectedResponse }
            return LoadedSceneDocument(id: document.id, title: document.title, text: revision.markdown, revisionID: revision.id)
        case .undocumented(statusCode: 401, _):
            status = .reauthenticationRequired
            throw OAuthError.signInRequired
        case .notFound: throw ProductAPIError.documentNotFound
        default: throw ProductAPIError.unexpectedResponse
        }
    }

    func prepareCoordinator(projectID: String) async throws -> PreparedProjectSession {
        try await withCoordinator(projectID: projectID) { coordinator in
            guard let authorID = authenticatedSubject, let config else { throw OAuthError.signInRequired }
            return PreparedProjectSession(
                projectID: projectID,
                authorID: authorID,
                apiOrigin: config.origin,
                generation: sessionGeneration,
                coordinator: coordinator
            )
        }
    }

    func protect(_ prepared: PreparedProjectSession, snapshot: EditorState.Snapshot, baseRevisionID: String, baseText: String) async throws -> DraftRecord {
        try await withPreparedCoordinator(prepared) { coordinator in
            try await coordinator.protect(snapshot: snapshot, baseRevisionID: baseRevisionID, baseText: baseText)
        }
    }

    func records(_ prepared: PreparedProjectSession, documentID: String, includeLocalBaseline: Bool = false) async throws -> [DraftRecord] {
        try await withPreparedCoordinator(prepared) { coordinator in
            try await coordinator.records(documentID: documentID, includeLocalBaseline: includeLocalBaseline)
        }
    }

    func save(_ prepared: PreparedProjectSession, documentID: String) async -> SaveDisposition {
        do {
            return try await withPreparedCoordinator(prepared) { coordinator in
                await coordinator.save(documentID: documentID)
            }
        } catch { return .atRisk }
    }

    func reconcile(_ prepared: PreparedProjectSession, documentID: String) async -> SaveDisposition {
        do {
            return try await withPreparedCoordinator(prepared) { coordinator in
                await coordinator.reconcile(documentID: documentID)
            }
        } catch { return .atRisk }
    }

    func conflictHead(_ prepared: PreparedProjectSession, documentID: String) async throws -> LoadedSceneDocument {
        try await withPreparedCoordinator(prepared) { _ in
            try await loadDocument(projectID: prepared.projectID, documentID: documentID)
        }
    }

    func resolveConflict(_ prepared: PreparedProjectSession, operationID: String, snapshot: EditorState.Snapshot,
                         head: LoadedSceneDocument) async throws {
        try await withPreparedCoordinator(prepared) { coordinator in
            _ = try await coordinator.resolveConflict(documentID: head.id, expectedOperationID: operationID,
                snapshot: snapshot, currentRevisionID: head.revisionID, currentText: head.text)
        }
    }

    private func withTransport<T>(_ operation: (APITransport) async throws -> T) async throws -> T {
        guard let session, let config, !closingSession else { throw OAuthError.sessionBusy }
        activeSessionOperations += 1
        defer { activeSessionOperations -= 1 }
        do {
            let subject = try await session.subject()
            authenticatedSubject = subject
            let transport = try session.makeTransport()
            guard transport.origin == config.origin else { throw APITransportError.invalidOrigin }
            return try await operation(transport)
        } catch OAuthError.signInRequired {
            status = .reauthenticationRequired
            throw OAuthError.signInRequired
        }
    }

    private func withCoordinator<T>(projectID: String, operation: (JournalSaveCoordinator) async throws -> T) async throws -> T {
        guard let session, let config, let journal, !closingSession else { throw OAuthError.sessionBusy }
        activeSessionOperations += 1
        defer { activeSessionOperations -= 1 }
        let subject: String
        do { subject = try await session.subject() }
        catch OAuthError.signInRequired {
            status = .reauthenticationRequired
            throw OAuthError.signInRequired
        }
        let transport = try session.makeTransport()
        guard transport.origin == config.origin else { throw APITransportError.invalidOrigin }
        let key = "\(subject)|\(transport.origin.absoluteString)|\(projectID)"
        let coordinator: JournalSaveCoordinator
        if let existing = coordinators[key] {
            coordinator = existing
        } else {
            coordinator = try JournalSaveCoordinator(
                authorID: subject,
                apiOrigin: transport.origin,
                projectID: projectID,
                clientID: config.clientID,
                journal: journal,
                api: transport.client
            )
            coordinators[key] = coordinator
        }
        return try await operation(coordinator)
    }

    private func withPreparedCoordinator<T>(_ prepared: PreparedProjectSession, operation: (JournalSaveCoordinator) async throws -> T) async throws -> T {
        guard !closingSession, let config,
              prepared.generation == sessionGeneration,
              prepared.authorID == authenticatedSubject,
              prepared.apiOrigin == config.origin else {
            throw OAuthError.signInRequired
        }
        activeSessionOperations += 1
        defer { activeSessionOperations -= 1 }
        return try await operation(prepared.coordinator)
    }

    func receive(_ url: URL) {
        // OAuth callback handling belongs exclusively to ASWebAuthenticationSession.
        // App links are accepted only for a project UUID and never carry identity.
        guard let link = NativeDeepLink(url: url) else { return }
        pendingDeepLink = link
        guard status.isSignedIn else { return }
        Task { await resolvePendingDeepLink() }
    }

    func resolvePendingDeepLink() async {
        guard status.isSignedIn, let link = pendingDeepLink else { return }
        do { try await activeEditorGuard?.protect() }
        catch {
            accountNotice = "画面を切り替える前に、最新の入力を端末へ保護できませんでした。"
            return
        }
        guard activeSessionOperations == 0 else {
            accountNotice = "保護または保存の処理が終わるまで作品を切り替えられません。"
            return
        }
        pendingDeepLink = nil
        pendingProjectID = link.projectID
    }

    func registerActiveEditorGuard(_ protect: @escaping @MainActor () async throws -> Void) -> UUID {
        let id = UUID()
        activeEditorGuard = (id, protect)
        return id
    }

    func unregisterActiveEditorGuard(_ id: UUID) {
        guard activeEditorGuard?.id == id else { return }
        activeEditorGuard = nil
    }

    func requireReauthentication() { status = .reauthenticationRequired }

    func dismissNotice() { accountNotice = nil }

    func signOutAfterProtectingEditor() async {
        do { try await activeEditorGuard?.protect() }
        catch {
            accountNotice = "サインアウト前に、最新の入力を端末へ保護できませんでした。"
            return
        }
        guard activeSessionOperations == 0 else {
            accountNotice = "保護または保存の処理が終わるまでサインアウトできません。"
            return
        }
        await signOut()
    }

    private static func presentationAnchor() -> ASPresentationAnchor? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
    }
}

private enum ProductAPIError: Error {
    case unexpectedResponse, documentNotFound, compositionInProgress, editorUnavailable
}

private struct LoadedSceneDocument: Sendable, Hashable, Identifiable {
    let id: String
    let title: String
    let text: String
    let revisionID: String
}

private struct PreparedProjectSession: Sendable {
    let projectID: String
    let authorID: String
    let apiOrigin: URL
    let generation: UInt64
    let coordinator: JournalSaveCoordinator
}

private struct LoadedEditorRoute {
    let document: LoadedSceneDocument
    let prepared: PreparedProjectSession
}

private struct NativeDeepLink: Equatable {
    let projectID: String

    init?(url: URL) {
        guard url.scheme == "codexia", url.host == "project",
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil,
              let id = URL(string: url.absoluteString)?.pathComponents.last,
              id == id.lowercased(), UUID(uuidString: id) != nil,
              parts.percentEncodedPath == "/\(id)" else { return nil }
        projectID = id
    }
}

private struct LibraryView: View {
    @StateObject private var account = AccountSession()
    @State private var path: [String] = []
    @State private var visibleAuthorID: String?
    @State private var showingAccount = false
#if DEBUG
    private let showsEditorFixture = ProcessInfo.processInfo.arguments.contains("--codexia-fixture-editor")
#endif

    var body: some View {
        NavigationStack(path: $path) {
            library
                .navigationDestination(for: String.self) { projectID in
                    ProjectScreen(projectID: projectID, account: account)
                }
        }
        .onChange(of: account.pendingProjectID) { _, projectID in
            guard let projectID else { return }
            path = [projectID]
            account.pendingProjectID = nil
        }
        .onChange(of: account.status) { _, status in
            switch status {
            case .signedOut, .signingIn:
                path = []
                visibleAuthorID = nil
            case .signedIn(let subject):
                if let visibleAuthorID, visibleAuthorID != subject { path = [] }
                visibleAuthorID = subject
            default:
                break
            }
        }
        .task { await account.restoreSession() }
        .onOpenURL { url in account.receive(url) }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let notice = account.accountNotice {
                HStack {
                    Text(notice).font(.callout)
                    Spacer()
                    Button("閉じる", action: account.dismissNotice)
                }
                .padding()
                .background(.regularMaterial)
            }
        }
    }

    private var library: some View {
        List {
            switch account.status {
            case .checking:
                ProgressView("セッションを確認しています")
                    .accessibilityIdentifier("account.checking")
            case .signedOut:
                Section("アカウント") {
                    Button("サインイン") { Task { await account.signIn() } }
                        .accessibilityIdentifier("account.signIn")
                    Text("Codexia APIへシステム認証で接続します。")
                        .foregroundStyle(.secondary)
                }
            case .signingIn:
                ProgressView("システム認証を待っています")
            case .signedIn(let subject):
                Section("作品") {
                    if let message = account.projectLoadMessage {
                        Text(message).foregroundStyle(.secondary)
                    }
                    ForEach(account.projects, id: \.id) { project in
                        NavigationLink(value: project.id) {
                            Text(project.title)
                        }
                        .accessibilityIdentifier("project.\(project.id)")
                    }
                }
                Section("アカウント") {
                    LabeledContent("接続中", value: subject)
                    Button("アカウント設定", systemImage: "person.crop.circle") { showingAccount = true }
                }
            case .reauthenticationRequired:
                Section("再認証が必要です") {
                    Text("セッションの確認に失敗しました。未送信の下書きがある場合は保持されています。")
                    Button("再認証") { Task { await account.signIn() } }
                        .accessibilityIdentifier("account.reauthenticate")
                }
            case .unavailable(let message):
                Section("接続できません") {
                    Text(message)
                    Button("再試行") { Task { await account.restoreSession() } }
                        .accessibilityIdentifier("account.retry")
                }
            }
#if DEBUG
            if showsEditorFixture {
                Section("エディター検証用（Debugのみ）") {
                    NavigationLink("サンプル作品") { FixtureProjectView() }
                        .accessibilityIdentifier("CTRL-LIB-01.A")
                }
            }
#endif
        }
        .accessibilityIdentifier("screen.library")
        .navigationTitle("ライブラリ")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("アカウント", systemImage: "person.crop.circle") { showingAccount = true }
                    .accessibilityIdentifier("account.entry")
            }
        }
        .sheet(isPresented: $showingAccount) {
            AccountScreen(account: account)
        }
    }
}

private struct AccountScreen: View {
    @ObservedObject var account: AccountSession
    @Environment(\.dismiss) private var dismiss
    @State private var showingSignOutConfirmation = false

    var body: some View {
        NavigationStack {
            List {
                Section("セッション") {
                    switch account.status {
                    case .signedIn(let subject):
                        LabeledContent("アカウント", value: subject)
                        Button("サインアウト", role: .destructive) { showingSignOutConfirmation = true }
                            .accessibilityIdentifier("account.signOut")
                    case .reauthenticationRequired:
                        Text("再認証が必要です")
                        Button("再認証") { Task { await account.signIn() } }
                    default:
                        Text("サインインしていません")
                        Button("サインイン") { Task { await account.signIn() } }
                    }
                }
                if let notice = account.accountNotice {
                    Section {
                        Text(notice).font(.callout)
                        Button("通知を閉じる", action: account.dismissNotice)
                    }
                }
            }
            .accessibilityIdentifier("screen.account")
            .navigationTitle("アカウント")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("閉じる") { dismiss() } } }
            .confirmationDialog("サインアウトしますか？", isPresented: $showingSignOutConfirmation, titleVisibility: .visible) {
                Button("サインアウト", role: .destructive) {
                    Task {
                        await account.signOut()
                        if case .signedOut = account.status { dismiss() }
                    }
                }
                Button("キャンセル", role: .cancel) { }
            } message: {
                Text("保護されていない入力がある場合は、作業を保護してからサインアウトしてください。")
            }
        }
    }
}

private struct ProjectScreen: View {
    let projectID: String
    @ObservedObject var account: AccountSession
    @StateObject private var model: ProjectContentsModel
    @State private var selectedEditorRoute: LoadedEditorRoute?

    init(projectID: String, account: AccountSession) {
        self.projectID = projectID
        self.account = account
        _model = StateObject(wrappedValue: ProjectContentsModel(projectID: projectID, account: account))
    }

    var body: some View {
        List {
            if let message = model.message {
                Section { Text(message).foregroundStyle(.secondary) }
            }
            ForEach(model.chapters) { chapter in
                Section(chapter.title) {
                    ForEach(chapter.scenes) { scene in
                        Button(scene.title) { Task { await model.open(scene) { selectedEditorRoute = $0 } } }
                    }
                }
            }
            if model.chapters.isEmpty, model.message == nil {
                ContentUnavailableView("構成は空です", systemImage: "text.book.closed")
            }
        }
        .accessibilityIdentifier("screen.project")
        .navigationTitle(account.projects.first(where: { $0.id == projectID })?.title ?? "作品")
        .task { await model.load() }
        .navigationDestination(isPresented: Binding(
            get: { selectedEditorRoute != nil },
            set: { if !$0, model.editorCanLeave { closeEditor() } }
        )) {
            if let route = selectedEditorRoute {
                if let editor = model.makeEditor(route: route) {
                    ProductEditorScreen(
                        model: editor,
                        onLeave: closeEditor,
                        onCanLeaveChanged: model.updateEditorLeaveState
                    )
                } else {
                    ProgressView("下書きを復元しています")
                }
            }
        }
    }

    private func closeEditor() {
        selectedEditorRoute = nil
        model.closeEditor()
    }
}

private struct ProjectChapter: Identifiable {
    let id: String
    let title: String
    let scenes: [ProjectScene]
}

private struct ProjectScene: Identifiable {
    let id: String
    let title: String
}

@MainActor
private final class ProjectContentsModel: ObservableObject {
    @Published private(set) var chapters: [ProjectChapter] = []
    @Published private(set) var message: String?
    @Published private(set) var editorCanLeave = true
    private let projectID: String
    private let account: AccountSession
    private var editor: ProductEditorModel?
    private var openingScene = false

    init(projectID: String, account: AccountSession) {
        self.projectID = projectID
        self.account = account
    }

    func load() async {
        do {
            let documents = try await account.loadProjectDocuments(projectID: projectID)
            let sceneDocs = documents.filter { $0.kind == "scene" }
            let documentByID = Dictionary(uniqueKeysWithValues: documents.map { ($0.id, $0) })
            let grouped = Dictionary(grouping: sceneDocs) { $0.parentId ?? "root" }
            func order(_ id: String) -> (String, String, String) {
                let chapter = documentByID[id]
                let volumeOrder = chapter?.parentId.flatMap { documentByID[$0]?.orderKey } ?? ""
                return (volumeOrder, chapter?.orderKey ?? "", id)
            }
            chapters = grouped.keys.sorted { order($0) < order($1) }.compactMap { parentID in
                guard let scenes = grouped[parentID] else { return nil }
                let title = documentByID[parentID]?.title ?? "原稿"
                return ProjectChapter(
                    id: parentID,
                    title: title,
                    scenes: scenes.sorted { ($0.orderKey, $0.id) < ($1.orderKey, $1.id) }
                        .map { ProjectScene(id: $0.id, title: $0.title) }
                )
            }
            message = chapters.isEmpty ? "この作品には表示できる原稿がありません。" : nil
        } catch OAuthError.signInRequired {
            message = "再認証が必要です。未保護の入力は端末に保存されていません。"
        } catch {
            message = "構成を読み込めませんでした。再試行してください。"
        }
    }

    func open(_ scene: ProjectScene, onOpen: @escaping (LoadedEditorRoute) -> Void) async {
        guard !openingScene, editor == nil else { return }
        openingScene = true
        defer { openingScene = false }
        do {
            let prepared = try await account.prepareCoordinator(projectID: projectID)
            let document = try await account.loadDocument(projectID: projectID, documentID: scene.id)
            try Task.checkCancellation()
            let route = LoadedEditorRoute(document: document, prepared: prepared)
            editor = ProductEditorModel(route: route, account: account)
            editorCanLeave = false
            onOpen(route)
        } catch is CancellationError {
            return
        } catch {
            message = "原稿を読み込めませんでした。構成から再度開いてください。"
        }
    }

    func makeEditor(route: LoadedEditorRoute) -> ProductEditorModel? {
        editor?.documentID == route.document.id ? editor : nil
    }

    func closeEditor() {
        editor = nil
        editorCanLeave = true
    }

    func updateEditorLeaveState(_ canLeave: Bool) {
        editorCanLeave = canLeave
    }
}

@MainActor
private final class ProductEditorModel: ObservableObject {
    @Published var state: EditorState
    @Published private(set) var saveMessage = ""
    @Published private(set) var saveIsInFlight = false
    @Published private(set) var isRestoring = true
    @Published private(set) var canReconcile = false
    @Published private(set) var conflictRemoteText: String?
    @Published private(set) var conflictRevisionID: String?

    let projectID: String
    let documentID: String
    private let account: AccountSession
    private var baseRevisionID: String
    private var baseText: String
    private var protectionTask: Task<Void, Never>?
    @Published private(set) var pendingState: DraftRecord.State?
    private let prepared: PreparedProjectSession

    init(route: LoadedEditorRoute, account: AccountSession) {
        let document = route.document
        prepared = route.prepared
        projectID = route.prepared.projectID
        documentID = document.id
        self.account = account
        baseRevisionID = document.revisionID
        baseText = document.text
        state = EditorState(documentID: document.id, text: document.text)
    }

    func restore() async {
        defer { isRestoring = false }
        do {
            let records = try await account.records(prepared, documentID: documentID, includeLocalBaseline: true)
            guard let latest = records.last else { return }
            let hasOnlyBaseline = records.count == 1 && latest.isLocalBaseline
            state = latest.restoreEditor(confirmedText: hasOnlyBaseline ? baseText : nil)
            if hasOnlyBaseline { return }
            baseRevisionID = latest.baseRevisionID
            baseText = latest.baseText
            pendingState = records.first(where: { $0.state == .conflict })?.state ?? latest.state
            canReconcile = records.contains { $0.state == .unknown || $0.state == .inFlight }
            saveMessage = Self.recoveryMessage(records: records)
        } catch {
            saveMessage = "端末の下書きを確認できません。入力リスクを確認してください。"
        }
    }

    func protect(_ snapshot: EditorState.Snapshot) async throws {
        _ = try await account.protect(
            prepared,
            snapshot: snapshot,
            baseRevisionID: baseRevisionID,
            baseText: baseText
        )
        guard state.snapshot == snapshot else { return }
        var current = state
        current.markProtected(snapshot)
        state = current
        if pendingState != .conflict {
            pendingState = .protected
            if state.canLeave { saveMessage = "端末に保護済み。サーバーへの保存は未確認です。" }
        }
    }

    func scheduleProtection() {
        protectionTask?.cancel()
        guard !state.isCurrentVersionProtected else { return }
        let snapshot = state.snapshot
        protectionTask = Task { @MainActor in
            do {
                try await Task.sleep(for: .milliseconds(450))
                guard state.snapshot == snapshot else { return }
                try await protect(snapshot)
                guard !Task.isCancelled, state.snapshot == snapshot else { return }
                protectionTask = nil
                await saveProtectedChangesIfReady()
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, state.snapshot == snapshot, !state.isCurrentVersionProtected else { return }
                saveMessage = "入力を端末に保護できません。入力リスクがあります。"
            }
        }
    }

    func protectBeforeBackground() async {
        protectionTask?.cancel()
        guard !isRestoring, !state.isCurrentVersionProtected else { return }
        let snapshot = state.snapshot
        do { try await protect(snapshot) }
        catch {
            guard state.snapshot == snapshot, !state.isCurrentVersionProtected else { return }
            saveMessage = "バックグラウンド移行前に端末へ保護できませんでした。入力リスクがあります。"
        }
    }

    func save() async {
        guard !saveIsInFlight, !state.isComposing else { return }
        saveIsInFlight = true
        defer { saveIsInFlight = false }
        protectionTask?.cancel()
        let snapshot = state.snapshot
        do {
            try await protect(snapshot)
        } catch {
            saveMessage = "端末に保護できないため、サーバーへ送信しませんでした。入力リスクがあります。"
            return
        }
        guard state.snapshot == snapshot, state.canLeave else { return }
        let result = await account.save(prepared, documentID: documentID)
        await refreshJournalState()
        await handle(result)
        continueAutosave(after: result)
    }

    func reconcile() async {
        guard !saveIsInFlight, !state.isComposing else { return }
        saveIsInFlight = true
        defer { saveIsInFlight = false }
        let result = await account.reconcile(prepared, documentID: documentID)
        await refreshJournalState()
        await handle(result)
        continueAutosave(after: result)
    }

    private func continueAutosave(after result: SaveDisposition) {
        guard case .saved = result, state.hasLocalEdits else { return }
        if !state.isCurrentVersionProtected {
            scheduleProtection()
            return
        }
        Task { [weak self] in await self?.saveProtectedChangesIfReady() }
    }

    private func saveProtectedChangesIfReady() async {
        guard state.canLeave, state.hasLocalEdits, !saveIsInFlight, !canReconcile,
              pendingState == .protected else { return }
        await save()
    }

    private func handle(_ result: SaveDisposition) async {
        switch result {
        case .saved(let receipt, let submitted):
            guard state.isCurrent(submitted) else { return }
            guard receipt.revision.documentId == documentID,
                  receipt.revision.projectId == projectID,
                  receipt.revision.id == receipt.document.headRevisionId else {
                saveMessage = "保存receiptのrevision identityを照合できません。"
                pendingState = .unknown
                return
            }
            baseRevisionID = receipt.revision.id
            baseText = receipt.revision.markdown
            var current = state
            current.markCommitted(submitted)
            state = current
            if state.snapshot == submitted {
                pendingState = nil
                saveMessage = "サーバーに保存済み。revisionを確認しました。"
            } else {
                pendingState = .protected
                saveMessage = state.canLeave
                    ? "送信済みのRevisionを確認しました。後続の入力は端末に保護され、未送信です。"
                    : "送信済みのRevisionを確認しました。後続の入力は端末に未保護です。"
            }
            canReconcile = false
        case .pending:
            saveMessage = "サーバーの応答を確認できません。下書きは端末に保護されています。照合してください。"
        case .accepted:
            saveMessage = "サーバーが受け付けました。保存完了はまだ確認されていません。照合してください。"
        case .conflict(let conflict):
            conflictRemoteText = conflict?.current?.revision?.markdown
            conflictRevisionID = conflict?.current?.revision?.id
            pendingState = .conflict
            canReconcile = false
            saveMessage = "別のrevisionがあります。下書きは保護されています。内容を確認するまで再送しません。"
        case .preconditionFailed:
            pendingState = .conflict
            canReconcile = false
            saveMessage = "別のrevisionがあります。下書きは保護されています。内容を確認するまで再送しません。"
        case .unauthorized:
            account.requireReauthentication()
            saveMessage = "再認証が必要です。下書きは端末に保護されています。"
        case .forbidden:
            saveMessage = "この操作は許可されていません。下書きは端末に保護されています。"
        case .rejected(let status):
            saveMessage = "サーバーが保存を拒否しました（HTTP \(status)）。下書きは端末に保護されています。"
        case .nothingToSave:
            if state.canLeave, state.text.utf8.elementsEqual(baseText.utf8) {
                var current = state
                current.markCommitted(state.snapshot)
                state = current
            }
            pendingState = nil
            canReconcile = false
            saveMessage = "未送信の下書きはありません。"
        case .atRisk:
            saveMessage = "保存状態を確認できません。端末の下書きを再確認してください。"
        }
    }

    func protectBeforeNavigation() async throws {
        guard !isRestoring else { throw ProductAPIError.editorUnavailable }
        guard !state.isComposing else { throw ProductAPIError.compositionInProgress }
        if state.canLeave { return }
        let snapshot = state.snapshot
        try await protect(snapshot)
        guard state.isCurrent(snapshot), state.canLeave else {
            throw ProductAPIError.editorUnavailable
        }
    }

    func cancelPendingProtection() { protectionTask?.cancel() }

    func loadConflictComparison() async {
        guard pendingState == .conflict else { return }
        do {
            let head = try await account.conflictHead(prepared, documentID: documentID)
            conflictRemoteText = head.text
            conflictRevisionID = head.revisionID
        } catch {
            conflictRemoteText = nil
            conflictRevisionID = nil
            saveMessage = "現行のRevisionを取得できませんでした。下書きは端末に保持されています。"
        }
    }

    func acceptConflictResolution() async -> Bool {
        guard !saveIsInFlight, !state.isComposing, let displayedRevision = conflictRevisionID else { return false }
        saveIsInFlight = true
        defer { saveIsInFlight = false }
        protectionTask?.cancel()
        let snapshot = state.snapshot
        do {
            let records = try await account.records(prepared, documentID: documentID)
            guard let conflict = records.first(where: { $0.state == .conflict }) else { return false }
            let head = try await account.conflictHead(prepared, documentID: documentID)
            guard head.revisionID == displayedRevision, state.snapshot == snapshot, !state.isComposing else {
                conflictRemoteText = head.text
                conflictRevisionID = head.revisionID
                saveMessage = "本文またはサーバーのRevisionが変わりました。もう一度比較してください。"
                return false
            }
            try await account.resolveConflict(prepared, operationID: conflict.operationID, snapshot: snapshot, head: head)
            baseRevisionID = head.revisionID
            baseText = head.text
            var current = state
            current.markProtected(snapshot)
            state = current
            pendingState = .protected
            canReconcile = false
            conflictRemoteText = nil
            conflictRevisionID = nil
            saveMessage = "解決後の本文を端末に保護しました。サーバーへの保存を実行してください。"
            return true
        } catch {
            saveMessage = "競合の解決内容を端末へ保護できませんでした。"
            return false
        }
    }

    func registerNavigationGuard() -> UUID {
        account.registerActiveEditorGuard { [weak self] in
            guard let self else { throw ProductAPIError.editorUnavailable }
            try await self.protectBeforeNavigation()
        }
    }

    func unregisterNavigationGuard(_ id: UUID) { account.unregisterActiveEditorGuard(id) }

    private func refreshJournalState() async {
        guard let records = try? await account.records(prepared, documentID: documentID) else { return }
        pendingState = records.first(where: { $0.state == .conflict })?.state ?? records.last?.state
        canReconcile = records.contains { $0.state == .unknown || $0.state == .inFlight }
    }

    private static func recoveryMessage(records: [DraftRecord]) -> String {
        guard let latest = records.last else { return "" }
        if records.contains(where: { $0.state == .unknown || $0.state == .inFlight }) {
            return "端末の下書きを復元しました。送信結果を照合してください。"
        }
        if records.contains(where: { $0.state == .conflict }) {
            return "Revision競合の下書きを復元しました。現行本文と比較してください。"
        }
        return switch latest.state {
        case .protected: "端末に保護済み。サーバーへの保存は未確認です。"
        case .conflict: "revision競合の下書きを復元しました。内容確認が必要です。"
        case .inFlight, .unknown: "送信結果を確認できません。下書きを復元しました。照合してください。"
        case .committed: "保存済みrevisionを確認しました。"
        }
    }
}

private struct ProductEditorScreen: View {
    @StateObject var model: ProductEditorModel
    let onLeave: () -> Void
    let onCanLeaveChanged: (Bool) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var navigationGuardID: UUID?
    @State private var showingConflict = false

    var body: some View {
        Group {
            if model.isRestoring {
                ProgressView("下書きを復元しています")
            } else {
                AuthoringView(
                    state: $model.state,
                    onLeave: onLeave,
                    onProtect: { snapshot in try await model.protect(snapshot) }
                )
                .onChange(of: model.state.snapshot.version) { _, _ in model.scheduleProtection() }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.saveMessage)
                            .font(.caption)
                            .accessibilityIdentifier("save.status")
                        HStack {
                            Button("サーバーへ保存") { Task { await model.save() } }
                                .disabled(model.saveIsInFlight || model.state.isComposing || !model.state.hasLocalEdits || model.pendingState == .conflict)
                            Button("保存結果を照合") { Task { await model.reconcile() } }
                                .disabled(model.saveIsInFlight || model.state.isComposing || !model.canReconcile)
                            if model.pendingState == .conflict {
                                Button("競合を確認") { showingConflict = true }
                            }
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                    .background(.bar)
                }
            }
        }
        .task { await model.restore() }
        .onAppear { navigationGuardID = model.registerNavigationGuard() }
        .onChange(of: model.state.canLeave) { _, value in onCanLeaveChanged(value) }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { Task { await model.protectBeforeBackground() } }
        }
        .onDisappear {
            model.cancelPendingProtection()
            if let navigationGuardID { model.unregisterNavigationGuard(navigationGuardID) }
        }
        .sheet(isPresented: $showingConflict) {
            NavigationStack {
                List {
                    Section("端末の下書き") { Text(model.state.text).textSelection(.enabled) }
                    Section("サーバーの現在のrevision \(model.conflictRevisionID ?? "未取得")") {
                        Text(model.conflictRemoteText ?? "現在の本文を取得できませんでした。")
                            .textSelection(.enabled)
                    }
                    Section {
                        Text("必要な変更を原稿へ反映してから、比較したRevisionを基準に解決後の本文を端末に保護できます。")
                            .foregroundStyle(.secondary)
                        Button("解決後の本文を端末に保護") {
                            Task { if await model.acceptConflictResolution() { showingConflict = false } }
                        }
                        .disabled(model.conflictRevisionID == nil || model.saveIsInFlight)
                        Text(model.saveMessage).font(.caption)
                    }
                }
                .navigationTitle("revision競合")
                .task { await model.loadConflictComparison() }
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("閉じる") { showingConflict = false } } }
            }
        }
    }
}

#if DEBUG
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
                .accessibilityIdentifier("CTRL-OUT-01.B.fixture.\(count)")
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
        let testsClipboard = ProcessInfo.processInfo.arguments.contains("--codexia-test-clipboard")
        let text = testsClipboard ? "原稿のコピー 🌙" : manuscriptFixture(characterCount: characterCount)
        state = EditorState(documentID: "fixture-\(characterCount)", text: text)
    }
}

private struct FixtureEditorDestination: View {
    @ObservedObject var session: FixtureEditingSession
    let onLeave: () -> Void
    @State private var copied = false
    private let showsClipboardControls = ProcessInfo.processInfo.arguments.contains("--codexia-test-clipboard")

    var body: some View {
        AuthoringView(state: $session.state, onLeave: onLeave)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if showsClipboardControls {
                    HStack {
                        Button("選択してコピー") {
                            guard let editor = focusedEditor else { return }
                            UIPasteboard.general.items = []
                            editor.selectAll(nil)
                            editor.copy(nil)
                            copied = UIPasteboard.general.string == session.state.text
                        }
                        .accessibilityIdentifier("fixture.clipboard.copy")
                        if copied {
                            Text("ペーストボード照合済み")
                                .accessibilityIdentifier("fixture.clipboard.verified")
                        }
                        Button("末尾に貼り付け") {
                            guard let editor = focusedEditor else { return }
                            editor.selectedRange = NSRange(location: editor.text.utf16.count, length: 0)
                            editor.paste(nil)
                        }
                        .accessibilityIdentifier("fixture.clipboard.paste")
                    }
                    .padding()
                    .background(.bar)
                }
            }
    }

    private var focusedEditor: UITextView? {
        let windows = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }
        for window in windows {
            if let editor = findFocusedEditor(in: window) { return editor }
        }
        return nil
    }

    private func findFocusedEditor(in view: UIView) -> UITextView? {
        if let editor = view as? UITextView, editor.isFirstResponder, editor.accessibilityLabel == "原稿本文" {
            return editor
        }
        for child in view.subviews {
            if let editor = findFocusedEditor(in: child) { return editor }
        }
        return nil
    }
}
#endif
