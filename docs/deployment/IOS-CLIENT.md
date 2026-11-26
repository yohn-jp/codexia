# iOS native SwiftUI client — build, distribution and acceptance

**Native SwiftUI is the approved iOS target, but is not currently a supported authoring deliverable.** Native development and automatic Xcode validation are paused; native source exists, but implementation and physical-device acceptance remain incomplete. Native acceptance is deferred, not waived. The retained iOS workflows are manual-dispatch only. The implementation architecture is [iOS SwiftUI architecture](../architecture/IOS-SWIFTUI-ARCHITECTURE.md). [User screen flows](../design/USER-SCREEN-FLOW.md), [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md) and [Core](../architecture/CORE.md) remain normative for behavior and rights.

## Goal and boundaries

Ship an installable **native SwiftUI** iOS application for a personally owned iPhone. Desktop Web remains React on Windows Chromium (Chrome/Edge). macOS Xcode CI remains an iOS build/acceptance environment, not a macOS author-client commitment. Mobile Web/PWA, Capacitor/Ionic WebView authoring, WebView-based CodeMirror and React Mobile-shell parity are not deliverables; iOS and Desktop do not share UI components, route state or client-side application implementations. Both use the **same** Fastify/Better Auth/Core/PostgreSQL API and manuscript authorization contract. Do not move Core/DB/MCP to the device.

Web static assets remain under Cloudflare Access; the app uses an independently registered **public OAuth/PKCE iOS client** to reach the HTTPS API, subject to the same owner/project/effect authorization. The existing Web same-hostname deployment does **not** yet prove Access-independent API reachability; the required ingress and authorization cutover is governed by [deployment](README.md) and [API AuthN/AuthZ](../architecture/API-AUTHN-AUTHZ.md).

The Mobile Web production route, launcher choice and authoring shell have been removed. The legacy Capacitor bridge, Ionic dependencies, Mobile Web package scripts and Capacitor IPA workflow have also been removed. The acceptance gates below remain unchanged.

## Target native packaging

- iOS minimum deployment target: **27.0**. Xcode 27, iOS 27 SDK and ARM64 macOS CI are the accepted target. Explicitly check minimum OS in the app/IPA. SwiftUI is the only iOS application implementation.
- Build a SwiftUI executable/IPA from the **exact commit under test**. Record the Xcode/Swift toolchain, dependency lock/resolution, source revision, architectures, bundle ID, entitlements, build status, archive structure, artifact digest and retention policy.
- The manual Xcode workflows run [Swift client generation](../../ios/CodexiaTransport/generate.sh) before building from a fresh checkout. For a local build, prepare the [native generation prerequisites](../architecture/IOS-SWIFTUI-ARCHITECTURE.md#5-api-client-and-oauth) and run the same script before opening the project. Use generated Swift OpenAPI client DTOs from the same TypeSpec-derived OpenAPI 3.1 as Web; dependencies and compiler/toolchain compatibility must be pinned and validated. No iOS API schema fork or embedded credential.
- Do not put Apple Account credentials, signing certificates, provisioning profiles, OAuth refresh tokens, bearer JWTs or user manuscripts in repository, GitHub Actions artifacts or distributed unsigned binaries.
- To build an unsigned SwiftUI IPA, manually dispatch [Native iOS](../../.github/workflows/ios-editor.yml). Supply both the public HTTPS API origin and the registered public OAuth client ID for a configured build. Leaving both inputs empty produces an unconfigured proof archive. The native packaging script certifies the archive before the workflow uploads it.

## Authentication and network

- Prefer a native system authentication flow with exact callback, discovery, PKCE S256, CSRF state, OAuth resource/scope checks and secure Keychain refresh-token rotation. The SwiftUI source uses `ASWebAuthenticationSession`; the retired AppAuth-iOS Capacitor bridge has been removed.
- Native HTTPS URLSession networking accepts only the configured API origin and approved API paths, rejects cross-origin redirects/ambient cookies, never uses the upstream IdP ID token as an API bearer, and separates the public reader URL origin.
- Token expiry, cancellation, revoked credentials, API outage, lost response, conflict and logout must preserve recoverable pending drafts. Do not grant the app different API permissions from Desktop.
- **Sign-out does not revoke already-issued API access tokens.** It clears client-side tokens and attempts the provider's refresh-token/session termination; an individual still-valid access token can be explicitly revoked through the authenticated RFC 7009 endpoint `/api/auth/oauth2/revoke`. Verify revocation separately from UI logout, and preserve unresolved drafts during either operation.
- The native client must verify job/events streaming; the actual capabilities are a native-client acceptance item.

## Personal-device signing boundary

An unsigned CI IPA is not an installable, sustainably signed app. Free Personal Team signing ordinarily has short-lived provisioning and device-count limits; the proposed no-fee sideload/re-sign path requires independent verification. Do not claim permanent free installation, supported TestFlight without a paid program, or safe credential handling by third-party signing tools without evidence.

- Prefer a documented least-privilege signing flow compatible with available hardware. Verify bundle identifier stability and whether upgrade/re-sign/reinstall preserves the app's protected local draft journal before relying on it.
- App Store and TestFlight publication, public distribution and Android are out of scope for the initial personal-device acceptance. Decide a supported installation path separately from the product UI architecture.

## Acceptance gates

1. Native SwiftUI app, generated Swift API client and UIKit/TextKit editor build and run on the prescribed Xcode/iOS toolchain; record the source SHA and artifacts. **Old Capacitor IPA is not sufficient.**
2. On a physical iPhone, validate OAuth/PKCE callback, Passkey through system authentication, exact API audience, Keychain rotation and revoked/expired credentials. No client secret or static token in the app.
3. Exercise real Japanese IME (conversion/reconversion/cancel), selection/undo, editor focus, safe areas, hardware/software keyboard, long manuscript, VoiceOver, reading and native navigation. Require measured latency/memory and actual device records.
4. Exercise create/edit, server save receipt, later typing, unknown response, offline/force-quit/local journal, revision conflict, proposal approval/apply and rejected cross-project mutations against a disposable real API/PostgreSQL.
5. Re-sign/install an upgrade and verify pending drafts, author scope, auth lifecycle and settings remain safe. Explicitly record any data-loss risk and recovery behavior.
6. Retire unsupported Mobile Web/PWA, Ionic/Capacitor, /mobile/ route and mobile React viewport E2E during the Desktop-only interim phase, independently of native acceptance, with source inventory and Desktop/reader/console regression evidence. Do not convert an unimplemented target into a false completed result.

References: [Apple official developer account guidance](https://developer.apple.com/help/account/basics/about-your-developer-account/), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252), [ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/), [SideStore FAQ](https://docs.sidestore.io/docs/faq).
