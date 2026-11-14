import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_MANIFESTS = ['package.json', 'app/package.json', 'packages/api/package.json', 'profiles/core/package.json', 'profiles/full/package.json'];
const INTENT = /^\.release-intents\/[a-z0-9][a-z0-9-]{0,63}\.json$/u;
const intentDirectory = '.release-intents/';
const rank = { patch: 1, feature: 2, breaking: 3 };
const shaPattern = /^[a-f0-9]{40}$/u;
const migration = file => /^packages\/persistence-postgres\/migrations\//u.test(file);
const testFile = file => /(?:^|\/)(?:tests|fixtures)\/|(?:\.test|\.spec)\.[^/]+$/u.test(file);
export function affectsBackend(file) {
  if (testFile(file) || /\.md$/iu.test(file)) return false;
  if (/^modules\/[^/]+\/src\/browser(?:\/|\.|$)/u.test(file)) return false;
  return /^(?:packages\/|modules\/|profiles\/|deploy\/backend\/)/u.test(file) ||
    ['Dockerfile.backend', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'deploy/update-compatibility.json', 'scripts/profile-build.mjs', 'scripts/profile-package.mjs',
      'scripts/runtime-package-closure.mjs', 'scripts/backend-update-identity.mjs'].includes(file);
}
function parts(version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, 'Invalid stable version');
  const result = version.split('.').map(Number);
  assert.ok(result.every(Number.isSafeInteger), 'Invalid version component');
  return result;
}
export function nextVersion(version, kind) {
  let [major, minor, patch] = parts(version);
  assert.ok(Object.hasOwn(rank, kind), 'Invalid release intent');
  if (kind === 'breaking') {
    if (major === 0) { minor++; patch = 0; }
    else { major++; minor = 0; patch = 0; }
  } else if (kind === 'feature' && major > 0) { minor++; patch = 0; }
  else patch++;
  assert.ok([major, minor, patch].every(Number.isSafeInteger), 'Version exhausted');
  return [major, minor, patch].join('.');
}
export function validateIntent(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['summary', 'type']);
  assert.ok(Object.hasOwn(rank, value.type), 'Intent type must be patch, feature or breaking');
  assert.ok(typeof value.summary === 'string' && value.summary.trim() === value.summary &&
    value.summary.length > 0 && value.summary.length <= 200 && !/[\r\n]/u.test(value.summary), 'Invalid release summary');
  return value;
}
function kindOf(intents) {
  return Object.values(intents).map(validateIntent).reduce((kind, intent) =>
    !kind || rank[intent.type] > rank[kind] ? intent.type : kind, null);
}
function validateSnapshot(snapshot) {
  const version = snapshot.manifests['package.json'].version;
  parts(version);
  for (const file of PRODUCT_MANIFESTS) assert.equal(snapshot.manifests[file].version, version, 'Product version mismatch: '+file);
  assert.deepEqual(Object.keys(snapshot.compatibility).sort(), ['apiEpoch','persistenceFormat']);
  for (const value of Object.values(snapshot.compatibility)) assert.ok(Number.isSafeInteger(value) && value > 0, 'Invalid compatibility epoch');
  for (const [file, intent] of Object.entries(snapshot.intents)) { assert.match(file, INTENT); validateIntent(intent); }
  return version;
}
export function releasePlan(snapshot) {
  const version = validateSnapshot(snapshot);
  const kind = kindOf(snapshot.intents);
  return kind ? { kind, version: nextVersion(version, kind), intents: Object.keys(snapshot.intents).sort() } : null;
}
export function validateTransition(base, head, files, { freshBase = true } = {}) {
  const before = validateSnapshot(base), after = validateSnapshot(head);
  const changed = [...new Set(files)].sort();
  if (before !== after) {
    assert.ok(freshBase, 'Release PR must be refreshed against current main');
    const plan = releasePlan(base);
    assert.ok(plan, 'Version changes require pending release intents');
    assert.equal(after, plan.version, 'Release version does not match pending intents');
    assert.deepEqual(Object.keys(head.intents), [], 'Release must consume all pending intents');
    assert.deepEqual(changed, [...PRODUCT_MANIFESTS, ...plan.intents].sort(), 'Release commit may change only product versions and consumed intents');
    for (const file of PRODUCT_MANIFESTS) assert.deepEqual(head.manifests[file], {...base.manifests[file], version: after}, 'Release changed manifest content beyond version: '+file);
    assert.deepEqual(head.compatibility, base.compatibility);
    return { release: true, kind: plan.kind, version: after };
  }
  for (const [file, intent] of Object.entries(base.intents)) assert.deepEqual(head.intents[file], intent, 'Pending release intent cannot be changed or removed: '+file);
  const added = Object.fromEntries(Object.entries(head.intents).filter(([file]) => !Object.hasOwn(base.intents,file)));
  const backend = changed.some(affectsBackend);
  const epochChanged = ['apiEpoch','persistenceFormat'].some(key => {
    const old = base.compatibility[key], next = head.compatibility[key];
    assert.ok(next >= old, 'Compatibility epochs cannot decrease: '+key);
    return next !== old;
  });
  const breaking = epochChanged || changed.some(migration);
  if (backend || breaking) {
    assert.ok(Object.keys(added).length > 0, 'Backend changes require a new .release-intents/<name>.json declaration');
    if (breaking) assert.equal(kindOf(added), 'breaking', 'Migration or compatibility epoch changes require breaking intent');
  } else assert.equal(Object.keys(added).length, 0, 'UI/test/documentation-only changes do not require a backend release');
  return { release: false, kind: kindOf(added), version: before };
}

const git = args => execFileSync('git', args, {encoding:'utf8', maxBuffer:32*1024*1024}).trimEnd();
function checkedRef(ref) { assert.match(ref, shaPattern, 'Expected immutable source SHA'); return ref; }
function snapshot(ref) {
  checkedRef(ref);
  const read = file => JSON.parse(git(['show',ref+':'+file]));
  const paths = git(['ls-tree','-r','--name-only','-z',ref,'--',intentDirectory]).split('\0').filter(Boolean);
  return {manifests:Object.fromEntries(PRODUCT_MANIFESTS.map(file=>[file,read(file)])),
    compatibility:read('deploy/update-compatibility.json'),intents:Object.fromEntries(paths.map(file=>[file,read(file)]))};
}
function changedFiles(base,head) { return git(['diff','--name-only','--no-renames','-z',checkedRef(base),checkedRef(head),'--']).split('\0').filter(Boolean); }
function eventTransition() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const head = checkedRef(git(['rev-parse','HEAD']));
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    assert.equal(head,event.pull_request.head.sha,'Release check must inspect exact PR source');
    const target=checkedRef(event.pull_request.base.sha);
    const base=checkedRef(git(['merge-base',target,head]));
    return validateTransition(snapshot(base),snapshot(head),changedFiles(base,head),{freshBase:base===target});
  }
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    assert.equal(head,event.after,'Release check must inspect exact pushed source');
    const base=checkedRef(event.before);
    return validateTransition(snapshot(base),snapshot(head),changedFiles(base,head));
  }
  validateSnapshot(snapshot(head));
  return {release:false};
}
function output(key,value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,key+'='+value+'\n');
}
function main() {
  const command=process.argv[2];
  if (command === 'check') { console.log(JSON.stringify(eventTransition())); return; }
  if (command === 'backend') {
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.CODEXIA_AUTO_RELEASE_ENABLED !== 'true') { output('build','true'); return; }
    const decision=eventTransition();
    output('build',String(decision.release));
    console.log(decision.release ? 'Build certified release source' : 'Defer backend publication to version release PR');
    return;
  }
  if (command === 'candidate') {
    const base=checkedRef(process.argv[3]), head=checkedRef(process.argv[4]);
    assert.equal(git(['merge-base',base,head]),base,'Release candidate is stale');
    const result=validateTransition(snapshot(base),snapshot(head),changedFiles(base,head));
    assert.ok(result.release,'Expected a version-only release candidate');
    console.log(JSON.stringify(result)); return;
  }
  if (command === 'prepare') {
    assert.equal(git(['status','--porcelain']), '', 'Release preparation requires a clean checkout');
    const source=checkedRef(git(['rev-parse','HEAD']));
    const state=snapshot(source), plan=releasePlan(state);
    output('release',String(Boolean(plan)));
    if (!plan) { console.log('No pending backend releases'); return; }
    for (const file of PRODUCT_MANIFESTS) writeFileSync(file,JSON.stringify({...state.manifests[file],version:plan.version},null,2)+'\n');
    for (const file of plan.intents) rmSync(file);
    output('version',plan.version); output('kind',plan.kind); output('source',source);
    console.log(JSON.stringify(plan)); return;
  }
  throw new Error('Usage: release-version.mjs <check|backend|candidate|prepare>');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
