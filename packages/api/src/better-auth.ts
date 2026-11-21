import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { genericOAuth, jwt } from "better-auth/plugins";
import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
  verifyOAuthQueryParams,
} from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";

export const CODEXIA_AUTH_SCHEMA = "codexia_auth";
export const CODEXIA_OWNER_SCOPE = "codexia:api";
export const CODEXIA_MCP_SCOPES = ["mcp:read", "mcp:compute", "mcp:propose"] as const;
export const OIDC_PROVIDER_ID = "workspace-oidc";

export interface BetterAuthRuntimeConfig {
  readonly databaseUrl: string;
  readonly publicOrigin: string;
  readonly oidcIssuer: string;
  readonly oidcClientId: string;
  readonly oidcClientSecret: string;
  readonly authSecret: string;
  readonly oauthIntrospectionClientId: string;
  readonly oauthIntrospectionClientSecret: string;
  readonly apiAudience?: string;
  readonly ownerClientIds: readonly string[];
  readonly mcpClientIds?: readonly string[];
  readonly allowInsecureLoopbackForTests?: boolean;
}

export interface OAuthConsentContext {
  readonly client: { readonly name: string };
  readonly requestedScopes: readonly string[];
}

const SUPPORTED_OAUTH_SCOPES = ["openid", "email", "profile", "offline_access", CODEXIA_OWNER_SCOPE, ...CODEXIA_MCP_SCOPES] as const;
const CONFIDENTIAL_TOKEN_AUTH_METHODS = ["client_secret_basic", "client_secret_post", "private_key_jwt"] as const;

/**
 * Better Auth 1.7.x only advertises public clients when dynamic registration or
 * client discovery is enabled. Codexia intentionally provisions clients through
 * the authenticated admin API instead, so keep public registration closed and
 * supplement the metadata with the public method the token endpoint accepts.
 */
export async function advertisePublicClientTokenAuth(metadata: Response): Promise<Response> {
  if (!metadata.ok) return metadata;
  const body: unknown = await metadata.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Better Auth returned invalid authorization-server metadata");
  }
  const record = body as Record<string, unknown>;
  const configured = Array.isArray(record.token_endpoint_auth_methods_supported)
    ? record.token_endpoint_auth_methods_supported.filter((value): value is string => typeof value === "string")
    : [];
  const headers = new Headers(metadata.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({
    ...record,
    token_endpoint_auth_methods_supported: [...new Set(["none", ...configured])],
  }), { status: metadata.status, statusText: metadata.statusText, headers });
}

function assertHttpsUrl(value: string, name: string, allowInsecureLoopbackForTests = false): URL {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${name} must be an absolute HTTPS URL`); }
  const isTestLoopback = allowInsecureLoopbackForTests && process.env.NODE_ENV === "test" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost") &&
    parsed.protocol === "http:";
  if ((!isTestLoopback && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials, query, or fragment`);
  }
  return parsed;
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function signedQueryParam(params: URLSearchParams, name: string): string {
  const values = params.getAll(name);
  if (values.length !== 1 || !values[0]) throw new Error(`OAuth consent request has invalid ${name}`);
  return values[0];
}

export function createBetterAuthRuntime(config: BetterAuthRuntimeConfig) {
  const publicOrigin = assertHttpsUrl(config.publicOrigin, "CODEXIA_PUBLIC_ORIGIN", config.allowInsecureLoopbackForTests);
  if (publicOrigin.pathname !== "/") throw new Error("CODEXIA_PUBLIC_ORIGIN must be an origin without a path");
  const issuer = new URL("/api/auth", publicOrigin).toString();
  const oidcIssuer = assertHttpsUrl(config.oidcIssuer, "CODEXIA_OIDC_ISSUER", config.allowInsecureLoopbackForTests).toString().replace(/\/$/u, "");
  const audience = config.apiAudience ?? new URL("/api", publicOrigin).toString();
  assertHttpsUrl(audience, "CODEXIA_API_AUDIENCE", config.allowInsecureLoopbackForTests);
  if (new URL(audience).pathname !== "/api") throw new Error("CODEXIA_API_AUDIENCE must identify the public API resource");
  if (!config.databaseUrl.trim() || !config.oidcClientId.trim() || config.oidcClientSecret.length < 16 ||
      config.authSecret.length < 32 || config.oauthIntrospectionClientId.trim() === "" ||
      config.oauthIntrospectionClientSecret.length < 16 || config.ownerClientIds.length === 0 ||
      config.ownerClientIds.some((id) => !id.trim())) {
    throw new Error("Better Auth requires PostgreSQL, OIDC client credentials, a 32-character auth secret, a confidential introspection client, and owner client IDs");
  }
  const mcpClientIds = [...new Set((config.mcpClientIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (mcpClientIds.some((id) => config.ownerClientIds.includes(id))) {
    throw new Error("Owner and limited MCP OAuth client allowlists must be disjoint");
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    options: `-c search_path=${CODEXIA_AUTH_SCHEMA}`,
  });
  const auth = betterAuth({
    database: pool,
    baseURL: issuer,
    secret: config.authSecret,
    account: { accountLinking: { enabled: false } },
    plugins: [
      genericOAuth({ config: [{
        providerId: OIDC_PROVIDER_ID,
        name: "Workspace identity provider",
        clientId: config.oidcClientId,
        clientSecret: config.oidcClientSecret,
        discoveryUrl: `${oidcIssuer}/.well-known/openid-configuration`,
        requireIdTokenVerification: true,
        pkce: true,
        scopes: ["openid", "email", "profile"],
      }] }),
      jwt({ disableSettingJwtHeader: true, jwks: { keyPairConfig: { alg: "ES256" } } }),
      oauthProvider({
        loginPage: "/oauth/login",
        consentPage: "/oauth/consent",
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        requireOpenidScope: true,
        allowPublicClientPrelogin: true,
        scopes: [...SUPPORTED_OAUTH_SCOPES],
        resources: [{
          identifier: audience,
          name: "Codexia API",
          accessTokenTtl: 300,
          allowedScopes: [CODEXIA_OWNER_SCOPE, ...CODEXIA_MCP_SCOPES, "offline_access"],
        }],
        clientRegistrationDefaultResources: [audience],
        clientRegistrationAllowedResources: [audience],
        grantTypes: ["authorization_code", "refresh_token"],
        advertisedMetadata: {
          scopes_supported: [...SUPPORTED_OAUTH_SCOPES],
          token_endpoint_auth_methods_supported: ["none", ...CONFIDENTIAL_TOKEN_AUTH_METHODS],
        },
        clientRegistrationRequirePKCE: true,
      }),
    ],
  });
  const resourceClient = oauthProviderResourceClient(auth).getActions();

  return {
    auth,
    pool,
    issuer,
    audience,
    handler: auth.handler,
    authorizationServerMetadata: oauthProviderAuthServerMetadata(auth),
    openIdConfigMetadata: oauthProviderOpenIdConfigMetadata(auth),
    async getConsentContext(headers: Headers, oauthQuery: string): Promise<OAuthConsentContext> {
      const session = await auth.api.getSession({ headers });
      if (!session) throw new Error("An active Codexia login is required to consent");
      if (!await verifyOAuthQueryParams(oauthQuery, config.authSecret)) throw new Error("OAuth consent request signature is invalid or expired");
      const params = new URLSearchParams(oauthQuery);
      const clientId = signedQueryParam(params, "client_id");
      const scope = signedQueryParam(params, "scope");
      const requestedScopes = [...new Set(scope.split(/\s+/u).filter(Boolean))];
      const resourceValues = params.getAll("resource");
      if (resourceValues.length !== 1 || resourceValues[0] !== audience) throw new Error("OAuth consent request does not target the configured API resource");
      if (requestedScopes.some((value) => !(SUPPORTED_OAUTH_SCOPES as readonly string[]).includes(value))) throw new Error("OAuth consent request includes an unsupported scope");
      const publicClient = await auth.api.getOAuthClientPublicPrelogin({ headers, body: { client_id: clientId, oauth_query: oauthQuery } });
      const registeredClient = await auth.api.getOAuthClient({ headers, query: { client_id: clientId } });
      const clientScopes = new Set((registeredClient.scope ?? "").split(/\s+/u).filter(Boolean));
      if (!requestedScopes.every((value) => clientScopes.has(value))) throw new Error("OAuth consent request exceeds the registered client scope");
      const context = await auth.$context;
      const linkedResources = await context.adapter.findMany({ model: "oauthClientResource", where: [{ field: "clientId", value: clientId }] });
      if (!linkedResources.some((resource) => typeof resource === "object" && resource !== null && "resourceId" in resource && resource.resourceId === audience)) throw new Error("OAuth client is not linked to the requested API resource");
      return { client: { name: publicClient.client_name ?? "Unknown client" }, requestedScopes };
    },
    isOwnerClient(clientId: string): boolean {
      return config.ownerClientIds.includes(clientId);
    },
    mcpClientIds,
    isMcpClient(clientId: string): boolean {
      return mcpClientIds.includes(clientId);
    },
    async verifyActiveAccessToken(token: string): Promise<boolean> {
      try {
        await resourceClient.verifyBearerToken(token, {
          verifyOptions: { issuer, audience, algorithms: ["ES256"], typ: "at+jwt", requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id"] },
          remoteVerify: {
            force: true,
            introspectUrl: `${issuer}/oauth2/introspect`,
            clientId: config.oauthIntrospectionClientId,
            clientSecret: config.oauthIntrospectionClientSecret,
          },
        });
        return true;
      } catch (error) {
        const statusCode = typeof error === "object" && error !== null && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : undefined;
        const status = typeof error === "object" && error !== null && "status" in error
          ? String((error as { status: unknown }).status)
          : "";
        if (statusCode === 401 || status === "UNAUTHORIZED") return false;
        throw error;
      }
    },
    matchesIntrospectionClient(clientId: string, clientSecret: string): boolean {
      return clientId === config.oauthIntrospectionClientId && sameSecret(clientSecret, config.oauthIntrospectionClientSecret);
    },
  };
}
