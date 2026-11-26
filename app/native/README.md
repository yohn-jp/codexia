# Legacy Capacitor authentication

**This package is not the current iOS app.** It is a retained legacy Capacitor authentication bridge; the current SwiftUI app and native OAuth implementation live under `ios/`. The Mobile Web authoring shell and its IPA workflow have been retired. Do not use this guide as SwiftUI build, release or acceptance instructions; use [the native iOS guide](../../docs/deployment/IOS-CLIENT.md).

The retained Capacitor bridge was built as a separate public OAuth client of Codexia's embedded Better Auth OAuth Provider. Better Auth owns upstream OIDC federation and issues the access token accepted by Codexia's API. That legacy client does not send an upstream ID token as an API bearer.

The native Capacitor bridge uses AppAuth-iOS for HTTPS OIDC discovery and Authorization Code + PKCE S256 in the platform system authentication session. AppAuth requests use an ephemeral cookie-free URL session that refuses redirects. The exact registered redirect URI is `jp.yohn.codexia:/oauth2redirect`; AppAuth generates and validates the authorization state and PKCE transaction. Only the provider-issued refresh token is persisted in iOS Keychain with device-only accessibility; access tokens remain in native and JavaScript runtime memory. Refresh token rotation is written to Keychain before the new API access token is returned.

Requests from this retained plugin use its restricted HTTPS transport, not WebView `fetch`: the bridge accepts only the configured HTTPS origin and `/api/*`, disables redirects, rejects cookies and non-Bearer authorization, uses an ephemeral cookie-free URL session, and does not forward `Set-Cookie` to the WebView. Responses are buffered, so the job event SSE stream is unavailable in this legacy shell; it must not fall back to a CORS-blocked WebView request or reconnect indefinitely.

The legacy bridge API transport requires `VITE_CODEXIA_API_ORIGIN` to be an explicit HTTPS origin. Its OAuth remains disabled unless `VITE_CODEXIA_OAUTH_IOS_CLIENT_ID` is set. The public resource indicator uses `VITE_CODEXIA_API_AUDIENCE` when supplied, otherwise it is `${VITE_CODEXIA_API_ORIGIN}/api`. The issuer and OAuth endpoints are fixed by the Better Auth contract under that API origin. The legacy OAuth client ID is public configuration, not a secret; do not set a client secret in an iOS bundle.

In the retained Capacitor bridge, `VITE_CODEXIA_PUBLIC_READER_ORIGIN` sets the public reader site's HTTPS origin for distributable publication links. It accepts an origin only, without credentials, path, query, or fragment, and is independent of `VITE_CODEXIA_API_ORIGIN`. If unset, the legacy share panel cannot create a link and never substitutes the Capacitor WebView origin. Web builds continue to use their current page origin.

Sign-out clears the in-memory access token and Keychain refresh token, then requests refresh-token revocation. Already-issued API access JWTs can remain valid until expiration. The owning client can explicitly revoke an individual access token through the [RFC 7009 endpoint](../../docs/deployment/IOS-CLIENT.md#authentication-and-network).

`npm test` runs the retained Capacitor configuration, API-origin, callback-scheme and bridge checks. The [native iOS build and distribution guide](../../docs/deployment/IOS-CLIENT.md) covers SwiftUI IPA packaging and personal-device signing.
