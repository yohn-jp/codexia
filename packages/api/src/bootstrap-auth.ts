import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import type { RequestListener } from "node:http";
import { createServer } from "node:https";
import { fileURLToPath } from "node:url";
import { CODEXIA_OWNER_SCOPE, createBetterAuthRuntime, OIDC_PROVIDER_ID, type BetterAuthRuntimeConfig } from "./better-auth.js";
import { migrateBetterAuth, readBetterAuthMigrationConfig } from "./migrate-auth.js";

const IOS_REDIRECT_URI = "jp.yohn.codexia:/oauth2redirect";

interface BootstrapOptions {
  readonly ownerOidcSubject?: string;
  readonly passkeyRecoveryOwnerId?: string;
  readonly webRedirectUris: readonly string[];
}

interface RegisteredClient {
  readonly userId: string;
  readonly redirectUris: readonly string[];
  readonly name: string;
  readonly scopes: readonly string[];
  readonly skipConsent: boolean;
  readonly grantTypes: readonly string[];
  readonly tokenEndpointAuthMethod: string;
  readonly applicationType: string;
}

function sameValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

export function resolvePasskeyBootstrapRpId(
  productionOrigin: string,
  setupOrigin: string,
  allowLoopbackForTests = false,
): string {
  const production = new URL(productionOrigin);
  const setup = new URL(setupOrigin);
  if ([production, setup].some((url) => url.username || url.password || url.pathname !== "/" || url.search || url.hash)) {
    throw new Error("Passkey setup requires exact production and setup origins");
  }
  const loopbackTest = allowLoopbackForTests && process.env.NODE_ENV === "test" &&
    production.protocol === "http:" && setup.protocol === "http:" &&
    production.hostname === "127.0.0.1" && setup.hostname === "127.0.0.1";
  if (production.protocol !== "https:" && !loopbackTest || setup.protocol !== "https:" && !loopbackTest) {
    throw new Error("Passkey setup requires HTTPS origins");
  }
  if (loopbackTest) return production.hostname;
  if (production.hostname === setup.hostname || !setup.hostname.endsWith(`.${production.hostname}`)) {
    throw new Error("Passkey setup host must be a strict subdomain of the production auth hostname");
  }
  return production.hostname;
}

/** Refuse an ambiguous or unapproved first-owner enrollment path. */
export function assertInitialAuthBootstrapMode(
  config: Pick<BetterAuthRuntimeConfig, "passkeyBootstrap" | "oidcIssuer">,
  approvedOidcOwnerSubject: string | undefined,
): void {
  const passkey = Boolean(config.passkeyBootstrap);
  const oidc = Boolean(config.oidcIssuer);
  if (passkey === oidc || oidc !== Boolean(approvedOidcOwnerSubject)) {
    throw new Error("First-owner bootstrap requires exactly one approved Passkey or OIDC identity");
  }
}

export function createBetterAuthBootstrap(config: BetterAuthRuntimeConfig, options: BootstrapOptions) {
  const origin = new URL(config.publicOrigin);
  const audience = new URL(config.apiAudience!);
  const [webClientId, iosClientId] = config.ownerClientIds;
  const introspectionClientId = config.oauthIntrospectionClientId;
  const disposableLoopback = config.allowInsecureLoopbackForTests && process.env.NODE_ENV === "test" && audience.protocol === "http:";
  if (origin.origin === audience.origin || (!disposableLoopback && origin.hostname === audience.hostname) ||
      config.ownerClientIds.length !== 2 ||
      new Set([webClientId, iosClientId, introspectionClientId]).size !== 3 ||
      (config.oidcIssuer && !options.ownerOidcSubject && !options.passkeyRecoveryOwnerId) ||
      (options.passkeyRecoveryOwnerId && (config.passkeyBootstrap || options.passkeyRecoveryOwnerId !== config.ownerSubject)) ||
      (options.ownerOidcSubject !== undefined && !/^[!-~]+$/u.test(options.ownerOidcSubject)) ||
      config.oauthIntrospectionClientSecret.length < 32 ||
      (!options.passkeyRecoveryOwnerId && options.webRedirectUris.length === 0) ||
      new Set(options.webRedirectUris).size !== options.webRedirectUris.length ||
      options.webRedirectUris.some((uri) => {
        const redirect = new URL(uri);
        return redirect.origin !== audience.origin || Boolean(redirect.username || redirect.password || redirect.search || redirect.hash);
      })) {
    throw new Error("Bootstrap requires an isolated origin, exact owner and callbacks, and three distinct client IDs");
  }
  if ((config.passkeyBootstrap || options.passkeyRecoveryOwnerId) && !config.passkeyRpId) {
    throw new Error("Passkey setup requires an RP ID derived from the production auth hostname");
  }

  const registrationId = new AsyncLocalStorage<string>();
  const runtime = createBetterAuthRuntime({
    ...config,
    authSecret: createHmac("sha256", config.authSecret).update("codexia-auth-bootstrap:" + origin.origin).digest("hex"),
  }, {
    ...(options.ownerOidcSubject ? { ownerOidcSubject: options.ownerOidcSubject } : {}),
    ...(options.passkeyRecoveryOwnerId ? { passkeyRecoveryOwnerId: options.passkeyRecoveryOwnerId } : {}),
    nextClientId() {
      const id = registrationId.getStore();
      if (!id) throw new Error("Bootstrap registration must select an approved client");
      return id;
    },
  });

  let registering = false;
  async function register(headers: Headers): Promise<Response> {
    if (options.passkeyRecoveryOwnerId) return new Response("OAuth client registration is unavailable during Passkey recovery", { status: 403 });
    const session = await runtime.auth.api.getSession({ headers });
    if (!session) return new Response("An IdP session is required", { status: 401 });
    const context = await runtime.auth.$context;
    const oidcOwner = options.ownerOidcSubject
      ? await context.internalAdapter.findAccountByKey({ providerId: OIDC_PROVIDER_ID, accountId: options.ownerOidcSubject })
      : null;
    const passkeys = config.passkeyBootstrap && session.user.id === config.passkeyBootstrap.ownerId
      ? await context.adapter.findMany({ model: "passkey", where: [{ field: "userId", value: session.user.id }] })
      : [];
    const approvedPasskeyOwner = passkeys.length > 0;
    if (oidcOwner?.userId !== session.user.id && !approvedPasskeyOwner) {
      return new Response("The session does not identify the approved OIDC or Passkey owner", { status: 403 });
    }
    const ownerSubject = session.user.id;
    if (registering) return new Response("Registration is already in progress", { status: 409 });

    registering = true;
    try {
      const ownerScopes = ["openid", CODEXIA_OWNER_SCOPE, "offline_access"];
      async function ensureClient(id: string, name: string, redirectUris: readonly string[], applicationType: "web" | "native", confidential = false) {
        const scopes = confidential ? ["openid"] : ownerScopes;
        const grantTypes = confidential ? ["authorization_code"] as const : ["authorization_code", "refresh_token"] as const;
        const tokenEndpointAuthMethod = confidential ? "client_secret_post" : "none";
        const current = await context.adapter.findOne<RegisteredClient>({
          model: "oauthClient", where: [{ field: "clientId", value: id }],
        });
        if (current) {
          if (current.userId !== ownerSubject || current.name !== name ||
              !sameValues(current.redirectUris, redirectUris) || !sameValues(current.scopes, scopes) ||
              !sameValues(current.grantTypes, grantTypes) || current.skipConsent !== confidential ||
              current.tokenEndpointAuthMethod !== tokenEndpointAuthMethod || current.applicationType !== applicationType) {
            throw new Error("An existing client differs from the approved registration");
          }
          return;
        }
        await registrationId.run(id, () => runtime.auth.api.adminCreateOAuthClient({
          headers,
          body: {
            client_name: name, redirect_uris: [...redirectUris], application_type: applicationType,
            scope: scopes.join(" "), resources: [audience.href], token_endpoint_auth_method: tokenEndpointAuthMethod,
            grant_types: [...grantTypes], response_types: ["code"], require_pkce: true, skip_consent: confidential,
          },
        }));
      }

      // The existing disposable HTTP loopback fixture uses the provider's native loopback allowance.
      const webType = disposableLoopback ? "native" : "web";
      await ensureClient(webClientId!, "Codexia Web", options.webRedirectUris, webType);
      await ensureClient(iosClientId!, "Codexia iOS", [IOS_REDIRECT_URI], "native");
      await ensureClient(introspectionClientId, "Codexia API introspection", [audience.origin + "/oauth/introspection"], webType, true);
      await runtime.assertRegisteredClients(ownerSubject);
      // Verify the stored secret through Better Auth's own authenticated client boundary.
      await runtime.verifyIntrospectionCredentials();
      return Response.json({ ownerSubject, webClientId, iosClientId, introspectionClientId });
    } finally {
      registering = false;
    }
  }

  async function handle(method: string, url: URL, headers: Headers, body?: Buffer): Promise<Response> {
    if (method === "GET" && url.pathname === "/passkey" && (config.passkeyBootstrap || options.passkeyRecoveryOwnerId)) {
      const isRecovery = Boolean(options.passkeyRecoveryOwnerId);
      const title = isRecovery ? "Add a replacement owner Passkey" : "Register the first owner Passkey";
      const instructions = isRecovery
        ? "Enter the one-time operator recovery grant. Existing owner identity and project data are preserved. The grant expires after ten minutes and is not saved in this browser."
        : "Enter the one-time operator grant. It expires after ten minutes and is not saved in this browser.";
      const success = isRecovery
        ? "Replacement Passkey registered. Close this setup page and sign in again at the Codexia login page."
        : "Passkey registered. Continue to register OAuth clients.";
      const recoveryHeader = isRecovery ? "x-codexia-owner-recovery" : "x-codexia-owner-enrollment";
      const ceremonyContext = isRecovery ? "codexia-owner-recovery-v1" : "codexia-first-owner-v1";
      const registrationForm = isRecovery ? "" : '<form method="post" action="/register"><button type="submit">Register OAuth clients</button></form>';
      const nonce = randomBytes(18).toString("base64");
      const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codexia Passkey owner setup</title><main><h1>${title}</h1>
<p>${instructions}</p>
<label for="grant">Enrollment grant</label> <input id="grant" type="password" autocomplete="off" required>
<button id="enroll" type="button">Create Passkey</button>${registrationForm}
<output id="status" aria-live="polite"></output></main><script nonce="${nonce}">
const button=document.querySelector("#enroll"),out=document.querySelector("#status"),grant=document.querySelector("#grant"),grantHeader=${JSON.stringify(recoveryHeader)},ceremonyContext=${JSON.stringify(ceremonyContext)},successMessage=${JSON.stringify(success)};
if(!window.isSecureContext||typeof PublicKeyCredential!=="function"||typeof PublicKeyCredential.parseCreationOptionsFromJSON!=="function"){
  button.disabled=true;out.textContent="This browser does not support secure Passkey registration. Use a current browser on this HTTPS setup page.";
}
button.addEventListener("click",async()=>{const token=grant.value;button.disabled=true;out.textContent="Waiting for the authenticator…";
let publicKey,encoded;
try{
  const headers={[grantHeader]:token};
  const optionsResponse=await fetch("/api/auth/passkey/generate-register-options?context="+encodeURIComponent(ceremonyContext),{headers,credentials:"same-origin"});
  if(!optionsResponse.ok)throw new Error("The enrollment grant is invalid, expired, or already used.");
  const options=await optionsResponse.json();publicKey=PublicKeyCredential.parseCreationOptionsFromJSON(options);
  const credential=await navigator.credentials.create({publicKey});if(!credential)throw new Error("Passkey creation was cancelled.");
  encoded=credential.toJSON();
}catch(error){
  out.textContent=error instanceof DOMException&&error.name==="NotAllowedError"?"Passkey creation was cancelled or timed out. You can retry before the grant expires.":error instanceof Error?error.message:"Passkey registration failed.";
  button.disabled=false;return;
}
try{
  const verified=await fetch("/api/auth/passkey/verify-registration",{method:"POST",headers:{[grantHeader]:token,"content-type":"application/json"},credentials:"same-origin",body:JSON.stringify({response:encoded,createSession:true})});
  if(!verified.ok){if(PublicKeyCredential.signalUnknownCredential)await PublicKeyCredential.signalUnknownCredential({rpId:publicKey.rp.id,credentialId:encoded.id});throw new Error("The server did not accept this Passkey. The enrollment state may need operator recovery.");}
  grant.value="";out.textContent=successMessage;
}catch(error){
  if(PublicKeyCredential.signalUnknownCredential)await PublicKeyCredential.signalUnknownCredential({rpId:publicKey.rp.id,credentialId:encoded.id}).catch(()=>{});
  out.textContent=error instanceof Error?error.message:"Passkey verification could not be confirmed. Check again before retrying.";button.disabled=false;
}
});</script></html>`;
      return new Response(page, { headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        "referrer-policy": "no-referrer",
      } });
    }
    if (method === "GET" && url.pathname === "/") {
      const passkey = config.passkeyBootstrap || options.passkeyRecoveryOwnerId
        ? '<p><a href="/passkey">' + (options.passkeyRecoveryOwnerId ? 'Add a replacement owner Passkey' : 'Register the first owner Passkey') + '</a></p>' : "";
      const oidcLogin = config.oidcIssuer && !options.passkeyRecoveryOwnerId
        ? '<form method="post" action="/login"><button>Sign in to the identity provider</button></form>' : "";
      const page = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codexia authentication setup</title>' +
        '<main><h1>Codexia authentication setup</h1>' + passkey + oidcLogin +
        '<form method="post" action="/register"><button type="submit">Register the approved OAuth clients</button></form></main></html>';
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (method === "GET" && !options.passkeyRecoveryOwnerId && config.oidcIssuer && url.pathname === "/api/auth/callback/" + OIDC_PROVIDER_ID) {
      return runtime.handler(new Request(url, { headers }));
    }
    if ((method === "GET" || method === "POST") && url.pathname.startsWith("/api/auth/passkey/")) {
      if (!config.passkeyBootstrap && !options.passkeyRecoveryOwnerId) {
        return new Response("Passkey endpoints are unavailable during OIDC client setup", { status: 404 });
      }
      return runtime.handler(new Request(url, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) }));
    }
    if (method === "POST" && (url.pathname === "/login" || url.pathname === "/register")) {
      if (headers.get("origin") !== origin.origin) return new Response("Origin is not authorized", { status: 403 });
      if (url.pathname === "/register") return register(headers);
      if (options.passkeyRecoveryOwnerId) return new Response("Identity-provider sign-in is unavailable during Passkey recovery", { status: 403 });
      if (!config.oidcIssuer || !config.oidcClientId || !config.oidcClientSecret) return new Response("OIDC is not configured", { status: 404 });
      const result = await runtime.auth.api.signInSocial({
        headers, asResponse: true,
        body: { provider: OIDC_PROVIDER_ID, callbackURL: origin.origin + "/", requestSignUp: true },
      });
      const { url: authorizationUrl } = await result.json() as { url?: string };
      if (!result.ok || !authorizationUrl) throw new Error("OIDC sign-in could not be started");
      const authorization = new URL(authorizationUrl);
      if (authorization.protocol !== "https:" &&
          !(disposableLoopback && authorization.origin === new URL(config.oidcIssuer).origin)) {
        throw new Error("The identity provider must authorize via HTTPS");
      }
      const link = authorization.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const responseHeaders = new Headers({ "content-type": "text/html; charset=utf-8" });
      for (const cookie of result.headers.getSetCookie()) responseHeaders.append("set-cookie", cookie);
      // Keep the form submission at this origin. A link can then navigate to the IdP.
      return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Continue sign-in</title>' +
        '<a rel="noreferrer" href="' + link + '">Continue to the identity provider</a></html>', { headers: responseHeaders });
    }
    return new Response("Not found", { status: 404 });
  }

  const listener: RequestListener = (request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += part.byteLength;
        if (size > 1024 * 1024) {
          response.writeHead(413, { "cache-control": "no-store" });
          response.end("Request body is too large");
          return;
        }
        chunks.push(part);
      }
      const url = new URL(request.url ?? "/", origin);
      const result = request.headers.host === origin.host && url.origin === origin.origin
        ? await handle(request.method ?? "", url, runtime.toHeaders(request.headers), chunks.length ? Buffer.concat(chunks) : undefined)
        : new Response("Host is not authorized", { status: 403 });
      const headers: Record<string, string | string[]> = Object.fromEntries(result.headers);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      response.writeHead(result.status, {
        ...headers,
        "cache-control": "no-store",
        "content-security-policy": result.headers.get("content-security-policy") ?? "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "referrer-policy": result.headers.get("referrer-policy") ?? "same-origin",
        "x-content-type-options": "nosniff",
      });
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { "cache-control": "no-store" });
      response.end("OAuth registration failed");
    });
  };
  return { listener, close: () => runtime.pool.end() };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recoveryMode = args.length === 2 && args[0] === "--recover" && args[1] === "--apply";
  const enrollmentMode = args.length === 1 && args[0] === "--apply";
  if (!recoveryMode && !enrollmentMode) throw new Error("Explicit --apply is required");
  const staged = readBetterAuthMigrationConfig(recoveryMode);
  if (recoveryMode && (!staged.ownerSubject || staged.passkeyBootstrap)) {
    throw new Error("Passkey recovery requires the configured existing owner");
  }
  if (enrollmentMode) {
    assertInitialAuthBootstrapMode(staged, process.env.CODEXIA_AUTH_BOOTSTRAP_OWNER_OIDC_SUBJECT);
  }
  const origin = process.env.CODEXIA_AUTH_BOOTSTRAP_ORIGIN!;
  const passkeySetup = Boolean(staged.passkeyBootstrap || recoveryMode);
  const config = {
    ...staged,
    publicOrigin: origin,
    ...(passkeySetup ? { passkeyRpId: resolvePasskeyBootstrapRpId(staged.publicOrigin, origin, staged.allowInsecureLoopbackForTests) } : {}),
    apiAudience: staged.apiAudience ?? new URL("/api", staged.publicOrigin).href,
  };
  const tls = { cert: readFileSync("/run/codexia-bootstrap/tls.crt"), key: readFileSync("/run/codexia-bootstrap/tls.key"), minVersion: "TLSv1.2" as const };
  const bootstrap = createBetterAuthBootstrap(config, {
    ...(process.env.CODEXIA_AUTH_BOOTSTRAP_OWNER_OIDC_SUBJECT ? { ownerOidcSubject: process.env.CODEXIA_AUTH_BOOTSTRAP_OWNER_OIDC_SUBJECT } : {}),
    ...(recoveryMode && staged.ownerSubject ? { passkeyRecoveryOwnerId: staged.ownerSubject } : {}),
    webRedirectUris: (process.env.CODEXIA_AUTH_BOOTSTRAP_WEB_REDIRECT_URIS ?? "").split(",").filter(Boolean),
  });
  const server = createServer(tls, bootstrap.listener);
  if (enrollmentMode) {
    try {
      await migrateBetterAuth(staged);
    } catch (error) {
      await bootstrap.close();
      throw error;
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8443, "0.0.0.0", resolve);
  }).catch(async (error) => {
    await bootstrap.close();
    throw error;
  });
  process.stdout.write("Better Auth bootstrap is ready.\n");
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => server.close(() => void bootstrap.close()));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(() => {
    process.stderr.write("Better Auth bootstrap could not start.\n");
    process.exitCode = 1;
  });
}
