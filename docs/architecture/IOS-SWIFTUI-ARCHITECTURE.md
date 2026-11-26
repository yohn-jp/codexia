# iOS native client architecture — SwiftUI

**Status: accepted target architecture; native implementation and physical-device acceptance remain incomplete. Native development and automatic Xcode validation are paused; acceptance is deferred, not waived.**
This document owns the **iOS frontend implementation design**. [System design](SYSTEM-DESIGN.md) owns the product/client split; [API AuthN/AuthZ](API-AUTHN-AUTHZ.md), [API contract](API-CONTRACT.md), [Route authorization](ROUTE-AUTHORIZATION-CONTRACT.md), [Core](CORE.md) and [Data model](DATA-MODEL.md) retain backend authority. [User flow](../design/USER-SCREEN-FLOW.md) and [UX contract](../design/UX-CONTRACT.md) own author-visible invariants. [iOS delivery](../deployment/IOS-CLIENT.md) owns packaging, signing and device acceptance.

## 1. Decision and scope

- **Desktop: React + CodeMirror on Windows Chromium (Chrome/Edge). iPhone: native SwiftUI application.** They have **no required UI component, routing, state-container or design-system code reuse**; API contracts and semantic guarantees are shared.
- **Mobile Web/PWA is retired as a supported authoring product.** The Ionic React authoring shell and `/mobile/` product route have been removed. The retired Capacitor plugin, Ionic shell, WebView packaging scripts, and their private dependency manifests have been removed; they were never the SwiftUI client. Do not build a second mobile React app or a permanent React/Swift fallback. No Android deliverable is implied.
- **Core/PostgreSQL remains the only authoritative manuscript store.** Native local drafts are recoverable pending work, not replicated manuscript authority. The iOS app is an authenticated API client, never a local Core, direct DB client, VM operator or MCP writer.
- A built or installable IPA is not proof that SwiftUI screens, Japanese text editing, recovery and security work on a physical iPhone. Preserve the distinction in every milestone.
- The Desktop-only interim decision in section 7 governs Mobile Web retirement while native acceptance is paused.

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

- **One wire source.** Apple Swift OpenAPI Generator reads OpenAPI 3.1 compiled from the [TypeSpec entry point](../../packages/http-contract/src/main.tsp).
  The [Swift package lock](../../ios/CodexiaTransport/Package.resolved) fixes the generator, runtime and URLSession transport versions.
  From a fresh checkout, install the workspace dependencies with `pnpm install --frozen-lockfile` and provide Swift 6.2 or later and Python with PyYAML 6.0.3. Run `ios/CodexiaTransport/generate.sh` before opening Xcode or invoking SwiftPM. Repeat after changing the contract or generator inputs. The script checks each generated operation ID, method and path. With `--check` it generates into two fresh directories and compares the complete outputs before installing the client.
  The native acceptance suite tests transport and status/receipt behavior.
  The [HTTP platform contract](HTTP-PLATFORM-MIGRATION.md) defines schema compatibility and the existing nullable normalization.
- Implement the existing Better Auth **iOS public OAuth client**, Authorization Code + PKCE S256, exact registered redirect, state/nonce/resource/audience/scope checks and system authentication presentation ([ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/)). Cloudflare Access protecting Web assets is **not** API caller authorization.
- Keep access tokens in memory and rotated refresh tokens only in device-protected Keychain; do not include secrets in binary, build logs, drafts or published artifacts. Preserve explicit logout and token revocation distinctions. Never send upstream OIDC ID tokens to ordinary APIs.
- Use native URLSession with an exact HTTPS API-origin/path policy, no ambient cookie authority, no redirect to another origin, and bounded cancellation/retry behavior. Keep public reader origin separate from API origin. SSE/event streams need a proper streaming URLSession implementation or an explicitly documented unsupported feature decision, **not** a WebView CORS fallback. The retired Capacitor bridge's buffered SSE limitation is a legacy behavior, not native design.
- Treat 401, 403, 409, 412, lost response, 202 acceptance, offline and 5xx as distinct states. Only the server's actual receipt/revision establishes a committed manuscript save; a client request or retry is never proof.

## 6. Draft journal and recovery contract

- Native pending edits and operation metadata are stored atomically in **Application Support** with appropriate iOS file protection. The journal is keyed by the authenticated author, API origin, project and document, with version/base revision, operation identity, content hash and recovery state. Protect against crashes, interrupted writes and accidental cross-author display. Keychain owns credentials **only**, not draft payloads.
- A save starts from a known base revision with an idempotency/operation key. When a response is lost, reconcile the **same operation ID** before issuing a distinct mutation. A stale base yields explicit compare/resolve; never force-overwrite prose or silently merge conflicts.
- Preserve subsequent typing during an in-flight save; its local version remains pending until its own receipt. Require a successful local protection gate before destructive navigation, sign-out, account switch or upgrade. Failed local persistence must surface At Risk, not Saved.
- Suspend/background/force-quit/OS process termination, authentication expiry and token revocation must retain unresolved local input; protect draft confidentiality while an author is signed out. A signed IPA upgrade and free-signing/reinstallation may affect data continuity; verify on hardware rather than assuming preservation.
- The **server** decides authorization, scope and mutation legality. UI state guards and local journal are UX protections, never alternative access control or a second DB.

## 7. Implementation slices and acceptance gates

**Desktop-only interim product decision.** Mobile Web retirement is independent of native release readiness: during the iOS freeze, the supported authoring product is Desktop Web only. Execute N5 without waiting for N1–N4 physical-device acceptance. This does not waive any native acceptance evidence or enable native release; keep Swift sources and manual native CI. Do not delete or rewrite existing author drafts, and do not revoke live credentials or change production configuration as part of source retirement.

| Gate | Deliverable | Evidence required |
| --- | --- | --- |
| N0: API contract dependency | TypeSpec source, OpenAPI version and epoch, scope, errors and receipts | Two independent generator runs produce identical Swift sources and cover every OpenAPI operation ID, method and path |
| N1: Native shell | SwiftUI app, deep links, native navigation, account entry | Xcode 27 build + iOS Simulator functional checks; no Capacitor authoring runtime in target |
| N2: Editor feasibility | TextKit 2 adapter, Japanese input and markdown source, navigation guards | Physical-device IME, selection, undo, large fixture latency/memory results |
| N3: Data safety | Native journal, receipt reconciliation, conflict/unknown recovery, OAuth/Keychain | Crash/force-quit/401/403/409/412/offline/timeout/reinstall-re-sign tests against disposable API |
| N4: Feature acceptance | Library, authoring, reading, outlines, history, proposals/approval, knowledge and permitted settings | Native UI tests + actual target iPhone + real isolated PostgreSQL; unsupported features listed explicitly |
| N5: Cutover | Retire /mobile/ Web/PWA and Capacitor/Ionic/JS-native bridge + obsolete CI/caches/tests | Source inventory; route/deep-link policy; no dangling imports, outputs or published mobile Web link; Desktop/reader/console and API remain functional |

- **Current implementation status:** the production Mobile Web route, authoring shell, Capacitor bridge, Ionic dependencies, legacy packaging scripts and old Capacitor IPA workflow have been removed. This source cutover does not establish native release readiness. During the iOS freeze, native workflows are manual-dispatch only; automatic Xcode validation is paused.
- **N5 source inventory:** removed `app/native/**` (Capacitor project, custom AppAuth bridge, Node manifest/lockfile and callback setup/tests), direct Ionic dependencies and pnpm lock entries, legacy `scripts/ios` package/Web-bundle validator and tests, and obsolete Mobile shell styles. Removed Capacitor publishing origin configuration/tests; Desktop reader links now use the current Web origin. Updated OCI path filters, CI impact classification, dependency inventory, docs register and static cache headers. Retained SwiftUI app/transport/generated client and manual `.github/workflows/ios-api.yml` + `ios-editor.yml`.
- **Route and OAuth policy:** `/mobile/`, `/mobile/` deep links and old Mobile bundle assets have no compatibility alias and return not-found; route-negative checks remain in Desktop/reader/API verification. Native deep links use the iOS URI scheme and exact callback `jp.yohn.codexia:/oauth2redirect`, declared by `ios/CodexiaTransport/Sources/CodexiaTransport/OAuthConfiguration.swift` and provisioned by `packages/api/src/setup-oauth-clients.ts`. The retired Capacitor bridge used the same callback URI, so matching callback/scheme does not identify a separate legacy client. Frontend OAuth config v1 remains accepted for exact artifact/deployment compatibility until its owned migration closes; it is not a supported Mobile Web runtime or route.
- **Credential retirement procedure (source-only):** no production OAuth clients, sessions or credentials were changed here. Before any operational cleanup, an authorized operator must inspect the protected deployed Better Auth client registry and deployment/config inventory by client ID, application type, exact redirect list, owner and timestamps; compare against the current Desktop public web registration and the configured SwiftUI native public client. Do not revoke by callback URI or scheme. Preserve the iOS native client whose exact URI is shared with the retired bridge. After the owned frontend-config v1/artifact and first-owner exact-registration migration compatibility is closed, update the Desktop Web registration in place to remove only its obsolete `/mobile` and `/mobile/` redirect entries, through the deployment operator’s approved client-registry maintenance process. Retain the exact Desktop callback documented in [Better Auth runtime provisioning](../../deploy/ansible/AUTH-RUNTIME.md). If a distinct, positively identified old Capacitor public client exists, first complete session/token impact review, then disable/revoke only that client under the same procedure. Unknown or shared registrations remain untouched pending owner review. After any approved registry change, verify Desktop PKCE with its exact `/desktop` callback and configured native iOS PKCE with `jp.yohn.codexia:/oauth2redirect`, including token audience/scope and API authorization. Do not perform these operations as part of source retirement.
- **No React Mobile-size UI validation target:** Mobile Web 320/375/390/430 CSS-px screenshots, emulated mobile Chromium/WebKit acceptance, Ionic gesture tests and mobile WebView packaging checks are not current product acceptance gates. Do not delete general browser security, Desktop Web, /console or public-reader tests merely because their viewport is narrow. For iOS, require Simulator and physical-iPhone evidence; emulated mobile WebKit is not native device evidence. The author Desktop WebKit compatibility requirement is independently retired per [System design](SYSTEM-DESIGN.md); [E2E execution](../verification/E2E-EXECUTION.md) governs Chromium-only browser CI; native-device obligations remain independent. macOS native is a separate future decision. The native acceptance obligation remains; automatic macOS Xcode workflows are paused during the current freeze and require a separate resumption decision.
- Maintain Core/Full and API schema/authorization verification; do not change or weaken the #652 workstream, CI evidence ownership or exact-source rule. The remaining `/mobile/` negative-route checks preserve the no-compatibility route contract; no legacy Mobile Web or Capacitor implementation tests remain in the Desktop test command.
- The [generation script](../../ios/CodexiaTransport/generate.sh) materializes ignored Swift sources under `ios/CodexiaTransport/Sources/CodexiaAPI/Generated/` for SwiftPM and Xcode. N0 requires regeneration and operation coverage for the evaluated source. Native runtime and device acceptance follow N1–N4.

## 8. Explicit non-goals

No React Native, no Mobile Web/PWA support, no UIKit-only application rewrite (UIKit for editor integration is allowed), no standalone iOS Core/PostgreSQL, no Android, no permanent dual mobile UI, no API/auth/DB redesign, no automatic migration of private author drafts via a server-side workaround, and no feature-completion claim from CI packaging alone.

## References

- [Apple: UIViewRepresentable](https://developer.apple.com/documentation/swiftui/uiviewrepresentable)
- [Apple: UITextView](https://developer.apple.com/documentation/uikit/uitextview/)
- [Apple: ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/)
- [Apple Swift OpenAPI Generator](https://github.com/apple/swift-openapi-generator)
- [Swift OpenAPI URLSession transport](https://github.com/apple/swift-openapi-urlsession)
- [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252)
