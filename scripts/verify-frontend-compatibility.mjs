#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { IDENTITY_PROBE_PATHS, probeScopedIdentityAccess, readLiveJson } from './update-release-policy.mjs';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const probes = JSON.parse(readFileSync(new URL('../deploy/cloudflare/identity-probes.json', import.meta.url), 'utf8'));
assert.deepEqual({backend:probes.backend.path,frontend:probes.frontend.path},IDENTITY_PROBE_PATHS,'Terraform and shared identity probe paths disagree');

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} identity */
export function assertFrontendIdentity(identity) {
  assert.ok(record(identity), 'Frontend identity is invalid');
  // Node's strict equality assertion includes raw values in its error diff,
  // even with a custom message. Do not disclose untrusted live response fields.
  if (identity.format !== 'codexia-frontend-identity/v1') throw new Error('Frontend identity format is invalid');
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

/** @param {unknown} backend */
export function assertBackendIdentity(backend) {
  assert.ok(record(backend), 'Live backend identity is invalid');
  if (backend.name !== 'codexia') throw new Error('Live backend identity name is invalid');
  if (backend.hosted !== false) throw new Error('Live backend must be standalone');
  assert.ok(typeof backend.version === 'string' && semver.test(backend.version), 'Live backend version is invalid');
  assert.ok(['core', 'full'].includes(backend.profile), 'Live backend profile is invalid');
  assert.ok(Number.isSafeInteger(backend.apiEpoch) && backend.apiEpoch > 0, 'Live backend API epoch is missing or invalid');
  return backend;
}

/** @param {unknown} frontend @param {unknown} backend */
export function assertFrontendCompatibility(frontend, backend) {
  assertFrontendIdentity(frontend);
  assertBackendCompatibility(backend, frontend.profile, frontend.apiEpoch);
}

/** The early release gate uses the same profile/epoch checks as artifact admission. */
export function assertBackendCompatibility(backend, profile, apiEpoch) {
  assertBackendIdentity(backend);
  assert.ok(['core', 'full'].includes(profile), 'Required frontend profile is invalid');
  assert.ok(Number.isSafeInteger(apiEpoch) && apiEpoch > 0, 'Required frontend API epoch is invalid');
  assert.equal(backend.profile, profile, 'Backend profile mismatch');
  assert.equal(backend.apiEpoch, apiEpoch, 'Frontend and backend API epochs are incompatible');
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

/** @param {{env?:NodeJS.ProcessEnv | Record<string,string|undefined>, fetchImpl?:typeof fetch, checkBoundary?:boolean}} options */
export async function probeLiveDeployment({ env = process.env, fetchImpl = fetch, checkBoundary = false } = {}) {
  const { origin, clientId, clientSecret } = readFrontendReleaseConfiguration(env);
  const credentials = { clientId, clientSecret };
  return probeScopedIdentityAccess({origin,credentials,fetchImpl,checkBoundary,validateBackend:assertBackendIdentity,validateFrontend:assertFrontendIdentity});
}

/**
 * Checks the built release against the live API and current frontend before mutation.
 * @param {{frontend:unknown, env?:NodeJS.ProcessEnv | Record<string,string|undefined>, fetchImpl?:typeof fetch, mode?:'predeploy'|'deployed'}} options
 */
export async function verifyFrontendCompatibility({ frontend, env = process.env, fetchImpl = fetch, mode = 'predeploy' }) {
  assertFrontendIdentity(frontend);
  assert.equal(frontend.sourceSha, env.GITHUB_SHA, 'Frontend artifact source mismatch');
  assert.equal(frontend.profile, 'full', 'Production frontend artifact must use the Full profile');
  if (mode === 'deployed') {
    const { origin, clientId, clientSecret } = readFrontendReleaseConfiguration(env);
    const deployed = await readLiveJson(probes.frontend.path, origin, { clientId, clientSecret }, fetchImpl);
    assertFrontendIdentity(deployed);
    if (!isDeepStrictEqual(deployed, frontend)) throw new Error('Deployed frontend identity does not match the tested artifact');
    return { deploy: false, backend: undefined };
  }

  const { backend, deployed } = await probeLiveDeployment({ env, fetchImpl });
  assertFrontendCompatibility(frontend, backend);
  const deploy = assertFrontendReleaseAdmission(deployed, frontend);
  return { deploy, backend };
}

function loadBuiltFrontend() {
  return JSON.parse(readFileSync(new URL('../app/dist/desktop/update-identity.json', import.meta.url), 'utf8'));
}

async function main() {
  if (process.argv[2] === 'preflight') {
    const { backend, deployed } = await probeLiveDeployment({ checkBoundary: true });
    const { apiEpoch } = JSON.parse(readFileSync(new URL('../deploy/frontend-compatibility.json', import.meta.url), 'utf8'));
    assertBackendCompatibility(backend, 'full', apiEpoch);
    console.log(`Verified protected production identities: backend ${backend.version} (epoch ${backend.apiEpoch}), frontend ${deployed.version} (epoch ${deployed.apiEpoch}), candidate API epoch ${apiEpoch}; anonymous identity requests denied; out-of-scope CI requests blocked at Access or the edge.`);
    return;
  }
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
