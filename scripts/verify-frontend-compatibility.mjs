#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const shaPattern = /^[a-f0-9]{40}$/u;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} identity */
export function assertFrontendIdentity(identity) {
  assert.ok(record(identity), 'Frontend identity is invalid');
  assert.equal(identity.format, 'codexia-frontend-identity/v1');
  assert.ok(typeof identity.version === 'string' && semver.test(identity.version), 'Frontend version is invalid');
  assert.ok(typeof identity.sourceSha === 'string' && shaPattern.test(identity.sourceSha), 'Frontend source SHA is invalid');
  assert.ok(['core', 'full'].includes(identity.profile), 'Frontend profile is invalid');
  assert.ok(Number.isSafeInteger(identity.apiEpoch) && identity.apiEpoch > 0, 'Frontend API epoch is invalid');
  return identity;
}

/** @param {string} version */
function versionParts(version) {
  assert.ok(typeof version === 'string' && semver.test(version), 'Frontend version is invalid');
  return version.split('.').map(BigInt);
}

/** @param {string} left @param {string} right */
export function compareFrontendVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Returns true when this exact release may replace the currently deployed UI.
 * An identical version/source retry is observed and recorded without replacing assets.
 * @param {unknown} deployed
 * @param {unknown} candidate
 */
export function assertFrontendReleaseAdmission(deployed, candidate) {
  assertFrontendIdentity(deployed);
  assertFrontendIdentity(candidate);
  const order = compareFrontendVersions(candidate.version, deployed.version);
  assert.ok(order >= 0, `Frontend release ${candidate.version} is older than deployed frontend ${deployed.version}`);
  if (order === 0) {
    assert.equal(candidate.sourceSha, deployed.sourceSha, `Frontend version ${candidate.version} is immutable and belongs to a different source`);
    assert.equal(candidate.profile, deployed.profile, `Frontend version ${candidate.version} is immutable and has a different profile`);
    assert.equal(candidate.apiEpoch, deployed.apiEpoch, `Frontend version ${candidate.version} is immutable and has a different API epoch`);
    return false;
  }
  return true;
}

/** @param {unknown} frontend @param {unknown} backend */
export function assertFrontendCompatibility(frontend, backend) {
  assertFrontendIdentity(frontend);
  assert.ok(record(backend), 'Live backend identity is invalid');
  assert.equal(backend.name, 'codexia');
  assert.equal(backend.hosted, false);
  assert.ok(typeof backend.version === 'string' && semver.test(backend.version), 'Live backend version is invalid');
  assert.equal(backend.profile, frontend.profile, 'Backend profile mismatch');
  assert.equal(backend.apiEpoch, frontend.apiEpoch, 'Frontend and backend API epochs are incompatible');
}

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env */
export function readFrontendReleaseConfiguration(env) {
  const configuredOrigin = env.CODEXIA_PUBLIC_ORIGIN;
  if (typeof configuredOrigin !== 'string' || configuredOrigin.length === 0 || configuredOrigin.trim() !== configuredOrigin) {
    throw new Error('CODEXIA_PUBLIC_ORIGIN must be configured as the HTTPS application origin.');
  }

  let origin;
  try {
    origin = new URL(configuredOrigin);
  } catch {
    throw new Error('CODEXIA_PUBLIC_ORIGIN must be configured as the HTTPS application origin.');
  }
  if (origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`) {
    throw new Error('CODEXIA_PUBLIC_ORIGIN must be an HTTPS origin without a path, query, or fragment.');
  }

  const clientId = env.CODEXIA_ACCESS_CLIENT_ID;
  const clientSecret = env.CODEXIA_ACCESS_CLIENT_SECRET;
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.trim() !== clientId ||
      typeof clientSecret !== 'string' || clientSecret.length === 0 || clientSecret.trim() !== clientSecret) {
    throw new Error('CODEXIA_ACCESS_CLIENT_ID and CODEXIA_ACCESS_CLIENT_SECRET must both be configured for the live Access gate.');
  }
  return { origin, clientId, clientSecret };
}

/** @param {string} endpoint @param {URL} origin @param {{clientId:string,clientSecret:string}} credentials @param {typeof fetch} fetchImpl */
async function readLiveJson(endpoint, origin, credentials, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(new URL(endpoint, origin), {
      headers: {
        'CF-Access-Client-Id': credentials.clientId,
        'CF-Access-Client-Secret': credentials.clientSecret,
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Could not reach protected live identity endpoint ${endpoint}; verify CODEXIA_PUBLIC_ORIGIN and the Cloudflare Access service credentials and policy.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Cloudflare Access denied live identity endpoint ${endpoint} (HTTP ${response.status}); verify CODEXIA_ACCESS_CLIENT_ID, CODEXIA_ACCESS_CLIENT_SECRET, and the service-token policy.`);
  }
  if (!response.ok) throw new Error(`Live identity endpoint ${endpoint} is unavailable (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error(`Live identity endpoint ${endpoint} returned invalid JSON.`);
  }
}

/**
 * Checks the built release against the live API and current frontend before mutation.
 * @param {{frontend:unknown, env?:NodeJS.ProcessEnv | Record<string,string|undefined>, fetchImpl?:typeof fetch, mode?:'predeploy'|'deployed'}} options
 */
export async function verifyFrontendCompatibility({ frontend, env = process.env, fetchImpl = fetch, mode = 'predeploy' }) {
  assertFrontendIdentity(frontend);
  assert.equal(frontend.sourceSha, env.GITHUB_SHA, 'Frontend artifact source mismatch');
  assert.equal(frontend.profile, 'full', 'Production frontend artifact must use the Full profile');
  const { origin, clientId, clientSecret } = readFrontendReleaseConfiguration(env);
  const credentials = { clientId, clientSecret };

  if (mode === 'deployed') {
    const deployed = await readLiveJson('/desktop/update-identity.json', origin, credentials, fetchImpl);
    assert.deepEqual(deployed, frontend, 'Deployed frontend identity does not match the tested artifact');
    return { deploy: false, backend: undefined };
  }

  const [backend, deployed] = await Promise.all([
    readLiveJson('/api/version', origin, credentials, fetchImpl),
    readLiveJson('/desktop/update-identity.json', origin, credentials, fetchImpl),
  ]);
  assertFrontendCompatibility(frontend, backend);
  const deploy = assertFrontendReleaseAdmission(deployed, frontend);
  return { deploy, backend };
}

function loadBuiltFrontend() {
  return JSON.parse(readFileSync(new URL('../app/dist/desktop/update-identity.json', import.meta.url), 'utf8'));
}

async function main() {
  const frontend = loadBuiltFrontend();
  const mode = process.argv[2] === 'deployed' ? 'deployed' : 'predeploy';
  const result = await verifyFrontendCompatibility({ frontend, mode });
  if (mode === 'deployed') {
    console.log(`Verified deployed frontend ${frontend.version} from ${frontend.sourceSha}.`);
    return;
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${result.deploy}\n`);
  const backend = result.backend;
  const action = result.deploy ? 'admitted for deployment' : 'already deployed; replacement skipped';
  console.log(`Frontend ${frontend.version} is compatible with deployed backend ${backend.version} (API epoch ${frontend.apiEpoch}) and is ${action}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Frontend compatibility verification failed');
    process.exitCode = 1;
  });
}
