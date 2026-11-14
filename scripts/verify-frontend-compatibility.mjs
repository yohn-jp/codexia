import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export function assertFrontendCompatibility(frontend,backend) {
  assert.equal(frontend?.format,'codexia-frontend-identity/v1');
  assert.match(frontend.version,semver);assert.match(frontend.sourceSha,/^[a-f0-9]{40}$/u);
  assert.ok(['core','full'].includes(frontend.profile));
  assert.ok(Number.isSafeInteger(frontend.apiEpoch)&&frontend.apiEpoch>0);
  assert.equal(backend?.name,'codexia');assert.equal(backend.hosted,false);
  assert.match(backend.version,semver);assert.equal(backend.profile,frontend.profile,'Backend profile mismatch');
  assert.equal(backend.apiEpoch,frontend.apiEpoch,'Frontend and backend API epochs are incompatible');
}
async function main() {
  const origin=new URL(process.env.CODEXIA_PUBLIC_ORIGIN);
  assert.equal(origin.protocol,'https:');assert.equal(origin.href,origin.origin+'/');
  const id=process.env.CODEXIA_ACCESS_CLIENT_ID,secret=process.env.CODEXIA_ACCESS_CLIENT_SECRET;
  assert.ok(id&&secret,'Cloudflare Access service credentials required');
  const frontend=JSON.parse(readFileSync(new URL('../app/dist/desktop/update-identity.json',import.meta.url),'utf8'));
  assert.equal(frontend.sourceSha,process.env.GITHUB_SHA,'Frontend artifact source mismatch');
  const response=await fetch(new URL('/api/version',origin),{
    headers:{'CF-Access-Client-Id':id,'CF-Access-Client-Secret':secret,Accept:'application/json','Cache-Control':'no-cache'},
    redirect:'error',signal:AbortSignal.timeout(15000),
  });
  if(!response.ok) throw Error('Live backend identity unavailable: HTTP '+response.status);
  const backend=await response.json();
  assertFrontendCompatibility(frontend,backend);
  console.log('Frontend '+frontend.version+' is compatible with deployed backend '+backend.version+' (API epoch '+frontend.apiEpoch+')');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
