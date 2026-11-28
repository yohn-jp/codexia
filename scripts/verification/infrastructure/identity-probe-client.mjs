// Exact-path production identity probing; independent of deployment/polling controllers.
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
export async function assertProbeDenied(endpoint, origin, credentials, fetchImpl) {
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

// The certified identity-probes.json is checked against these paths by the release gate.
export const IDENTITY_PROBE_PATHS=Object.freeze({backend:'/api/version',frontend:'/desktop/update-identity.json'});
/** Canonical exact-path identity probe for protected frontend release preflight.
 * @template Backend, Frontend
 * @param {{origin:URL,credentials:{clientId:string,clientSecret:string},fetchImpl?:typeof fetch,checkBoundary?:boolean,includeBackend?:boolean,includeFrontend?:boolean,validateBackend?:(value:unknown)=>Backend,validateFrontend:(value:unknown)=>Frontend}} options
 */
export async function probeScopedIdentityAccess({origin,credentials,fetchImpl=fetch,checkBoundary=false,includeBackend=true,includeFrontend=true,validateBackend,validateFrontend}){
  const backend=includeBackend?readLiveJson(IDENTITY_PROBE_PATHS.backend,origin,credentials,fetchImpl).then(validateBackend):undefined;
  const deployed=includeFrontend?readLiveJson(IDENTITY_PROBE_PATHS.frontend,origin,credentials,fetchImpl).then(validateFrontend):undefined;
  const checks=[...(backend?[backend]:[]),...(deployed?[deployed]:[]),...(checkBoundary?[
    assertProbeDenied(IDENTITY_PROBE_PATHS.backend,origin,null,fetchImpl),
    assertProbeDenied(IDENTITY_PROBE_PATHS.frontend,origin,null,fetchImpl),
    assertProbeDenied('/',origin,credentials,fetchImpl),
    assertProbeDenied('/api/ready',origin,credentials,fetchImpl),
  ]:[])];
  const results=await Promise.allSettled(checks);
  const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason instanceof Error?result.reason.message:'Probe failed');
  if(errors.length)throw new Error('Production deployment preflight failed:\n- '+errors.join('\n- '));
  return {...(backend?{backend:await backend}:{}),...(deployed?{deployed:await deployed}:{})};
}
