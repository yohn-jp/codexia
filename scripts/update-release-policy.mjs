// Compatibility functions are pure. Inputs MUST already be authenticated by the
// standalone release publication/verification boundary. This module does not
// establish publisher identity, registry freshness, revocation or deployment authority.
const fields = [
  'format', 'channel', 'state', 'version', 'sourceSha', 'image', 'platform',
  'profile', 'migrationFingerprint', 'persistenceFormat', 'apiEpoch',
];
const digest = /^sha256:[a-f0-9]{64}$/u;
const backendImage = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) {
    throw new Error('Expected a stable semantic version');
  }
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Unsupported version component');
  return parts;
}

export function validateUpdateRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error('Invalid update release fields');
  }
  if (value.format !== 'codexia-update-release/v1' || value.channel !== 'stable' ||
      !['published', 'withdrawn'].includes(value.state)) throw new Error('Invalid release format, channel or state');
  versionParts(value.version);
  if (typeof value.sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(value.sourceSha)) throw new Error('Invalid source revision');
  if (typeof value.image !== 'string' || !backendImage.test(value.image)) throw new Error('Expected an immutable Codexia backend image');
  if (value.platform !== 'linux/amd64' || !['core', 'full'].includes(value.profile)) throw new Error('Unsupported release platform or profile');
  if (typeof value.migrationFingerprint !== 'string' || !digest.test(value.migrationFingerprint)) throw new Error('Invalid migration fingerprint');
  if (!positiveInteger(value.persistenceFormat) || !positiveInteger(value.apiEpoch)) throw new Error('Invalid compatibility epoch');
  return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
}

/**
 * Check an already authenticated candidate against the installed release and
 * deployed UI epoch. Throws on incompatible or non-forward releases.
 * Success is compatibility only, never authorization to activate an image.
 */
function assertForwardRelease(installedValue, candidateValue) {
  const installed = validateUpdateRelease(installedValue);
  const candidate = validateUpdateRelease(candidateValue);
  if (candidate.state !== 'published') throw new Error('Candidate release is withdrawn');
  const [major, minor, patch] = versionParts(installed.version);
  const [nextMajor, nextMinor, nextPatch] = versionParts(candidate.version);
  if (nextMajor !== major || (major === 0 && nextMinor !== minor)) throw new Error('Manual breaking-version update required');
  if (nextMinor < minor || (nextMinor === minor && nextPatch <= patch)) throw new Error('Candidate version must advance');
  if (candidate.image === installed.image || candidate.sourceSha === installed.sourceSha) throw new Error('Candidate must have a new image and source revision');
  if (candidate.profile !== installed.profile || candidate.platform !== installed.platform) throw new Error('Release profile or platform changed');
  if (candidate.migrationFingerprint !== installed.migrationFingerprint) throw new Error('Manual database migration required');
  if (candidate.persistenceFormat !== installed.persistenceFormat) throw new Error('Manual persistent-format update required');
  return { installed, candidate };
}

export function assertCompatibleUpdate(installedValue, candidateValue, deployedUiEpoch) {
  const { installed, candidate } = assertForwardRelease(installedValue, candidateValue);
  if (!positiveInteger(deployedUiEpoch) || installed.apiEpoch !== deployedUiEpoch || candidate.apiEpoch !== deployedUiEpoch) {
    throw new Error('Frontend/API compatibility epoch mismatch');
  }
  return candidate;
}

/** Explicit pre-journal bootstrap admission only; never use for routine updates.
 * Both release records must already have authenticated channel membership.
 * The old API may not advertise an epoch; only the real UI and new API must
 * agree. A schema or persistent-format change needs a separate migration.
 */
export function assertLegacyBootstrapCandidate(legacyValue, candidateValue, deployedUiEpoch) {
  const { installed, candidate } = assertForwardRelease(legacyValue, candidateValue);
  if (installed.state !== 'published') throw new Error('Legacy release is not published');
  if (!positiveInteger(deployedUiEpoch) || candidate.apiEpoch !== deployedUiEpoch) {
    throw new Error('Bootstrap candidate and deployed UI epoch mismatch');
  }
  return candidate;
}


/** @param {string} endpoint @param {URL} origin @param {{clientId:string,clientSecret:string}|null} credentials @param {typeof fetch} fetchImpl */
async function requestProbe(endpoint, origin, credentials, fetchImpl) {
  try {
    return await fetchImpl(new URL(endpoint, origin), {
      headers: {
        ...(credentials ? {
          'CF-Access-Client-Id': credentials.clientId,
          'CF-Access-Client-Secret': credentials.clientSecret,
        } : {}),
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`NETWORK: ${endpoint} unreachable; check origin, DNS, Tunnel and TLS.`);
  }
}

/** @param {Response} response */
function statusEvidence(response) {
  const ray = response.headers.get('cf-ray');
  return `HTTP ${response.status}${ray && /^[0-9a-f]+-[A-Z0-9]+$/u.test(ray) ? `, CF-Ray ${ray}` : ''}`;
}

/** @param {number} status */
function accessDenied(status) {
  return [301, 302, 303, 307, 308, 401, 403].includes(status);
}

/** @param {string} endpoint @param {URL} origin @param {{clientId:string,clientSecret:string}} credentials @param {typeof fetch} fetchImpl */
export async function readLiveJson(endpoint, origin, credentials, fetchImpl) {
  const response = await requestProbe(endpoint, origin, credentials, fetchImpl);
  if (response.headers.get('cf-mitigated') === 'challenge') {
    const evidence = statusEvidence(response);
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`EDGE_CHALLENGE: ${endpoint} (${evidence}); exclude only the exact GET identity paths from interactive edge challenges, not Access authentication.`);
  }
  if (!response.ok) {
    const evidence = statusEvidence(response);
    await response.body?.cancel().catch(() => undefined);
    if (accessDenied(response.status)) {
      throw new Error(`ACCESS_DENIED: ${endpoint} (${evidence}); check CI token pair, exact-path Service Auth policy and Tunnel AUD for this endpoint.`);
    }
    throw new Error(`IDENTITY_UNAVAILABLE: ${endpoint} (${evidence}); check origin route and deployed identity artifact.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`IDENTITY_INVALID_JSON: ${endpoint} (${statusEvidence(response)}).`);
  }
}

/** @param {Response} response @param {URL} origin */
function accessBoundaryDenied(response, origin) {
  if (response.status === 401 || response.status === 403) return true;
  if (!accessDenied(response.status)) return false;
  // A navigation redirect is not proof of authorization denial.
  const location = response.headers.get('location');
  if (!location) return false;
  try {
    const target = new URL(location, origin);
    return target.protocol === 'https:' &&
      (target.origin === origin.origin || target.hostname.endsWith('.cloudflareaccess.com')) &&
      /^\/cdn-cgi\/access\/login(?:\/|$)/u.test(target.pathname);
  } catch { return false; }
}

/** @param {string} endpoint @param {URL} origin @param {{clientId:string,clientSecret:string}|null} credentials @param {typeof fetch} fetchImpl */
async function assertProbeDenied(endpoint, origin, credentials, fetchImpl) {
  const response = await requestProbe(endpoint, origin, credentials, fetchImpl);
  const evidence = statusEvidence(response);
  await response.body?.cancel().catch(() => undefined);
  if (response.headers.get('cf-mitigated') === 'challenge') {
    if (!credentials) throw new Error(`EDGE_CHALLENGE: anonymous identity request to ${endpoint} (${evidence}); cannot verify Access denial behind an interactive challenge.`);
    // Author routes may be blocked by the geographic WAF before Access.
    // This proves external denial, not the specific Access policy decision.
    return;
  }
  if (!accessBoundaryDenied(response, origin)) {
    throw new Error(`ACCESS_BOUNDARY: ${credentials ? 'CI token' : 'anonymous'} request to ${endpoint} was not denied (${evidence}). Check parent Access policy and route scope.`);
  }
}

// Terraform's identity-probes.json is checked against these paths by the release gate.
export const IDENTITY_PROBE_PATHS=Object.freeze({backend:'/api/version',frontend:'/desktop/update-identity.json'});
/** Canonical exact-path identity probe shared by release and VM maintenance.
 * @template Backend, Frontend
 * @param {{origin:URL,credentials:{clientId:string,clientSecret:string},fetchImpl?:typeof fetch,checkBoundary?:boolean,validateBackend:(value:unknown)=>Backend,validateFrontend:(value:unknown)=>Frontend}} options
 */
export async function probeScopedIdentityAccess({origin,credentials,fetchImpl=fetch,checkBoundary=false,validateBackend,validateFrontend}){
  const backend=readLiveJson(IDENTITY_PROBE_PATHS.backend,origin,credentials,fetchImpl).then(validateBackend);
  const deployed=readLiveJson(IDENTITY_PROBE_PATHS.frontend,origin,credentials,fetchImpl).then(validateFrontend);
  const checks=[backend,deployed,...(checkBoundary?[
    assertProbeDenied(IDENTITY_PROBE_PATHS.backend,origin,null,fetchImpl),
    assertProbeDenied(IDENTITY_PROBE_PATHS.frontend,origin,null,fetchImpl),
    assertProbeDenied('/',origin,credentials,fetchImpl),
    assertProbeDenied('/api/ready',origin,credentials,fetchImpl),
  ]:[])];
  const results=await Promise.allSettled(checks);
  const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason instanceof Error?result.reason.message:'Probe failed');
  if(errors.length)throw new Error('Production deployment preflight failed:\n- '+errors.join('\n- '));
  return {backend:await backend,deployed:await deployed};
}
