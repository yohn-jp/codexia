# iOS client and personal-device distribution

Client sign-in, manuscript navigation and session management must follow [user screen transitions](../design/USER-SCREEN-FLOW.md), [owner security transitions](../design/ADMIN-SCREEN-FLOW.md) and the [API OAuth contract](../architecture/API-AUTHN-AUTHZ.md). iOS delivery does not grant a separate data authority.

> **Accepted architecture with native client and unsigned IPA CI under development. The Xcode 27 build, signed installation and physical-device acceptance require independent execution evidence.**
> Authentication and resource permissions are defined by [API authentication and authorization](../architecture/API-AUTHN-AUTHZ.md). Presentation remains governed by the [Design and UX contract](../design/UX-CONTRACT.md), [Mobile interactions](../architecture/MOBILE-INTERACTION-UX.md) and [Core architecture](../architecture/CORE.md).

## Purpose and non-goals

Provide an installable, thin iOS client for the existing Codexia Mobile shell on a privately owned iPhone, without buying a Mac or requiring Apple Developer Program membership **for the intended personal sideload workflow**. The app is an API client, not a self-hosted Core, PostgreSQL or MCP server. Retain the deployed Web UI/PWA and the existing standalone VM; App Store/TestFlight publication, public distribution, a second mobile UI, local manuscript authority and built-in secrets are out of scope.

This design does not assume that a free signing workflow has been proven on the physical device. An IPA generated on GitHub Actions and an IPA that can be installed and kept operational under Apple's free provisioning restrictions are **different acceptance outcomes**.

## Data plane and boundaries

```text
Browser / PWA -> Access-protected Workers static UI --+
                                                      +--> HTTPS Codexia API origin
Installed iOS -> bundled Mobile shell ----------------+           |
                       |                                          v
          system browser -> Better Auth OAuth Provider  Cloudflare Edge / Tunnel
                       |                                          |
             Codexia API access token                         Fastify API
                                                                  |
                                                         Core / PostgreSQL
```

The browser and native clients use separate public clients of Codexia's embedded Better Auth OAuth Provider and receive access tokens for the **same API authorization policy**. Better Auth federates interactive sign-in to the configured upstream OIDC provider; Google or another upstream ID token is never sent to ordinary API routes. Cloudflare Access remains a policy for delivering the Web UI, not proof of the API caller. Web and iOS retain separate redirects and local credential handling. The proposed separately addressable API requires explicit Cloudflare routing and CORS changes; see the current same-hostname arrangement in [Deployment](README.md). The app connects only to a configured HTTPS API hostname, not directly to a VM address, internal database, or Tunnel connector.

## Client implementation

- **React 19 + Ionic React 9 + Capacitor 8** remain the client stack. Swift/SwiftUI is not a second authoring UI; native Swift is reserved for narrowly required bridges (system authentication, Keychain and OS APIs). **Capacitor** is the first-choice native shell; use existing React, Ionic React, CodeMirror and `app/src/entries/mobile.tsx` instead of recreating the editor in SwiftUI or introducing a second authoring coordinator. Keep the browser Mobile build operational.
- Bundle a dedicated production Mobile Vite build as Capacitor `webDir`; do not load the live Web UI through Capacitor `server.url` in a production package. Its existing `/mobile/` Vite asset base and `BrowserRouter` expect an HTTP path and must be adapted for the bundled `capacitor://localhost`/local WebView origin without changing browser deployment semantics. Resolve deep links, asset loading, refresh/navigation and CSP under WKWebView.
- Configure the API endpoint as a **nonsecret** build/deployment setting, constrained to an HTTPS allowlist. No `CODEXIA_AUTH_TOKEN`, client secret, Cloudflare service token or author JWT is ever placed in the app, JavaScript assets, logs or GitHub build artifacts.
- Keep the native API origin and public reader origin as separate public settings. `VITE_CODEXIA_PUBLIC_READER_ORIGIN` is the HTTPS origin that native publication links target; if it is unset, the share panel does not create or display a distributable link. Never use the bundled Capacitor/WebView origin for reader links. Web links continue to use the Web page's same origin.
- Register a separate iOS public client with Codexia's Better Auth OAuth Provider; use the platform system authentication session, provider metadata discovery, OAuth Authorization Code + PKCE (S256), an exact app redirect, state/nonce handling, cancellation, reauthentication, and token expiry. Better Auth performs upstream OIDC federation and issues the Codexia API access token. Send only that access token to API routes; never send the upstream ID token as an API bearer.
- Keep the short-lived access token in runtime memory and the provider-issued, rotated refresh token in OS-protected Keychain storage. Do not place OAuth tokens in WebView IndexedDB or `localStorage`. A native HTTPS bridge must restrict requests to the configured API origin and API paths, use no ambient cookies, and refuse redirects to other origins. Sign-out clears local tokens and ends the Better Auth session; this alone does not revoke already-issued API access JWTs. The client may explicitly revoke an access token through the authenticated RFC 7009 endpoint at `/api/auth/oauth2/revoke`; the API checks that exact token revocation without affecting sibling tokens or the login session.
- Keep browser recovery and native credentials separate. Current IndexedDB drafts remain **recoverable local state**, not the manuscript authority. Verify stable app identifier and upgrade/re-sign behavior before assuming an update preserves drafts. Logout, expired credentials, revoked access and switching backend origins must not silently discard uncommitted drafts.
- Client/network errors, offline resumes, large edits, uploads and server-side 401/403/409 responses must preserve the same authoring and conflict-recovery guarantees as Mobile Web. External links, OAuth callbacks and file handling must not permit navigation to an untrusted privileged origin.

## Build and delivery

The minimum supported iOS deployment target is **iOS 27.0** (independent of the Web/PWA), with **GitHub Actions `xcode-27` ARM64** as the iOS packaging runner. Require Xcode major 27 and the iOS 27 SDK at build time, explicitly set `IPHONEOS_DEPLOYMENT_TARGET=27.0`, and reject IPA artifacts with another minimum OS. The dedicated [iOS unsigned IPA workflow](../../.github/workflows/ios-unsigned-ipa.yml) uses the selected Xcode 27 toolchain and pinned Node, pnpm and profile inputs. Pull requests that touch native iOS, its authentication entry points or bundle tooling build the Core IPA at the exact PR head. Use `workflow_dispatch` to select Core or Full manually. The workflow validates the bundled web assets and retains the unsigned IPA as an Actions artifact for seven days. Preserve source identity and the frontend/API compatibility contract.

Package the unsigned `.app` into an **unsigned, structurally valid IPA** (including `Payload/<AppName>.app` and required metadata). Validate Xcode build exit status, bundle ID, supported architectures, entitlements, IPA archive structure and asset inclusion. The repository/CI must never store Apple Account credentials, development signing identities or personal provisioning profiles. Publish only the nonsecret unsigned artifact to a restricted-retention Actions artifact; distribution/public GitHub Releases are not assumed necessary.

### Free personal installation boundary

- **Apple's official Personal Team flow** ordinarily requires signing and device provisioning through Xcode, with a seven-day provisioning expiry and a maximum of three installed apps per device. Official TestFlight requires a paid developer membership and is **not** the no-fee option.
- **SideStore** is a community sideload/re-sign option, not an Apple-supported distribution channel; its own documentation describes first-time installation using a computer, then attempting later app refresh on-device. iPhone-only initial bootstrap methods are experimental until independently verified; do not claim SideInstaller, AltLoad or similar services are a validated production dependency.
- Prefer the least-privileged documented initial setup route compatible with available hardware (Windows/Linux via iloader + SideStore if needed). Verify authenticity, source and Apple Account credential exposure before using any third-party signer. Do not assume SideStore refresh always succeeds or that an unsigned GitHub artifact can be installed without a separate signing step.
- Refresh or re-provision **before** expiration and recover gracefully after expiry; app reinstall, certificate changes or bundle-ID changes can erase local recovery data. Never describe seven-day free signing as perpetual native installation.

## Acceptance contract

1. Build a structurally valid unsigned IPA on the configured macOS runner without Apple credentials; capture run, source SHA, Xcode/Capacitor versions, architecture and artifact digest.
2. Install the package on the actual target iPhone through a documented no-fee signing path; confirm app launch, author login through the system browser, PKCE callback, valid API audience and protected bearer requests. CI build success alone is not this result.
3. Confirm Mobile shell navigation, safe areas, editor focus/IME/keyboard, CodeMirror editing, recovery journaling, project switching, file import/export, and error/retry behavior in WKWebView. Exercise the job event stream; native buffering currently marks SSE unavailable and must never fall back to WebView CORS or reconnect indefinitely.
4. Exercise create/edit, save receipt, revision conflict, explicit proposal approval/apply and denied cross-object actions against a disposable instance using the **same API authorization contract as the Web UI**; no static owner token is embedded.
5. Refresh/re-sign and install a subsequent build; confirm drafts, author scope, settings, Core data, project identity and secure login persist or fail safely with a documented recovery path.
6. Validate expiry, revoked token, offline operation, lost response, app force quit, unsigned/disallowed artifact and wrong API origin. Never claim acceptance for unexecuted physical-device tests.

References: [Capacitor iOS](https://capacitorjs.com/docs/ios), [Apple free developer account and Personal Team restrictions](https://developer.apple.com/help/account/basics/about-your-developer-account/), [SideStore installation](https://docs.sidestore.io/docs/installation/install), [SideStore FAQ](https://docs.sidestore.io/docs/faq), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252).
