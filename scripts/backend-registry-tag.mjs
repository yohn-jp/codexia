import assert from 'node:assert/strict';
import { assertImageTagAbsent } from './release-policy.mjs';

const tag=process.argv[2],sha=process.env.GITHUB_SHA;
assert.match(sha,/^[a-f0-9]{40}$/u);
assert.ok(tag==='sha-'+sha||tag==='sha-'+sha+'-full','Registry lookup requires exact main SHA tag');
assert.equal(process.env.GITHUB_REPOSITORY,'yohn-jp/codexia');
assert.equal(process.env.GITHUB_REF,'refs/heads/main');
const actor=process.env.GITHUB_ACTOR,token=process.env.GH_TOKEN;assert.ok(actor&&token);
const repository='yohn-jp/codexia-backend';
const auth=await fetch('https://ghcr.io/token?service=ghcr.io&scope='+encodeURIComponent('repository:'+repository+':pull'),{
  headers:{Authorization:'Basic '+Buffer.from(actor+':'+token).toString('base64')},
  redirect:'error',signal:AbortSignal.timeout(15000),
});
if(!auth.ok)throw Error('Registry authentication failed: HTTP '+auth.status);
const credentials=await auth.json();assert.ok(typeof credentials?.token==='string'&&credentials.token);
const response=await fetch('https://ghcr.io/v2/'+repository+'/manifests/'+encodeURIComponent(tag),{
  headers:{Authorization:'Bearer '+credentials.token,Accept:'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'},
  redirect:'error',signal:AbortSignal.timeout(15000),
});
if(response.status===200){
  const digest=response.headers.get('docker-content-digest');
  assert.match(digest,/^sha256:[a-f0-9]{64}$/u,'Registry response has no immutable digest');
  console.log(digest);
}else{
  await assertImageTagAbsent(response);
  console.log('absent');
}
