import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type ActionDescriptor,
  type ActionResult,
  assertProjectPath,
  type ChangeOperation,
  type ChangeProposal,
  CONTRACT_VERSION,
  createMcpProtectedResourceMetadataResponse,
  isModulePreservationArchivePath,
  isPrivatePublishingPath,
  isPublishingRecordKey,
  type ModuleAction,
  type ModuleActionContext,
  type ModuleId,
  type ModuleStatus,
  NLP_FEATURE_SETTINGS_KEY,
  type ProposalEvidence,
  type ProposalStatus,
  protectedResourceMetadataUrl,
  type RecentActivityInput,
  type SnapshotId,
  snapshotKey,
  type ValueSchema,
} from '@codexia/contracts';
import type {
  CoreStore,
  CreateHierarchyInput,
  HierarchyTarget,
  Project,
  ProposeManuscriptRestoreInput,
  ReorderHierarchyInput,
} from '@codexia/core';
import { isPersistedProposalWithinSizeLimit } from '@codexia/core/proposal-size';
import {
  type ChangeSetResult,
  type Persistence,
  PersistenceError,
  type ProjectId,
  type ProjectPageCursor,
} from '@codexia/persistence-contracts';
import {
  createPostgresPersistence,
  migratePostgresDatabase,
  type PostgresPersistence,
  verifyPostgresSchema,
} from '@codexia/persistence-postgres';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type HTTPMethods } from 'fastify';
import { resolveBetterAuthOidcSettings } from './auth-mode.js';
import { verifyAuthSchema } from './auth-schema.js';
import { type BackupConsoleOptions, loadBackupConsole, registerBackupConsole } from './backup-console-routes.js';
import type { createBetterAuthRuntime } from './better-auth.js';
import { readCodexiaEnvironment } from './environment.js';
import { EventStreams } from './event-streams.js';
import { httpContract, httpContractSchemaController } from './http-contract.js';
import { deriveModuleHttpRoutes, type FastifyHttpContributionRoute } from './http-contributions.js';
import {
  createOAuthMcpAuthenticator,
  OAUTH_MCP_SCOPE_BY_EFFECT,
  OAUTH_MCP_SCOPES,
  type OAuthMcpOptions,
  type OAuthMcpPrincipal,
  parseOAuthMcpProjectAssignments,
} from './oauth-mcp.js';
import { CODEXIA_OWNER_SCOPE, createOAuthOwnerAuthenticator, type OAuthOwnerOptions } from './oauth-owner.js';
import { OAuthAuthenticationError } from './oauth-token.js';

export {
  initializeFreshPostgresSchema,
  inspectFreshPostgresSchema,
  migratePostgresAdditiveSchema,
  packagedMigrationFingerprint,
  runPostgresAdditiveMigrations,
  verifyPostgresSchema,
} from '@codexia/persistence-postgres';

import {
  type ActionHostContext,
  type DomainJobActionExecutor,
  type ModuleLoader,
  ModuleRuntime,
  type ModuleRuntimeOptions,
  type WorkerJobLifecycleSnapshot,
} from '@codexia/module-runtime';
import { assertCurrentJobHistory, type JobEvent, JobHistoryError, JobHistoryStore } from './job-history-store.js';
import { createNativeKnowledgeActions } from './native-knowledge-actions.js';
import { handlePersistenceOperation } from './persistence-routes.js';
import { compareProjectPageKeys, decodeProjectPageCursor, encodeProjectPageCursor } from './project-pagination.js';
import { RecentActivityStore } from './recent-activity-store.js';

// The installed protocol handler owns these endpoints and their wire schemas.
const BETTER_AUTH_HTTP_ROUTES = [
  ['GET', '/api/auth/oauth2/authorize'],
  ['POST', '/api/auth/oauth2/authorize'],
  ['POST', '/api/auth/oauth2/token'],
  ['POST', '/api/auth/oauth2/revoke'],
  ['POST', '/api/auth/oauth2/introspect'],
  ['GET', '/api/auth/oauth2/userinfo'],
  ['POST', '/api/auth/oauth2/userinfo'],
  ['POST', '/api/auth/oauth2/consent'],
  ['POST', '/api/auth/oauth2/continue'],
  ['GET', '/api/auth/oauth2/end-session'],
  ['POST', '/api/auth/oauth2/end-session'],
  ['POST', '/api/auth/oauth2/register'],
  ['GET', '/api/auth/jwks'],
  ['GET', '/api/auth/get-session'],
  ['GET', '/api/auth/list-sessions'],
  ['POST', '/api/auth/revoke-session'],
  ['POST', '/api/auth/revoke-other-sessions'],
  ['POST', '/api/auth/revoke-sessions'],
  ['POST', '/api/auth/sign-out'],
  ['POST', '/api/auth/sign-in/sso'],
  ['POST', '/api/auth/sign-in/social'],
  ['GET', '/api/auth/callback/workspace-oidc'],
  ['POST', '/api/auth/sign-up/email'],
  ['GET', '/api/auth/sso/callback/codexia-owner-oidc'],
  ['GET', '/api/auth/passkey/generate-authenticate-options'],
  ['POST', '/api/auth/passkey/verify-authentication'],
  ['GET', '/api/auth/passkey/generate-register-options'],
  ['POST', '/api/auth/passkey/verify-registration'],
  ['GET', '/api/auth/passkey/list-user-passkeys'],
  ['POST', '/api/auth/passkey/update-passkey'],
  ['POST', '/api/auth/passkey/delete-passkey'],
  ['GET', '/api/auth/codexia/owner-security/identity'],
  ['POST', '/api/auth/codexia/owner-security/revoke-consent'],
] as const;

const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const POSTGRES_REVISION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_SCRATCH_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const API_DRAIN_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_DOMAIN_JOBS = 32;
const apiManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const standaloneIdentity =
  process.env.CODEXIA_STANDALONE_IDENTITY === '1'
    ? (JSON.parse(readFileSync('/app/update-identity.json', 'utf8')) as { version: string; apiEpoch: number })
    : undefined;
const API_VERSION = standaloneIdentity?.version ?? apiManifest.version;
if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(API_VERSION) ||
  (standaloneIdentity && (!Number.isSafeInteger(standaloneIdentity.apiEpoch) || standaloneIdentity.apiEpoch < 1))
) {
  throw new Error('Invalid API release identity');
}
const STYLE_NONCES = new WeakMap<IncomingMessage, string>();

function hasBase64AlphabetAndPadding(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const firstPadding = value.indexOf('=');
  const dataLength = firstPadding < 0 ? value.length : firstPadding;
  const paddingLength = value.length - dataLength;
  if (paddingLength > 2 || (paddingLength === 1 && dataLength % 4 !== 3) || (paddingLength === 2 && dataLength % 4 !== 2)) return false;
  for (let index = 0; index < dataLength; index++) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2b ||
        code === 0x2f
      )
    )
      return false;
  }
  for (let index = dataLength; index < value.length; index++) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

const PUBLIC_READER_MODULES = new Set(['story', 'diagnostics', 'nlp', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp']);
const SOURCE_DOMAIN_JOB_TYPES = new Set(['speaker-eval', 'speaker-retrain', 'aspect-review', 'zukan-proposal', 'summary-refresh']);

export interface ApiServerOptions {
  backupConsole?: BackupConsoleOptions;
  store: CoreStore;
  /** Sole durable manuscript authority. */
  persistence: Persistence;
  /** Set only by `start()` when it created the PostgreSQL pool itself. */
  closePersistenceOnShutdown?: boolean;
  /** Close the API-owned Better Auth PostgreSQL pool, never a caller-owned test/runtime pool. */
  closeBetterAuthOnShutdown?: boolean;
  /** Optional standalone API-audience OAuth access tokens for the configured owner. */
  oauthOwner?: OAuthOwnerOptions;
  /** Explicitly registered standalone MCP OAuth clients, always separate from owner admission. */
  oauthMcp?: OAuthMcpOptions;
  /** Better Auth is the standalone OIDC and OAuth provider when configured. */
  betterAuth?: ReturnType<typeof createBetterAuthRuntime>;
  /** Exact HTTPS browser origins allowed to call the API cross-origin with bearer tokens. */
  corsAllowedOrigins?: readonly string[];
  /** Defaults to `<cwd>/app/dist`. */
  staticDir?: string;
  /** Trust X-Forwarded-Proto when TLS terminates at a reverse proxy. */
  trustProxy?: boolean;
  /** A deployment-selected, metadata-first runtime. Omitted modules are never imported. */
  runtime?: ModuleRuntime;
  /** Trusted profile composition; loaders remain lazy until their module is activated. */
  runtimeOptions?: Omit<ModuleRuntimeOptions, 'cacheDirectory'> & { cacheDirectory?: string };
  /** Host-owned historical model usage, independent from Core's disposable cache. */
  usageDirectory?: string;
  profile?: string;
}

interface HttpFailure {
  status: number;
  code: string;
  message: string;
}

function httpFailure(status: number, code: string, message: string): HttpFailure {
  return { status, code, message };
}

function mcpChallenge(metadataUrl: string, requiredScope?: string): string {
  return `Bearer ${[
    ...(requiredScope ? ['error="insufficient_scope"'] : []),
    `resource_metadata="${metadataUrl}"`,
    `scope="${requiredScope ?? OAUTH_MCP_SCOPES.join(' ')}"`,
  ].join(', ')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

function requestProtocol(request: IncomingMessage, trustProxy: boolean): 'http:' | 'https:' {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-proto'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',', 1)[0]?.trim();
    if (first === 'https') return 'https:';
  }
  return (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted ? 'https:' : 'http:';
}

function sameOrigin(request: IncomingMessage, trustProxy: boolean): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    const target = new URL(`${requestProtocol(request, trustProxy)}//${host}`);
    return parsed.origin === target.origin && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

const CORS_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const VERSION_PATHS = ['/api/version', '/api/browser/version'];
const CORS_HEADERS = new Map([
  ['authorization', 'Authorization'],
  ['content-type', 'Content-Type'],
  ['idempotency-key', 'Idempotency-Key'],
  ['x-client-id', 'X-Client-Id'],
  ['x-codexia-recent-activity-order', 'X-Codexia-Recent-Activity-Order'],
  ['prefer', 'Prefer'],
]);
const MCP_CORS_HEADERS = new Map([
  ['mcp-protocol-version', 'MCP-Protocol-Version'],
  ['mcp-method', 'Mcp-Method'],
  ['mcp-name', 'Mcp-Name'],
]);

function normalizeCorsOrigins(origins: readonly string[] | undefined): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const origin of origins ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('CORS origins must be exact normalized HTTPS origins');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.origin !== origin ||
      parsed.hostname.includes('*') ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      normalized.has(origin)
    ) {
      throw new Error('CORS origins must be unique exact normalized HTTPS origins');
    }
    normalized.add(origin);
  }
  return normalized;
}

function vary(response: ServerResponse, value: string): void {
  const current = response.getHeader('Vary');
  const values = new Set(
    (Array.isArray(current) ? current.join(',') : String(current ?? ''))
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  );
  values.add(value);
  response.setHeader('Vary', [...values].join(', '));
}

function setSecurityHeaders(response: ServerResponse, styleNonce: string): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; style-src 'self' 'nonce-${styleNonce}'; style-src-attr 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  );
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function serializeParsedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw httpFailure(400, 'INVALID_JSON', 'Request body must be a JSON value');
  return serialized;
}

function isHttpFailure(error: unknown): error is HttpFailure {
  return isRecord(error) && typeof error.status === 'number' && typeof error.code === 'string' && typeof error.message === 'string';
}

function sendError(response: ServerResponse, error: unknown): void {
  if (isHttpFailure(error)) {
    sendJson(response, error.status, { error: error.message, code: error.code });
    return;
  }
  console.error('Unhandled Codexia API error', error);
  sendJson(response, 500, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
}

function isPostgresRevisionId(value: unknown): value is string {
  return typeof value === 'string' && POSTGRES_REVISION_ID.test(value);
}

function isPublicReaderPath(pathname: string): boolean {
  const parts = pathname.split('/');
  if (
    parts.length !== 5 ||
    parts[0] !== '' ||
    parts[1] !== 'r' ||
    !POSTGRES_REVISION_ID.test(parts[3] ?? '') ||
    !/^[A-Za-z0-9._~-]{1,128}$/u.test(parts[4] ?? '')
  )
    return false;
  let moduleId: string;
  try {
    moduleId = decodeURIComponent(parts[2] ?? '');
  } catch {
    return false;
  }
  return PUBLIC_READER_MODULES.has(moduleId);
}

function manifestAssetFile(value: unknown, extension: '.js' | '.css'): value is string {
  if (typeof value !== 'string' || extname(value).toLowerCase() !== extension) return false;
  if (value === (extension === '.js' ? 'main.js' : 'styles.css')) return true;
  return /^assets\/[A-Za-z0-9._-]{1,180}$/u.test(value);
}

async function staticAliasTarget(
  staticDir: string,
  ui: string | undefined,
  kind: 'script' | 'stylesheet',
  fallback: string,
): Promise<string> {
  const uiRoot = resolve(staticDir, ...(ui ? [ui] : []));
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(resolve(uiRoot, '.vite', 'manifest.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(staticDir, fallback);
    throw error;
  }
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (!isRecord(manifest) || !isRecord(manifest['index.html'])) return resolve(staticDir, fallback);
  const entry = manifest['index.html'];
  let candidate: unknown;
  if (kind === 'script') {
    candidate = entry.file;
  } else {
    candidate = Array.isArray(entry.css) ? entry.css.find(file => manifestAssetFile(file, '.css')) : undefined;
    if (!candidate && isRecord(manifest['style.css'])) candidate = manifest['style.css'].file;
  }
  const extension = kind === 'script' ? '.js' : '.css';
  if (!manifestAssetFile(candidate, extension)) return resolve(staticDir, fallback);
  return resolve(uiRoot, candidate);
}

function isContentHashedAssetPath(pathname: string): boolean {
  return (
    /^\/(?:desktop\/)?assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/u.test(pathname) ||
    /^\/oauth\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.(?:js|css|svg)$/u.test(pathname)
  );
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, staticDir: string, styleNonce: string): Promise<boolean> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = requestPath(request);
  const publicReaderPath = isPublicReaderPath(path);
  const files: Record<string, { filename: string; contentType: string }> = {
    '/': { filename: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/oauth/login': { filename: 'oauth/oauth-login.html', contentType: 'text/html; charset=utf-8' },
    '/oauth/consent': { filename: 'oauth/oauth-consent.html', contentType: 'text/html; charset=utf-8' },
    '/main.js': { filename: 'main.js', contentType: 'text/javascript; charset=utf-8' },
    '/api.js': { filename: 'api.js', contentType: 'text/javascript; charset=utf-8' },
    '/drafts.js': { filename: 'drafts.js', contentType: 'text/javascript; charset=utf-8' },
    '/styles.css': { filename: 'styles.css', contentType: 'text/css; charset=utf-8' },
  };
  const uiMatch = /^\/(desktop)(?:\/(.*))?$/u.exec(path);
  const ui = uiMatch?.[1];
  const uiPath = uiMatch?.[2] ?? '';
  const uiEntry =
    ui &&
    /^(?:(?:|library|writing|reading|inspection|review|tools|settings)\/?|projects\/(?!\.{1,2}(?:\/|$))[^/\\]+(?:\/scenes\/(?!\.{1,2}(?:\/|$))[^/\\]+)?\/?)$/u.test(
      uiPath,
    );
  let file = files[path] ?? (publicReaderPath ? files['/'] : undefined);
  if (uiEntry) file = { filename: `${ui}/index.html`, contentType: 'text/html; charset=utf-8' };
  if (ui && /^(?:main\.js|styles\.css)$/u.test(uiPath)) {
    file = {
      filename: `${ui}/${uiPath}`,
      contentType: uiPath.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
    };
  }
  const oauthAssetRequest = !ui && path.startsWith('/oauth/assets/');
  const assetPrefix = ui ? `/${ui}/assets/` : oauthAssetRequest ? '/oauth/assets/' : '/assets/';
  const staticAssetsDirectory = resolve(staticDir, ...(ui ? [ui] : oauthAssetRequest ? ['oauth'] : []), 'assets');
  if (!file && path.startsWith(assetPrefix)) {
    const name = path.slice(assetPrefix.length);
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') return false;
    const extension = extname(name).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.gif': 'image/gif',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.ico': 'image/x-icon',
    };
    if (!contentTypes[extension] || !/^[A-Za-z0-9._-]{1,180}$/u.test(name)) return false;
    file = { filename: resolve(staticAssetsDirectory, name), contentType: contentTypes[extension] };
  }
  if (!file) return false;
  try {
    if (file.filename === 'main.js' || (ui && file.filename === `${ui}/main.js`)) {
      file = { ...file, filename: await staticAliasTarget(staticDir, ui, 'script', file.filename) };
    } else if (file.filename === 'styles.css' || (ui && file.filename === `${ui}/styles.css`)) {
      file = { ...file, filename: await staticAliasTarget(staticDir, ui, 'stylesheet', file.filename) };
    }
    const target = file.filename.startsWith(sep) ? file.filename : resolve(staticDir, file.filename);
    const root = await realpath(staticDir);
    const assetsDirectory =
      path.startsWith(assetPrefix) || target.startsWith(`${staticAssetsDirectory}${sep}`) ? staticAssetsDirectory : undefined;
    if (path.startsWith('/oauth/') && (await lstat(resolve(staticDir, 'oauth'))).isSymbolicLink()) {
      sendJson(response, 404, { error: 'Page not found', code: 'NOT_FOUND' });
      return true;
    }
    if (ui && (await lstat(resolve(staticDir, ui))).isSymbolicLink()) {
      sendJson(response, 404, { error: 'Page not found', code: 'NOT_FOUND' });
      return true;
    }
    if (assetsDirectory && (await lstat(assetsDirectory)).isSymbolicLink()) {
      sendJson(response, 404, { error: 'Page not found', code: 'NOT_FOUND' });
      return true;
    }
    const originalStat = await lstat(target);
    if (!originalStat.isFile() || originalStat.isSymbolicLink()) {
      sendJson(response, 404, { error: 'Page not found', code: 'NOT_FOUND' });
      return true;
    }
    const resolvedTarget = await realpath(target);
    if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
      sendJson(response, 404, { error: 'Page not found', code: 'NOT_FOUND' });
      return true;
    }
    const original = await readFile(resolvedTarget);
    const content = file.contentType.startsWith('text/html')
      ? Buffer.from(original.toString('utf8').replaceAll('__CODEXIA_STYLE_NONCE__', styleNonce))
      : original;
    if (publicReaderPath) {
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }
    response.writeHead(200, {
      'Content-Type': file.contentType,
      'Content-Length': content.length,
      'Cache-Control': isContentHashedAssetPath(path) ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((path.startsWith(assetPrefix) || path.startsWith('/oauth/assets/')) && (code === 'ENOENT' || code === 'ENOTDIR')) {
      sendJson(response, 404, { error: 'Page not found', code: 'NOT_FOUND' });
    } else {
      sendJson(response, 503, { error: 'Writing application is not built', code: 'APP_NOT_BUILT' });
    }
  }
  return true;
}

function queryOf(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).searchParams;
}

function parseRecentActivityInput(value: unknown): RecentActivityInput {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['sceneId', 'sentenceOffset', 'pageIndex', 'deviceType']))) {
    throw httpFailure(400, 'INVALID_RECENT_ACTIVITY', 'Recent activity input is invalid');
  }
  if (
    typeof value.sceneId !== 'string' ||
    value.sceneId.length < 1 ||
    value.sceneId.length > 512 ||
    Array.from(value.sceneId).some(character => character < ' ' || character === '\x7f') ||
    (value.sentenceOffset !== null && !Number.isSafeInteger(value.sentenceOffset)) ||
    (value.deviceType !== 'desktop' && value.deviceType !== 'mobile') ||
    (value.pageIndex !== undefined &&
      value.pageIndex !== null &&
      (!Number.isSafeInteger(value.pageIndex) || (value.pageIndex as number) < 0))
  ) {
    throw httpFailure(400, 'INVALID_RECENT_ACTIVITY', 'Recent activity cursor fields are invalid');
  }
  return {
    sceneId: value.sceneId,
    sentenceOffset: value.sentenceOffset as number | null,
    ...(value.pageIndex === undefined ? {} : { pageIndex: value.pageIndex as number | null }),
    deviceType: value.deviceType,
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key));
}

function isVisibleProposal(status: ProposalStatus, canReviewPrivateChangeSets: boolean): boolean {
  return (
    canReviewPrivateChangeSets ||
    !status.proposal.operations.some(operation => operation.writes.some(({ path }) => isPrivatePublishingPath(path)))
  );
}

function optionalSnapshot(query: URLSearchParams, selectedProjectId?: string): { pinned?: SnapshotId } {
  if (query.has('view') || query.has('snapshot')) throw httpFailure(400, 'INVALID_SNAPSHOT', 'Use a PostgreSQL project version');
  const projectId = selectedProjectId ?? query.get('projectId');
  const version = query.get('projectVersion');
  if (version === null) return {};
  if (!projectId || !/^[1-9][0-9]*$/u.test(version) || !Number.isSafeInteger(Number(version)))
    throw httpFailure(400, 'INVALID_SNAPSHOT', 'A project ID and positive project version are required');
  return { pinned: { projectId, projectVersion: Number(version) } };
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/u.test(value)) throw httpFailure(400, 'INVALID_LIMIT', 'Limit must be a positive integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw httpFailure(400, 'INVALID_LIMIT', `Limit must be from ${min} to ${max}`);
  return parsed;
}

type CoreStoreApi = CoreStore;

type RuntimeHttpHost = ModuleRuntime & {
  metadata?: () => unknown;
  invokeHttp?: (id: string, contributionId: string, request: Request, host: ActionHostContext) => Promise<Response>;
};

type TrackedDomainAction = ActionDescriptor & { job: NonNullable<ActionDescriptor['job']> };
type DomainJobTracker = (
  descriptor: TrackedDomainAction,
  snapshot: SnapshotId,
  signal: AbortSignal,
  execute: DomainJobActionExecutor,
) => Promise<ActionResult>;

type ApiActionHost = Omit<ActionHostContext, 'propose'> & {
  actions?: readonly { module: ModuleId | 'core'; action: ModuleAction }[];
  linkedReader?: (repositoryId: string) => Promise<ModuleActionContext['reader']>;
  access?: 'owner' | 'public';
  trackDomainJob?: DomainJobTracker;
  propose(operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string, signal?: AbortSignal): Promise<ChangeProposal>;
};

function resolveUsageDirectory(usageDirectory?: string): string {
  const configured =
    usageDirectory ?? readCodexiaEnvironment('USAGE_DIR') ?? process.env.CODEXIA_BUILD_USAGE_DIR ?? resolveDataPath('host-history');
  if (!configured.trim()) throw new Error('Model usage history requires a non-empty usage directory');
  return resolve(configured);
}

function resolveDataPath(child: string): string {
  return resolve(readCodexiaEnvironment('DATA_DIR') ?? process.env.CODEXIA_BUILD_DATA_DIR ?? './data', child);
}

export function createServer(options: ApiServerOptions): Server {
  if (!options.persistence) throw new Error('PostgreSQL persistence is required for Codexia authoring');
  if (!options.betterAuth) throw new Error('Standalone authentication requires Better Auth');
  const authenticateOAuthOwner = options.oauthOwner ? createOAuthOwnerAuthenticator(options.oauthOwner) : undefined;
  const authenticateOAuthMcp = options.oauthMcp ? createOAuthMcpAuthenticator(options.oauthMcp) : undefined;
  const publicBetterAuth =
    options.betterAuth?.audience?.startsWith('https://') && options.betterAuth.issuer?.startsWith('https://')
      ? options.betterAuth
      : undefined;
  const oauthResource = options.oauthMcp?.audience ?? publicBetterAuth?.audience;
  const oauthAuthorizationServer = options.oauthMcp?.issuer ?? publicBetterAuth?.issuer;
  const oauthMcpMetadataUrl = oauthResource ? protectedResourceMetadataUrl(oauthResource) : undefined;
  const oauthMcpMetadata =
    oauthResource && oauthAuthorizationServer ? { resource: oauthResource, authorizationServer: oauthAuthorizationServer } : undefined;
  const corsAllowedOrigins = normalizeCorsOrigins(options.corsAllowedOrigins);
  const staticDir = options.staticDir ?? resolve(process.cwd(), 'app/dist');
  const trustProxy = options.trustProxy ?? false;
  const usageDirectory = resolveUsageDirectory(options.usageDirectory);
  const jobHistory = new JobHistoryStore(usageDirectory);
  const recentActivity = new RecentActivityStore(usageDirectory);
  const requestControllers = new Set<AbortController>();
  const asyncDomainJobControllers = new Set<AbortController>();
  const activeDomainJobIds = new Set<string>();
  const projectEventStreams = new EventStreams();
  const jobEventStreams = new EventStreams();
  const coreStore = options.store as CoreStoreApi;
  const listVisibleProjectsPage = async (limit: number, cursor?: ProjectPageCursor, assignedIds?: readonly string[]) => {
    if (!assignedIds) return options.store.listProjectsPage(limit, cursor);

    const eligible = await options.persistence.read(async reader => {
      const projects: Project[] = [];
      for (const id of assignedIds) {
        const project = await reader.getProject(id as ProjectId);
        if (project?.id === id && (!cursor || compareProjectPageKeys(project, cursor) > 0)) projects.push(project);
      }
      return projects;
    });
    eligible.sort(compareProjectPageKeys);
    const projects = eligible.slice(0, limit);
    const last = projects.at(-1);
    return { projects, nextCursor: eligible.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null };
  };
  const assertAssignedProject = (projectId: string, allowedProjectIds?: readonly string[]): void => {
    if (allowedProjectIds && !allowedProjectIds.includes(projectId)) {
      throw httpFailure(404, 'PROJECT_NOT_FOUND', 'Project was not found');
    }
  };
  const findAuthorizedProject = async (projectId: string, allowedProjectIds?: readonly string[]): Promise<Project | undefined> => {
    assertAssignedProject(projectId, allowedProjectIds);
    const project = await options.persistence.read(reader =>
      reader.getProject(projectId as import('@codexia/persistence-contracts').ProjectId),
    );
    return project?.id === projectId ? project : undefined;
  };
  const capabilityProviders = options.runtimeOptions?.capabilityProviders ?? {};
  const hostCapabilities = options.runtimeOptions?.hostCapabilities ?? Object.keys(capabilityProviders);
  const runtime: RuntimeHttpHost =
    options.runtime ??
    new ModuleRuntime({
      manifests: options.runtimeOptions?.manifests ?? [],
      enabled: options.runtimeOptions?.enabled ?? [],
      ...(options.runtimeOptions ?? {}),
      hostCapabilities,
      capabilityProviders,
      cacheDirectory:
        options.runtimeOptions?.cacheDirectory ?? readCodexiaEnvironment('MODULE_CACHE_DIR') ?? resolveDataPath('module-cache'),
    });
  const profile = options.profile ?? readCodexiaEnvironment('PROFILE') ?? process.env.CODEXIA_BUILD_PROFILE ?? 'core';
  if (profile === 'full' && !options.runtime && !options.runtimeOptions) {
    throw new Error('The full profile requires trusted runtime manifests and lazy loaders');
  }
  const app: FastifyInstance = Fastify({
    logger: false,
    trustProxy,
    exposeHeadRoutes: false,
    bodyLimit: MAX_JSON_BYTES,
    schemaController: httpContractSchemaController,
  });
  let unsubscribeJobLifecycle = (): void => undefined;
  let shuttingDown = false;
  let activeRequests = 0;
  let started = false;
  let closed = false;
  let runtimeShutdownPromise: Promise<void> | undefined;
  const publishJobEvent = (event: JobEvent): void => {
    jobEventStreams.publish(`data: ${JSON.stringify(event)}\n\n`);
  };
  const shutdownRuntime = (): Promise<void> => {
    runtimeShutdownPromise ??= Promise.resolve()
      .then(() => {
        for (const controller of asyncDomainJobControllers) controller.abort(new Error('The API server is shutting down'));
        return runtime.shutdown();
      })
      .finally(async () => {
        unsubscribeJobLifecycle();
        await jobHistory.flush();
      });
    return runtimeShutdownPromise;
  };

  unsubscribeJobLifecycle = runtime.subscribeJobLifecycle(async (lifecycle: WorkerJobLifecycleSnapshot) => {
    try {
      publishJobEvent(await jobHistory.record(lifecycle));
    } catch (error) {
      const code = error instanceof JobHistoryError ? error.code : 'storage_failure';
      console.error(`Codexia worker lifecycle history was not retained (${code}).`);
    }
  });

  app.addHook('onRequest', (request, reply, done) => {
    const nonce = randomBytes(18).toString('base64');
    STYLE_NONCES.set(request.raw, nonce);
    setSecurityHeaders(reply.raw, nonce);
    activeRequests++;
    reply.raw.once('close', () => {
      activeRequests--;
    });
    done();
  });
  app.setErrorHandler((error: Error & { statusCode?: number; validationContext?: string; code?: string }, _request, reply) => {
    // Admission and non-MCP errors keep ApiError. Only authenticated MCP
    // POSTs that reached the JSON parser get the JSON-RPC parse error.
    const route = _request.routeOptions.url;
    const mcpPost = _request.method === 'POST' && (route === '/mcp' || route === '/api/projects/:projectId/modules/mcp/streamable');
    if (
      mcpPost &&
      routeContexts.has(_request) &&
      error.statusCode === 400 &&
      !error.validationContext &&
      (error instanceof SyntaxError || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY')
    ) {
      void reply
        .code(400)
        .type('application/json; charset=utf-8')
        .send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    let failure: HttpFailure;
    if (isHttpFailure(error)) failure = error;
    else if (error instanceof PersistenceError && error.code === 'unavailable')
      failure = httpFailure(503, 'PERSISTENCE_UNAVAILABLE', error.message);
    else if (error.statusCode === 413) failure = httpFailure(413, 'BODY_TOO_LARGE', 'Request body is too large');
    else if (error.statusCode === 415) failure = httpFailure(415, 'JSON_REQUIRED', 'Send a JSON request body');
    else if (error.validationContext) {
      const code =
        error.validationContext === 'querystring' &&
        _request.routeOptions.url === '/api/projects/:projectId/snapshot' &&
        error.message.includes('/projection')
          ? 'INVALID_PROJECTION'
          : error.validationContext === 'querystring' && queryOf(_request.raw).has('view')
            ? 'INVALID_SNAPSHOT'
            : error.validationContext === 'querystring'
              ? 'INVALID_QUERY'
              : error.validationContext === 'params'
                ? 'INVALID_ID'
                : 'INVALID_BODY';
      failure = httpFailure(400, code, 'Request does not match the HTTP contract');
    } else if (error.statusCode === 400) failure = httpFailure(400, 'INVALID_JSON', 'Request body must be valid JSON');
    else {
      console.error('Unhandled Codexia API error', error);
      failure = httpFailure(500, 'INTERNAL_ERROR', 'Internal server error');
    }
    void reply.code(failure.status).send({ error: failure.message, code: failure.code });
  });
  app.addHook('onClose', async () => {
    try {
      if (!closed) await shutdownRuntime();
    } finally {
      try {
        if (options.closeBetterAuthOnShutdown) await options.betterAuth?.pool.end();
      } finally {
        if (options.closePersistenceOnShutdown) await options.persistence?.close();
      }
    }
  });

  const abortSignalFor = (request: IncomingMessage, response: ServerResponse): AbortSignal => {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('HTTP request was cancelled'));
    if (request.aborted || response.destroyed) {
      abort();
      return controller.signal;
    }
    requestControllers.add(controller);
    const cleanup = () => requestControllers.delete(controller);
    request.once('aborted', () => {
      abort();
      cleanup();
    });
    response.once('close', () => {
      if (!response.writableEnded) abort();
      cleanup();
    });
    response.once('finish', cleanup);
    return controller.signal;
  };
  const freshReader = async (projectId: string, pinned?: SnapshotId) => options.store.reader(projectId, pinned);
  const searchSnapshot = async (projectId: string, term: string, limit: number, selected: ReturnType<typeof optionalSnapshot>) => {
    if (!coreStore.searchSnapshot) throw httpFailure(503, 'SEARCH_UNAVAILABLE', 'Snapshot search is not available in this Core version');
    const result = await coreStore.searchSnapshot(projectId, term, limit, selected.pinned);
    return { snapshot: result.snapshot, query: term, results: result.results };
  };
  const writingStatsSnapshot = async (projectId: string, selected: ReturnType<typeof optionalSnapshot>) => {
    if (!coreStore.writingStatsSnapshot)
      throw httpFailure(503, 'WRITING_STATS_UNAVAILABLE', 'Snapshot writing statistics are not available in this Core version');
    return coreStore.writingStatsSnapshot(projectId, selected.pinned);
  };
  const buildCoreActions = (
    projectId: string,
    source: ChangeProposal['source'],
    actorId: string,
    authorizeProposal?: () => Promise<void>,
    allowedProjectIds?: readonly string[],
    resolveNativeProposalActor?: () => Promise<string>,
    canReviewPrivateChangeSets = false,
  ): Array<{ module: 'core'; action: ModuleAction }> => {
    const jsonSchema: ValueSchema = {
      parse(value: unknown): unknown {
        let encoded: string;
        try {
          encoded = JSON.stringify(value);
        } catch {
          throw new Error('Core result is not JSON serializable');
        }
        if (Buffer.byteLength(encoded ?? '', 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('Core result exceeds the allowed size');
        return value;
      },
    };
    const emptyInput: ValueSchema = {
      parse(value: unknown) {
        if (value === undefined) return {};
        if (!isRecord(value) || Object.keys(value).length !== 0) throw new Error('This action accepts an empty object');
        return {};
      },
    };
    const proposalInput: ValueSchema = {
      parse(value: unknown) {
        if (!isRecord(value) || typeof value.proposalId !== 'string' || value.proposalId.length < 1 || value.proposalId.length > 128)
          throw new Error('proposalId is required');
        return { proposalId: value.proposalId };
      },
    };
    const sceneInput: ValueSchema = {
      parse(value: unknown) {
        if (!isRecord(value) || typeof value.sceneId !== 'string' || value.sceneId.length < 1 || value.sceneId.length > 256)
          throw new Error('sceneId is required');
        return { sceneId: value.sceneId };
      },
    };
    const manuscriptSnapshotsInput: ValueSchema = {
      parse(value: unknown) {
        if (
          !isRecord(value) ||
          typeof value.manuscriptId !== 'string' ||
          !value.manuscriptId ||
          value.manuscriptId.length > 256 ||
          (value.sceneId !== undefined && (typeof value.sceneId !== 'string' || !value.sceneId || value.sceneId.length > 256))
        ) {
          throw new Error('manuscriptId and an optional sceneId are required');
        }
        return { manuscriptId: value.manuscriptId, ...(typeof value.sceneId === 'string' ? { sceneId: value.sceneId } : {}) };
      },
    };
    const manuscriptSnapshotInput: ValueSchema = {
      parse(value: unknown) {
        if (
          !isRecord(value) ||
          typeof value.manuscriptId !== 'string' ||
          !value.manuscriptId ||
          value.manuscriptId.length > 256 ||
          !isPostgresRevisionId(value.snapshotId)
        ) {
          throw new Error('manuscriptId and a canonical PostgreSQL revision ID are required');
        }
        return { manuscriptId: value.manuscriptId, snapshotId: value.snapshotId };
      },
    };
    const searchInput: ValueSchema = {
      parse(value: unknown) {
        if (!isRecord(value) || typeof value.query !== 'string' || !value.query.trim() || value.query.length > 512)
          throw new Error('query must contain 1 to 512 characters');
        const limit = value.limit === undefined ? 20 : value.limit;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new Error('limit must be an integer from 1 to 100');
        return { query: value.query, limit };
      },
    };
    const hierarchyCreateInput: ValueSchema = {
      parse(value: unknown) {
        if (
          !isRecord(value) ||
          typeof value.kind !== 'string' ||
          !['volume', 'chapter', 'scene'].includes(value.kind) ||
          typeof value.id !== 'string' ||
          typeof value.title !== 'string'
        )
          throw new Error('kind, id, and title are required for hierarchy creation');
        const { idempotencyKey } = value;
        if ('proposalId' in value || typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) {
          throw new Error('A native hierarchy creation requires an idempotencyKey of 1 to 200 characters');
        }
        if (value.kind === 'volume') return { kind: value.kind, id: value.id, title: value.title, idempotencyKey };
        if (typeof value.volumeId !== 'string') throw new Error('volumeId is required for chapter or scene creation');
        if (value.kind === 'chapter')
          return { kind: value.kind, id: value.id, title: value.title, volumeId: value.volumeId, idempotencyKey };
        if (typeof value.chapterId !== 'string' || (value.manuscriptBody !== undefined && typeof value.manuscriptBody !== 'string')) {
          throw new Error('chapterId and an optional string manuscriptBody are required for scene creation');
        }
        return {
          kind: value.kind,
          id: value.id,
          title: value.title,
          volumeId: value.volumeId,
          chapterId: value.chapterId,
          ...(typeof value.manuscriptBody === 'string' ? { manuscriptBody: value.manuscriptBody } : {}),
          idempotencyKey,
        };
      },
    };
    const hierarchyDeleteInput: ValueSchema = {
      parse(value: unknown) {
        if (
          !isRecord(value) ||
          !isRecord(value.target) ||
          typeof value.target.kind !== 'string' ||
          !['volume', 'chapter', 'scene'].includes(value.target.kind) ||
          typeof value.target.id !== 'string'
        ) {
          throw new Error('A volume, chapter, or scene target is required for hierarchy deletion');
        }
        const { idempotencyKey } = value;
        if ('proposalId' in value || typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) {
          throw new Error('A native hierarchy deletion requires an idempotencyKey of 1 to 200 characters');
        }
        if (value.target.kind === 'volume') return { target: { kind: value.target.kind, id: value.target.id }, idempotencyKey };
        if (typeof value.target.volumeId !== 'string') throw new Error('volumeId is required for chapter or scene deletion');
        if (value.target.kind === 'chapter')
          return { target: { kind: value.target.kind, id: value.target.id, volumeId: value.target.volumeId }, idempotencyKey };
        if (typeof value.target.chapterId !== 'string') throw new Error('chapterId is required for scene deletion');
        return {
          target: { kind: value.target.kind, id: value.target.id, volumeId: value.target.volumeId, chapterId: value.target.chapterId },
          idempotencyKey,
        };
      },
    };
    const hierarchyReorderInput: ValueSchema = {
      parse(value: unknown) {
        if (
          !isRecord(value) ||
          typeof value.kind !== 'string' ||
          !['volume', 'chapter', 'scene'].includes(value.kind) ||
          !Array.isArray(value.orderedIds) ||
          !value.orderedIds.every(id => typeof id === 'string')
        ) {
          throw new Error('kind and an ordered sibling ID list are required for hierarchy reorder');
        }
        const { idempotencyKey } = value;
        if (value.proposalId !== undefined || typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) {
          throw new Error('A native hierarchy reorder requires an idempotencyKey of 1 to 200 characters');
        }
        if (value.kind === 'volume') return { kind: value.kind, orderedIds: value.orderedIds, idempotencyKey };
        if (typeof value.volumeId !== 'string') throw new Error('volumeId is required for chapter or scene reorder');
        if (value.kind === 'chapter') return { kind: value.kind, volumeId: value.volumeId, orderedIds: value.orderedIds, idempotencyKey };
        if (typeof value.chapterId !== 'string') throw new Error('chapterId is required for scene reorder');
        return { kind: value.kind, volumeId: value.volumeId, chapterId: value.chapterId, orderedIds: value.orderedIds, idempotencyKey };
      },
    };
    const restoreInput: ValueSchema = {
      parse(value: unknown) {
        if (
          !isRecord(value) ||
          !isPostgresRevisionId(value.documentId) ||
          !isPostgresRevisionId(value.baseRevisionId) ||
          !isPostgresRevisionId(value.sourceRevisionId)
        ) {
          throw new Error('documentId, baseRevisionId and sourceRevisionId must be canonical PostgreSQL IDs');
        }
        const { idempotencyKey } = value;
        if (
          typeof idempotencyKey !== 'string' ||
          !idempotencyKey.trim() ||
          idempotencyKey.length > 200 ||
          'proposalId' in value ||
          'sceneId' in value ||
          'snapshotId' in value
        ) {
          throw new Error('A native restore requires an idempotencyKey of 1 to 200 characters and canonical revision fields');
        }
        return {
          documentId: value.documentId,
          baseRevisionId: value.baseRevisionId,
          sourceRevisionId: value.sourceRevisionId,
          idempotencyKey,
        };
      },
    };
    const search = async (reader: Awaited<ReturnType<typeof freshReader>>, term: string, limit: number) => {
      if (!coreStore.searchSnapshot) throw httpFailure(503, 'SEARCH_UNAVAILABLE', 'Snapshot search is not available in this Core version');
      const result = await coreStore.searchSnapshot(projectId, term, limit, reader.snapshot);
      return { query: term, results: result.results };
    };
    const make = (
      id: string,
      inputSchema: ValueSchema,
      read: (context: ModuleActionContext, input: unknown) => Promise<unknown>,
    ): ModuleAction => ({
      id,
      effect: 'read',
      inputSchema,
      outputSchema: jsonSchema,
      async invoke(input, context) {
        try {
          const before = await options.store.observe(projectId);
          if (context.signal.aborted)
            return {
              ok: false,
              snapshot: context.reader.snapshot,
              error: { code: 'action_cancelled', message: 'Action was cancelled', retryable: false },
            };
          if (snapshotKey(before.snapshot) !== snapshotKey(context.reader.snapshot)) {
            return {
              ok: false,
              snapshot: context.reader.snapshot,
              error: { code: 'snapshot_changed', message: 'The project changed before this read completed', retryable: true },
            };
          }
          const data = await read(context, input);
          if (context.signal.aborted)
            return {
              ok: false,
              snapshot: context.reader.snapshot,
              error: { code: 'action_cancelled', message: 'Action was cancelled', retryable: false },
            };
          const after = await options.store.observe(projectId);
          if (snapshotKey(after.snapshot) !== snapshotKey(context.reader.snapshot)) {
            return {
              ok: false,
              snapshot: context.reader.snapshot,
              error: { code: 'snapshot_changed', message: 'The project changed during this read', retryable: true },
            };
          }
          return { ok: true, snapshot: context.reader.snapshot, data };
        } catch (error) {
          const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; status?: unknown };
          return {
            ok: false,
            snapshot: context.reader.snapshot,
            error: {
              code: typeof candidate?.code === 'string' ? candidate.code : 'core_read_failed',
              message: typeof candidate?.message === 'string' ? candidate.message.slice(0, 512) : 'Core read failed',
              retryable: candidate?.retryable === true || candidate?.status === 502,
            },
          };
        }
      },
    });
    const nativeCoreProposal = <Input>(
      id: string,
      inputSchema: ValueSchema,
      propose: (
        input: Input,
        options: {
          snapshot: SnapshotId;
          actorId: string;
          idempotencyKey: string;
          origin: 'author' | 'external-agent';
        },
      ) => Promise<ChangeSetResult>,
      resolveActor: () => Promise<string>,
    ): ModuleAction => ({
      id,
      effect: 'propose',
      inputSchema,
      outputSchema: jsonSchema,
      async invoke(input, context) {
        const snapshot = context.reader.snapshot;
        const checkCancelled = (): void => {
          if (context.signal.aborted) throw httpFailure(499, 'action_cancelled', 'Action was cancelled');
        };
        try {
          checkCancelled();
          if (context.projectId !== projectId || snapshot.projectId !== projectId) {
            throw httpFailure(409, 'snapshot_unavailable', 'Action project does not match its selected reader');
          }
          const actorId = await resolveActor();
          checkCancelled();
          const { idempotencyKey, ...command } = input as Input & { idempotencyKey: string };
          const result = await propose(command as Input, {
            snapshot,
            actorId,
            idempotencyKey,
            origin: source === 'mcp' ? 'external-agent' : 'author',
          });
          checkCancelled();
          return { ok: true, snapshot, data: result };
        } catch (error) {
          return actionFailure(snapshot, error, 'core_proposal_failed');
        }
      },
    });
    const nativeProposals =
      resolveNativeProposalActor === undefined
        ? []
        : [
            nativeCoreProposal<CreateHierarchyInput>(
              'core.hierarchy.create',
              hierarchyCreateInput,
              (input, { snapshot, ...options }) =>
                coreStore.proposeHierarchyCreate(projectId, input, {
                  ...options,
                  projectVersion: snapshot.projectVersion,
                }),
              resolveNativeProposalActor,
            ),
            nativeCoreProposal<{ target: HierarchyTarget }>(
              'core.hierarchy.delete',
              hierarchyDeleteInput,
              ({ target }, { snapshot, ...options }) =>
                coreStore.proposeHierarchyDelete(projectId, target, {
                  ...options,
                  projectVersion: snapshot.projectVersion,
                }),
              resolveNativeProposalActor,
            ),
            nativeCoreProposal<ReorderHierarchyInput>(
              'core.hierarchy.reorder',
              hierarchyReorderInput,
              (input, { snapshot, ...options }) =>
                coreStore.proposeHierarchyReorder(projectId, input, {
                  ...options,
                  projectVersion: snapshot.projectVersion,
                }),
              resolveNativeProposalActor,
            ),
            nativeCoreProposal<ProposeManuscriptRestoreInput>(
              'core.operation.restore',
              restoreInput,
              (input, options) => coreStore.proposeManuscriptRestore(projectId, input, options),
              resolveNativeProposalActor,
            ),
          ];
    return [
      ...nativeProposals.map(action => ({ module: 'core' as const, action })),
      { module: 'core', action: make('core.status', emptyInput, async () => options.store.status(projectId)) },
      {
        module: 'core',
        action: make('core.history', emptyInput, async context => options.store.history(projectId, context.reader.snapshot)),
      },
      { module: 'core', action: make('core.observation', emptyInput, async () => options.store.observe(projectId)) },
      {
        module: 'core',
        action: make('core.tree', emptyInput, async context => options.store.readTreeSnapshot(projectId, context.reader.snapshot)),
      },
      {
        module: 'core',
        action: make('core.scene.context', sceneInput, async (context, input) =>
          options.store.readSceneSnapshot(projectId, (input as { sceneId: string }).sceneId, context.reader.snapshot),
        ),
      },
      {
        module: 'core',
        action: make('core.manuscript-snapshots', manuscriptSnapshotsInput, async (context, input) => {
          if (!coreStore.listManuscriptSnapshots)
            throw httpFailure(503, 'SNAPSHOT_HISTORY_UNAVAILABLE', 'Manuscript snapshot history is not available in this Core version');
          const parsed = input as { manuscriptId: string; sceneId?: string };
          return coreStore.listManuscriptSnapshots(projectId, parsed.manuscriptId, parsed.sceneId, context.reader.snapshot);
        }),
      },
      {
        module: 'core',
        action: make('core.manuscript-snapshot', manuscriptSnapshotInput, async (context, input) => {
          if (!coreStore.readManuscriptSnapshot)
            throw httpFailure(503, 'SNAPSHOT_HISTORY_UNAVAILABLE', 'Manuscript snapshot history is not available in this Core version');
          const parsed = input as { manuscriptId: string; snapshotId: string };
          const result = await coreStore.readManuscriptSnapshot(
            projectId,
            parsed.snapshotId,
            parsed.manuscriptId,
            undefined,
            context.reader.snapshot,
          );
          if (!result)
            throw httpFailure(404, 'MANUSCRIPT_SNAPSHOT_NOT_FOUND', 'Manuscript snapshot is not reachable from the selected commit');
          return result;
        }),
      },
      {
        module: 'core',
        action: make('core.proposals.list', emptyInput, async () => {
          if (!coreStore.listProposals)
            throw httpFailure(503, 'PROPOSAL_STATUS_UNAVAILABLE', 'Proposal review is not available in this Core version');
          const proposals = await coreStore.listProposals(projectId);
          return { proposals: proposals.filter(status => isVisibleProposal(status, canReviewPrivateChangeSets)).slice(0, 1000) };
        }),
      },
      {
        module: 'core',
        action: make('core.proposals.get', proposalInput, async (_context, input) => {
          if (!coreStore.getProposal)
            throw httpFailure(503, 'PROPOSAL_STATUS_UNAVAILABLE', 'Proposal review is not available in this Core version');
          const status = await coreStore.getProposal(projectId, (input as { proposalId: string }).proposalId);
          if (!status || !isVisibleProposal(status, canReviewPrivateChangeSets))
            throw httpFailure(404, 'PROPOSAL_NOT_FOUND', 'Proposal not found');
          return { proposal: status };
        }),
      },
      {
        module: 'core',
        action: {
          id: 'core.document.resolve',
          effect: 'read',
          outputSchema: jsonSchema,
          inputSchema: {
            parse(value: unknown) {
              if (!isRecord(value) || typeof value.path !== 'string') throw new Error('A document path is required');
              assertProjectPath(value.path);
              return { path: value.path };
            },
          },
          async invoke(input, context) {
            const { path } = input as { path: string };
            if (isModulePreservationArchivePath(path) || (!canReviewPrivateChangeSets && isPrivatePublishingPath(path))) {
              return { ok: true, snapshot: context.reader.snapshot, data: { documentId: null, document: null } };
            }
            if (!coreStore.resolveSnapshotDocument)
              return {
                ok: false,
                snapshot: context.reader.snapshot,
                error: { code: 'DOCUMENT_NAVIGATION_UNAVAILABLE', message: 'Document navigation is unavailable', retryable: false },
              };
            const result = await coreStore.resolveSnapshotDocument(projectId, path, context.reader.snapshot);
            const document = result.documentId === null ? await context.reader.read(path) : undefined;
            return {
              ok: true,
              snapshot: result.snapshot,
              data: {
                documentId: result.documentId,
                ...(document !== undefined
                  ? { document: document ? { path, content: document.content, revision: document.revision } : null }
                  : {}),
              },
            };
          },
        },
      },
      {
        module: 'core',
        action: make('core.search', searchInput, async (context, input) => {
          const parsed = input as { query: string; limit: number };
          return search(context.reader, parsed.query, parsed.limit);
        }),
      },
      {
        module: 'core',
        action: make('core.writing-stats', emptyInput, async context => {
          if (!coreStore.writingStatsSnapshot)
            throw httpFailure(503, 'WRITING_STATS_UNAVAILABLE', 'Snapshot writing statistics are not available in this Core version');
          const result = await coreStore.writingStatsSnapshot(projectId, context.reader.snapshot);
          return result.stats;
        }),
      },
      {
        module: 'core',
        action: make('core.projects.list', emptyInput, async () => {
          const { projects } = await listVisibleProjectsPage(200, undefined, allowedProjectIds);
          return { projects };
        }),
      },
      ...createNativeKnowledgeActions({
        persistence: options.persistence!,
        projectId: projectId as import('@codexia/persistence-contracts').ProjectId,
        actorId: actorId as import('@codexia/persistence-contracts').ActorId,
        origin: source === 'mcp' ? 'external-agent' : 'author',
        canReviewPrivateChangeSets,
        authorizeProposal:
          authorizeProposal ??
          (async () => {
            throw httpFailure(
              403,
              'WRITE_PERMISSION_REQUIRED',
              'Current authenticated write permission is required to propose native changes',
            );
          }),
      }).map(action => ({ module: 'core' as const, action })),
    ];
  };

  const enabledStatuses = async (): Promise<ModuleStatus[]> => runtime.statuses();
  const activateEnabled = async (): Promise<void> => {
    for (const status of await enabledStatuses()) {
      if (status.availability === 'enabled-idle' || status.availability === 'active') await runtime.activate(status.id);
    }
  };
  const listActionDescriptors = async (
    projectId: string,
    signal: AbortSignal,
    source: ChangeProposal['source'],
    allowedEffects?: readonly ActionDescriptor['effect'][],
    allowedProjectIds?: readonly string[],
    resolveNativeProposalActor?: () => Promise<string>,
  ): Promise<ActionDescriptor[]> => {
    const reader = await freshReader(projectId);
    return runtime.listActions(
      actionHost(
        projectId,
        reader,
        signal,
        source,
        'owner',
        undefined,
        undefined,
        'owner',
        allowedEffects,
        allowedProjectIds,
        resolveNativeProposalActor,
      ),
    );
  };
  const proposeAs = async (
    projectId: string,
    snapshot: SnapshotId,
    operations: ChangeOperation[],
    source: ChangeProposal['source'],
    evidence?: ProposalEvidence[],
    requestedId?: string,
  ): Promise<ChangeProposal> =>
    options.store.propose(projectId, {
      id: requestedId ?? randomBytes(16).toString('hex'),
      snapshot,
      operations,
      source,
      ...(evidence?.length ? { evidence } : {}),
    });
  const actionFailure = (snapshot: SnapshotId, error: unknown, fallbackCode: string): ActionResult => {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    const code = typeof candidate?.code === 'string' && /^[A-Za-z0-9_.-]{1,128}$/u.test(candidate.code) ? candidate.code : fallbackCode;
    const message = typeof candidate?.message === 'string' ? candidate.message.slice(0, 512) : 'The domain job could not be completed';
    return { ok: false, snapshot, error: { code, message, retryable: candidate?.retryable === true } };
  };
  const actionHost = (
    projectId: string,
    reader: Awaited<ReturnType<typeof freshReader>>,
    signal: AbortSignal,
    source: ChangeProposal['source'],
    access: 'owner' | 'public' = 'owner',
    onDomainJobStarted?: (jobId: string) => void,
    authorizeProposal?: () => Promise<void>,
    actorId = 'owner',
    allowedEffects?: readonly ActionDescriptor['effect'][],
    allowedProjectIds?: readonly string[],
    resolveNativeProposalActor?: () => Promise<string>,
    canReviewPrivateChangeSets = false,
    resolvePublishingAuthor?: () => Promise<string>,
  ): ApiActionHost => {
    const host: ApiActionHost = {
      projectId,
      reader,
      signal,
      caller: access === 'public' || source === 'mcp' ? 'external-agent' : 'author',
      ...(allowedEffects ? { allowedEffects } : {}),
      actions:
        access === 'public'
          ? []
          : buildCoreActions(
              projectId,
              source,
              actorId,
              async () => {
                if (authorizeProposal) {
                  await authorizeProposal();
                  return;
                }
                throw httpFailure(
                  403,
                  'AUTHOR_SESSION_REQUIRED',
                  'Current authenticated write permission is required to propose native changes',
                );
              },
              allowedProjectIds,
              resolveNativeProposalActor,
              canReviewPrivateChangeSets && source !== 'mcp',
            ),
      propose: async (operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string, proposalSignal?: AbortSignal) => {
        if (access === 'public') throw httpFailure(403, 'PUBLIC_PROPOSAL_DENIED', 'Public module requests cannot propose changes');
        if (source === 'mcp' && authorizeProposal) {
          await authorizeProposal();
        }
        if (proposalId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(proposalId))
          throw httpFailure(400, 'INVALID_PROPOSAL_ID', 'Proposal ID must contain 1 to 128 letters, numbers, underscores, or hyphens');
        const requestSignal = proposalSignal ?? signal;
        if (signal.aborted || requestSignal.aborted) throw httpFailure(499, 'ACTION_CANCELLED', 'Proposal request was cancelled');
        const proposal = await proposeAs(projectId, reader.snapshot, operations, source, evidence, proposalId);
        if (signal.aborted || requestSignal.aborted) throw httpFailure(499, 'ACTION_CANCELLED', 'Proposal request was cancelled');
        return proposal;
      },
      access,
    };
    type RecordScope = Parameters<NonNullable<ActionHostContext['readOwnModuleRecord']>>[0];
    const sameRecordScope = (scope: RecordScope): boolean =>
      scope.access === access && snapshotKey(scope.snapshot) === snapshotKey(reader.snapshot);
    const assertPublishingRecordScope = (scope: RecordScope, key: string): void => {
      if (scope.moduleId !== 'publishing' || !isPublishingRecordKey(key) || !sameRecordScope(scope)) {
        throw httpFailure(403, 'PUBLISHING_RECORD_SCOPE_DENIED', 'Publishing record access is limited to the selected project snapshot');
      }
    };
    const assertNlpRecordScope = (scope: RecordScope, key: string): void => {
      if (access !== 'owner' || key !== NLP_FEATURE_SETTINGS_KEY || !sameRecordScope(scope)) {
        throw httpFailure(403, 'NLP_RECORD_SCOPE_DENIED', 'NLP settings access is limited to the selected project snapshot');
      }
    };
    host.readOwnModuleRecord = async (scope, key, recordSignal) => {
      if (scope.moduleId === 'nlp') {
        assertNlpRecordScope(scope, key);
        if (recordSignal.aborted) throw httpFailure(499, 'ACTION_CANCELLED', 'Action request was cancelled');
        return coreStore.readNlpFeatureSettingsSnapshotRecord(projectId, scope.snapshot);
      }
      assertPublishingRecordScope(scope, key);
      if (access !== 'public') {
        if (!resolvePublishingAuthor || source === 'mcp') {
          throw httpFailure(403, 'AUTHOR_SESSION_REQUIRED', 'Publishing settings require an authenticated author');
        }
        await resolvePublishingAuthor();
      }
      if (recordSignal.aborted) throw httpFailure(499, 'ACTION_CANCELLED', 'Action request was cancelled');
      return coreStore.readPublishingSnapshotRecord(projectId, scope.snapshot, key);
    };
    if (access === 'owner' && (resolvePublishingAuthor || resolveNativeProposalActor)) {
      host.proposeOwnModuleRecord = async (scope, input, recordSignal) => {
        if (scope.moduleId === 'nlp') {
          assertNlpRecordScope(scope, input.key);
          if (!resolveNativeProposalActor) {
            throw httpFailure(403, 'AUTHOR_SESSION_REQUIRED', 'A verified actor is required to propose NLP settings');
          }
          const actorId = await resolveNativeProposalActor();
          if (recordSignal.aborted) throw httpFailure(499, 'ACTION_CANCELLED', 'Action request was cancelled');
          return coreStore.proposeNlpFeatureSettingsSnapshotRecord(
            projectId,
            scope.snapshot,
            input,
            actorId,
            source === 'mcp' ? 'external-agent' : 'author',
          );
        }
        assertPublishingRecordScope(scope, input.key);
        if (!resolvePublishingAuthor || source === 'mcp') {
          throw httpFailure(403, 'AUTHOR_SESSION_REQUIRED', 'Publishing settings require an authenticated author');
        }
        const authorId = await resolvePublishingAuthor();
        if (recordSignal.aborted) throw httpFailure(499, 'ACTION_CANCELLED', 'Action request was cancelled');
        return coreStore.proposePublishingSnapshotRecord(projectId, scope.snapshot, input, authorId);
      };
    }
    if (access !== 'public') {
      host.trackDomainJob = async (descriptor, snapshot, jobSignal, execute) => {
        const type = descriptor.job.type;
        if (!SOURCE_DOMAIN_JOB_TYPES.has(type)) {
          return {
            ok: false,
            snapshot,
            error: { code: 'domain_job_type_unsupported', message: 'This domain job type is not registered by the host', retryable: false },
          };
        }
        if (activeDomainJobIds.size >= MAX_ACTIVE_DOMAIN_JOBS) {
          return {
            ok: false,
            snapshot,
            error: {
              code: 'domain_job_capacity',
              message: 'The host is already tracking the maximum number of domain jobs',
              retryable: true,
            },
          };
        }
        const id = randomBytes(16).toString('hex');
        // Reserve synchronously, before the durable registration awaits, so
        // concurrent invokes cannot all observe the same free capacity.
        activeDomainJobIds.add(id);
        const historyId = `domain:${id}`;
        let registered = false;
        try {
          const event = await jobHistory.beginDomainJob({ id, type, projectId: snapshot.projectId });
          registered = true;
          publishJobEvent(event);
          onDomainJobStarted?.(id);
          publishJobEvent(await jobHistory.markDomainJobRunning(id));
        } catch (error) {
          if (registered) {
            try {
              publishJobEvent(
                await jobHistory.finishDomainJob(
                  id,
                  actionFailure(
                    snapshot,
                    {
                      code: 'job_history_unavailable',
                      message: 'The host could not safely start this task',
                      retryable: true,
                    },
                    'job_history_unavailable',
                  ),
                ),
              );
            } catch {
              /* Keep the original storage failure as the useful boundary error. */
            }
          }
          activeDomainJobIds.delete(id);
          const code = error instanceof JobHistoryError ? error.code : 'job_history_unavailable';
          console.error(`Codexia domain job was not started (${code}).`);
          return actionFailure(
            snapshot,
            { code: 'job_history_unavailable', message: 'The host could not safely register this job' },
            'job_history_unavailable',
          );
        }
        let result: ActionResult;
        try {
          result = jobSignal.aborted
            ? actionFailure(snapshot, jobSignal.reason, 'action_cancelled')
            : await execute(async progress => {
                const event = await jobHistory.reportDomainJobProgress(id, progress);
                if (event) publishJobEvent(event);
              });
        } catch (error) {
          result = actionFailure(snapshot, error, 'domain_job_failed');
        }
        try {
          publishJobEvent(await jobHistory.finishDomainJob(id, result));
        } catch (error) {
          const code = error instanceof JobHistoryError ? error.code : 'storage_failure';
          console.error(`Codexia domain job result was not retained (${code}).`);
          try {
            const failed = actionFailure(
              snapshot,
              {
                code: 'domain_job_result_not_retained',
                message: 'The task finished, but its result could not be safely retained',
                retryable: true,
              },
              'domain_job_result_not_retained',
            );
            publishJobEvent(await jobHistory.finishDomainJob(id, failed));
          } catch {
            /* Startup recovery will mark any still-running record as interrupted. */
          }
        } finally {
          activeDomainJobIds.delete(id);
        }
        return result;
      };
      host.linkedReader = async (linkedProjectId: string) => {
        assertAssignedProject(linkedProjectId, allowedProjectIds);
        if (!(await findAuthorizedProject(linkedProjectId, allowedProjectIds)))
          throw httpFailure(404, 'PROJECT_NOT_FOUND', 'Linked project was not found');
        return freshReader(linkedProjectId);
      };
    }
    return host;
  };

  const serveModuleResponse = async (
    response: Response,
    raw: ServerResponse,
    signal: AbortSignal,
    publicResponse = false,
  ): Promise<void> => {
    if (response.status < 200 || response.status > 599)
      throw httpFailure(502, 'MODULE_HTTP_INVALID_RESPONSE', 'Module returned an invalid HTTP response');
    const forbiddenHeaders = new Set([
      'set-cookie',
      'content-security-policy',
      'x-frame-options',
      'x-content-type-options',
      'referrer-policy',
      'cache-control',
      'connection',
      'keep-alive',
      'content-length',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ]);
    response.headers.forEach((value, key) => {
      if (publicResponse && key.toLowerCase() === 'referrer-policy' && value.trim().toLowerCase() === 'no-referrer') {
        raw.setHeader(key, 'no-referrer');
        return;
      }
      if (!forbiddenHeaders.has(key.toLowerCase()) && !key.toLowerCase().startsWith('access-control-')) raw.setHeader(key, value);
    });
    raw.statusCode = response.status;
    if (response.body === null) {
      raw.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body as never), raw, { signal });
  };
  const makeWebRequest = (request: IncomingMessage, body: unknown, signal: AbortSignal, relativePath?: string): Request => {
    const method = request.method ?? 'GET';
    const host = request.headers.host ?? 'localhost';
    const originalUrl = new URL(request.url ?? '/', `${requestProtocol(request, trustProxy)}//${host}`);
    if (relativePath !== undefined) originalUrl.pathname = `/${relativePath.replace(/^\/+/, '')}`;
    const url = originalUrl.href;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value === undefined ||
        ['host', 'connection', 'content-length', 'transfer-encoding', 'cookie', 'authorization', 'proxy-authorization'].includes(
          name.toLowerCase(),
        )
      )
        continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
    const init: RequestInit = { method, headers, signal };
    if (body !== undefined && !['GET', 'HEAD'].includes(method)) init.body = JSON.stringify(body);
    return new Request(url, init);
  };
  const createScratch = async (projectId: string, value: unknown, authorScope: string, json: SendJson): Promise<void> => {
    if (
      !isRecord(value) ||
      typeof value.text !== 'string' ||
      value.text.length > 100_000 ||
      (value.source !== undefined && !['voice', 'camera', 'text'].includes(String(value.source))) ||
      (value.sceneId !== undefined && (typeof value.sceneId !== 'string' || !value.sceneId || value.sceneId.length > 256)) ||
      (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > 8))
    ) {
      throw httpFailure(400, 'INVALID_SCRATCH', 'Scratch text, source, scene, or attachment fields are invalid');
    }
    const text = value.text;
    const source = typeof value.source === 'string' ? value.source : undefined;
    const sceneId = typeof value.sceneId === 'string' ? value.sceneId : undefined;
    const inputs = (value.attachments ?? []) as unknown[];
    const createdAt = new Date().toISOString();
    const id = `scratch-${createdAt.slice(0, 10).replaceAll('-', '')}-${randomBytes(6).toString('hex')}`;
    const attachments: Array<{ filename: string; path: string; mimeType: string; content: Buffer }> = [];
    let totalBytes = 0;
    for (const item of inputs) {
      if (
        !isRecord(item) ||
        typeof item.filename !== 'string' ||
        !item.filename.trim() ||
        item.filename.length > 256 ||
        typeof item.mimeType !== 'string' ||
        !/^[A-Za-z0-9!#$&^_.+-]{1,128}\/[A-Za-z0-9!#$&^_.+-]{1,128}$/u.test(item.mimeType) ||
        typeof item.dataBase64 !== 'string' ||
        !item.dataBase64 ||
        !hasBase64AlphabetAndPadding(item.dataBase64)
      ) {
        throw httpFailure(400, 'INVALID_SCRATCH_ATTACHMENT', 'Scratch attachment fields are invalid');
      }
      const content = Buffer.from(item.dataBase64, 'base64');
      if (content.length === 0) throw httpFailure(400, 'EMPTY_SCRATCH_ATTACHMENT', 'Scratch attachments cannot be empty');
      if (content.toString('base64') !== item.dataBase64)
        throw httpFailure(400, 'INVALID_SCRATCH_ATTACHMENT', 'Scratch attachment base64 is not canonical');
      totalBytes += content.length;
      if (content.length > MAX_SCRATCH_ATTACHMENT_BYTES || totalBytes > MAX_SCRATCH_ATTACHMENT_BYTES) {
        throw httpFailure(413, 'SCRATCH_ATTACHMENT_TOO_LARGE', 'Scratch attachments exceed the 8 MiB total limit');
      }
      const baseName = item.filename.split(/[\\/]/u).at(-1) ?? '';
      const storageName = baseName.replace(/[^\w.\-()\u3040-\u30ff\u4e00-\u9fff]+/gu, '_').slice(0, 120) || 'attachment.bin';
      const filename = baseName.trim() ? baseName : storageName;
      const ordinal = String(attachments.length + 1).padStart(2, '0');
      attachments.push({ filename, path: `meta/scratch/files/${id}-${ordinal}-${storageName}`, mimeType: item.mimeType, content });
    }
    if (!text.trim() && attachments.length === 0)
      throw httpFailure(400, 'INVALID_SCRATCH', 'Scratch text or at least one attachment is required');
    const filePath = `meta/scratch/${id}.md`;
    const reader = await freshReader(projectId);
    const old = await reader.read(filePath);
    const markdownLines = [
      '---',
      `id: ${JSON.stringify(id)}`,
      `createdAt: ${JSON.stringify(createdAt)}`,
      ...(source ? [`source: ${JSON.stringify(source)}`] : []),
      ...(sceneId ? [`sceneId: ${JSON.stringify(sceneId)}`] : []),
    ];
    if (attachments.length) {
      markdownLines.push('attachments:');
      for (const attachment of attachments)
        markdownLines.push(
          `  - filename: ${JSON.stringify(attachment.filename)}`,
          `    path: ${JSON.stringify(attachment.path)}`,
          `    mimeType: ${JSON.stringify(attachment.mimeType)}`,
        );
    }
    markdownLines.push('---', '', ...(text.trimEnd() ? [text.trimEnd(), ''] : []));
    for (const attachment of attachments) {
      const label = attachment.filename.replace(/\p{Cc}/gu, ' ').replace(/[\\\[\]*_`~<>|&]/gu, '\\$&');
      const destination = attachment.path.replaceAll('(', '%28').replaceAll(')', '%29');
      markdownLines.push(`${attachment.mimeType.startsWith('image/') ? '!' : ''}[${label}](${destination})`, '');
    }
    const markdown = markdownLines.join('\n');
    const writes: ChangeOperation['writes'] = [{ path: filePath, revision: old?.revision ?? null, content: markdown }];
    for (const attachment of attachments) {
      const previous = await reader.read(attachment.path, 'base64');
      writes.push({
        path: attachment.path,
        revision: previous?.revision ?? null,
        content: attachment.content.toString('base64'),
        encoding: 'base64',
      });
    }
    const operation: ChangeOperation = {
      id: randomBytes(16).toString('hex'),
      generation: 0,
      projectId,
      baseProjectVersion: reader.snapshot.projectVersion,
      effect: 'metadata',
      reads: writes.map(({ path, revision }) => ({ path, revision })),
      writes,
      message: `scratch: ${id}`,
    };
    const proposalInput: ChangeProposal = {
      id: randomBytes(16).toString('hex'),
      snapshot: reader.snapshot,
      operations: [operation],
      source: 'author',
    };
    // With one operation, no deltas, and only string write contents, this exact normalized proposal cap
    // also bounds the operation's UTF-16 content accounting (base64 writes expand raw bytes by 4/3).
    if (!isPersistedProposalWithinSizeLimit(proposalInput))
      throw httpFailure(413, 'SCRATCH_ATTACHMENT_TOO_LARGE', 'Scratch submission exceeds the 8 MiB persisted proposal limit');
    const proposal = await options.store.propose(projectId, proposalInput);
    await options.store.approve(projectId, { proposalId: proposal.id, operationIds: [operation.id], authorScope });
    const receipt = await options.store.apply(projectId, operation);
    json(201, {
      id,
      path: filePath,
      createdAt,
      ...(source ? { source } : {}),
      sceneId: sceneId ?? null,
      attachments: attachments.map(({ filename, path, mimeType }) => ({ filename, path, mimeType })),
      proposal,
      receipt,
    });
  };

  type AdmissionPolicy = 'public' | 'api' | 'persistence' | 'mcp' | 'mcp-module';
  const publicAuthorities = new Set(
    [oauthResource, oauthAuthorizationServer, options.betterAuth.issuer]
      .filter((url): url is string => typeof url === 'string')
      .map(url => new URL(url).host),
  );
  const checkRequestTarget = (request: IncomingMessage, mcp: boolean): void => {
    const rawPath = (request.url ?? '/').split('?', 1)[0]!;
    if (
      !rawPath.startsWith('/') ||
      rawPath.startsWith('//') ||
      Array.from(rawPath).some(character => character <= ' ' || character === '\x7f' || character === '\\')
    ) {
      throw httpFailure(400, 'INVALID_PATH', 'Request target must use an origin-relative path');
    }
    const host = request.headers.host;
    if (!host || /[\s,@/\\?#]/u.test(host)) throw httpFailure(400, 'HOST_INVALID', 'Request Host is invalid');
    let target: URL;
    try {
      target = new URL(`${requestProtocol(request, trustProxy)}//${host}`);
    } catch {
      throw httpFailure(400, 'HOST_INVALID', 'Request Host is invalid');
    }
    const forwardedHost = request.headers['x-forwarded-host'];
    if (trustProxy && forwardedHost !== undefined && forwardedHost !== host) {
      throw httpFailure(400, 'HOST_INVALID', 'Forwarded Host does not match the request Host');
    }
    if (mcp && publicAuthorities.size > 0 && !publicAuthorities.has(target.host)) {
      const peer = request.socket.remoteAddress?.replace(/^::ffff:/u, '');
      const local = peer === '127.0.0.1' || peer === '::1';
      if (!local || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
        throw httpFailure(403, 'MCP_HOST_DENIED', 'Request Host is not configured for MCP');
      }
    }
  };
  const checkOrigin = (request: IncomingMessage, response: ServerResponse, isApiRoute: boolean, mcpStreamableRoute: boolean) => {
    checkRequestTarget(request, mcpStreamableRoute);
    const originHeader = request.headers.origin;
    const crossOrigin = originHeader !== undefined && !sameOrigin(request, trustProxy);
    if (isApiRoute && crossOrigin) {
      vary(response, 'Origin');
      vary(response, 'Access-Control-Request-Method');
      vary(response, 'Access-Control-Request-Headers');
      if (typeof originHeader !== 'string' || !corsAllowedOrigins.has(originHeader)) {
        throw httpFailure(403, 'CORS_ORIGIN_DENIED', 'Cross-origin API access is not configured for this origin');
      }
      if (request.headers.cookie !== undefined) {
        throw httpFailure(403, 'CORS_COOKIE_DENIED', 'Cross-origin API access requires bearer credentials without cookies');
      }
      response.setHeader('Access-Control-Allow-Origin', originHeader);
      if (mcpStreamableRoute) response.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, WWW-Authenticate');
    }

    return crossOrigin;
  };
  const checkPathParams = (params: Record<string, string>): void => {
    for (const param of Object.values(params)) {
      if (
        Array.from(param).some(character => character < ' ' || character === '\x7f' || character === '/' || character === '\\') ||
        param === '.' ||
        param === '..'
      ) {
        throw httpFailure(400, 'INVALID_ID', 'Invalid route parameter');
      }
    }
  };
  const admit = async (
    request: IncomingMessage,
    response: ServerResponse,
    params: Record<string, string>,
    query: URLSearchParams,
    policy: AdmissionPolicy,
  ) => {
    const standaloneMcpRoute = policy === 'mcp';
    const mcpStreamableRoute = standaloneMcpRoute || policy === 'mcp-module';
    const needsBearer = policy !== 'public';
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    let resolvedProjectId = params.projectId ?? '';
    const authHeader = request.headers.authorization;
    const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    let oauthPrincipal: Awaited<ReturnType<NonNullable<typeof authenticateOAuthOwner>>> | undefined;
    // Admission returns public identity and policy fields after signature and liveness checks.
    let admittedMcpClient: OAuthMcpPrincipal | undefined;
    if (standaloneMcpRoute) {
      if (!oauthMcpMetadataUrl) throw httpFailure(503, 'MCP_OAUTH_UNAVAILABLE', 'Standalone MCP OAuth is not configured');
      if (!bearer || !authenticateOAuthMcp) {
        response.setHeader('WWW-Authenticate', mcpChallenge(oauthMcpMetadataUrl));
        throw httpFailure(401, 'UNAUTHORIZED', 'MCP OAuth authentication required');
      }
    }
    if (needsBearer && !standaloneMcpRoute && bearer && authenticateOAuthOwner) {
      try {
        oauthPrincipal = await authenticateOAuthOwner(bearer);
      } catch (error) {
        if (authenticateOAuthMcp && error instanceof OAuthAuthenticationError && error.code === 'OAUTH_SCOPE_REQUIRED') {
          try {
            admittedMcpClient = await authenticateOAuthMcp(bearer);
          } catch (mcpError) {
            const failure =
              mcpError instanceof OAuthAuthenticationError
                ? mcpError
                : new OAuthAuthenticationError(401, 'OAUTH_TOKEN_INVALID', 'OAuth access token is invalid or unverifiable');
            if (failure.status === 401 && mcpStreamableRoute && oauthMcpMetadataUrl) {
              response.setHeader('WWW-Authenticate', mcpChallenge(oauthMcpMetadataUrl));
            }
            throw httpFailure(failure.status, failure.code, failure.message);
          }
        } else {
          const failure =
            error instanceof OAuthAuthenticationError
              ? error
              : new OAuthAuthenticationError(401, 'OAUTH_TOKEN_INVALID', 'OAuth access token is invalid or unverifiable');
          if (failure.status === 401 && mcpStreamableRoute && oauthMcpMetadataUrl) {
            response.setHeader('WWW-Authenticate', mcpChallenge(oauthMcpMetadataUrl));
          }
          throw httpFailure(failure.status, failure.code, failure.message);
        }
      }
    }
    if (needsBearer && bearer && authenticateOAuthMcp && (standaloneMcpRoute || !authenticateOAuthOwner)) {
      try {
        admittedMcpClient = await authenticateOAuthMcp(bearer);
      } catch (error) {
        const failure =
          error instanceof OAuthAuthenticationError
            ? error
            : new OAuthAuthenticationError(401, 'OAUTH_TOKEN_INVALID', 'OAuth access token is invalid or unverifiable');
        if (failure.status === 401 && mcpStreamableRoute && oauthMcpMetadataUrl) {
          response.setHeader('WWW-Authenticate', mcpChallenge(oauthMcpMetadataUrl));
        }
        throw httpFailure(failure.status, failure.code, failure.message);
      }
    }
    if (standaloneMcpRoute && admittedMcpClient) {
      const requested = query.getAll('projectId');
      if (requested.length > 1 || requested[0] === '') {
        throw httpFailure(400, 'INVALID_PROJECT', 'Specify at most one projectId');
      }
      const assigned = admittedMcpClient.projectIds;
      const projectId = requested[0] ?? (assigned.length === 1 ? assigned[0] : undefined);
      if (!projectId)
        throw httpFailure(400, 'MCP_PROJECT_REQUIRED', 'Specify projectId when the OAuth client has several project assignments');
      assertAssignedProject(projectId, assigned);
      resolvedProjectId = projectId;
    }
    if (admittedMcpClient && policy === 'persistence') {
      throw httpFailure(403, 'OAUTH_MCP_PERSISTENCE_DENIED', 'Standalone MCP clients cannot use the direct persistence API');
    }
    const isAuthor = Boolean(oauthPrincipal);
    const isBearer = Boolean(admittedMcpClient);
    const canReviewPrivateChangeSets = isAuthor;
    const hasAuth = isAuthor || isBearer;
    const mcpAllowedEffects: readonly ActionDescriptor['effect'][] | undefined = admittedMcpClient
      ? (['read', 'compute', 'propose'] as const).filter(effect => admittedMcpClient!.scopes.includes(OAUTH_MCP_SCOPE_BY_EFFECT[effect]))
      : undefined;
    const requireMcpEffect = (effect: ActionDescriptor['effect']): void => {
      if (!admittedMcpClient) return;
      const requiredScope = OAUTH_MCP_SCOPE_BY_EFFECT[effect];
      if (admittedMcpClient.scopes.includes(requiredScope)) return;
      if (oauthMcpMetadataUrl) response.setHeader('WWW-Authenticate', mcpChallenge(oauthMcpMetadataUrl, requiredScope));
      throw httpFailure(403, 'OAUTH_MCP_SCOPE_REQUIRED', `Access token does not grant ${requiredScope}`);
    };
    if (admittedMcpClient && isRead && !mcpStreamableRoute) {
      requireMcpEffect('read');
    }
    if (!hasAuth && needsBearer) {
      response.setHeader(
        'WWW-Authenticate',
        mcpStreamableRoute && oauthMcpMetadataUrl ? mcpChallenge(oauthMcpMetadataUrl) : 'Bearer realm="codexia"',
      );
      throw httpFailure(401, 'UNAUTHORIZED', 'Authentication required');
    }
    const requireAuthorSession = async (): Promise<string> => {
      if (!isAuthor) throw httpFailure(403, 'AUTHOR_SESSION_REQUIRED', 'An authenticated author identity is required');
      return 'owner';
    };
    const resolvePublishingAuthor = isAuthor ? requireAuthorSession : undefined;
    const authorizeActionProposal = async (): Promise<void> => {
      requireMcpEffect('propose');
      if (!isAuthor && !isBearer)
        throw httpFailure(403, 'AUTHOR_SESSION_REQUIRED', 'An authenticated author or bearer identity is required to propose changes');
    };
    const resolveNativeProposalActor = hasAuth
      ? async (): Promise<string> => {
          await authorizeActionProposal();
          return admittedMcpClient?.userId ?? 'owner';
        }
      : undefined;
    if (needsBearer && shuttingDown && !isRead) {
      throw httpFailure(503, 'SHUTTING_DOWN', 'The server is draining and is not accepting new mutations');
    }
    if (admittedMcpClient && resolvedProjectId && !(await findAuthorizedProject(resolvedProjectId, admittedMcpClient.projectIds))) {
      throw httpFailure(404, 'PROJECT_NOT_FOUND', 'Project was not found');
    }
    return {
      projectId: resolvedProjectId,
      isAuthor,
      isBearer,
      canReviewPrivateChangeSets,
      admittedMcpClient,
      mcpAllowedEffects,
      requireMcpEffect,
      requireAuthorSession,
      authorizeActionProposal,
      resolveNativeProposalActor,
      resolvePublishingAuthor,
      signal: abortSignalFor(request, response),
    };
  };
  type Admission = Awaited<ReturnType<typeof admit>> & {
    params: Record<string, string>;
    query: URLSearchParams;
    crossOrigin: boolean;
  };
  type SendJson = (status: number, value: unknown) => void;
  type Handler = (
    context: Admission & {
      request: IncomingMessage;
      response: ServerResponse;
      reply: FastifyReply;
      parsedBody: unknown;
      json: SendJson;
      reject: (status: number, code: string, message: string) => void;
    },
  ) => Promise<void>;
  const routeContexts = new WeakMap<FastifyRequest, Admission>();
  const sendWebResponse = async (
    reply: FastifyReply,
    response: Response,
    headers: Record<string, string | string[]> = Object.fromEntries(response.headers),
  ): Promise<void> => {
    reply.code(response.status).headers(headers);
    for (const name of ['connection', 'transfer-encoding', 'content-length']) reply.removeHeader(name);
    await reply.send(response.body ? Readable.fromWeb(response.body as never) : undefined);
  };
  const handlers: Record<string, Handler> = {
    api_health_get: async ({ json }) => {
      json(200, { status: 'ok' });
      return;
    },
    api_ready_get: async ({ json }) => {
      const databaseReady = await postgresReady(options.persistence);
      const ready = !shuttingDown && databaseReady;
      json(ready ? 200 : 503, { ok: ready, pendingRequests: activeRequests, persistenceReady: databaseReady });
      return;
    },
    health_live_get: async ({ json }) => {
      json(200, { ok: true });
      return;
    },
    health_ready_get: async ({ json }) => {
      const databaseReady = await postgresReady(options.persistence);
      const ready = !shuttingDown && databaseReady;
      json(ready ? 200 : 503, { ok: ready, pendingRequests: activeRequests, persistenceReady: databaseReady });
      return;
    },
    health_startup_get: async ({ json }) => {
      json(started && !closed ? 200 : 503, { ok: started && !closed, started });
      return;
    },
    api_version_get: async ({ json }) => {
      json(200, {
        name: 'codexia',
        version: API_VERSION,
        contractVersion: CONTRACT_VERSION,
        ...(standaloneIdentity ? { apiEpoch: standaloneIdentity.apiEpoch } : {}),
        profile,
        auth: ['oauth-owner', 'oauth-mcp'],
        runtime: {
          name: '@codexia/module-runtime',
          contractVersion: CONTRACT_VERSION,
          ...(runtime.metadata ? { metadata: runtime.metadata() } : {}),
        },
        modules: await enabledStatuses(),
      });
      return;
    },
    api_session_get: async ({ requireAuthorSession, json }) => {
      const authorScope = await requireAuthorSession();
      json(200, {
        authenticated: true,
        authorScope,
      });
      return;
    },
    project_events_get: async ({ response, reply, admittedMcpClient }) => {
      if (admittedMcpClient)
        throw httpFailure(
          403,
          'OAUTH_MCP_PROJECT_EVENTS_DENIED',
          'Standalone MCP clients cannot subscribe to the owner-wide project event stream',
        );
      if (projectEventStreams.full) throw httpFailure(503, 'PROJECT_EVENT_STREAM_LIMIT', 'Too many project event streams are open');
      reply.hijack();
      projectEventStreams.open(response, 'no-store', undefined);
      return;
    },
    job_events_get: async ({ response, reply, isAuthor, reject }) => {
      if (!isAuthor) {
        reject(403, 'AUTHOR_SESSION_REQUIRED', 'Job events require an owner identity');
        return;
      }
      if (jobEventStreams.full) throw httpFailure(503, 'JOB_EVENT_STREAM_LIMIT', 'Too many job event streams are open');
      reply.hijack();
      jobEventStreams.open(response, 'no-cache', ': ok\n\n');
      return;
    },
    jobs_list_get: async ({ isAuthor, json, reject }) => {
      if (!isAuthor) {
        reject(403, 'AUTHOR_SESSION_REQUIRED', 'Job history requires an owner identity');
        return;
      }
      try {
        json(200, await jobHistory.listJobs());
      } catch {
        throw httpFailure(503, 'JOB_HISTORY_UNAVAILABLE', 'Job history is temporarily unavailable');
      }
      return;
    },
    inbox_list_get: async ({ query, isAuthor, json, reject }) => {
      if (!isAuthor) {
        reject(403, 'AUTHOR_SESSION_REQUIRED', 'Inbox requires an owner identity');
        return;
      }
      try {
        json(200, await jobHistory.listInbox({ unreadOnly: query.get('unread') === '1' }));
      } catch {
        throw httpFailure(503, 'JOB_HISTORY_UNAVAILABLE', 'Inbox is temporarily unavailable');
      }
      return;
    },
    inbox_read_all_post: async ({ requireAuthorSession, json }) => {
      await requireAuthorSession();
      try {
        json(200, { marked: await jobHistory.markAllInboxRead() });
      } catch {
        throw httpFailure(503, 'JOB_HISTORY_UNAVAILABLE', 'Inbox is temporarily unavailable');
      }
      return;
    },
    projects_list_get: async ({ query, admittedMcpClient, json }) => {
      const limit = boundedInt(query.get('limit'), 200, 1, 200);
      let cursor: ProjectPageCursor | undefined;
      try {
        cursor = decodeProjectPageCursor(query.get('cursor'));
      } catch {
        throw httpFailure(400, 'INVALID_CURSOR', 'Project cursor is invalid');
      }

      const page = await listVisibleProjectsPage(limit, cursor, admittedMcpClient?.projectIds);
      json(200, { projects: page.projects, nextCursor: page.nextCursor ? encodeProjectPageCursor(page.nextCursor) : null });
      return;
    },
    projects_create_post: async ({ request, parsedBody, requireAuthorSession, json }) => {
      await requireAuthorSession();
      const { title } = parsedBody as { title: string };
      const project = await options.store.createProject({ title: title.trim() });
      json(201, project);
      return;
    },
    review_queue_get: async ({ canReviewPrivateChangeSets, admittedMcpClient, json }) => {
      if (!coreStore.reviewQueue)
        throw httpFailure(503, 'PROPOSAL_STATUS_UNAVAILABLE', 'Proposal review is not available in this Core version');
      const projectIds = admittedMcpClient ? [...admittedMcpClient.projectIds] : null;
      json(200, await coreStore.reviewQueue(projectIds, { excludePrivateProposals: !canReviewPrivateChangeSets }));
      return;
    },
    job_get: async ({ params, isAuthor, json, reject }) => {
      if (!isAuthor) {
        reject(403, 'AUTHOR_SESSION_REQUIRED', 'Job history requires an owner identity');
        return;
      }
      const jobId = params.jobId!;
      try {
        const job = await jobHistory.getJob(jobId);
        if (!job) throw httpFailure(404, 'JOB_NOT_FOUND', 'Job was not found');
        json(200, job);
      } catch (error) {
        if (isHttpFailure(error)) throw error;
        throw httpFailure(503, 'JOB_HISTORY_UNAVAILABLE', 'Job history is temporarily unavailable');
      }
      return;
    },
    inbox_item_read_post: async ({ params, requireAuthorSession, json }) => {
      await requireAuthorSession();
      const inboxId = params.inboxId!;
      try {
        const item = await jobHistory.markInboxRead(inboxId);
        if (!item) throw httpFailure(404, 'INBOX_ITEM_NOT_FOUND', 'Inbox item was not found');
        json(200, { item });
      } catch (error) {
        if (isHttpFailure(error)) throw error;
        throw httpFailure(503, 'JOB_HISTORY_UNAVAILABLE', 'Inbox is temporarily unavailable');
      }
      return;
    },
    project_get: async ({ projectId, admittedMcpClient, json }) => {
      const project = await findAuthorizedProject(projectId, admittedMcpClient?.projectIds);
      if (!project) throw httpFailure(404, 'PROJECT_NOT_FOUND', 'Project not found');
      const observation = await options.store.observe(projectId);
      json(200, { project, observation });
      return;
    },
    project_modules_get: async ({ json }) => {
      json(200, await enabledStatuses());
      return;
    },
    project_contributions_get: async ({ json }) => {
      await activateEnabled();
      const contributions = (await enabledStatuses())
        .filter(status => status.availability === 'enabled-idle' || status.availability === 'active')
        .flatMap(status => runtime.contributions(status.id));
      json(200, contributions);
      return;
    },
    project_tree_get: async ({ query, projectId, json }) => {
      const selected = optionalSnapshot(query, projectId);
      json(200, await options.store.readTreeSnapshot(projectId, selected.pinned));
      return;
    },
    project_snapshot_get: async ({ query, projectId, json }) => {
      const projection = query.getAll('projection');
      if (projection.length !== 1 || projection[0] !== 'editor') {
        throw httpFailure(400, 'INVALID_PROJECTION', 'Select the editor snapshot projection');
      }
      const selected = optionalSnapshot(query, projectId);
      const documentId = query.get('documentId');
      if (documentId !== null && !isPostgresRevisionId(documentId)) {
        throw httpFailure(400, 'INVALID_ID', 'Use a canonical PostgreSQL document identifier');
      }
      const reader = await freshReader(projectId, selected.pinned);
      if (documentId === null) {
        json(200, { snapshot: reader.snapshot, document: null });
        return;
      }
      if (!reader.listRevisions) {
        throw httpFailure(503, 'SNAPSHOT_REVISIONS_UNAVAILABLE', 'Editor document revisions are unavailable');
      }
      const path = `documents/${documentId}.md`;
      const entry = (await reader.listRevisions(path)).find(candidate => candidate.path === path);
      json(200, { snapshot: reader.snapshot, document: entry ? { path, revision: entry.revision } : null });
      return;
    },
    project_history_get: async ({ query, projectId, json }) => {
      json(200, await options.store.history(projectId, optionalSnapshot(query, projectId).pinned));
      return;
    },
    project_status_get: async ({ projectId, json }) => {
      json(200, await options.store.status(projectId));
      return;
    },
    project_observation_get: async ({ projectId, json }) => {
      json(200, await options.store.observe(projectId));
      return;
    },
    project_proposals_create_post: async ({ request, parsedBody, signal, projectId, isBearer, requireMcpEffect, json }) => {
      requireMcpEffect('propose');
      const body = parsedBody;
      if (!isRecord(body) || !isRecord(body.snapshot) || !Array.isArray(body.operations) || !body.operations.length)
        throw httpFailure(400, 'INVALID_PROPOSAL', 'A proposal snapshot and at least one operation are required');
      if (signal.aborted) throw httpFailure(499, 'ACTION_CANCELLED', 'Proposal request was cancelled');
      if ('proposalId' in body) throw httpFailure(400, 'INVALID_PROPOSAL', 'Use id for the proposal identity');
      const requestedId = typeof body.id === 'string' && body.id ? body.id : undefined;
      let source: ChangeProposal['source'] = isBearer ? 'mcp' : 'author';
      if (requestedId !== undefined) {
        if (!coreStore.getProposal)
          throw httpFailure(503, 'PROPOSAL_IDENTITY_UNAVAILABLE', 'Core cannot verify an existing proposal identity for this retry');
        const existing = await coreStore.getProposal(projectId, requestedId);
        if (signal.aborted) throw httpFailure(499, 'ACTION_CANCELLED', 'Proposal request was cancelled');
        if (existing) {
          if (existing.proposal.id !== requestedId)
            throw httpFailure(503, 'PROPOSAL_IDENTITY_INVALID', 'Core returned a mismatched proposal identity');
          // Preserve only Core's immutable source for an existing identity; Core still checks the full original digest below.
          source = existing.proposal.source;
        }
      }
      const proposal: ChangeProposal = {
        id: requestedId || randomBytes(16).toString('hex'),
        snapshot: body.snapshot as unknown as SnapshotId,
        operations: body.operations as ChangeOperation[],
        source,
        ...(Array.isArray(body.evidence) ? { evidence: body.evidence as ProposalEvidence[] } : {}),
      };
      const stored = await options.store.propose(projectId, proposal);
      if (signal.aborted) throw httpFailure(499, 'ACTION_CANCELLED', 'Proposal request was cancelled');
      json(201, stored);
      return;
    },
    project_proposals_list_get: async ({ projectId, canReviewPrivateChangeSets, json }) => {
      if (!coreStore.listProposals)
        throw httpFailure(503, 'PROPOSAL_STATUS_UNAVAILABLE', 'Proposal review is not available in this Core version');
      const proposals = await coreStore.listProposals(projectId);
      json(200, { proposals: proposals.filter(status => isVisibleProposal(status, canReviewPrivateChangeSets)).slice(0, 1000) });
      return;
    },
    project_approvals_post: async ({ request, reply, parsedBody, projectId, requireAuthorSession }) => {
      const authorScope = await requireAuthorSession();
      const body = parsedBody;
      if (
        !isRecord(body) ||
        typeof body.proposalId !== 'string' ||
        !body.proposalId ||
        !Array.isArray(body.operationIds) ||
        !body.operationIds.every(id => typeof id === 'string')
      )
        throw httpFailure(400, 'INVALID_APPROVAL', 'Proposal and operation IDs are required');
      await options.store.approve(projectId, { proposalId: body.proposalId, operationIds: body.operationIds as string[], authorScope });
      void reply.code(204).send();
      return;
    },
    project_apply_post: async ({ request, parsedBody, projectId, requireAuthorSession, json }) => {
      await requireAuthorSession();
      const body = parsedBody;
      json(201, await options.store.apply(projectId, body as ChangeOperation));
      return;
    },
    project_actions_get: async ({
      signal,
      projectId,
      isBearer,
      admittedMcpClient,
      mcpAllowedEffects,
      resolveNativeProposalActor,
      json,
    }) => {
      json(200, {
        actions: await listActionDescriptors(
          projectId,
          signal,
          isBearer ? 'mcp' : 'author',
          mcpAllowedEffects,
          admittedMcpClient?.projectIds,
          resolveNativeProposalActor,
        ),
      });
      return;
    },
    project_scratch_post: async ({ request, parsedBody, projectId, requireAuthorSession, json }) => {
      const authorScope = await requireAuthorSession();
      await createScratch(projectId, parsedBody, authorScope, json);
      return;
    },
    project_review_queue_get: async ({ projectId, canReviewPrivateChangeSets, json }) => {
      if (!coreStore.listProposalsSnapshot)
        throw httpFailure(503, 'PROPOSAL_STATUS_UNAVAILABLE', 'Proposal review is not available in this Core version');
      const result = await coreStore.listProposalsSnapshot(projectId);
      json(200, {
        snapshot: result.snapshot,
        proposals: result.proposals.filter(status => isVisibleProposal(status, canReviewPrivateChangeSets)).slice(0, 1000),
      });
      return;
    },
    project_scene_get: async ({ params, query, projectId, json }) => {
      const sceneId = params.sceneId!;
      const selected = optionalSnapshot(query, projectId);
      json(200, await options.store.readSceneSnapshot(projectId, sceneId, selected.pinned));
      return;
    },
    project_proposal_get: async ({ params, projectId, canReviewPrivateChangeSets, json }) => {
      if (!coreStore.getProposal)
        throw httpFailure(503, 'PROPOSAL_STATUS_UNAVAILABLE', 'Proposal review is not available in this Core version');
      const proposal = await coreStore.getProposal(projectId, params.proposalId!);
      if (!proposal || !isVisibleProposal(proposal, canReviewPrivateChangeSets))
        throw httpFailure(404, 'PROPOSAL_NOT_FOUND', 'Proposal not found');
      json(200, proposal);
      return;
    },
    project_action_post: async ({
      request,
      response,
      parsedBody,
      params,
      signal,
      projectId,
      isAuthor,
      isBearer,
      canReviewPrivateChangeSets,
      admittedMcpClient,
      mcpAllowedEffects,
      requireMcpEffect,
      authorizeActionProposal,
      resolveNativeProposalActor,
      resolvePublishingAuthor,
      json,
    }) => {
      const body = parsedBody;
      if (!isRecord(body) || !('input' in body)) throw httpFailure(400, 'INVALID_ACTION', 'Action input is required');
      const actionId = params.actionId!;
      if (isBearer && actionId.startsWith('assistant.')) {
        throw httpFailure(403, 'external_agent_assistant_denied', 'External agents cannot invoke Assistant');
      }
      const descriptors = await listActionDescriptors(
        projectId,
        signal,
        isBearer || params.actionId!.startsWith('mcp.') ? 'mcp' : 'author',
        mcpAllowedEffects,
        admittedMcpClient?.projectIds,
        resolveNativeProposalActor,
      );
      const descriptor = descriptors.find(item => item.id === actionId);
      if (!descriptor && admittedMcpClient) {
        const completeDescriptors = await listActionDescriptors(
          projectId,
          signal,
          'mcp',
          undefined,
          admittedMcpClient.projectIds,
          resolveNativeProposalActor,
        );
        const requestedDescriptor = completeDescriptors.find(item => item.id === actionId);
        if (requestedDescriptor) requireMcpEffect(requestedDescriptor.effect);
      }
      if (!descriptor) throw httpFailure(404, 'ACTION_NOT_FOUND', `Action ${actionId} is unavailable`);
      if (isBearer && !['read', 'compute', 'propose'].includes(descriptor.effect))
        throw httpFailure(403, 'BEARER_EFFECT_DENIED', 'Bearer credentials may only invoke read, compute, and propose actions');
      requireMcpEffect(descriptor.effect);
      let boundSnapshot: SnapshotId | undefined;
      if (body.snapshot !== undefined) {
        const selected = body.snapshot;
        if (
          !isRecord(selected) ||
          selected.projectId !== projectId ||
          !Number.isSafeInteger(selected.projectVersion) ||
          (selected.projectVersion as number) < 1
        ) {
          throw httpFailure(400, 'INVALID_SNAPSHOT', 'A project-bound PostgreSQL version is required');
        }
        boundSnapshot = selected as unknown as SnapshotId;
      }
      const reader = await freshReader(projectId, boundSnapshot);
      const source =
        descriptor.module === 'core' ? (isBearer ? 'mcp' : 'author') : isBearer || descriptor.module === 'mcp' ? 'mcp' : 'module';
      const prefer = request.headers.prefer;
      const respondAsyncRequested =
        isAuthor &&
        (Array.isArray(prefer) ? prefer : [prefer ?? ''])
          .flatMap(value => value.split(','))
          .some(value => value.trim().toLowerCase() === 'respond-async');
      const jobController = respondAsyncRequested && descriptor.module !== 'core' ? new AbortController() : undefined;
      let domainJobId: string | undefined;
      let resolveDomainJobStart!: (id: string) => void;
      const domainJobStarted = new Promise<string>(resolveStarted => {
        resolveDomainJobStart = resolveStarted;
      });
      const abortBeforeAcceptance = (): void => {
        if (!domainJobId) jobController?.abort(signal.reason ?? new Error('The action request was cancelled before job registration'));
      };
      if (jobController) {
        asyncDomainJobControllers.add(jobController);
        if (signal.aborted) abortBeforeAcceptance();
        else signal.addEventListener('abort', abortBeforeAcceptance, { once: true });
      }
      const actionSignal = jobController?.signal ?? signal;
      const host = actionHost(
        projectId,
        reader,
        actionSignal,
        source,
        'owner',
        id => {
          domainJobId = id;
          signal.removeEventListener('abort', abortBeforeAcceptance);
          resolveDomainJobStart(id);
        },
        authorizeActionProposal,
        'owner',
        mcpAllowedEffects,
        admittedMcpClient?.projectIds,
        resolveNativeProposalActor,
        canReviewPrivateChangeSets,
        resolvePublishingAuthor,
      );
      if (descriptor.module === 'core') {
        const coreAction = host.actions?.find(({ action }) => action.id === descriptor.id)?.action;
        if (!coreAction) throw httpFailure(404, 'ACTION_NOT_FOUND', `Action ${actionId} is unavailable`);
        const moduleContext: ModuleActionContext = {
          projectId,
          reader,
          signal,
          invoke: async () => ({
            ok: false,
            snapshot: reader.snapshot,
            error: { code: 'ACTION_UNAVAILABLE', message: 'Core host actions cannot dispatch module actions', retryable: false },
          }),
          listActions: async () => descriptors,
          linkedReader: async (repositoryId: string) => host.linkedReader!(repositoryId),
          propose: async (operations, evidence, proposalId) => {
            if (coreAction.effect !== 'propose')
              throw httpFailure(403, 'ACTION_EFFECT_DENIED', 'Read-only Core actions cannot propose changes');
            return host.propose(operations, evidence, proposalId, signal);
          },
          runJob: async request => ({
            ok: false,
            id: request.id,
            snapshot: reader.snapshot,
            error: { code: 'ACTION_EFFECT_DENIED', message: 'Core host actions cannot run jobs', retryable: false },
          }),
        };
        let input: unknown;
        try {
          input = coreAction.inputSchema.parse(body.input);
        } catch (error) {
          json(200, {
            ok: false,
            snapshot: reader.snapshot,
            error: {
              code: 'invalid_action_input',
              message: error instanceof Error ? error.message.slice(0, 512) : 'Action input is invalid',
              retryable: false,
            },
          } satisfies ActionResult);
          return;
        }
        let result = await coreAction.invoke(input, moduleContext);
        if (result.ok) {
          try {
            result = { ...result, data: coreAction.outputSchema.parse(result.data) };
          } catch (error) {
            result = {
              ok: false,
              snapshot: reader.snapshot,
              error: {
                code: 'invalid_action_result',
                message: error instanceof Error ? error.message.slice(0, 512) : 'Action result is invalid',
                retryable: false,
              },
            };
          }
        }
        json(200, result);
        return;
      }
      const invocation = runtime.invokeAction(descriptor.module, actionId, body.input, host);
      const settledInvocation = invocation.then(
        result => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      if (jobController) {
        void settledInvocation.then(() => {
          asyncDomainJobControllers.delete(jobController);
          signal.removeEventListener('abort', abortBeforeAcceptance);
        });
      }
      if (respondAsyncRequested) {
        const outcome = await Promise.race([
          domainJobStarted.then(id => ({ kind: 'started' as const, id })),
          settledInvocation.then(settled => ({ kind: 'settled' as const, settled })),
        ]);
        if (outcome.kind === 'started') {
          const job = await jobHistory.getJob(outcome.id);
          if (!job) throw httpFailure(503, 'JOB_HISTORY_UNAVAILABLE', 'The registered job could not be read back');
          response.setHeader('X-Codexia-Job-Id', job.id);
          response.setHeader('Location', `/api/jobs/${encodeURIComponent(job.id)}`);
          response.setHeader('Preference-Applied', 'respond-async');
          json(202, job);
          return;
        }
        if (outcome.settled.kind === 'error') throw outcome.settled.error;
        if (domainJobId) response.setHeader('X-Codexia-Job-Id', domainJobId);
        json(200, outcome.settled.result);
        return;
      }
      const outcome = await settledInvocation;
      if (outcome.kind === 'error') throw outcome.error;
      if (domainJobId) response.setHeader('X-Codexia-Job-Id', domainJobId);
      json(200, outcome.result);
      return;
    },
    manuscript_snapshots_get: async ({ params, query, projectId, json }) => {
      if (!coreStore.listManuscriptSnapshots)
        throw httpFailure(503, 'SNAPSHOT_HISTORY_UNAVAILABLE', 'Manuscript snapshot history is not available in this Core version');
      const selected = optionalSnapshot(query, projectId);
      const sceneId = query.get('sceneId') ?? undefined;
      if (sceneId !== undefined && (!sceneId || sceneId.length > 256)) throw httpFailure(400, 'INVALID_ID', 'Scene identifier is invalid');
      json(200, await coreStore.listManuscriptSnapshots(projectId, params.manuscriptId!, sceneId, selected.pinned));
      return;
    },
    manuscript_snapshot_get: async ({ response, params, query, projectId, json }) => {
      if (!coreStore.readManuscriptSnapshot)
        throw httpFailure(503, 'SNAPSHOT_HISTORY_UNAVAILABLE', 'Manuscript snapshot history is not available in this Core version');
      const selected = optionalSnapshot(query, projectId);
      const snapshotId = params.snapshotId!;
      if (!isPostgresRevisionId(snapshotId))
        throw httpFailure(400, 'INVALID_SNAPSHOT', 'Manuscript revision ID must be a canonical PostgreSQL revision UUID');
      const result = await coreStore.readManuscriptSnapshot(projectId, snapshotId, params.manuscriptId!, undefined, selected.pinned);
      if (!result)
        throw httpFailure(
          404,
          'MANUSCRIPT_SNAPSHOT_NOT_FOUND',
          'Manuscript revision is not reachable from the selected PostgreSQL project version',
        );
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SNAPSHOT_BYTES)
        throw httpFailure(413, 'SNAPSHOT_TOO_LARGE', 'Manuscript snapshot exceeds the response size limit');
      json(200, result);
      return;
    },
    project_search_get: async ({ query, projectId, json }) => {
      const term = query.get('q') ?? '';
      if (!term.trim() || term.length > 512) throw httpFailure(400, 'INVALID_QUERY', 'A search query from 1 to 512 characters is required');
      const limit = boundedInt(query.get('limit'), 20, 1, 100);
      const selected = optionalSnapshot(query, projectId);
      json(200, await searchSnapshot(projectId, term, limit, selected));
      return;
    },
    project_writing_stats_get: async ({ query, projectId, json }) => {
      const selected = optionalSnapshot(query, projectId);
      json(200, await writingStatsSnapshot(projectId, selected));
      return;
    },
    project_recent_activity_get: async ({ projectId, isAuthor, json, reject }) => {
      if (!isAuthor) {
        reject(403, 'AUTHOR_SESSION_REQUIRED', 'Recent activity requires an owner identity');
        return;
      }
      const activityAuthorScope = 'owner';

      try {
        json(200, { items: await recentActivity.list(activityAuthorScope, projectId) });
        return;
      } catch (error) {
        if (isHttpFailure(error)) throw error;
        throw httpFailure(503, 'RECENT_ACTIVITY_UNAVAILABLE', 'Recent activity history is temporarily unavailable');
      }
    },
    project_recent_activity_put: async ({ request, parsedBody, projectId, isAuthor, json, reject }) => {
      if (!isAuthor) {
        reject(403, 'AUTHOR_SESSION_REQUIRED', 'Recent activity requires an owner identity');
        return;
      }
      const activityAuthorScope = 'owner';

      try {
        const input = parseRecentActivityInput(parsedBody);
        const header = request.headers['x-codexia-recent-activity-order'];
        let order: { writer: string; sequence: number } | undefined;
        if (header !== undefined) {
          const match =
            typeof header === 'string'
              ? /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([1-9][0-9]{0,15})$/u.exec(header)
              : null;
          const sequence = Number(match?.[2]);
          if (!match || !Number.isSafeInteger(sequence))
            throw httpFailure(400, 'INVALID_RECENT_ACTIVITY', 'Recent activity order is invalid');
          order = { writer: match[1]!, sequence };
        }
        json(200, { items: await recentActivity.upsert(activityAuthorScope, projectId, input, order) });
        return;
      } catch (error) {
        if (isHttpFailure(error)) throw error;
        throw httpFailure(503, 'RECENT_ACTIVITY_UNAVAILABLE', 'Recent activity history is temporarily unavailable');
      }
    },
    auth_consent_context_post: async ({ request, parsedBody, json, reject }) => {
      if (!sameOrigin(request, trustProxy)) {
        reject(403, 'CROSS_ORIGIN_REQUEST', 'OAuth consent context requires a same-origin request');
        return;
      }
      const body = parsedBody;
      if (!isRecord(body) || !hasOnlyKeys(body, new Set(['oauth_query'])) || typeof body.oauth_query !== 'string' || !body.oauth_query) {
        reject(400, 'OAUTH_CONSENT_CONTEXT_INVALID', 'OAuth consent context request is invalid');
        return;
      }
      try {
        const context = await options.betterAuth!.getConsentContext(options.betterAuth!.toHeaders(request.headers), body.oauth_query);
        json(200, context);
      } catch {
        reject(request.headers.cookie ? 403 : 401, 'OAUTH_CONSENT_CONTEXT_DENIED', 'OAuth consent context could not be verified');
      }
      return;
    },
    owner_setup_status_get: async ({ request, response, json, crossOrigin }) => {
      response.setHeader('Cache-Control', 'no-store');
      if (crossOrigin || request.headers.authorization !== undefined) {
        json(403, { code: 'SETUP_SAME_ORIGIN_REQUIRED' });
        return;
      }
      json(200, { state: 'active' });
      return;
    },
    owner_session_confirm_post: async ({ request, json, reject }) => {
      if (!sameOrigin(request, trustProxy)) {
        reject(403, 'CROSS_ORIGIN_REQUEST', 'Owner session confirmation requires the exact same origin');
        return;
      }
      if (request.headers.authorization !== undefined) {
        reject(403, 'OWNER_SESSION_COOKIE_REQUIRED', 'Owner session confirmation does not accept bearer credentials');
        return;
      }
      const result = await options.betterAuth!.checkOwnerSession(options.betterAuth!.toHeaders(request.headers));
      if (result.status === 200) json(200, { authenticated: true });
      else if (result.status === 403) reject(403, 'OWNER_SESSION_REQUIRED', 'Owner session confirmation was denied');
      else reject(401, 'AUTHENTICATION_REQUIRED', 'A valid owner session is required');
      return;
    },
    auth_list_consents_get: async ({ request, json, reject, crossOrigin }) => {
      if (crossOrigin) {
        reject(403, 'CROSS_ORIGIN_REQUEST', 'OAuth consent listing requires a same-origin request');
        return;
      }
      const result = await options.betterAuth!.listOwnerOAuthConsents(options.betterAuth!.toHeaders(request.headers));
      if (result.status === 200) json(200, result.consents);
      else reject(result.status, 'OAUTH_CONSENT_LIST_DENIED', 'OAuth consent listing requires the owner session');
      return;
    },
    authorizationServerMetadata: async ({ request, reply }) => {
      const metadataRequest = new Request(
        `${requestProtocol(request, trustProxy)}//${request.headers.host ?? 'localhost'}${request.url ?? '/'}`,
        { headers: options.betterAuth!.toHeaders(request.headers) },
      );
      const metadata = await options.betterAuth!.advertisePublicClientTokenAuth(
        await options.betterAuth!.authorizationServerMetadata(metadataRequest),
      );
      await sendWebResponse(reply, metadata);
      return;
    },
    openIdConfigMetadata: async ({ request, reply }) => {
      const metadataRequest = new Request(
        `${requestProtocol(request, trustProxy)}//${request.headers.host ?? 'localhost'}${request.url ?? '/'}`,
        { headers: options.betterAuth!.toHeaders(request.headers) },
      );
      const metadata = await options.betterAuth!.advertisePublicClientTokenAuth(
        await options.betterAuth!.openIdConfigMetadata(metadataRequest),
      );
      await sendWebResponse(reply, metadata);
      return;
    },
    protectedResourceMetadata: async ({ reply }) => {
      await sendWebResponse(reply, createMcpProtectedResourceMetadataResponse(oauthMcpMetadata!));
      return;
    },
    betterAuthWeb: async ({ request, reply, parsedBody, signal }) => {
      const host = request.headers.host ?? 'localhost';
      const authUrl = `${requestProtocol(request, trustProxy)}//${host}${request.url ?? '/'}`;
      const headers = options.betterAuth!.toHeaders(request.headers);
      headers.delete('connection');
      headers.delete('content-length');
      headers.delete('host');
      headers.delete('transfer-encoding');
      const authMethod = request.method ?? 'GET';
      let body: BodyInit | undefined;
      if (authMethod !== 'GET' && authMethod !== 'HEAD' && parsedBody !== undefined) {
        body = typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody);
      }
      const authRequest = new Request(authUrl, { method: authMethod, headers, signal, ...(body !== undefined ? { body } : {}) });
      const authResponse = await options.betterAuth!.handler(authRequest);
      const responseHeaders: Record<string, string | string[]> = Object.fromEntries(authResponse.headers.entries());
      const cookies = authResponse.headers.getSetCookie();
      if (cookies.length) responseHeaders['set-cookie'] = cookies;
      await sendWebResponse(reply, authResponse, responseHeaders);
      return;
    },
  };
  const publicHealth = new Set(['/api/health', '/api/ready', '/health/live', '/health/ready', '/health/startup', ...VERSION_PATHS]);
  const responseDeviations = new Set([
    'api_version_get',
    'api_browser_version_get',
    'jobs_list_get',
    'project_modules_get',
    'project_contributions_get',
    'project_history_get',
    'auth_list_consents_get',
  ]);
  const pathMethods = new Map<string, Set<HTTPMethods>>();
  const knownMethods = new Set<HTTPMethods>();
  for (const schema of httpContract.schemas) app.addSchema(schema);

  const register = (
    instance: FastifyInstance,
    method: HTTPMethods,
    url: string,
    handler: Handler,
    contract?: (typeof httpContract.routes)[number],
    policy: AdmissionPolicy = 'public',
  ) => {
    const methods = pathMethods.get(url) ?? new Set<HTTPMethods>();
    methods.add(method);
    knownMethods.add(method);
    pathMethods.set(url, methods);
    const schema = contract && { ...contract.schema };
    if (schema && contract && responseDeviations.has(contract.operationId)) {
      const responses = { ...(schema.response as Record<string, unknown>) };
      delete responses['200'];
      schema.response = responses;
    }
    instance.route({
      method,
      url,
      ...(schema ? { schema } : {}),
      onRequest: async (request, reply) => {
        const input = request.raw;
        const response = reply.raw;
        const params = (request.params ?? {}) as Record<string, string>;
        const query = queryOf(input);
        const crossOrigin = checkOrigin(
          input,
          response,
          url.startsWith('/api/') || url === '/mcp',
          policy === 'mcp' || policy === 'mcp-module',
        );
        checkPathParams(params);
        if (contract?.operationId === 'owner_session_confirm_post' || contract?.operationId === 'auth_consent_context_post') {
          if (!sameOrigin(input, trustProxy))
            throw httpFailure(403, 'CROSS_ORIGIN_REQUEST', 'The authentication operation requires the exact same origin');
        }
        const admission = await admit(input, response, params, query, policy);
        if ((contract?.requestContentTypes.length ?? 0) > 0) {
          const contentType = input.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
          if (!contract!.requestContentTypes.includes(contentType)) {
            throw httpFailure(415, 'JSON_REQUIRED', 'Send a supported request body');
          }
        }
        routeContexts.set(request, { ...admission, params, query, crossOrigin });
      },
      handler: async (request, reply) => {
        const admission = routeContexts.get(request)!;
        const json: SendJson = (status, value) => {
          void reply.code(status).type('application/json; charset=utf-8').send(value);
        };
        try {
          await handler({
            ...admission,
            request: request.raw,
            response: reply.raw,
            reply,
            parsedBody: request.body,
            json,
            reject: (status, code, message) => json(status, { error: message, code }),
          });
        } catch (error) {
          if (reply.raw.headersSent || reply.sent) {
            reply.raw.destroy(error instanceof Error ? error : undefined);
          } else {
            throw error;
          }
        }
      },
    });
  };

  const ownerSetupOnly = new Set(['owner_setup_authorize_post', 'owner_setup_profile_post', 'owner_setup_complete_post']);
  const authAdapters = new Set([
    'auth_methods_get',
    'auth_consent_context_post',
    'auth_list_consents_get',
    'owner_session_confirm_post',
    'owner_setup_status_get',
  ]);
  handlers.auth_methods_get = handlers.betterAuthWeb!;
  handlers.api_browser_version_get = handlers.api_version_get!;

  const invokeContribution =
    (
      contribution: Pick<FastifyHttpContributionRoute, 'moduleId' | 'contributionId' | 'effect' | 'access' | 'relativePath'>,
      mcpStreamableRoute: boolean,
    ): Handler =>
    async ({
      request,
      reply,
      response,
      params,
      projectId,
      admittedMcpClient,
      isBearer,
      requireMcpEffect,
      mcpAllowedEffects,
      authorizeActionProposal,
      resolveNativeProposalActor,
      canReviewPrivateChangeSets,
      resolvePublishingAuthor,
      signal,
      parsedBody,
    }) => {
      if (signal.aborted) return;
      const { moduleId, contributionId, effect } = contribution;
      const relativePath = contribution.relativePath
        .split('/')
        .map(segment => {
          if (!segment.startsWith(':')) return segment;
          const param = params[segment.slice(1)];
          if (!param || !/^[A-Za-z0-9._~-]{1,256}$/u.test(param))
            throw httpFailure(404, 'MODULE_ROUTE_UNAVAILABLE', 'Module route is unavailable');
          return param;
        })
        .join('/');
      try {
        await runtime.activate(moduleId);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code === 'module_disabled' || code === 'redeployment_required' || code === 'unknown_module_id') {
          throw httpFailure(404, 'MODULE_ROUTE_UNAVAILABLE', 'Module route is unavailable');
        }
        throw error;
      }
      if (contribution.access === 'public') {
        if (!(await findAuthorizedProject(projectId))) throw httpFailure(404, 'PROJECT_NOT_FOUND', 'Public project was not found');
        if (!runtime.invokeHttp)
          throw httpFailure(503, 'MODULE_HTTP_UNAVAILABLE', 'The runtime does not support HTTP module contributions');
        const reader = await freshReader(projectId);
        const host = actionHost(projectId, reader, signal, 'module', 'public');
        const result = await runtime.invokeHttp(moduleId, contributionId, makeWebRequest(request, parsedBody, signal, relativePath), host);
        reply.hijack();
        await serveModuleResponse(result, response, signal, true);
        return;
      }
      if (admittedMcpClient && moduleId !== 'mcp') {
        throw httpFailure(403, 'OAUTH_MCP_MODULE_DENIED', 'Standalone MCP clients may only use the MCP transport route');
      }
      if (!runtime.invokeHttp) throw httpFailure(503, 'MODULE_HTTP_UNAVAILABLE', 'The runtime does not support HTTP module contributions');
      if (admittedMcpClient && !mcpStreamableRoute) requireMcpEffect(effect);
      const reader = await freshReader(projectId);
      let domainJobId: string | undefined;
      const host = actionHost(
        projectId,
        reader,
        signal,
        isBearer || moduleId === 'mcp' ? 'mcp' : 'module',
        'owner',
        id => {
          domainJobId = id;
        },
        authorizeActionProposal,
        'owner',
        mcpAllowedEffects,
        admittedMcpClient?.projectIds,
        resolveNativeProposalActor,
        canReviewPrivateChangeSets,
        resolvePublishingAuthor,
      );
      const result = await runtime.invokeHttp(moduleId, contributionId, makeWebRequest(request, parsedBody, signal, relativePath), host);
      if (domainJobId) response.setHeader('X-Codexia-Job-Id', domainJobId);
      reply.hijack();
      await serveModuleResponse(result, response, signal);
    };
  const moduleHttpRoutes = deriveModuleHttpRoutes(runtime.httpRegistrationManifests());
  const contractByRoute = new Map(httpContract.routes.map(route => [`${route.method} ${route.url}`, route]));
  const standaloneMcp = invokeContribution(
    { moduleId: 'mcp', contributionId: 'streamable', effect: 'propose', access: 'owner', relativePath: 'streamable' },
    true,
  );

  const persistenceHandler =
    (route: (typeof httpContract.routes)[number]): Handler =>
    async context => {
      const result = await handlePersistenceOperation(route.operationId, {
        persistence: options.persistence,
        params: context.params,
        query: context.query,
        body: context.parsedBody,
        requestHeaders: context.request.headers,
        canReviewPrivateChangeSets: context.canReviewPrivateChangeSets,
        requireAuthor: context.requireAuthorSession,
      });
      context.json(result.status, result.body);
    };
  for (const route of httpContract.routes) {
    if (route.contractStatus === 'target' || ownerSetupOnly.has(route.operationId) || authAdapters.has(route.operationId)) continue;
    if (
      route.operationId.startsWith('project_mcp_') ||
      route.operationId.startsWith('public_share_') ||
      route.operationId.startsWith('backup_console_')
    ) {
      continue;
    }
    const policy =
      route.url === '/mcp'
        ? 'mcp'
        : publicHealth.has(route.url)
          ? 'public'
          : route.operationId.startsWith('persistence_')
            ? 'persistence'
            : 'api';
    const handler =
      policy === 'mcp'
        ? standaloneMcp
        : policy === 'persistence'
          ? persistenceHandler(route)
          : (handlers[route.operationId] ?? (route.method === 'HEAD' ? handlers[route.operationId.replace(/_head$/u, '_get')] : undefined));
    if (!handler) throw new Error(`No handler registered for ${route.operationId}`);
    register(app, route.method, route.url, handler, route, policy);
  }

  registerBackupConsole(app, options.betterAuth, options.backupConsole, () => shuttingDown);
  if (options.backupConsole?.closeStoreOnShutdown) {
    app.addHook('onClose', () => options.backupConsole!.store.close());
  }

  app.register(async auth => {
    if (!options.betterAuth) return;
    auth.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body));
    for (const route of httpContract.routes) {
      if (authAdapters.has(route.operationId)) register(auth, route.method, route.url, handlers[route.operationId]!, route);
    }
    register(auth, 'GET', '/.well-known/oauth-authorization-server/api/auth', handlers.authorizationServerMetadata!);
    register(auth, 'GET', '/.well-known/openid-configuration/api/auth', handlers.openIdConfigMetadata!);
    for (const [method, url] of BETTER_AUTH_HTTP_ROUTES) register(auth, method, url, handlers.betterAuthWeb!);
  });
  if (oauthMcpMetadataUrl && oauthMcpMetadata) {
    register(app, 'GET', new URL(oauthMcpMetadataUrl).pathname, handlers.protectedResourceMetadata!);
  }
  for (const route of moduleHttpRoutes) {
    const contract = contractByRoute.get(`${route.method} ${route.url}`);
    const mcp = route.moduleId === 'mcp' && route.relativePath === 'streamable';
    register(
      app,
      route.method,
      route.url,
      invokeContribution(route, mcp),
      contract,
      route.access === 'public' ? 'public' : mcp ? 'mcp-module' : 'api',
    );
  }

  app.after(() => {
    for (const [url, methods] of pathMethods) {
      if (!(url.startsWith('/api/') || url === '/mcp')) continue;
      app.options(url, async (request, reply) => {
        const mcp = url === '/mcp' || url === '/api/projects/:projectId/modules/mcp/streamable';
        const crossOrigin = checkOrigin(request.raw, reply.raw, true, mcp);
        const allow = [...methods, 'OPTIONS'].join(', ');
        if (crossOrigin) {
          const requestedMethod = request.headers['access-control-request-method'];
          if (typeof requestedMethod !== 'string' || !methods.has(requestedMethod.toUpperCase() as HTTPMethods)) {
            throw httpFailure(403, 'CORS_METHOD_DENIED', 'Cross-origin API method is not allowed');
          }
          const rawHeaders = request.headers['access-control-request-headers'];
          const requestedHeaders =
            typeof rawHeaders === 'string' && rawHeaders.trim() ? rawHeaders.split(',').map(header => header.trim().toLowerCase()) : [];
          const available = (header: string) => CORS_HEADERS.get(header) ?? (mcp ? MCP_CORS_HEADERS.get(header) : undefined);
          if (requestedHeaders.some(header => !available(header))) {
            throw httpFailure(403, 'CORS_HEADER_DENIED', 'Cross-origin API request headers are not allowed');
          }
          reply.header('Access-Control-Allow-Methods', requestedMethod.toUpperCase());
          if (requestedHeaders.length)
            reply.header('Access-Control-Allow-Headers', [...new Set(requestedHeaders)].map(available).join(', '));
        }
        return reply.code(204).header('Allow', allow).send();
      });
    }
  });
  app.setNotFoundHandler(async (request, reply) => {
    const isMcp = request.url.split('?', 1)[0] === '/mcp';
    checkOrigin(request.raw, reply.raw, request.url.startsWith('/api/') || isMcp, isMcp);
    const methods = [...knownMethods].filter(method => app.findRoute({ method, url: request.url }));
    if (methods.length > 0) {
      reply.header('Allow', methods.join(', '));
      throw httpFailure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }
    const path = requestPath(request.raw);
    if (['GET', 'HEAD'].includes(request.method) && !path.startsWith('/api/') && path !== '/mcp') {
      if (await serveStatic(request.raw, reply.raw, staticDir, STYLE_NONCES.get(request.raw)!)) {
        reply.hijack();
        return;
      }
    }
    throw httpFailure(404, 'NOT_FOUND', 'Route not found');
  });

  // Keep the historical synchronous Node server factory while routing every request through Fastify.
  const server = createHttpServer((request, response) => {
    void Promise.resolve(app.ready())
      .then(() => {
        app.routing(request, response);
      })
      .catch((error: unknown) => sendError(response, error));
  });
  server.once('listening', () => {
    started = true;
  });
  const nodeClose = server.close.bind(server);
  let closePromise: Promise<Error | undefined> | undefined;
  server.close = ((callback?: (error?: Error) => void): Server => {
    if (!closePromise) {
      closed = true;
      shuttingDown = true;
      const beganAt = Date.now();
      let deadlineExpired = false;
      let drainTimer: NodeJS.Timeout | undefined;
      let resolveDeadline!: () => void;
      const deadline = new Promise<void>(resolveDeadlinePromise => {
        resolveDeadline = resolveDeadlinePromise;
      });
      const forceClose = () => {
        if (deadlineExpired) return;
        deadlineExpired = true;
        for (const controller of requestControllers) controller.abort(new Error('The API drain deadline expired'));
        server.closeAllConnections();
        resolveDeadline();
      };
      for (const controller of requestControllers) controller.abort(new Error('The API server is shutting down'));
      projectEventStreams.close();
      jobEventStreams.close();
      const nodeDrain = new Promise<Error | undefined>(resolveNode => nodeClose((error?: Error) => resolveNode(error)));
      const runtimeDrain = shutdownRuntime().then(
        () => undefined,
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error('Module runtime shutdown failed');
          console.error('Codexia module runtime shutdown failed', error);
          return failure;
        },
      );
      drainTimer = setTimeout(forceClose, API_DRAIN_TIMEOUT_MS);
      drainTimer.unref();
      closePromise = (async () => {
        let closeError: Error | undefined;
        const nodeOutcome = await Promise.race([nodeDrain.then(error => ({ error })), deadline.then(() => ({ timedOut: true as const }))]);
        if ('error' in nodeOutcome) closeError ??= nodeOutcome.error;
        const runtimeOutcome = await Promise.race([
          runtimeDrain.then(error => ({ error })),
          deadline.then(() => ({ timedOut: true as const })),
        ]);
        if ('error' in runtimeOutcome) closeError ??= runtimeOutcome.error;
        if (deadlineExpired || 'timedOut' in nodeOutcome || 'timedOut' in runtimeOutcome) {
          forceClose();
          console.warn(`Codexia API shutdown exceeded ${API_DRAIN_TIMEOUT_MS} ms; remaining HTTP connections were closed.`);
        }

        const appClose = app.close().then(
          () => undefined,
          (error: unknown) => {
            closeError ??= error instanceof Error ? error : new Error('Fastify shutdown failed');
          },
        );
        if (!deadlineExpired) {
          const appClosed = await Promise.race([appClose.then(() => true), deadline.then(() => false)]);
          if (!appClosed) {
            forceClose();
            closeError ??= new Error('API shutdown deadline expired');
          }
        }
        if (drainTimer) clearTimeout(drainTimer);
        return closeError;
      })().catch((error: unknown) => (error instanceof Error ? error : new Error('API shutdown failed')));
    }
    if (callback) void closePromise.then(error => callback(error));
    return server;
  }) as Server['close'];
  Object.defineProperty(server, 'codexia', { value: { fastify: app, runtime, profile }, enumerable: false });
  return server;
}

function parsePositivePort(value: string | undefined): number {
  if (!value) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return port;
}

export async function start(options?: ApiServerOptions): Promise<Server> {
  if (options) return startServer(options);
  const corsOriginsValue = readCodexiaEnvironment('CORS_ALLOWED_ORIGINS');
  const deprecatedSettings = [
    'AUTH_TOKEN',
    'AUTH_TOKEN_FILE',
    'BROWSER_AUTH',
    'ACCESS_ISSUER',
    'ACCESS_AUDIENCE',
    'ACCESS_ORIGIN',
    'ACCESS_OWNER_EMAIL',
    'OAUTH_ISSUER',
    'OAUTH_AUDIENCE',
    'OAUTH_JWKS_URL',
  ];
  if (deprecatedSettings.some(setting => readCodexiaEnvironment(setting) !== undefined)) {
    throw new Error('Standalone authentication supports only Better Auth settings');
  }
  const configuredAuthMode = readCodexiaEnvironment('AUTH_MODE');
  if (configuredAuthMode === 'setup-only') {
    const { createOwnerSetupApp, readOwnerSetupConfig } = await import('./owner-setup.js');
    const { config, redirects } = readOwnerSetupConfig();
    const app = createOwnerSetupApp(config, redirects);
    try {
      await app.verifySchema();
      await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: parsePositivePort(process.env.PORT) });
      app.server.once('close', () => {
        void app.close();
      });
      return app.server;
    } catch (error) {
      await app.close();
      throw error;
    }
  }
  if (configuredAuthMode !== undefined && configuredAuthMode !== 'better-auth') {
    throw new Error('CODEXIA_AUTH_MODE must be better-auth or setup-only');
  }
  const { CoreStore, SNAPSHOT_PROJECTION_EPOCH } = await import('@codexia/core');
  const betterAuthValues = {
    databaseUrl: readCodexiaEnvironment('AUTH_DATABASE_URL'),
    publicOrigin: readCodexiaEnvironment('PUBLIC_ORIGIN'),
    oidcIssuer: readCodexiaEnvironment('OIDC_ISSUER'),
    oidcClientId: readCodexiaEnvironment('OIDC_CLIENT_ID'),
    oidcClientSecret: readCodexiaEnvironment('OIDC_CLIENT_SECRET'),
    authSecret: readCodexiaEnvironment('AUTH_SECRET'),
    introspectionClientId: readCodexiaEnvironment('OAUTH_INTROSPECTION_CLIENT_ID'),
    introspectionClientSecret: readCodexiaEnvironment('OAUTH_INTROSPECTION_CLIENT_SECRET'),
    ownerSubject: readCodexiaEnvironment('OAUTH_OWNER_SUBJECT'),
    ownerClientIds: readCodexiaEnvironment('OAUTH_OWNER_CLIENT_IDS'),
    mcpClientIds: readCodexiaEnvironment('OAUTH_MCP_CLIENT_IDS'),
    mcpProjectAssignments: readCodexiaEnvironment('OAUTH_MCP_PROJECT_ASSIGNMENTS'),
    apiAudience: readCodexiaEnvironment('API_AUDIENCE'),
  };
  const betterAuthOidcSettings = resolveBetterAuthOidcSettings({
    oidcIssuer: betterAuthValues.oidcIssuer,
    oidcClientId: betterAuthValues.oidcClientId,
    oidcClientSecret: betterAuthValues.oidcClientSecret,
  });
  const requiredBetterAuthValues = [
    betterAuthValues.databaseUrl,
    betterAuthValues.publicOrigin,
    betterAuthValues.authSecret,
    betterAuthValues.introspectionClientId,
    betterAuthValues.introspectionClientSecret,
    betterAuthValues.ownerSubject,
    betterAuthValues.ownerClientIds,
  ];
  if (requiredBetterAuthValues.some(value => !value)) {
    throw new Error(
      'Standalone Better Auth requires AUTH_DATABASE_URL, PUBLIC_ORIGIN, AUTH_SECRET, OAUTH_INTROSPECTION_CLIENT_ID, OAUTH_INTROSPECTION_CLIENT_SECRET, OAUTH_OWNER_SUBJECT, and OAUTH_OWNER_CLIENT_IDS',
    );
  }
  const mcpClientIds = (betterAuthValues.mcpClientIds ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const mcpProjectAssignments = parseOAuthMcpProjectAssignments(betterAuthValues.mcpProjectAssignments, mcpClientIds);
  const ownerClientIds = betterAuthValues
    .ownerClientIds!.split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const { createBetterAuthRuntime } = await import('./better-auth.js');
  const betterAuth = createBetterAuthRuntime({
    databaseUrl: betterAuthValues.databaseUrl!,
    publicOrigin: betterAuthValues.publicOrigin!,
    ...betterAuthOidcSettings,
    authSecret: betterAuthValues.authSecret!,
    oauthIntrospectionClientId: betterAuthValues.introspectionClientId!,
    oauthIntrospectionClientSecret: betterAuthValues.introspectionClientSecret!,
    ownerSubject: betterAuthValues.ownerSubject!,
    ...(betterAuthValues.apiAudience ? { apiAudience: betterAuthValues.apiAudience } : {}),
    ownerClientIds,
    mcpClientIds,
  });
  let persistenceOptions: Awaited<ReturnType<typeof postgresPersistenceOptions>> | undefined;
  let backupConsole: BackupConsoleOptions | undefined;
  try {
    await verifyAuthSchema(betterAuth.pool);
    const { installedSetupOwner } = await import('./owner-setup-store.js');
    await installedSetupOwner(betterAuth.pool, betterAuthValues.ownerSubject);
    await betterAuth.assertRegisteredClients();
    await betterAuth.verifyIntrospectionCredentials();
    const oauthOwner: OAuthOwnerOptions = {
      issuer: betterAuth.issuer,
      audience: betterAuth.audience,
      jwksUrl: `${betterAuth.issuer}/jwks`,
      ownerSubject: betterAuthValues.ownerSubject!,
      requiredScopes: (readCodexiaEnvironment('OAUTH_REQUIRED_SCOPES') ?? CODEXIA_OWNER_SCOPE).split(/\s+/u).filter(Boolean),
      allowedClientIds: ownerClientIds,
      verifyActiveToken: betterAuth.verifyActiveAccessToken,
    };
    const oauthMcp: OAuthMcpOptions | undefined =
      betterAuth.mcpClientIds.length > 0
        ? {
            issuer: betterAuth.issuer,
            audience: betterAuth.audience,
            jwksUrl: `${betterAuth.issuer}/jwks`,
            verifyActiveToken: betterAuth.verifyActiveAccessToken,
            allowedClientIds: betterAuth.mcpClientIds,
            projectIdsByClient: mcpProjectAssignments,
            ownerClientIds,
            ownerSubject: betterAuthValues.ownerSubject!,
          }
        : undefined;
    const corsAllowedOrigins: string[] | undefined =
      corsOriginsValue === undefined
        ? undefined
        : corsOriginsValue
            .split(',')
            .map(origin => origin.trim())
            .filter(Boolean);
    if (corsOriginsValue !== undefined && corsAllowedOrigins?.length === 0) {
      throw new Error('CODEXIA_CORS_ALLOWED_ORIGINS must contain at least one exact HTTPS origin');
    }
    const profile = readCodexiaEnvironment('PROFILE') ?? process.env.CODEXIA_BUILD_PROFILE ?? 'core';
    const runtimeOptions = await loadProfileRuntimeOptions(profile);
    persistenceOptions = await postgresPersistenceOptions();
    if (Object.keys(mcpProjectAssignments).length > 0) {
      const missingMcpProjects = await persistenceOptions.persistence!.read(async reader => {
        const missing: string[] = [];
        for (const projectIds of Object.values(mcpProjectAssignments)) {
          for (const projectId of projectIds) {
            const project = await reader.getProject(projectId as import('@codexia/persistence-contracts').ProjectId);
            if (project?.id !== projectId) missing.push(projectId);
          }
        }
        return missing;
      });
      if (missingMcpProjects.length) throw new Error('CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS contains a project that does not exist');
    }
    await assertSnapshotProjectionReady(persistenceOptions.persistence, SNAPSHOT_PROJECTION_EPOCH);
    const store = new CoreStore({ persistence: persistenceOptions.persistence });
    backupConsole = loadBackupConsole();
    return await startServer({
      ...(backupConsole ? { backupConsole } : {}),
      store,
      ...persistenceOptions,
      oauthOwner,
      ...(oauthMcp ? { oauthMcp } : {}),
      betterAuth,
      closeBetterAuthOnShutdown: true,
      ...(corsAllowedOrigins ? { corsAllowedOrigins } : {}),
      trustProxy: readCodexiaEnvironment('TRUST_PROXY') === '1',
      runtimeOptions,
      profile,
    });
  } catch (error) {
    await backupConsole?.store.close().catch(() => undefined);
    await persistenceOptions?.persistence?.close().catch(() => undefined);
    await betterAuth.pool.end().catch(() => undefined);
    throw error;
  }
}

async function assertSnapshotProjectionReady(persistence: PostgresPersistence, projectionEpoch: number): Promise<void> {
  await persistence.snapshotStartupMode();
  const selection = { limit: 10 };
  const [unprovenSnapshots, unmigratedPublishing, unmigratedNlpSettings] = await Promise.all([
    persistence.findUnprovenCurrentSnapshotProjectIds(projectionEpoch, selection),
    persistence.findUnmigratedPublishingProjectIds(selection),
    persistence.findUnmigratedNlpFeatureSettingsProjectIds(selection),
  ]);
  const pending = [...new Set([...unprovenSnapshots, ...unmigratedPublishing, ...unmigratedNlpSettings])];
  if (pending.length > 0) {
    const maintenanceScript = fileURLToPath(new URL('./maintain-snapshot-projections.js', import.meta.url)).replaceAll("'", "'\\''");
    throw new Error(
      `SNAPSHOT_PROJECTION_MAINTENANCE_REQUIRED: PostgreSQL projects ${pending.join(', ')} require maintenance for snapshot projections, Publishing records, or NLP feature settings. ` +
        `Run node '${maintenanceScript}' --check, then replace --check with --apply using the PostgreSQL writer before starting Codexia.`,
    );
  }
}

async function postgresReady(persistence: Persistence | undefined): Promise<boolean> {
  if (!persistence?.checkHealth) return false;
  try {
    await persistence.checkHealth();
    return true;
  } catch {
    return false;
  }
}

async function postgresPersistenceOptions() {
  const connectionString = readCodexiaEnvironment('DATABASE_URL');
  // PostgreSQL is the only manuscript authority; startup never has a local or Git fallback.
  if (!connectionString) {
    throw new Error('CODEXIA_DATABASE_URL is required for Codexia authoring');
  }
  const migrateOnStart = readCodexiaEnvironment('DATABASE_MIGRATE_ON_START');
  if (migrateOnStart !== undefined && migrateOnStart !== '0' && migrateOnStart !== '1') {
    throw new Error('CODEXIA_DATABASE_MIGRATE_ON_START must be 1 or 0');
  }
  if (migrateOnStart === '1') await migratePostgresDatabase(connectionString);
  // A healthy connection alone cannot prove that this image supports the deployed schema.
  await verifyPostgresSchema(connectionString);
  const persistence = createPostgresPersistence(connectionString);
  try {
    await persistence.checkHealth();
  } catch (error) {
    await persistence.close();
    throw new Error('Codexia PostgreSQL is unavailable at startup', { cause: error });
  }
  return { persistence, closePersistenceOnShutdown: true };
}

async function loadProfileRuntimeOptions(profile: string): Promise<Omit<ModuleRuntimeOptions, 'cacheDirectory'>> {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(profile)) throw new Error('CODEXIA_PROFILE must be a valid profile name');
  const generated =
    readCodexiaEnvironment('MODULE_PROFILE_PATH') ??
    process.env.CODEXIA_BUILD_MODULE_PROFILE_PATH ??
    resolve(process.cwd(), 'profiles', profile, 'generated/server.mjs');
  let composition:
    | {
        profile?: unknown;
        moduleManifests?: ModuleRuntimeOptions['manifests'];
        moduleLoaders?: ModuleRuntimeOptions['loaders'];
        moduleDirectories?: ModuleRuntimeOptions['moduleDirectories'];
        moduleWorkerEntries?: ModuleRuntimeOptions['workerEntries'];
      }
    | undefined;
  try {
    composition = (await import(pathToFileURL(generated).href)) as typeof composition;
  } catch (error) {
    if (profile === 'core' && (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      return { manifests: [], enabled: [] };
    }
    throw new Error(
      `Unable to load trusted ${profile} module composition from ${generated}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (composition?.profile !== profile || !Array.isArray(composition.moduleManifests))
    throw new Error(`Generated composition does not match profile ${profile}`);
  const enabledByEnvironment = readCodexiaEnvironment('ENABLED_MODULES');
  const enabled =
    enabledByEnvironment === undefined
      ? composition.moduleManifests.map(manifest => manifest.id)
      : enabledByEnvironment
          .split(',')
          .map(id => id.trim())
          .filter(Boolean);
  if (new Set(enabled).size !== enabled.length || enabled.some(id => !composition!.moduleManifests!.some(manifest => manifest.id === id))) {
    throw new Error('Requested enabled module set does not match the immutable composition');
  }
  return {
    manifests: composition.moduleManifests,
    enabled,
    loaders: composition.moduleLoaders,
    moduleDirectories: composition.moduleDirectories,
    workerEntries: composition.moduleWorkerEntries,
  };
}

async function startServer(options: ApiServerOptions): Promise<Server> {
  const usageDirectory = resolveUsageDirectory(options.usageDirectory);
  await assertCurrentJobHistory(usageDirectory);
  const server = createServer({ ...options, usageDirectory });
  const host = process.env.HOST ?? '127.0.0.1';
  const port = parsePositivePort(process.env.PORT);
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
  console.info(`Codexia is listening on http://${host}:${port}`);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void start().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Codexia failed to start');
    process.exitCode = 1;
  });
}
