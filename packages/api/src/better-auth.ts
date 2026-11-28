import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context';
import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
  verifyOAuthQueryParams,
} from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { passkey } from '@better-auth/passkey';
import { MCP_OAUTH_SCOPES } from '@codexia/contracts';
import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { fromNodeHeaders } from 'better-auth/node';
import { genericOAuth, jwt } from 'better-auth/plugins';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { Pool } from 'pg';
import { CODEXIA_AUTH_SCHEMA } from './auth-schema.js';
import {
  CODEXIA_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS,
  createJwtAccessTokenRevocationAdapter,
  recordOwnerOAuthGrantRevocation,
  type VerifiedJwtAccessToken,
} from './jwt-access-token-revocation.js';
import { CODEXIA_OWNER_SCOPE } from './oauth-owner.js';
import { ownerSecurity } from './owner-security.js';
import { consumeOwnerSetupGrant, ownerSetupSchema, ownerSetupTableExists, type SetupRegistration } from './owner-setup-store.js';

export { CODEXIA_OWNER_SCOPE };

export const CODEXIA_MCP_SCOPES = MCP_OAUTH_SCOPES;
export const OIDC_PROVIDER_ID = 'workspace-oidc';
export const CODEXIA_IOS_REDIRECT_URI = 'jp.yohn.codexia:/oauth2redirect';

export interface BetterAuthRuntimeConfig {
  readonly databaseUrl: string;
  /** Prevent plugin initialization from writing during deployment verification. */
  readonly readOnlyDatabase?: boolean;
  /** Set only for the offline migration on protected, fresh setup installations. */
  readonly installOwnerSetupSchema?: boolean;
  readonly publicOrigin: string;
  /** Explicit Passkey RP ID for an isolated setup listener on a production-host subdomain. */
  readonly passkeyRpId?: string;
  readonly oidcIssuer?: string;
  readonly oidcClientId?: string;
  readonly oidcClientSecret?: string;
  readonly authSecret: string;
  readonly oauthIntrospectionClientId: string;
  readonly oauthIntrospectionClientSecret: string;
  readonly ownerSubject?: string;
  readonly apiAudience?: string;
  readonly ownerClientIds: readonly string[];
  readonly mcpClientIds?: readonly string[];
  /** Present only in the isolated, operator-authorized first-owner bootstrap runtime. */
  readonly passkeyBootstrap?: {
    readonly ownerId: string;
    readonly ownerEmail: string;
    readonly ownerName: string;
  };
  readonly allowInsecureLoopbackForTests?: boolean;
}

export interface OAuthConsentContext {
  readonly client: { readonly name: string };
  readonly requestedScopes: readonly string[];
  /** Redirect URI from the authorization query verified with the server's signing key. */
  readonly redirectUri: string;
}

const BACKUP_OWNER_FRESH_AGE_MS = 5 * 60 * 1000;

export type OwnerSessionCheck = { readonly status: 200 } | { readonly status: 401 | 403 };

const SUPPORTED_OAUTH_SCOPES = ['openid', 'email', 'profile', 'offline_access', CODEXIA_OWNER_SCOPE, ...CODEXIA_MCP_SCOPES] as const;
const OWNER_PUBLIC_SCOPES = ['openid', 'email', 'profile', 'offline_access', CODEXIA_OWNER_SCOPE] as const;
const CONFIDENTIAL_TOKEN_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'private_key_jwt'] as const;

function codexiaAuthMethodsPlugin(oidcConfigured: boolean, ownerSetupEnabled: boolean) {
  return {
    id: 'codexia-auth-methods',
    schema: {
      ...(ownerSetupEnabled ? { ownerSetup: ownerSetupSchema } : {}),
      passkeyRecoveryAudit: {
        modelName: 'passkey_recovery_audit',
        fields: {
          ownerId: { type: 'string', required: true, fieldName: 'owner_id' },
          sessionsRevoked: { type: 'number', required: true, fieldName: 'sessions_revoked' },
          accessGrantsRevoked: { type: 'number', required: true, fieldName: 'access_grants_revoked' },
          refreshGrantsRevoked: { type: 'number', required: true, fieldName: 'refresh_grants_revoked' },
          recordedAt: { type: 'date', required: true, fieldName: 'recorded_at' },
          grantExpiresAt: { type: 'date', required: true, fieldName: 'grant_expires_at' },
        },
      },
    } as const,
    endpoints: {
      authMethods: createAuthEndpoint('/codexia/auth-methods', { method: 'GET' }, async ctx => {
        return ctx.json({ passkey: true, upstreamOidc: oidcConfigured });
      }),
    },
  };
}
function setupProvisioningSessionPlugin(provisioningOwner: () => string | undefined) {
  return {
    id: 'codexia-setup-provisioning',
    endpoints: {
      setupProvisioningSession: createAuthEndpoint(
        '/codexia/setup-internal-session',
        {
          method: 'POST',
          metadata: { SERVER_ONLY: true },
        },
        async ctx => {
          const ownerId = provisioningOwner();
          const user = ownerId && (await ctx.context.internalAdapter.findUserById(ownerId));
          if (!user) throw new Error('No enrolled setup owner is approved for client provisioning');
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new Error('Could not start the setup provisioning session');
          await setSessionCookie(ctx, { user, session });
          return ctx.json({ token: session.token });
        },
      ),
    },
  };
}

const PASSKEY_BOOTSTRAP_VERIFICATION_ID = 'codexia:first-owner-passkey:v1';
const PASSKEY_BOOTSTRAP_CONTEXT = 'codexia-first-owner-v1';
const PASSKEY_OWNER_RECOVERY_CONTEXT = 'codexia-owner-recovery-v1';
const PASSKEY_BOOTSTRAP_GRANT_TTL_MS = 10 * 60 * 1000;
const passkeyDeletionQueues = new Map<string, Promise<void>>();
const oauthGrantQueues = new Map<string, Promise<void>>();
// The sole normal API writer serializes provider grant changes and withdrawal.
// The login callbacks may resume authorization from the provider's after hook.
const oauthGrantMutationPaths = new Set([
  '/oauth2/authorize',
  '/oauth2/consent',
  '/oauth2/continue',
  '/oauth2/token',
  '/oauth2/revoke',
  '/codexia/owner-security/revoke-consent',
  '/callback/workspace-oidc',
  '/sso/callback/codexia-owner-oidc',
  '/passkey/verify-authentication',
  '/passkey/verify-registration',
  '/sign-in/social',
  '/sign-in/sso',
  '/sign-up/email',
]);

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function withAuthMutationLock<T>(queues: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  queues.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

export interface BetterAuthClientRegistry {
  getOwner(ownerSubject: string): Promise<unknown | null | undefined>;
  getClient(clientId: string): Promise<unknown | null | undefined>;
  getClientResources(clientId: string): Promise<readonly unknown[]>;
}

export interface BetterAuthClientRegistrationConfig {
  readonly audience: string;
  readonly ownerSubject: string;
  readonly ownerClientIds: readonly string[];
  readonly mcpClientIds?: readonly string[];
  readonly introspectionClientId: string;
  /** An exact callback allowlist for clients whose bootstrap contract is known. */
  readonly expectedRedirectUris?: Readonly<Record<string, readonly string[]>>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Verify the configured owner, MCP, and introspection clients against Better Auth's persisted registry. */
export async function assertBetterAuthClientRegistrations(
  config: BetterAuthClientRegistrationConfig,
  registry: BetterAuthClientRegistry,
): Promise<void> {
  if (
    !config.ownerSubject.trim() ||
    config.ownerSubject !== config.ownerSubject.trim() ||
    !(await registry.getOwner(config.ownerSubject))
  ) {
    throw new Error('Configured Better Auth owner subject is not registered');
  }
  const ownerClientIds = [...new Set(config.ownerClientIds)];
  const mcpClientIds = [...new Set(config.mcpClientIds ?? [])];
  if (
    ownerClientIds.length === 0 ||
    ownerClientIds.length !== config.ownerClientIds.length ||
    ownerClientIds.some(id => !id.trim() || id !== id.trim())
  ) {
    throw new Error('Better Auth owner client registration is required');
  }
  if (
    mcpClientIds.length !== (config.mcpClientIds ?? []).length ||
    mcpClientIds.some(id => !id.trim() || id !== id.trim()) ||
    !config.introspectionClientId.trim() ||
    config.introspectionClientId !== config.introspectionClientId.trim() ||
    ownerClientIds.some(id => mcpClientIds.includes(id)) ||
    [...ownerClientIds, ...mcpClientIds].includes(config.introspectionClientId)
  ) {
    throw new Error('Better Auth owner, MCP, and introspection client registrations must be disjoint');
  }

  const assertRegisteredRedirects = (clientId: string, client: Record<string, unknown>): void => {
    const expected = config.expectedRedirectUris?.[clientId];
    if (!expected) return;
    const actual = stringList(client.redirectUris);
    if (
      expected.length === 0 ||
      new Set(expected).size !== expected.length ||
      actual.length !== expected.length ||
      new Set(actual).size !== actual.length ||
      !expected.every(uri => actual.includes(uri))
    ) {
      throw new Error(`Registered Better Auth client ${clientId} has unexpected OAuth redirect URIs`);
    }
  };

  const assertLinkedToAudience = async (clientId: string): Promise<void> => {
    const resources = await registry.getClientResources(clientId);
    if (!resources.some(resource => asRecord(resource)?.resourceId === config.audience)) {
      throw new Error(`Registered Better Auth client ${clientId} is not linked to the configured API audience`);
    }
  };
  const assertPublicClient = async (clientId: string, requiredScopes: readonly string[], kind: 'owner' | 'MCP'): Promise<void> => {
    const client = asRecord(await registry.getClient(clientId));
    if (!client) throw new Error(`Registered Better Auth ${kind} client is missing: ${clientId}`);
    if (
      client.disabled !== false ||
      client.tokenEndpointAuthMethod !== 'none' ||
      !stringList(client.grantTypes).includes('authorization_code') ||
      !stringList(client.grantTypes).includes('refresh_token') ||
      !stringList(client.responseTypes).includes('code') ||
      client.requirePKCE !== true
    ) {
      throw new Error(`Registered Better Auth ${kind} client is disabled or does not require Authorization Code with PKCE: ${clientId}`);
    }
    const scopes = stringList(client.scopes);
    if (!requiredScopes.every(scope => scopes.includes(scope))) {
      throw new Error(`Registered Better Auth ${kind} client is missing required scopes: ${clientId}`);
    }
    const allowedScopes = kind === 'owner' ? OWNER_PUBLIC_SCOPES : ['openid', 'offline_access', ...CODEXIA_MCP_SCOPES];
    if (scopes.some(scope => !(allowedScopes as readonly string[]).includes(scope))) {
      throw new Error(`Registered Better Auth ${kind} client has an unsupported scope: ${clientId}`);
    }
    assertRegisteredRedirects(clientId, client);
    await assertLinkedToAudience(clientId);
  };

  for (const clientId of ownerClientIds) {
    await assertPublicClient(clientId, ['openid', CODEXIA_OWNER_SCOPE], 'owner');
  }
  for (const clientId of mcpClientIds) {
    await assertPublicClient(clientId, ['openid'], 'MCP');
    const client = asRecord(await registry.getClient(clientId));
    const scopes = stringList(client?.scopes);
    if (!scopes.some(scope => (CODEXIA_MCP_SCOPES as readonly string[]).includes(scope))) {
      throw new Error(`Registered Better Auth MCP client is missing a limited MCP scope: ${clientId}`);
    }
  }

  const introspectionClient = asRecord(await registry.getClient(config.introspectionClientId));
  if (!introspectionClient)
    throw new Error(`Registered Better Auth confidential introspection client is missing: ${config.introspectionClientId}`);
  if (
    introspectionClient.disabled !== false ||
    !(CONFIDENTIAL_TOKEN_AUTH_METHODS as readonly string[]).includes(String(introspectionClient.tokenEndpointAuthMethod)) ||
    typeof introspectionClient.clientSecret !== 'string' ||
    introspectionClient.clientSecret.length === 0
  ) {
    throw new Error(
      `Better Auth introspection ID must identify an enabled confidential registered client: ${config.introspectionClientId}`,
    );
  }
  assertRegisteredRedirects(config.introspectionClientId, introspectionClient);
  await assertLinkedToAudience(config.introspectionClientId);
}

/**
 * Better Auth 1.7.x only advertises public clients when dynamic registration or
 * client discovery is enabled. Codexia intentionally provisions clients through
 * the authenticated admin API instead, so keep public registration closed and
 * supplement the metadata with the public method the token endpoint accepts.
 */
export async function advertisePublicClientTokenAuth(metadata: Response): Promise<Response> {
  if (!metadata.ok) return metadata;
  const body: unknown = await metadata.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Better Auth returned invalid authorization-server metadata');
  }
  const record = body as Record<string, unknown>;
  const configured = Array.isArray(record.token_endpoint_auth_methods_supported)
    ? record.token_endpoint_auth_methods_supported.filter((value): value is string => typeof value === 'string')
    : [];
  const headers = new Headers(metadata.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(
    JSON.stringify({
      ...record,
      token_endpoint_auth_methods_supported: [...new Set(['none', ...configured])],
    }),
    { status: metadata.status, statusText: metadata.statusText, headers },
  );
}

function assertHttpsUrl(value: string, name: string, allowInsecureLoopbackForTests = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  const isTestLoopback =
    allowInsecureLoopbackForTests &&
    process.env.NODE_ENV === 'test' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === 'localhost') &&
    parsed.protocol === 'http:';
  if ((!isTestLoopback && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials, query, or fragment`);
  }
  return parsed;
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function signedQueryParam(params: URLSearchParams, name: string): string {
  const values = params.getAll(name);
  if (values.length !== 1 || !values[0]) throw new Error(`OAuth consent request has invalid ${name}`);
  return values[0];
}

interface BetterAuthBootstrapRegistration {
  readonly ownerOidcSubject?: string;
  readonly passkeyRecoveryOwnerId?: string;
  readonly ownerSetup?: () => SetupRegistration | undefined;
  readonly setupProvisioningOwner?: () => string | undefined;
  readonly nextClientId: () => string;
}

function passkeyOwnerRecoveryVerificationId(ownerId: string): string {
  return `codexia:owner-passkey-recovery:v1:${ownerId}`;
}

export function createBetterAuthRuntime(config: BetterAuthRuntimeConfig, bootstrap?: BetterAuthBootstrapRegistration) {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(config.databaseUrl);
  } catch {
    throw new Error('CODEXIA_AUTH_DATABASE_URL must be an absolute PostgreSQL URL without query or fragment');
  }
  if (!new Set(['postgres:', 'postgresql:']).has(databaseUrl.protocol) || !databaseUrl.hostname || databaseUrl.search || databaseUrl.hash) {
    throw new Error('CODEXIA_AUTH_DATABASE_URL must be an absolute PostgreSQL URL without query or fragment');
  }
  const publicOrigin = assertHttpsUrl(config.publicOrigin, 'CODEXIA_PUBLIC_ORIGIN', config.allowInsecureLoopbackForTests);
  if (publicOrigin.pathname !== '/') throw new Error('CODEXIA_PUBLIC_ORIGIN must be an origin without a path');
  const passkeyRpId = config.passkeyRpId ?? publicOrigin.hostname;
  if (publicOrigin.hostname !== passkeyRpId && !publicOrigin.hostname.endsWith(`.${passkeyRpId}`)) {
    throw new Error('Passkey RP ID must be the public auth hostname or its parent domain');
  }
  const issuer = new URL('/api/auth', publicOrigin).toString();
  const oidcValues = [config.oidcIssuer, config.oidcClientId, config.oidcClientSecret];
  if (oidcValues.some(Boolean) && oidcValues.some(value => !value)) {
    throw new Error('CODEXIA_OIDC_ISSUER, CODEXIA_OIDC_CLIENT_ID, and CODEXIA_OIDC_CLIENT_SECRET must be configured together');
  }
  const oidcIssuer = config.oidcIssuer
    ? assertHttpsUrl(config.oidcIssuer, 'CODEXIA_OIDC_ISSUER', config.allowInsecureLoopbackForTests).toString().replace(/\/$/u, '')
    : undefined;
  const audience = config.apiAudience ?? new URL('/api', publicOrigin).toString();
  assertHttpsUrl(audience, 'CODEXIA_API_AUDIENCE', config.allowInsecureLoopbackForTests);
  if (new URL(audience).pathname !== '/api') throw new Error('CODEXIA_API_AUDIENCE must identify the public API resource');
  if (
    !config.databaseUrl.trim() ||
    (config.oidcClientId !== undefined && !config.oidcClientId.trim()) ||
    (config.oidcClientSecret !== undefined && config.oidcClientSecret.length < 16) ||
    config.authSecret.length < 32 ||
    config.oauthIntrospectionClientId.trim() === '' ||
    config.oauthIntrospectionClientSecret.length < 16 ||
    config.ownerClientIds.length === 0 ||
    config.ownerClientIds.some(id => !id.trim())
  ) {
    throw new Error(
      'Better Auth requires PostgreSQL, complete optional OIDC credentials, a 32-character auth secret, a confidential introspection client, and owner client IDs',
    );
  }
  if (
    config.passkeyBootstrap &&
    (!config.passkeyBootstrap.ownerId.trim() ||
      !config.passkeyBootstrap.ownerEmail.trim() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(config.passkeyBootstrap.ownerEmail) ||
      !config.passkeyBootstrap.ownerName.trim())
  ) {
    throw new Error('Passkey owner bootstrap requires a stable owner ID, valid email, and display name');
  }
  const mcpClientIds = [...new Set((config.mcpClientIds ?? []).map(id => id.trim()).filter(Boolean))];
  if (mcpClientIds.some(id => config.ownerClientIds.includes(id))) {
    throw new Error('Owner and limited MCP OAuth client allowlists must be disjoint');
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    options: `-c search_path=${CODEXIA_AUTH_SCHEMA}${config.readOnlyDatabase ? ' -c default_transaction_read_only=on' : ''}`,
  });
  const approvedBootstrapOidcSubject = bootstrap?.ownerOidcSubject;
  const normalOwnerId = !bootstrap && !config.passkeyBootstrap && !config.readOnlyDatabase ? config.ownerSubject : undefined;
  const auth = betterAuth({
    database: pool,
    baseURL: issuer,
    secret: config.authSecret,
    disabledPaths: ['/oauth2/get-consent', '/oauth2/get-consents', '/oauth2/update-consent', '/oauth2/delete-consent'],
    account: { accountLinking: { enabled: false } },
    ...(bootstrap?.ownerSetup
      ? {
          logger: { disabled: true },
          advanced: { cookiePrefix: 'codexia-setup', defaultCookieAttributes: { sameSite: 'strict' } },
          session: { expiresIn: 10 * 60, disableSessionRefresh: true },
        }
      : {}),
    hooks: {
      before: createAuthMiddleware(async ctx => {
        // The normal owner runtime uses the policy plugin for these maintained operations.
        if (normalOwnerId) return;
        const path = ctx.path;
        if (path !== '/passkey/update-passkey' && path !== '/passkey/delete-passkey') return;
        if (config.passkeyBootstrap)
          return new Response('Passkey management is unavailable during first-owner enrollment', { status: 403 });
        const session = await getSessionFromCtx(ctx);
        if (!session || !config.ownerSubject || session.user.id !== config.ownerSubject) {
          return new Response('Passkey management is restricted to the configured owner', { status: 403 });
        }
        if (Date.now() - new Date(session.session.createdAt).getTime() >= 5 * 60 * 1000) {
          return new Response('Recent reauthentication is required for Passkey management', { status: 403 });
        }
        if (path === '/passkey/delete-passkey') {
          const passkeys = await ctx.context.adapter.findMany({ model: 'passkey', where: [{ field: 'userId', value: session.user.id }] });
          if (passkeys.length <= 1) {
            return new Response('The last Passkey cannot be removed', { status: 403 });
          }
        }
      }),
    },
    plugins: [
      codexiaAuthMethodsPlugin(Boolean(oidcIssuer), Boolean(bootstrap?.ownerSetup || config.installOwnerSetupSchema)),
      setupProvisioningSessionPlugin(() => bootstrap?.setupProvisioningOwner?.()),
      ...(normalOwnerId
        ? [
            ownerSecurity({
              origin: publicOrigin.origin,
              ownerId: normalOwnerId,
              oauthClientIds: config.ownerClientIds,
              legacyOidcConfigured: Boolean(oidcIssuer),
              revokeOAuthGrant: ({ clientId, subject, revokedAt }) =>
                recordOwnerOAuthGrantRevocation(pool, { issuer, clientId, subject, revokedAt }),
            }),
          ]
        : []),
      passkey({
        rpID: passkeyRpId,
        rpName: 'Codexia',
        origin: publicOrigin.origin,
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        ...(normalOwnerId
          ? {
              authentication: {
                async afterVerification({ ctx, clientData }) {
                  // The maintained ceremony verifies the assertion before this policy binds it to the established owner.
                  const credential = await ctx.context.adapter.findOne({
                    model: 'passkey',
                    where: [
                      { field: 'credentialID', value: clientData.id },
                      { field: 'userId', value: normalOwnerId },
                    ],
                  });
                  if (!credential) throw new APIError('UNAUTHORIZED', { code: 'OWNER_SECURITY_OWNER_REQUIRED' });
                },
              },
            }
          : {}),
        registration: {
          requireSession: !config.passkeyBootstrap && !bootstrap?.passkeyRecoveryOwnerId && !bootstrap?.ownerSetup,
          ...(bootstrap?.ownerSetup
            ? {
                async resolveUser({ context }) {
                  const registration = bootstrap.ownerSetup?.();
                  if (!registration || context !== registration.ceremonyContext) {
                    throw new Error('An authorized setup transaction is required');
                  }
                  return { id: registration.ownerId, name: registration.name, displayName: registration.name };
                },
              }
            : config.passkeyBootstrap
              ? {
                  async resolveUser({ ctx, context }) {
                    const suppliedToken = ctx.request?.headers.get('x-codexia-owner-enrollment') ?? '';
                    if (context !== PASSKEY_BOOTSTRAP_CONTEXT || !suppliedToken) {
                      throw new Error('An operator-granted owner enrollment is required');
                    }
                    const grant = await ctx.context.internalAdapter.findVerificationValue(PASSKEY_BOOTSTRAP_VERIFICATION_ID);
                    if (
                      !grant ||
                      grant.expiresAt.getTime() <= Date.now() ||
                      !constantTimeEqual(grant.value, createHash('sha256').update(suppliedToken).digest('hex'))
                    ) {
                      throw new Error('The owner enrollment grant is unavailable or expired');
                    }
                    return {
                      id: config.passkeyBootstrap!.ownerId,
                      name: config.passkeyBootstrap!.ownerName,
                      displayName: config.passkeyBootstrap!.ownerName,
                    };
                  },
                }
              : bootstrap?.passkeyRecoveryOwnerId
                ? {
                    async resolveUser({ ctx, context }) {
                      const ownerId = bootstrap.passkeyRecoveryOwnerId!;
                      const token = ctx.request?.headers.get('x-codexia-owner-recovery') ?? '';
                      if (context !== PASSKEY_OWNER_RECOVERY_CONTEXT || !token || ownerId !== config.ownerSubject) {
                        throw new Error('An operator-granted owner recovery is required');
                      }
                      const verificationId = passkeyOwnerRecoveryVerificationId(ownerId);
                      const grant = await ctx.context.internalAdapter.findVerificationValue(verificationId);
                      if (
                        !grant ||
                        grant.expiresAt.getTime() <= Date.now() ||
                        !constantTimeEqual(grant.value, createHash('sha256').update(token).digest('hex'))
                      ) {
                        throw new Error('The owner recovery grant is unavailable or expired');
                      }
                      const owner = await ctx.context.internalAdapter.findUserById(ownerId);
                      if (!owner) throw new Error('The configured owner is unavailable');
                      return { id: owner.id, name: owner.name, displayName: owner.name };
                    },
                  }
                : {}),
          async afterVerification({ ctx, user, context }) {
            if (bootstrap?.ownerSetup) {
              const registration = bootstrap.ownerSetup();
              if (
                !registration ||
                context !== registration.ceremonyContext ||
                user.id !== registration.ownerId ||
                ctx.body.createSession !== true
              ) {
                throw new Error('The verified ceremony does not match the authorized setup transaction');
              }
              // This adapter is the maintained Passkey plugin's PostgreSQL transaction.
              // A failed owner, credential, or session insertion rolls grant consumption back.
              await consumeOwnerSetupGrant(await getCurrentAdapter(ctx.context.adapter), registration);
              const owner = await ctx.context.internalAdapter.createUser(
                {
                  id: registration.ownerId,
                  name: registration.name,
                  email: registration.email,
                  emailVerified: false,
                },
                { method: 'passkey' },
              );
              if (owner.id !== registration.ownerId) throw new Error('The owner identity changed during registration');
              return;
            }
            if (config.passkeyBootstrap) {
              if (context !== PASSKEY_BOOTSTRAP_CONTEXT) throw new Error('Owner enrollment context is invalid');
              // The plugin accepts createSession=false, which skips its PostgreSQL transaction.
              // Refuse that request before claiming the one-time grant or creating the owner.
              if (ctx.body.createSession !== true || user.id !== config.passkeyBootstrap!.ownerId) {
                throw new Error('Owner enrollment requires an atomic session-creating registration');
              }
              const suppliedToken = ctx.request?.headers.get('x-codexia-owner-enrollment') ?? '';
              const grant = await ctx.context.internalAdapter.consumeVerificationValue(PASSKEY_BOOTSTRAP_VERIFICATION_ID);
              if (
                !grant ||
                grant.expiresAt.getTime() <= Date.now() ||
                !suppliedToken ||
                !constantTimeEqual(grant.value, createHash('sha256').update(suppliedToken).digest('hex'))
              ) {
                throw new Error('The owner enrollment grant was already used or expired');
              }
              if (await ownerSetupTableExists(pool)) {
                throw new Error('A first-owner setup deployment is already recorded');
              }
              const existingOwner = await ctx.context.internalAdapter.findUserById(user.id);
              const anyUser = await ctx.context.adapter.findMany({ model: 'user', limit: 1 });
              if (existingOwner || anyUser.length > 0)
                throw new Error('Owner enrollment is only available for an empty authentication database');
              const createdOwner = await ctx.context.internalAdapter.createUser(
                {
                  id: user.id,
                  name: config.passkeyBootstrap!.ownerName,
                  email: config.passkeyBootstrap!.ownerEmail,
                  emailVerified: false,
                },
                { method: 'passkey' },
              );
              if (createdOwner.id !== config.passkeyBootstrap!.ownerId) {
                throw new Error('The owner ID could not be preserved during Passkey enrollment');
              }
              return;
            }
            if (bootstrap?.passkeyRecoveryOwnerId) {
              const ownerId = bootstrap.passkeyRecoveryOwnerId;
              if (
                context !== PASSKEY_OWNER_RECOVERY_CONTEXT ||
                ctx.body.createSession !== true ||
                ownerId !== config.ownerSubject ||
                user.id !== ownerId
              ) {
                throw new Error('Owner recovery requires the configured owner and an atomic session-creating registration');
              }
              const token = ctx.request?.headers.get('x-codexia-owner-recovery') ?? '';
              const grant = await ctx.context.internalAdapter.consumeVerificationValue(passkeyOwnerRecoveryVerificationId(ownerId));
              if (!grant || !token || !constantTimeEqual(grant.value, createHash('sha256').update(token).digest('hex'))) {
                throw new Error('The owner recovery grant was already used or expired');
              }
              return { userId: ownerId };
            }
            const session = ctx.context.session;
            if (
              !session ||
              !config.ownerSubject ||
              user.id !== config.ownerSubject ||
              session.user.id !== config.ownerSubject ||
              Date.now() - new Date(session.session.createdAt).getTime() >= 5 * 60 * 1000
            ) {
              throw new Error('Passkey registration requires the configured owner and a fresh session');
            }
          },
        },
      }),
      ...(oidcIssuer
        ? [
            genericOAuth({
              config: [
                {
                  providerId: OIDC_PROVIDER_ID,
                  name: 'Workspace identity provider',
                  clientId: config.oidcClientId!,
                  clientSecret: config.oidcClientSecret!,
                  discoveryUrl: `${oidcIssuer}/.well-known/openid-configuration`,
                  requireIdTokenVerification: true,
                  ...(approvedBootstrapOidcSubject
                    ? {
                        accountSubject({ tokens }) {
                          // Better Auth verifies the signature, audience, expiry, and nonce before calling this resolver.
                          const claims = tokens.idToken && decodeJwt(tokens.idToken);
                          if (!claims || claims.iss !== config.oidcIssuer || claims.sub !== approvedBootstrapOidcSubject) {
                            throw new Error('OIDC identity is outside the approved bootstrap account');
                          }
                          return claims.sub;
                        },
                      }
                    : {}),
                  pkce: true,
                  scopes: ['openid', 'email', 'profile'],
                },
              ],
            }),
          ]
        : []),
      jwt({ disableSettingJwtHeader: true, jwks: { keyPairConfig: { alg: 'ES256' } } }),
      oauthProvider({
        loginPage: '/oauth/login',
        consentPage: '/oauth/consent',
        accessTokenExpiresIn: CODEXIA_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        requireOpenidScope: true,
        allowPublicClientPrelogin: true,
        scopes: [...SUPPORTED_OAUTH_SCOPES],
        resources: [
          {
            identifier: audience,
            name: 'Codexia API',
            accessTokenTtl: CODEXIA_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS,
            allowedScopes: [CODEXIA_OWNER_SCOPE, ...CODEXIA_MCP_SCOPES, 'offline_access'],
          },
        ],
        clientRegistrationDefaultResources: [audience],
        clientRegistrationAllowedResources: [audience],
        grantTypes: ['authorization_code', 'refresh_token'],
        advertisedMetadata: {
          scopes_supported: [...SUPPORTED_OAUTH_SCOPES],
          token_endpoint_auth_methods_supported: ['none', ...CONFIDENTIAL_TOKEN_AUTH_METHODS],
        },
        clientRegistrationRequirePKCE: true,
        ...(bootstrap
          ? {
              generateClientId: bootstrap.nextClientId,
              generateClientSecret: () => config.oauthIntrospectionClientSecret,
            }
          : {}),
      }),
    ],
  });
  const resourceClient = oauthProviderResourceClient(auth).getActions();
  const accessTokenRevocation = createJwtAccessTokenRevocationAdapter({
    issuer,
    audience,
    pool,
    async verifyToken(token): Promise<VerifiedJwtAccessToken> {
      const payload = await resourceClient.verifyBearerToken(token, {
        verifyOptions: {
          issuer,
          audience: [audience, `${issuer}/oauth2/userinfo`],
          algorithms: ['ES256'],
          requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id'],
        },
        jwksUrl: `${issuer}/jwks`,
      });
      if (
        typeof payload.iss !== 'string' ||
        typeof payload.sub !== 'string' ||
        typeof payload.exp !== 'number' ||
        typeof payload.iat !== 'number' ||
        typeof payload.jti !== 'string' ||
        typeof payload.client_id !== 'string'
      ) {
        throw new Error('Verified OAuth access token is missing a required revocation claim');
      }
      return { ...payload, typ: decodeProtectedHeader(token).typ } as VerifiedJwtAccessToken;
    },
  });

  return {
    auth,
    pool,
    async createPasskeyBootstrapGrant(): Promise<string> {
      if (!config.passkeyBootstrap) throw new Error('Passkey first-owner enrollment is not configured');
      const context = await auth.$context;
      const users = await context.adapter.findMany({ model: 'user', limit: 1 });
      if (await ownerSetupTableExists(pool)) throw new Error('A first-owner setup deployment is already recorded');
      if (users.length > 0) {
        throw new Error('Passkey first-owner enrollment requires an empty authentication database');
      }
      const existing = await context.internalAdapter.findVerificationValue(PASSKEY_BOOTSTRAP_VERIFICATION_ID);
      if (existing && existing.expiresAt.getTime() > Date.now()) {
        throw new Error('A first-owner Passkey enrollment grant is already active; wait for expiry before replacing it');
      }
      if (existing) {
        await context.internalAdapter.consumeVerificationValue(PASSKEY_BOOTSTRAP_VERIFICATION_ID);
      }
      const token = randomBytes(32).toString('base64url');
      const reserved = await context.internalAdapter.reserveVerificationValue({
        identifier: PASSKEY_BOOTSTRAP_VERIFICATION_ID,
        value: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + PASSKEY_BOOTSTRAP_GRANT_TTL_MS),
      });
      if (!reserved) throw new Error('Unable to reserve a single-use first-owner Passkey grant');
      return token;
    },
    async createPasskeyOwnerRecoveryGrant(): Promise<{
      token: string;
      ownerId: string;
      expiresInSeconds: number;
      recordedAt: Date;
      sessionsRevoked: number;
      accessGrantsRevoked: number;
      refreshGrantsRevoked: number;
    }> {
      const ownerId = config.ownerSubject;
      if (!ownerId || config.passkeyBootstrap) throw new Error('Recovery requires the configured existing owner');
      const context = await auth.$context;
      if (context.options.database !== pool) {
        throw new Error('Owner recovery requires the configured PostgreSQL database');
      }
      const token = randomBytes(32).toString('base64url');
      const verificationId = passkeyOwnerRecoveryVerificationId(ownerId);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + PASSKEY_BOOTSTRAP_GRANT_TTL_MS);
      let sessionsRevoked = 0;
      let accessGrantsRevoked = 0;
      let refreshGrantsRevoked = 0;

      await runWithTransaction(context.adapter, async () => {
        const adapter = await getCurrentAdapter(context.adapter);
        const owner = await adapter.findOne<{ id: string; updatedAt?: Date }>({
          model: 'user',
          where: [{ field: 'id', value: ownerId }],
        });
        if (!owner || owner.id !== ownerId) throw new Error('The configured owner does not exist');

        // Serialize operator grant issuance by taking a write lock on the configured owner row.
        if (
          (await adapter.updateMany({
            model: 'user',
            where: [{ field: 'id', value: ownerId }],
            update: { updatedAt: owner.updatedAt ?? now },
          })) !== 1
        )
          throw new Error('The configured owner could not be locked for recovery');

        const activeGrants = await adapter.count({
          model: 'verification',
          where: [
            { field: 'identifier', value: verificationId },
            { field: 'expiresAt', value: now, operator: 'gt' },
          ],
        });
        if (activeGrants > 0) {
          throw new Error('An owner recovery grant is already active; wait for expiry before requesting another');
        }

        // Better Auth's session-delete hook intentionally preserves offline_access refresh rows.
        // Recovery revokes all OAuth grants for this owner, including those rows, before deleting sessions.
        accessGrantsRevoked = await adapter.updateMany({
          model: 'oauthAccessToken',
          where: [
            { field: 'userId', value: ownerId },
            { field: 'revoked', value: null },
          ],
          update: { revoked: now },
        });
        refreshGrantsRevoked = await adapter.updateMany({
          model: 'oauthRefreshToken',
          where: [
            { field: 'userId', value: ownerId },
            { field: 'revoked', value: null },
          ],
          update: { revoked: now },
        });
        sessionsRevoked = await adapter.count({
          model: 'session',
          where: [{ field: 'userId', value: ownerId }],
        });
        await context.internalAdapter.deleteUserSessions(ownerId);
        await context.internalAdapter.deleteVerificationByIdentifier(verificationId);
        await context.internalAdapter.createVerificationValue({
          identifier: verificationId,
          value: createHash('sha256').update(token).digest('hex'),
          expiresAt,
        });
        await adapter.create({
          model: 'passkeyRecoveryAudit',
          data: {
            ownerId,
            sessionsRevoked,
            accessGrantsRevoked,
            refreshGrantsRevoked,
            recordedAt: now,
            grantExpiresAt: expiresAt,
          },
        });
      });

      return {
        token,
        ownerId,
        expiresInSeconds: PASSKEY_BOOTSTRAP_GRANT_TTL_MS / 1000,
        recordedAt: now,
        sessionsRevoked,
        accessGrantsRevoked,
        refreshGrantsRevoked,
      };
    },
    async assertRegisteredClients(
      ownerSubject = config.ownerSubject ?? '',
      expectedRedirectUris?: Readonly<Record<string, readonly string[]>>,
    ): Promise<void> {
      const context = await auth.$context;
      await assertBetterAuthClientRegistrations(
        {
          audience,
          ownerSubject,
          ownerClientIds: config.ownerClientIds,
          mcpClientIds,
          introspectionClientId: config.oauthIntrospectionClientId,
          expectedRedirectUris,
        },
        {
          async getOwner(ownerSubject) {
            return context.adapter.findOne({ model: 'user', where: [{ field: 'id', value: ownerSubject }] });
          },
          async getClient(clientId) {
            return context.adapter.findOne({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });
          },
          async getClientResources(clientId) {
            return context.adapter.findMany({ model: 'oauthClientResource', where: [{ field: 'clientId', value: clientId }] });
          },
        },
      );
    },
    async verifyIntrospectionCredentials(): Promise<void> {
      const result = await auth.api.oauth2Introspect({
        body: {
          token: randomBytes(32).toString('base64url'),
          client_id: config.oauthIntrospectionClientId,
          client_secret: config.oauthIntrospectionClientSecret,
        },
      });
      if (result.active !== false) throw new Error('Unable to verify Better Auth introspection credentials');
    },
    issuer,
    audience,
    toHeaders: fromNodeHeaders,
    advertisePublicClientTokenAuth,
    async handler(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith('/passkey/delete-passkey')) {
        const session = await auth.api.getSession({ headers: request.headers });
        if (session)
          return withAuthMutationLock(passkeyDeletionQueues, session.user.id, () => accessTokenRevocation.handle(request, auth.handler));
      }
      const relativePath = pathname.slice(new URL(issuer).pathname.length);
      if (normalOwnerId && oauthGrantMutationPaths.has(relativePath)) {
        return withAuthMutationLock(oauthGrantQueues, issuer, () => accessTokenRevocation.handle(request, auth.handler));
      }
      return accessTokenRevocation.handle(request, auth.handler);
    },
    authorizationServerMetadata: oauthProviderAuthServerMetadata(auth),
    openIdConfigMetadata: oauthProviderOpenIdConfigMetadata(auth),
    async listOwnerOAuthConsents(headers: Headers) {
      if (headers.has('authorization') || !headers.has('cookie')) return { status: 401 } as const;
      const session = await auth.api.getSession({ headers });
      if (!session) return { status: 401 } as const;
      if (!config.ownerSubject || session.user.id !== config.ownerSubject) return { status: 403 } as const;
      const context = await auth.$context;
      const consents = await context.adapter.findMany<{
        id: string;
        clientId: string;
        scopes: string[];
        createdAt?: Date;
        updatedAt?: Date;
      }>({ model: 'oauthConsent', where: [{ field: 'userId', value: session.user.id }] });
      return {
        status: 200,
        consents: consents.map(({ id, clientId, scopes, createdAt, updatedAt }) => ({ id, clientId, scopes, createdAt, updatedAt })),
      } as const;
    },
    /** Confirms only the configured owner session; never returns account or credential data. */
    async checkOwnerSession(headers: Headers, policy?: { write: boolean; fresh: boolean }): Promise<OwnerSessionCheck> {
      const origin = headers.get('origin');
      const fetchSite = headers.get('sec-fetch-site');
      if (
        headers.has('authorization') ||
        ((!policy || policy.write || origin !== null) && origin !== publicOrigin.origin) ||
        (policy && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')
      ) {
        return { status: 403 };
      }
      if (!headers.has('cookie')) return { status: 401 };
      const session = await auth.api.getSession({
        headers,
        ...(policy ? { query: { disableCookieCache: true } } : {}),
      });
      if (!session) return { status: 401 };
      const age = Date.now() - new Date(session.session.createdAt).getTime();
      if (
        !config.ownerSubject ||
        session.user.id !== config.ownerSubject ||
        (policy?.fresh && !(age >= 0 && age < BACKUP_OWNER_FRESH_AGE_MS))
      )
        return { status: 403 };
      return { status: 200 };
    },
    async getConsentContext(headers: Headers, oauthQuery: string): Promise<OAuthConsentContext> {
      const session = await auth.api.getSession({ headers });
      if (!session) throw new Error('An active Codexia login is required to consent');
      if (!(await verifyOAuthQueryParams(oauthQuery, config.authSecret)))
        throw new Error('OAuth consent request signature is invalid or expired');
      const params = new URLSearchParams(oauthQuery);
      const clientId = signedQueryParam(params, 'client_id');
      const redirectUri = signedQueryParam(params, 'redirect_uri');
      const scope = signedQueryParam(params, 'scope');
      const requestedScopes = [...new Set(scope.split(/\s+/u).filter(Boolean))];
      const resourceValues = params.getAll('resource');
      if (resourceValues.length !== 1 || resourceValues[0] !== audience)
        throw new Error('OAuth consent request does not target the configured API resource');
      if (requestedScopes.some(value => !(SUPPORTED_OAUTH_SCOPES as readonly string[]).includes(value)))
        throw new Error('OAuth consent request includes an unsupported scope');
      const publicClient = await auth.api.getOAuthClientPublicPrelogin({ headers, body: { client_id: clientId, oauth_query: oauthQuery } });
      const registeredClient = await auth.api.getOAuthClient({ headers, query: { client_id: clientId } });
      const clientScopes = new Set((registeredClient.scope ?? '').split(/\s+/u).filter(Boolean));
      if (!requestedScopes.every(value => clientScopes.has(value)))
        throw new Error('OAuth consent request exceeds the registered client scope');
      const context = await auth.$context;
      const linkedResources = await context.adapter.findMany({
        model: 'oauthClientResource',
        where: [{ field: 'clientId', value: clientId }],
      });
      if (
        !linkedResources.some(
          resource => typeof resource === 'object' && resource !== null && 'resourceId' in resource && resource.resourceId === audience,
        )
      )
        throw new Error('OAuth client is not linked to the requested API resource');
      return { client: { name: publicClient.client_name ?? 'Unknown client' }, requestedScopes, redirectUri };
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
        const payload = await resourceClient.verifyBearerToken(token, {
          verifyOptions: {
            issuer,
            audience,
            algorithms: ['ES256'],
            typ: 'at+jwt',
            requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id'],
          },
          remoteVerify: {
            force: true,
            introspectUrl: `${issuer}/oauth2/introspect`,
            clientId: config.oauthIntrospectionClientId,
            clientSecret: config.oauthIntrospectionClientSecret,
          },
        });
        if (typeof payload.iss !== 'string' || typeof payload.jti !== 'string') return false;
        return !(await accessTokenRevocation.isRevoked({
          issuer: payload.iss,
          jti: payload.jti,
          ...(typeof payload.client_id === 'string' ? { clientId: payload.client_id } : {}),
          ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}),
          ...(typeof payload.iat === 'number' ? { issuedAt: payload.iat } : {}),
        }));
      } catch (error) {
        const statusCode =
          typeof error === 'object' && error !== null && 'statusCode' in error
            ? Number((error as { statusCode: unknown }).statusCode)
            : undefined;
        const status =
          typeof error === 'object' && error !== null && 'status' in error ? String((error as { status: unknown }).status) : '';
        if (statusCode === 401 || status === 'UNAUTHORIZED') return false;
        throw error;
      }
    },
    matchesIntrospectionClient(clientId: string, clientSecret: string): boolean {
      return clientId === config.oauthIntrospectionClientId && sameSecret(clientSecret, config.oauthIntrospectionClientSecret);
    },
  };
}
