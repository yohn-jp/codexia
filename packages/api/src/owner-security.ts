import { createHash } from "node:crypto";
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

interface OwnerSecurityPolicyOptions {
  readonly origin: string;
  readonly ownerId: string;
}

interface OwnerSecurityOptions extends OwnerSecurityPolicyOptions {
  readonly oauthClientIds: readonly string[];
  readonly legacyOidcConfigured: boolean;
  readonly revokeOAuthGrant: (input: {
    readonly clientId: string;
    readonly subject: string;
    readonly revokedAt: Date;
  }) => Promise<void>;
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
  readonly referenceId?: string | null;
  readonly resources?: string[] | null;
  readonly requestedUserInfoClaims?: string[] | null;
}

function reject(status: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT", code: string): never {
  throw new APIError(status, { code, message: code }, NO_STORE);
}

function isFresh(createdAt: Date): boolean {
  const age = Date.now() - new Date(createdAt).getTime();
  return age >= 0 && age < OWNER_FRESH_AGE_MS;
}

// The OAuth Provider may write the same timestamp to multiple distinct consent revisions.
function consentRevision(consent: OAuthConsent): string {
  return createHash("sha256").update(JSON.stringify([
    consent.id, consent.clientId, consent.scopes, consent.updatedAt.toISOString(),
    consent.referenceId ?? null, consent.resources ?? null, consent.requestedUserInfoClaims ?? null,
  ])).digest("base64url");
}

async function requireOwner(ctx: GenericEndpointContext, options: OwnerSecurityPolicyOptions, { write = false, fresh = false } = {}) {
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

/** Attach these maintained-path guards only to the normal owner runtime. */
export function ownerSecurityPolicy(options: OwnerSecurityPolicyOptions) {
  return {
    id: "codexia-owner-security",
    hooks: {
      before: [{
        matcher: (ctx: { path?: string }) => Boolean(ctx.path && protectedPaths.has(ctx.path)),
        handler: createAuthMiddleware(async (ctx) => {
          const path = ctx.path;
          const { user, session } = await requireOwner(ctx, options, {
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
  };
}

/** In-process evidence for scoped consent withdrawal pending admission to the HTTP contract. */
export function ownerSecurity(options: OwnerSecurityOptions) {
  const clientIds = new Set(options.oauthClientIds);
  return {
    ...ownerSecurityPolicy(options),
    endpoints: {
      ownerSecurityIdentity: createAuthEndpoint("/codexia/owner-security/identity", { method: "GET", requireHeaders: true }, async (ctx) => {
        const { user } = await requireOwner(ctx, options);
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
          consents: consents.filter(({ clientId }) => registered.has(clientId)).map((consent) => ({
            id: consent.id, clientId: consent.clientId, scopes: consent.scopes, updatedAt: consent.updatedAt,
            revision: consentRevision(consent),
          })),
        });
      }),
      ownerSecurityRevokeConsent: createAuthEndpoint("/codexia/owner-security/revoke-consent", {
        method: "POST",
        requireHeaders: true,
        body: z.strictObject({
          id: z.string().min(1), clientId: z.string().min(1), scopes: z.array(z.string().min(1)).min(1),
          revision: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        }),
      }, async (ctx) => {
        const { user } = await requireOwner(ctx, options, { write: true, fresh: true });
        const { id, clientId, scopes, revision } = ctx.body;
        if (!clientIds.has(clientId)) reject("NOT_FOUND", "OWNER_SECURITY_CONSENT_NOT_FOUND");
        const adapter = ctx.context.adapter;
        const where = [{ field: "id", value: id }, { field: "clientId", value: clientId }, { field: "userId", value: user.id }];
        const consent = await adapter.findOne<OAuthConsent>({ model: "oauthConsent", where });
        if (!consent) reject("NOT_FOUND", "OWNER_SECURITY_CONSENT_NOT_FOUND");
        const selectedScopes = new Set(scopes);
        if (selectedScopes.size !== scopes.length || consent.scopes.length !== scopes.length ||
            !consent.scopes.every((scope) => selectedScopes.has(scope)) || consentRevision(consent) !== revision) {
          reject("CONFLICT", "OWNER_SECURITY_CONSENT_CHANGED");
        }
        // Better Auth's PostgreSQL/Kysely schema stores string arrays in JSONB.
        // Its where-clause transformer does not serialize string[] values as its writer does.
        const storedArray = (value: string[] | null | undefined) => value == null ? null
          : adapter.id === "kysely" ? JSON.stringify(value) : value;
        const consentRevisionWhere = [
          ...where,
          { field: "updatedAt", value: consent.updatedAt },
          { field: "scopes", value: storedArray(consent.scopes) },
          { field: "referenceId", value: consent.referenceId ?? null },
          { field: "resources", value: storedArray(consent.resources) },
          { field: "requestedUserInfoClaims", value: storedArray(consent.requestedUserInfoClaims) },
        ];
        // Write the online JWT cutoff first. If any later write fails, access remains
        // denied rather than leaving a withdrawn grant usable through an old token.
        const revokedAt = new Date();
        await options.revokeOAuthGrant({ clientId, subject: user.id, revokedAt });
        await adapter.deleteMany({
          model: "oauthAccessToken",
          where: [
            { field: "clientId", value: clientId },
            { field: "userId", value: user.id },
          ],
        });
        const refreshWhere = [
          { field: "clientId", value: clientId },
          { field: "userId", value: user.id },
          { field: "revoked", operator: "eq" as const, value: null },
        ];
        await adapter.updateMany({ model: "oauthRefreshToken", where: refreshWhere, update: { revoked: revokedAt } });
        // A concurrent refresh can finish between the initial access-token
        // cleanup and refresh invalidation. Repeat both writes to catch rows it
        // committed while the family was being withdrawn.
        await adapter.deleteMany({
          model: "oauthAccessToken",
          where: [
            { field: "clientId", value: clientId },
            { field: "userId", value: user.id },
          ],
        });
        await adapter.updateMany({ model: "oauthRefreshToken", where: refreshWhere, update: { revoked: revokedAt } });

        const deleted = await adapter.deleteMany({
          model: "oauthConsent",
          where: consentRevisionWhere,
        });
        if (deleted !== 1) reject("CONFLICT", "OWNER_SECURITY_CONSENT_CHANGED");
        return ctx.json({ consentRemoved: true, grantRevoked: true });
      }),
    },
  };
}
