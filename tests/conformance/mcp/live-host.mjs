import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CoreStore } from '../../../packages/core/dist/index.js';
import { createPostgresPersistence, migratePostgresDatabase } from '../../../packages/persistence-postgres/dist/index.js';
import { ModuleRuntime } from '../../../packages/module-runtime/dist/index.js';
import { createServer } from '../../../packages/api/dist/server.js';
import { assertDisposableAuthFixtureDatabaseUrl } from '../../../packages/api/test/fixtures/better-auth-server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(root, 'packages/api/package.json'));
const { SignJWT } = await import(apiRequire.resolve('jose'));

export async function startLiveHost(databaseUrl, tempRoot) {
  if (!databaseUrl) throw new Error('CODEXIA_MCP_CONFORMANCE_DATABASE_URL must name a dedicated disposable PostgreSQL database');
  if (process.env.CODEXIA_AUTH_TEST_DISPOSABLE !== '1') throw new Error('CODEXIA_AUTH_TEST_DISPOSABLE=1 is required before database writes');
  if (!/^\/codexia_perf_mcp_conformance(?:_[a-z0-9_]+)?$/u.test(URL.parse(databaseUrl)?.pathname ?? '')) {
    throw new Error('The database must be dedicated to MCP conformance');
  }
  assertDisposableAuthFixtureDatabaseUrl(databaseUrl);
  await migratePostgresDatabase(databaseUrl);
  const persistence = createPostgresPersistence(databaseUrl);
  let runtime;
  let server;
  try {
    const cacheDirectory = resolve(tempRoot, 'module-cache');
    const usageDirectory = resolve(tempRoot, 'host-history');
    const directory = resolve(root, 'modules/mcp');
    const metadata = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(directory, 'package.json'), 'utf8')).codexiaModule;
    runtime = new ModuleRuntime({
      manifests: [metadata], enabled: ['mcp'], moduleDirectories: { mcp: directory },
      loaders: { mcp: async () => (await import(pathToFileURL(resolve(directory, metadata.serverEntry)).href)).createModule({}) },
      cacheDirectory, workerEntries: {},
    });
    const store = new CoreStore({ persistence });
    const project = { id: randomUUID(), title: 'MCP conformance isolated project' };
    const unassignedProject = { id: randomUUID(), title: 'MCP conformance unassigned project' };
    await persistence.transaction(async tx => { await tx.createProject(project); await tx.createProject(unassignedProject); });

    const issuer = 'https://mcp-conformance.codexia.test/api/auth';
  const resource = 'https://mcp-conformance.codexia.test/api';
  const mcpClientId = 'mcp-conformance-client';
  const webClientId = 'mcp-conformance-owner';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mcp-conformance-key', alg: 'RS256', use: 'sig' };
  const active = new Set();
  const issue = async (clientId, scope, { expired = false } = {}) => {
    const token = await new SignJWT({ client_id: clientId, azp: clientId, scope })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: jwk.kid })
      .setIssuer(issuer).setAudience(resource).setSubject('owner').setIssuedAt()
      .setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 30 : '5m').setJti(randomUUID()).sign(privateKey);
    active.add(token);
    return token;
  };
  const publicJwks = { keys: [jwk] };
  const verifier = {
    issuer, audience: resource, ownerSubject: 'owner', jwksUrl: `${issuer}/jwks`,
    fetch: async () => Response.json(publicJwks), verifyActiveToken: async token => active.has(token),
  };
  const options = {
    store, persistence, runtime, staticDir: resolve(root, 'app/dist'), usageDirectory,
    profile: 'mcp-conformance-isolated',
    betterAuth: { issuer, audience: resource },
    oauthOwner: { ...verifier, requiredScopes: ['codexia:api'], allowedClientIds: [webClientId] },
    oauthMcp: { ...verifier, allowedClientIds: [mcpClientId], ownerClientIds: [webClientId], projectIdsByClient: { [mcpClientId]: [project.id] } },
  };
    server = createServer(options);
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); });
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    // Listening opens the socket; the first request waits for Fastify readiness.
    const readiness = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(60_000) }).catch(cause => {
      throw new Error('Live MCP fixture did not become ready', { cause });
    });
    await readiness.body?.cancel();
    if (!readiness.ok) throw new Error(`Live MCP fixture readiness returned HTTP ${readiness.status}`);
    const tokens = {
    full: await issue(mcpClientId, 'mcp:read mcp:compute mcp:propose'),
    read: await issue(mcpClientId, 'mcp:read'),
    owner: await issue(webClientId, 'codexia:api'),
    expired: await issue(mcpClientId, 'mcp:read', { expired: true }),
    wrongScope: await issue(mcpClientId, 'codexia:api'),
  };
    return {
    baseUrl,
    projectId: project.id,
    unassignedProjectId: unassignedProject.id,
    tokens,
    async close() {
      await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
      await runtime.shutdown();
      await persistence.close();
    },
    };
  } catch (error) {
    if (server?.listening) await new Promise(resolveClose => server.close(() => resolveClose()));
    await runtime?.shutdown().catch(() => undefined);
    await persistence.close().catch(() => undefined);
    throw error;
  }
}
