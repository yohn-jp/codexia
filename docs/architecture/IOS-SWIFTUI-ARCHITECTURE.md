# iOS native client architecture — SwiftUI

**Status: accepted target architecture; implementation and physical-device acceptance NOT VERIFIED.**
This document owns the **iOS frontend implementation design**. [System design](SYSTEM-DESIGN.md) owns the product/client split; [API AuthN/AuthZ](API-AUTHN-AUTHZ.md), [API contract](API-CONTRACT.md), [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md), [Core](CORE.md) and [Data model](DATA-MODEL.md) retain backend authority. [User flow](../design/USER-SCREEN-FLOW.md) and [UX contract](../design/UX-CONTRACT.md) own author-visible invariants. [iOS delivery](../deployment/IOS-CLIENT.md) owns packaging, signing and device acceptance.

## 1. Decision and scope

- **Desktop: React + CodeMirror on Web. iPhone: native SwiftUI application.** They have **no required UI component, routing, state-container or design-system code reuse**; API contracts and semantic guarantees are shared.
- **Retire Mobile Web/PWA as a supported authoring product.** Ionic React, the React Mobile shell, Capacitor/WebView authoring, the /mobile/ route and their viewport-driven browser acceptance are **legacy implementation, not the target**. Do not build a second mobile React app or a permanent React/Swift fallback. No Android deliverable is implied.
- **Core/PostgreSQL remains the only authoritative manuscript store.** Native local drafts are recoverable pending work, not replicated manuscript authority. The iOS app is an authenticated API client, never a local Core, direct DB client, VM operator or MCP writer.
- A built or installable IPA is not proof that SwiftUI screens, Japanese text editing, recovery and security work on a physical iPhone. Preserve the distinction in every milestone.
- This design decision does not assert that the existing TypeScript/Capacitor implementation has already been replaced. Its removal is an implementation task after a native replacement is accepted, not a compatibility obligation.

## 2. Target system and responsibilities

~~~mermaid
flowchart TD
    WEB["Desktop Web\nReact + CodeMirror"] --> API["HTTPS / TypeSpec OpenAPI contract\nBetter Auth OAuth + Fastify admission"]
    IOS["iOS application\nSwiftUI screens + UIKit TextKit editor"] --> NET["Generated Swift client / URLSession\nnative OAuth + Keychain"]
    NET --> API
    API --> CORE["Core / PostgreSQL authoritative manuscript"]
    IOS <--> DRAFT["On-device protected draft journal\nrecovery only; author/project/document scoped"]
~~~

| Component | Ownership | Must not do |
| --- | --- | --- |
| SwiftUI App/scene coordinator | Lifecycle, navigation, screen composition, focus/accessibility, user-visible states | Decide server authorization or invent committed revisions |
| Native editor adapter | Text editing, IME marked text, selection, undo, text layout, caret/scroll | Send API requests from text callbacks or overwrite marked text on view refresh |
| Authoring coordinator | Base revision, in-flight operation, queued edits, recovery state, navigation protection | Treat request submission or HTTP 202 as a confirmed save |
| Protected draft journal | Atomic local pending-draft and operation record, scope isolation, crash/force-quit recovery | Become a second authoritative manuscript store; erase unresolved drafts on logout |
| Typed API client | Generated request/response DTO, HTTPS transport, cancellation, idempotency headers, receipt handling | Handwrite a parallel wire schema, infer permissions from UI, follow untrusted redirects |
| Auth client | System authentication, public-client OAuth/PKCE, in-memory access token, Keychain refresh token | Embed static token/client secret or send an upstream OIDC ID token to manuscript APIs |
| Core/API | Authorize project/object/revision/effect, enforce mutation preconditions, persist receipts | Delegate authorization to SwiftUI or native local storage |

## 3. Native UI and navigation

- Use SwiftUI for **Library → Project/Outline → Writing/Reading → History/Review/Knowledge → Settings**. Reuse *logical* screen IDs and domain actions from [screen catalog](../design/SCREEN-CONTROL-CATALOG.md), not React routes, CSS, Ionic sheets, DOM or shared React view models.
- Keep the current work/project/document/revision identity during navigation. For transient reference, use native sheet/popover/navigation presentation according to context; close it without destroying unsaved editor state. If editor identity must change, the authoring coordinator performs the same draft-protection gate first.
- Desktop layout, panels, saved browser layout settings and /desktop/ routes are not imported into the iOS UI. iOS app navigation is native application state/deep-link handling; /mobile/?view=... is not a canonical iOS URI.
- The installed iOS client does not render /console in a privileged embedded WebView. Operator/deployment management remains separate; owner account operations use the same owner-only API contract or an explicitly approved external Web entry, preserving draft protection.
- Preserve OS accessibility: Dynamic Type where appropriate, VoiceOver labels/traits/announcements, hardware keyboard, focus return, safe areas, keyboard occlusion, reduced motion and non-color-only state cues. No fixed CSS viewport tests are substituted for native acceptance.

## 4. Japanese manuscript editor

**Selected implementation baseline:** SwiftUI composition with a dedicated UIKit **UITextView / TextKit 2** editing surface wrapped through UIViewRepresentable. SwiftUI TextEditor may be measured as a short-lived spike comparator, **not shipped as a parallel fallback editor**. If physical-device evidence disqualifies the selected baseline, request a design change before introducing a different editor engine.

- The text view owns marked text, insertion point, selection affinity/ranges, hardware/soft keyboard input, dictation, undo grouping and scroll position. Synchronize committed edits outward without forcing a full attributed-string rewrite after every keystroke or while IME composition is active.
- Represent manuscript Markdown as source text; ruby, vertical reading/typography, preview and search highlights are *derived views*. Do not silently mutate source Markdown because visual formatting changes. Ruby/vertical layout feasibility must be verified separately; TextKit 2 alone is **not evidence** of complete Japanese book typography.
- Document identity, base revision and the locally edited text version are separate from rendered layout state. A delayed server response cannot overwrite newer local input or a different open document.
- Evaluate 10k / 100k / 500k Japanese-character fixtures, including long scene names, emoji, ruby markup and mixed newline widths. Record typing-to-paint latency distributions, scroll hitches, memory high-water mark and recovery correctness on the same physical iPhone against the existing WKWebView/CodeMirror baseline.
- Every native editor integration must prove IME conversion/reconversion/cancellation, selection, paste, undo/redo, caret visibility, app background/foreground and forced termination without discarded author input.

## 5. API client and OAuth

- **One wire source:** Issue [#652](https://github.com/yohn-jp/codexia/issues/652) owns the TypeSpec → OpenAPI 3.1 server/API contract. Use a **Swift generator consuming that same generated OpenAPI** (candidate: [Apple Swift OpenAPI Generator](https://github.com/apple/swift-openapi-generator) with [URLSession transport](https://github.com/apple/swift-openapi-urlsession)). Orval remains a TypeScript/Web client generator, **not** the iOS generator. Select and lock generator versions after confirming OpenAPI 3.1, status/error, multipart and streaming compatibility. No hand-maintained iOS wire DTO schema.
- Implement the existing Better Auth **iOS public OAuth client**, Authorization Code + PKCE S256, exact registered redirect, state/nonce/resource/audience/scope checks and system authentication presentation ([ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/); existing AppAuth-iOS logic can be assessed for native-only reuse). Cloudflare Access protecting Web assets is **not** API caller authorization.
- Keep access tokens in memory and rotated refresh tokens only in device-protected Keychain; do not include secrets in binary, build logs, drafts or published artifacts. Preserve explicit logout and token revocation distinctions. Never send upstream OIDC ID tokens to ordinary APIs.
- Use native URLSession with an exact HTTPS API-origin/path policy, no ambient cookie authority, no redirect to another origin, and bounded cancellation/retry behavior. Keep public reader origin separate from API origin. SSE/event streams need a proper streaming URLSession implementation or an explicitly documented unsupported feature decision, **not** a WebView CORS fallback. The current Capacitor bridge's buffered SSE limitation is a legacy behavior, not native design.
- Treat 401, 403, 409, 412, lost response, 202 acceptance, offline and 5xx as distinct states. Only the server's actual receipt/revision establishes a committed manuscript save; a client request or retry is never proof.

## 6. Draft journal and recovery contract

- Native pending edits and operation metadata are stored atomically in **Application Support** with appropriate iOS file protection. The journal is keyed by the authenticated author, API origin, project and document, with version/base revision, operation identity, content hash and recovery state. Protect against crashes, interrupted writes and accidental cross-author display. Keychain owns credentials **only**, not draft payloads.
- A save starts from a known base revision with an idempotency/operation key. When a response is lost, reconcile the **same operation ID** before issuing a distinct mutation. A stale base yields explicit compare/resolve; never force-overwrite prose or silently merge conflicts.
- Preserve subsequent typing during an in-flight save; its local version remains pending until its own receipt. Require a successful local protection gate before destructive navigation, sign-out, account switch or upgrade. Failed local persistence must surface At Risk, not Saved.
- Suspend/background/force-quit/OS process termination, authentication expiry and token revocation must retain unresolved local input; protect draft confidentiality while an author is signed out. A signed IPA upgrade and free-signing/reinstallation may affect data continuity; verify on hardware rather than assuming preservation.
- The **server** decides authorization, scope and mutation legality. UI state guards and local journal are UX protections, never alternative access control or a second DB.

## 7. Implementation slices and acceptance gates

| Gate | Deliverable | Evidence required |
| --- | --- | --- |
| N0: API contract dependency | OpenAPI 3.1 version/epoch and scope/error/receipt requirements available from #652 | Generated Swift client compiles; no duplicate manually authored wire DTO |
| N1: Native shell | SwiftUI app, deep links, native navigation, account entry | Xcode 27 build + iOS Simulator functional checks; no Capacitor authoring runtime in target |
| N2: Editor feasibility | TextKit 2 adapter, Japanese input and markdown source, navigation guards | Physical-device IME, selection, undo, large fixture latency/memory results |
| N3: Data safety | Native journal, receipt reconciliation, conflict/unknown recovery, OAuth/Keychain | Crash/force-quit/401/403/409/412/offline/timeout/reinstall-re-sign tests against disposable API |
| N4: Feature acceptance | Library, authoring, reading, outlines, history, proposals/approval, knowledge and permitted settings | Native UI tests + actual target iPhone + real isolated PostgreSQL; unsupported features listed explicitly |
| N5: Cutover | Retire /mobile/ Web/PWA and Capacitor/Ionic/JS-native bridge + obsolete CI/caches/tests | Source inventory; route/deep-link policy; no dangling imports, outputs or published mobile Web link; Desktop/reader/console and API remain functional |

- **No React Mobile-size UI validation target:** remove Mobile Web 320/375/390/430 CSS-px screenshots, emulated mobile Chromium/WebKit acceptance, Ionic gesture tests and mobile WebView packaging checks **when their legacy implementation is retired**. Do not delete general browser security, Desktop Web, /console or public-reader tests merely because their viewport is narrow. For iOS, require Simulator and physical-iPhone evidence; emulated mobile WebKit is not native device evidence.
- Maintain Core/Full and API schema/authorization verification; do not change or weaken the #652 workstream, CI evidence ownership or exact-source rule. A doc-only adoption is **not** implementation completion; the existing legacy tests may still run until the code cutover.
- Any API-generator scope conflict with existing [HTTP migration workstream](HTTP-PLATFORM-MIGRATION.md) or Issue #660 must be explicitly reconciled before implementation. No generated Swift client is claimed available today.

## 8. Explicit non-goals

No React Native, no Mobile Web/PWA support, no UIKit-only application rewrite (UIKit for editor integration is allowed), no standalone iOS Core/PostgreSQL, no Android, no permanent dual mobile UI, no API/auth/DB redesign, no automatic migration of private author drafts via a server-side workaround, and no feature-completion claim from CI packaging alone.

## References

- [Apple: UIViewRepresentable](https://developer.apple.com/documentation/swiftui/uiviewrepresentable)
- [Apple: UITextView](https://developer.apple.com/documentation/uikit/uitextview/)
- [Apple: ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/)
- [Apple Swift OpenAPI Generator](https://github.com/apple/swift-openapi-generator)
- [Swift OpenAPI URLSession transport](https://github.com/apple/swift-openapi-urlsession)
- [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252)
