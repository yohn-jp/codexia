import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** @param {string} version */
function versionParts(version) {
  assert.ok(typeof version === 'string' && semver.test(version), 'Component version is invalid');
  return version.split('.').map(BigInt);
}

/** @param {string} left @param {string} right */
export function compareComponentVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

const root=fileURLToPath(new URL('../',import.meta.url));
const manifests={frontend:'app/package.json',backend:'packages/api/package.json'};
export function componentVersion(base,runNumber) {
  if (typeof base!=='string'||!semver.test(base)) throw Error('Invalid component SemVer');
  const [major,minor,patch]=base.split('.').map(Number);
  if (![major,minor,patch].every(Number.isSafeInteger)) throw Error('Invalid component version');
  if (runNumber===undefined||runNumber==='') return base;
  if (typeof runNumber!=='string'||!/^[1-9]\d*$/u.test(runNumber)||!Number.isSafeInteger(Number(runNumber))||!Number.isSafeInteger(patch+Number(runNumber))) throw Error('Invalid release workflow run number');
  return [major,minor,patch+Number(runNumber)].join('.');
}
export function readComponentVersion(component,runNumber=process.env.GITHUB_RUN_NUMBER) {
  if (!Object.hasOwn(manifests,component)) throw Error('Unknown release component');
  return componentVersion(JSON.parse(readFileSync(path.join(root,manifests[component]),'utf8')).version,runNumber);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(readComponentVersion(process.argv[2]));
