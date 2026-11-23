import type { GenericEndpointContext } from "@better-auth/core";
import { APIError, createAuthEndpoint, createAuthMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { z } from "zod";

const OWNER_FRESH_AGE_MS = 5 * 60 * 1000;
const NO_STORE = { "cache-control": "no-store" };
const protectedPaths = new Set([
  "/list-sessions", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions",
  "/passkey/list-user-passkeys", "/passkey/generate-register-options", "/passkey/verify-registration",
  "/passkey/update-passkey", "/passkey/delete-passkey",
]);
const freshPaths = new Set([
  "/revoke-other-sessions", "/passkey/generate-register-options", "/passkey/verify-registration",
  "/passkey/update-passkey", "/passkey/delete-passkey",
]);

interface OwnerSecurityOptions {
  readonly origin: string;
  readonly ownerId: string;
  readonly oauthClientIds: readonly string[];
  readonly legacyOidcConfigured: boolean;
}

interface OAuthClient {
  readonly clientId: string;
  readonly name?: string | null;
  readonly scopes?: string[] | null;
  readonly redirectUris: string[];
  readonly disabled?: boolean;
}

interface OAuthConsent {
  readonly id: string;
  readonly clientId: string;
  readonly scopes: string[];
  readonly updatedAt: Date;
}

function reject(status: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT", code: string): never {
  throw new APIError(status, { code, message: code }, NO_STORE);
}

function isFresh(createdAt: Date): boolean {
  const age = Date.now() - new Date(createdAt).getTime();
  return age >= 0 && age < OWNER_FRESH_AGE_MS;
}

/** Attach only to the normal author runtime. Setup and operator recovery own their separate ceremony admission. */
export function ownerSecurity(options: OwnerSecurityOptions) {
  const clientIds = new Set(options.oauthClientIds);

  async function requireOwner(ctx: GenericEndpointContext, { write = false, fresh = false } = {}) {
    ctx.setHeader("cache-control", "no-store");
    const origin = ctx.headers?.get("origin");
    const fetchSite = ctx.headers?.get("sec-fetch-site");
    if ((write && origin !== options.origin) || (origin && origin !== options.origin) ||
        (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
      reject("FORBIDDEN", "OWNER_SECURITY_ORIGIN_DENIED");
    }
    if (ctx.headers?.has("authorization")) reject("FORBIDDEN", "OWNER_SECURITY_COOKIE_REQUIRED");
    if (!ctx.headers?.has("cookie")) reject("UNAUTHORIZED", "OWNER_SECURITY_SESSION_REQUIRED");
    const result = await getAuthoritativeSessionFromCtx(ctx);
    if (!result) reject("UNAUTHORIZED", "OWNER_SECURITY_SESSION_REQUIRED");
    if (result.user.id !== options.ownerId) reject("FORBIDDEN", "OWNER_SECURITY_OWNER_REQUIRED");
    if (fresh && !isFresh(result.session.createdAt)) reject("FORBIDDEN", "OWNER_SECURITY_REAUTH_REQUIRED");
    return result;
  }

  return {
    id: "codexia-owner-security",
    hooks: {
      before: [{
        matcher: (ctx: { path?: string }) => Boolean(ctx.path && protectedPaths.has(ctx.path)),
        handler: createAuthMiddleware(async (ctx) => {
          const path = ctx.path;
          const { user, session } = await requireOwner(ctx, {
            write: ctx.method === "POST", fresh: Boolean(path && freshPaths.has(path)),
          });
          if (path === "/revoke-sessions") reject("FORBIDDEN", "OWNER_SECURITY_CURRENT_SESSION");
          if (path === "/revoke-session") {
            const token = ctx.body?.token;
            if (token === session.token) reject("FORBIDDEN", "OWNER_SECURITY_CURRENT_SESSION");
            const target = typeof token === "string" && await ctx.context.internalAdapter.findSession(token);
            if (!target || target.session.userId !== user.id) reject("NOT_FOUND", "OWNER_SECURITY_SESSION_NOT_FOUND");
          }
          // Keep the surrounding runtime deletion lock while adding this policy.
          if (path === "/passkey/delete-passkey" && await ctx.context.adapter.count({
            model: "passkey", where: [{ field: "userId", value: user.id }],
          }) <= 1) reject("FORBIDDEN", "OWNER_SECURITY_LAST_PASSKEY");
        }),
      }],
    },
    endpoints: {
      ownerSecurityIdentity: createAuthEndpoint("/codexia/owner-security/identity", { method: "GET", requireHeaders: true }, async (ctx) => {
        const { user } = await requireOwner(ctx);
        const adapter = ctx.context.adapter;
        const clients = clientIds.size === 0 ? [] : await adapter.findMany<OAuthClient>({
          model: "oauthClient", where: [{ field: "clientId", operator: "in", value: [...clientIds] }],
        });
        const consents = await adapter.findMany<OAuthConsent>({
          model: "oauthConsent", where: [{ field: "userId", value: user.id }],
        });
        const registered = new Set(clients.map(({ clientId }) => clientId));
        return ctx.json({
          provider: { status: options.legacyOidcConfigured ? "operator-configured-unverified" : "not-configured" },
          clients: clients.map(({ clientId, name, scopes, redirectUris, disabled }) =>
            ({ clientId, name: name ?? clientId, scopes: scopes ?? [], redirectUris, disabled: disabled === true })),
          consents: consents.filter(({ clientId }) => registered.has(clientId)).map(({ id, clientId, scopes, updatedAt }) =>
            ({ id, clientId, scopes, updatedAt })),
        });
      }),
      ownerSecurityRevokeConsent: createAuthEndpoint("/codexia/owner-security/revoke-consent", {
        method: "POST",
        requireHeaders: true,
        body: z.strictObject({ id: z.string().min(1), clientId: z.string().min(1), scopes: z.array(z.string().min(1)).min(1), updatedAt: z.iso.datetime() }),
      }, async (ctx) => {
        const { user } = await requireOwner(ctx, { write: true, fresh: true });
        const { id, clientId, scopes, updatedAt } = ctx.body;
        if (!clientIds.has(clientId)) reject("NOT_FOUND", "OWNER_SECURITY_CONSENT_NOT_FOUND");
        const adapter = ctx.context.adapter;
        const where = [{ field: "id", value: id }, { field: "clientId", value: clientId }, { field: "userId", value: user.id }];
        const consent = await adapter.findOne<OAuthConsent>({ model: "oauthConsent", where });
        if (!consent) reject("NOT_FOUND", "OWNER_SECURITY_CONSENT_NOT_FOUND");
        const selectedScopes = new Set(scopes);
        if (selectedScopes.size !== scopes.length || consent.scopes.length !== scopes.length ||
            !consent.scopes.every((scope) => selectedScopes.has(scope)) || consent.updatedAt.toISOString() !== updatedAt) {
          reject("CONFLICT", "OWNER_SECURITY_CONSENT_CHANGED");
        }
        const deleted = await adapter.deleteMany({
          model: "oauthConsent", where: [...where, { field: "updatedAt", value: consent.updatedAt }],
        });
        if (deleted !== 1) reject("CONFLICT", "OWNER_SECURITY_CONSENT_CHANGED");
        // This withdraws the persisted approval. The OAuth protocol owns already issued tokens.
        return ctx.json({ consentRemoved: true });
      }),
    },
  };
}
