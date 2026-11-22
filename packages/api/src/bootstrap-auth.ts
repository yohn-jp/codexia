import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RequestListener } from "node:http";
import { createServer } from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEXIA_OWNER_SCOPE, createBetterAuthRuntime, OIDC_PROVIDER_ID, type BetterAuthRuntimeConfig } from "./better-auth.js";
import { migrateBetterAuth, readBetterAuthMigrationConfig } from "./migrate-auth.js";

const IOS_REDIRECT_URI = "jp.yohn.codexia:/oauth2redirect";

interface BootstrapOptions {
  readonly ownerOidcSubject: string;
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

export function createBetterAuthBootstrap(config: BetterAuthRuntimeConfig, options: BootstrapOptions) {
  const origin = new URL(config.publicOrigin);
  const audience = new URL(config.apiAudience!);
  const [webClientId, iosClientId] = config.ownerClientIds;
  const introspectionClientId = config.oauthIntrospectionClientId;
  const disposableLoopback = config.allowInsecureLoopbackForTests && process.env.NODE_ENV === "test" && audience.protocol === "http:";
  if (origin.origin === audience.origin || (!disposableLoopback && origin.hostname === audience.hostname) ||
      config.ownerClientIds.length !== 2 ||
      new Set([webClientId, iosClientId, introspectionClientId]).size !== 3 ||
      !/^[!-~]+$/u.test(options.ownerOidcSubject) || config.oauthIntrospectionClientSecret.length < 32 ||
      options.webRedirectUris.length === 0 || new Set(options.webRedirectUris).size !== options.webRedirectUris.length ||
      options.webRedirectUris.some((uri) => {
        const redirect = new URL(uri);
        return redirect.origin !== audience.origin || Boolean(redirect.username || redirect.password || redirect.search || redirect.hash);
      })) {
    throw new Error("Bootstrap requires an isolated origin, exact owner and callbacks, and three distinct client IDs");
  }

  const registrationId = new AsyncLocalStorage<string>();
  const runtime = createBetterAuthRuntime({
    ...config,
    authSecret: createHmac("sha256", config.authSecret).update("codexia-auth-bootstrap:" + origin.origin).digest("hex"),
  }, {
    ownerOidcSubject: options.ownerOidcSubject,
    nextClientId() {
      const id = registrationId.getStore();
      if (!id) throw new Error("Bootstrap registration must select an approved client");
      return id;
    },
  });

  let registering = false;
  async function register(headers: Headers): Promise<Response> {
    const session = await runtime.auth.api.getSession({ headers });
    if (!session) return new Response("An IdP session is required", { status: 401 });
    const context = await runtime.auth.$context;
    const owner = await context.internalAdapter.findAccountByKey({
      providerId: OIDC_PROVIDER_ID,
      accountId: options.ownerOidcSubject,
    });
    if (owner?.userId !== session.user.id) return new Response("The IdP session does not identify the approved owner", { status: 403 });
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
          if (current.userId !== owner!.userId || current.name !== name ||
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
      await runtime.assertRegisteredClients(session.user.id);
      // Verify the stored secret through Better Auth's own authenticated client boundary.
      await runtime.verifyIntrospectionCredentials();
      return Response.json({ ownerSubject: session.user.id, webClientId, iosClientId, introspectionClientId });
    } finally {
      registering = false;
    }
  }

  async function handle(method: string, url: URL, headers: Headers): Promise<Response> {
    if (method === "GET" && url.pathname === "/") {
      const page = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Codexia OAuth registration</title>' +
        '<h1>Codexia OAuth registration</h1><form method="post" action="/login"><button>Sign in to the identity provider</button></form>' +
        '<form method="post" action="/register"><button>Register the approved clients</button></form></html>';
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (method === "GET" && url.pathname === "/api/auth/callback/" + OIDC_PROVIDER_ID) {
      return runtime.handler(new Request(url, { headers }));
    }
    if (method === "POST" && (url.pathname === "/login" || url.pathname === "/register")) {
      if (headers.get("origin") !== origin.origin) return new Response("Origin is not authorized", { status: 403 });
      if (url.pathname === "/register") return register(headers);
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
    request.resume();
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      const result = request.headers.host === origin.host && url.origin === origin.origin
        ? await handle(request.method ?? "", url, runtime.toHeaders(request.headers))
        : new Response("Host is not authorized", { status: 403 });
      const headers: Record<string, string | string[]> = Object.fromEntries(result.headers);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      response.writeHead(result.status, {
        ...headers,
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "referrer-policy": "same-origin",
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
  if (process.argv.length !== 3 || process.argv[2] !== "--apply") throw new Error("Explicit --apply is required");
  const staged = readBetterAuthMigrationConfig(false);
  const origin = process.env.CODEXIA_AUTH_BOOTSTRAP_ORIGIN!;
  const config = { ...staged, publicOrigin: origin, apiAudience: staged.apiAudience ?? new URL("/api", staged.publicOrigin).href };
  const tls = { cert: readFileSync("/run/codexia-bootstrap/tls.crt"), key: readFileSync("/run/codexia-bootstrap/tls.key"), minVersion: "TLSv1.2" as const };
  const bootstrap = createBetterAuthBootstrap(config, {
    ownerOidcSubject: process.env.CODEXIA_AUTH_BOOTSTRAP_OWNER_OIDC_SUBJECT ?? "",
    webRedirectUris: (process.env.CODEXIA_AUTH_BOOTSTRAP_WEB_REDIRECT_URIS ?? "").split(",").filter(Boolean),
  });
  const server = createServer(tls, bootstrap.listener);
  try {
    await migrateBetterAuth(staged);
  } catch (error) {
    await bootstrap.close();
    throw error;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write("Better Auth bootstrap could not start.\n");
    process.exitCode = 1;
  });
}
