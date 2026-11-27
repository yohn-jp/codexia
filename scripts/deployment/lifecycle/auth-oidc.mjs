// Disposable OIDC peer and browser-flow driver for the push deployment lifecycle.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { request as requestHttp } from "node:http";
import { createServer, request as requestHttps } from "node:https";
import { fileURLToPath } from "node:url";

const apiOrigin = "https://codexia-lifecycle-proxy:4443";
const registrationOrigin = "https://codexia-auth-registration:8443";
const apiIssuer = apiOrigin + "/api/auth";
const apiAudience = apiOrigin + "/api";
const callbackPath = "/api/auth/callback/workspace-oidc";
export const clientId = "codexia-fixture-client";
export const clientSecret = "codexia-fixture-oidc-secret-32-characters";
export const identity = {
  sub: "codexia-fixture-owner",
  email: "codexia-fixture-owner@example.test",
  email_verified: true,
  name: "Codexia Fixture Owner",
};
const readFixtureCert = () => readFileSync("/fixture/tls.crt");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function randomValue() {
  return randomBytes(32).toString("base64url");
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createIdp({ appOrigin = apiOrigin, setupOrigin = registrationOrigin } = {}) {
  const issuer = appOrigin + "/idp";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: "jwk" }), kid: "codexia-fixture-idp-key", use: "sig", alg: "RS256" };
  const codes = new Map();
  const accessTokens = new Map();
  const callbacks = new Set([appOrigin + callbackPath, setupOrigin + callbackPath]);

  return async (request, response, url) => {
    const now = Math.floor(Date.now() / 1000);
    for (const [code, value] of codes) if (value.exp <= now) codes.delete(code);
    for (const [token, exp] of accessTokens) if (exp <= now) accessTokens.delete(token);

    if (request.method === "GET" && url.pathname === "/idp/.well-known/openid-configuration") {
      return sendJson(response, {
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        userinfo_endpoint: issuer + "/userinfo",
        jwks_uri: issuer + "/jwks",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (request.method === "GET" && url.pathname === "/idp/jwks") {
      return sendJson(response, { keys: [key] });
    }
    if (request.method === "GET" && url.pathname === "/idp/authorize") {
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const challenge = url.searchParams.get("code_challenge");
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!state || !nonce || !challenge || !callbacks.has(redirectUri) ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          url.searchParams.get("response_type") !== "code" ||
          url.searchParams.get("client_id") !== clientId) {
        return sendJson(response, { error: "invalid_request" }, 400);
      }

      const code = randomValue();
      codes.set(code, { nonce, challenge, redirectUri, exp: now + 60 });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.href, "cache-control": "no-store" });
      return response.end();
    }
    if (request.method === "POST" && url.pathname === "/idp/token") {
      const form = new URLSearchParams((await readBody(request)).toString("utf8"));
      if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) {
        return sendJson(response, { error: "invalid_client" }, 401);
      }
      const code = form.get("code");
      const pending = codes.get(code);
      const verifier = form.get("code_verifier");
      if (form.get("grant_type") !== "authorization_code" || !pending || !verifier ||
          form.get("redirect_uri") !== pending.redirectUri || pkceChallenge(verifier) !== pending.challenge) {
        return sendJson(response, { error: "invalid_grant" }, 400);
      }
      codes.delete(code);

      const exp = now + 300;
      const header = encodeJwtPart({ alg: key.alg, kid: key.kid });
      const claims = encodeJwtPart({ ...identity, nonce: pending.nonce, iss: issuer, aud: clientId, iat: now, exp });
      const payload = header + "." + claims;
      const signature = sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url");
      const accessToken = randomValue();
      accessTokens.set(accessToken, exp);
      return sendJson(response, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 300,
        id_token: payload + "." + signature,
      });
    }
    if (request.method === "GET" && url.pathname === "/idp/userinfo") {
      const authorization = /^Bearer (\S+)$/iu.exec(request.headers.authorization ?? "");
      if (!authorization || !accessTokens.has(authorization[1])) {
        return sendJson(response, { error: "invalid_token" }, 401);
      }
      return sendJson(response, identity);
    }
    sendJson(response, { error: "not_found" }, 404);
  };
}

function proxyToApi(request, response) {
  const headers = {
    ...request.headers,
    "x-forwarded-host": new URL(apiOrigin).host,
    "x-forwarded-proto": "https",
  };
  // The fixture acts as the sole proxy and supplies its own forwarding information.
  delete headers.forwarded;
  delete headers["x-forwarded-for"];

  const upstream = requestHttp("http://codexia-api:3000", {
    method: request.method,
    path: request.url,
    headers,
  }, (result) => {
    response.writeHead(result.statusCode, result.headers);
    result.on("error", () => response.destroy());
    result.pipe(response);
  });
  upstream.on("error", () => {
    if (response.headersSent) response.destroy();
    else sendJson(response, { error: "upstream_unavailable" }, 502);
  });
  request.on("error", () => upstream.destroy());
  request.pipe(upstream);
}

function serve() {
  const idp = createIdp();
  const apiHost = new URL(apiOrigin).host;
  const server = createServer({ cert: readFixtureCert(), key: readFileSync("/fixture/tls.key") }, (request, response) => {
    const url = new URL(request.url ?? "/", apiOrigin);
    if (request.headers.host !== apiHost || url.origin !== apiOrigin) {
      return sendJson(response, { error: "invalid_host" }, 403);
    }
    if (url.pathname === "/idp" || url.pathname.startsWith("/idp/")) {
      void idp(request, response, url).catch(() => {
        if (response.headersSent) response.destroy();
        else sendJson(response, { error: "fixture_idp_failure" }, 500);
      });
      return;
    }
    proxyToApi(request, response);
  });
  server.listen(4443, "0.0.0.0");
}

function httpsRequest(url, { method = "GET", headers = {}, body, ca = readFixtureCert() } = {}) {
  return new Promise((resolve, reject) => {
    const request = requestHttps(url, {
      ca,
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) },
      signal: AbortSignal.timeout(10_000),
    }, async (result) => {
      try {
        const body = (await readBody(result)).toString("utf8");
        resolve({ status: result.statusCode, headers: result.headers, body });
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
    request.end(body);
  });
}

function expectStatus(response, status, step) {
  requireCondition(response.status === status, step + " returned HTTP " + response.status);
  return response;
}

function jsonResponse(response, step, status = 200) {
  expectStatus(response, status, step);
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(step + " returned invalid JSON");
  }
}

function assertUrl(value, origin, path, step) {
  requireCondition(typeof value === "string" && value.length > 0, step + " did not supply a URL");
  const url = new URL(value, origin);
  requireCondition(url.origin === origin && url.pathname === path && !url.username && !url.password && !url.hash,
    step + " returned an unexpected URL");
  return url;
}

function sessionClient(origin, send = httpsRequest) {
  const cookies = new Map();
  return async (path, options = {}) => {
    const url = new URL(path, origin);
    requireCondition(url.origin === origin, "Session request left its origin");
    const cookie = [...cookies.values()].join("; ");
    const result = await send(url, {
      ...options,
      headers: { ...(cookie ? { cookie } : {}), ...options.headers },
    });
    for (const line of result.headers["set-cookie"] ?? []) {
      const pair = line.split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index < 1) continue;
      const name = pair.slice(0, index);
      if (/;\s*max-age=0(?:;|$)/iu.test(line)) cookies.delete(name);
      else cookies.set(name, pair);
    }
    return result;
  };
}

async function idpCallback(link, origin, appOrigin = apiOrigin, send = httpsRequest) {
  const authorizeUrl = assertUrl(link, appOrigin, "/idp/authorize", "OIDC sign-in");
  requireCondition(authorizeUrl.searchParams.get("redirect_uri") === origin + callbackPath,
    "OIDC sign-in did not bind the expected callback");
  const authorized = expectStatus(await send(authorizeUrl), 302, "Fixture IdP authorization");
  const callback = assertUrl(authorized.headers.location, origin, callbackPath, "Fixture IdP authorization");
  requireCondition(callback.searchParams.has("code") &&
    callback.searchParams.get("state") === authorizeUrl.searchParams.get("state"),
  "Fixture IdP authorization lost its code or state");
  return callback;
}

export async function register({ appOrigin = apiOrigin, setupOrigin = registrationOrigin, ca } = {}) {
  const send = (url, options) => httpsRequest(url, { ...options, ca });
  const request = sessionClient(setupOrigin, send);
  const post = (path) => request(path, { method: "POST", headers: { origin: setupOrigin } });
  expectStatus(await post("/register"), 401, "Registration before OIDC sign-in");
  const login = expectStatus(await post("/login"), 200, "Protected registration login");
  const link = login.body.match(/href="([^"]+)"/u)?.[1];
  requireCondition(link, "Protected registration login did not return its IdP link");
  const callback = await idpCallback(link.replaceAll("&amp;", "&"), setupOrigin, appOrigin, send);
  const finished = expectStatus(await request(callback), 302, "Registration OIDC callback");
  assertUrl(finished.headers.location, setupOrigin, "/", "Registration OIDC callback");

  const { ownerSubject, webClientId, iosClientId, introspectionClientId } =
    jsonResponse(await post("/register"), "Protected OAuth registration");
  const registration = { ownerSubject, webClientId, iosClientId, introspectionClientId };
  requireCondition(Object.values(registration).every((value) => typeof value === "string" && value.length > 0),
    "Protected OAuth registration did not return all four identifiers");
  return registration;
}

async function discover() {
  const url = apiOrigin + "/.well-known/openid-configuration/api/auth";
  const discovery = jsonResponse(await httpsRequest(url), "API OIDC discovery");
  requireCondition(discovery.issuer === apiIssuer &&
    discovery.authorization_endpoint === apiIssuer + "/oauth2/authorize" &&
    discovery.token_endpoint === apiIssuer + "/oauth2/token" &&
    discovery.jwks_uri === apiIssuer + "/jwks" &&
    discovery.code_challenge_methods_supported?.includes("S256"), "API OIDC discovery did not match the fixture contract");
  return discovery;
}

async function assertOwnerSession(accessToken) {
  const session = jsonResponse(await httpsRequest(apiOrigin + "/api/session", {
    headers: { authorization: "Bearer " + accessToken },
  }), "Protected API session");
  requireCondition(session.authenticated === true && session.authorScope === "owner", "Protected API session did not identify the owner");
}

function signedOAuthQuery(url) {
  // Match the Better Auth client plugin. Carry only the server-selected signed fields.
  const signedNames = new Set(["sig", "ba_param", ...url.searchParams.getAll("ba_param")]);
  requireCondition(url.searchParams.has("sig") && url.searchParams.has("ba_param"), "Missing signed OAuth authorization query");
  return new URLSearchParams([...url.searchParams].filter(([name]) => signedNames.has(name))).toString();
}

async function authorize(webClientId, ownerSubject) {
  requireCondition(typeof webClientId === "string" && webClientId.length > 0, "The registered web client ID is required");
  const discovery = await discover();
  const request = sessionClient(apiOrigin);
  const redirectUri = apiOrigin + "/desktop";
  const scopes = "openid codexia:api offline_access";
  const verifier = randomValue();
  const state = randomValue();
  const authorizeUrl = new URL(discovery.authorization_endpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: webClientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource: apiAudience,
  });
  const pending = jsonResponse(await request(authorizeUrl, { headers: { accept: "application/json" } }), "Owner client authorization");
  const login = assertUrl(pending.url, apiOrigin, "/oauth/login", "Owner client authorization");
  const oauthQuery = signedOAuthQuery(login);
  const postJson = async (path, body, step) => jsonResponse(await request(path, {
    method: "POST",
    headers: { origin: apiOrigin, "content-type": "application/json" },
    body: JSON.stringify({ ...body, oauth_query: oauthQuery }),
  }), step);

  const upstream = await postJson("/api/auth/sign-in/social", {
    provider: "workspace-oidc",
    callbackURL: login.pathname + login.search,
    requestSignUp: true,
    disableRedirect: true,
  }, "API OIDC sign-in");
  const callback = await idpCallback(upstream.url, apiOrigin);
  const finished = expectStatus(await request(callback), 302, "API OIDC callback");
  const resumed = assertUrl(finished.headers.location, apiOrigin, "/oauth/login", "API OIDC callback");
  requireCondition(resumed.search === login.search, "API OIDC callback changed the signed authorization query");

  const context = await postJson("/api/auth/oauth2/consent-context", {}, "Owner consent context");
  requireCondition(context.client?.name === "Codexia Web" && context.redirectUri === redirectUri &&
    context.requestedScopes?.join(" ") === scopes, "Owner consent context did not match the registered request");
  const consent = await postJson("/api/auth/oauth2/consent", { accept: true }, "Owner consent");
  const redirect = assertUrl(consent.url, apiOrigin, "/desktop", "Owner consent");
  const code = redirect.searchParams.get("code");
  requireCondition(code && redirect.searchParams.get("state") === state && redirect.searchParams.get("iss") === apiIssuer,
    "Owner consent did not return an authorization code bound to the request and issuer");

  const grant = await exchangeOwnerGrant(discovery.token_endpoint, webClientId, ownerSubject, {
    grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier,
  });
  return { ...grant, sessionRequest: request };
}

async function exchangeOwnerGrant(endpoint, webClientId, ownerSubject, grant) {
  const token = jsonResponse(await httpsRequest(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...grant, client_id: webClientId, resource: apiAudience }).toString(),
  }), "Owner OAuth grant exchange");
  requireCondition(token.token_type === "Bearer" && typeof token.access_token === "string" &&
    typeof token.refresh_token === "string" && token.refresh_token.length > 0,
    "Owner OAuth grant did not return access and refresh tokens");

  const accessToken = token.access_token;
  const [encodedHeader, encodedClaims] = accessToken.split(".");
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
  } catch {
    throw new Error("Owner access token did not contain a JWT header and claims");
  }
  requireCondition(header.typ === "at+jwt" && header.alg === "ES256" && typeof header.kid === "string" &&
    claims.iss === apiIssuer && [claims.aud].flat().includes(apiAudience) && claims.client_id === webClientId &&
    (ownerSubject === undefined || claims.sub === ownerSubject), "Owner access token did not match the registration");
  await assertOwnerSession(accessToken);
  return { accessToken, refreshToken: token.refresh_token, kid: header.kid };
}

async function backendSmoke(webClientId, ownerSubject) {
  requireCondition(typeof ownerSubject === "string" && ownerSubject.length > 0, "The registered owner ID is required");
  const { accessToken, sessionRequest } = await authorize(webClientId, ownerSubject);
  const authorization = "Bearer " + accessToken;
  const createProject = async title => {
    const project = jsonResponse(await httpsRequest(apiOrigin + "/api/projects", {
      method: "POST",
      headers: { authorization, origin: apiOrigin, "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }), "Owner project creation", 201);
    requireCondition(typeof project.id === "string" && project.id.length > 0, "Owner project creation returned no project ID");
    expectStatus(await httpsRequest(apiOrigin + "/api/projects/" + encodeURIComponent(project.id) + "/snapshot?projection=editor", {
      headers: { authorization },
    }), 200, "Owner snapshot read");
    return project.id;
  };
  const legacyProject = await createProject("Legacy snapshot compatibility");
  const incompatibleProject = await createProject("Legacy snapshot with different projection");

  const signOut = origin => sessionRequest("/api/auth/sign-out", { method: "POST", headers: { origin } });
  expectStatus(await signOut("https://foreign.invalid"), 403, "Cross-origin sign-out");
  const active = jsonResponse(await sessionRequest("/api/auth/get-session"), "Session after rejected sign-out");
  requireCondition(active?.user?.id === ownerSubject, "Cross-origin sign-out removed the owner session");
  expectStatus(await signOut(apiOrigin), 200, "Same-origin sign-out");
  const cleared = jsonResponse(await sessionRequest("/api/auth/get-session"), "Session after sign-out");
  requireCondition(cleared === null, "Same-origin sign-out left an active session");
  return { legacyProject, incompatibleProject };
}

async function probe(accessToken) {
  requireCondition(typeof accessToken === "string" && accessToken.length > 0, "A live bearer token is required");
  const discovery = await discover();
  const jwks = jsonResponse(await httpsRequest(discovery.jwks_uri), "API JWKS");
  const keyIds = jwks.keys?.map((key) => key.kid);
  requireCondition(keyIds?.length > 0 && keyIds.every((kid) => typeof kid === "string" && kid.length > 0),
    "API JWKS did not advertise signing keys");
  await assertOwnerSession(accessToken);
  return { keyIds: keyIds.sort() };
}

async function main() {
  const [command, argument, ownerSubject] = process.argv.slice(2);
  if (command === "serve") return serve();
  let result;
  if (command === "register") result = await register();
  else if (command === "authorize") {
    const { accessToken, refreshToken, kid } = await authorize(argument, ownerSubject);
    result = { accessToken, refreshToken, kid };
  } else if (command === "refresh") {
    const { refreshToken } = JSON.parse((await readBody(process.stdin)).toString("utf8"));
    requireCondition(typeof refreshToken === "string" && refreshToken.length > 0, "Original owner refresh token is required");
    const discovery = await discover();
    const { accessToken } = await exchangeOwnerGrant(discovery.token_endpoint, argument, ownerSubject, {
      grant_type: "refresh_token", refresh_token: refreshToken,
    });
    result = { accessToken };
  } else if (command === "backend-smoke") result = await backendSmoke(argument, ownerSubject);
  else if (command === "probe") {
    const accessToken = argument === "-" ? (await readBody(process.stdin)).toString("utf8").trim() : argument;
    result = await probe(accessToken);
  } else {
    throw new Error("Expected serve, register, authorize, refresh, backend-smoke, or probe");
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write("Auth lifecycle fixture: " + error.message + "\n");
    process.exitCode = 1;
  });
}
