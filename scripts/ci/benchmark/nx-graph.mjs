import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACES } from '../impact/contract.mjs';
import { createVerificationPlan } from '../impact/plan.mjs';

const out = process.argv[2];
assert.ok(out);
const nx = (...args) => execFileSync('pnpm', ['exec', 'nx', ...args], {
  encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true', NX_TASKS_RUNNER_DYNAMIC_OUTPUT: 'false' },
});
// The root is not inferred by Nx's package workspace discovery. Make the
// candidate root edges explicit for the next comparison.
const rootManifest = JSON.parse(readFileSync('package.json', 'utf8'));
rootManifest.nx = { ...rootManifest.nx, implicitDependencies: [
  ...WORKSPACES.map(w => JSON.parse(readFileSync(path.join(w.path, 'package.json'), 'utf8')).name),
  '@codexia/profile-core', '@codexia/profile-full', '@codexia/ci-evidence',
] };
writeFileSync('package.json', JSON.stringify(rootManifest, null, 2) + '\n');
const start = performance.now();
nx('graph', '--file=' + path.join(out, 'project-graph.json'));
const graphMs = Math.round(performance.now() - start);
const exported = JSON.parse(readFileSync(path.join(out, 'project-graph.json'), 'utf8'));
const graph = exported.graph ?? exported.projectGraph ?? exported;
assert.ok(graph.nodes && graph.dependencies, 'Nx graph export schema');
const manifests = new Map([...WORKSPACES.map(w => w.path), 'profiles/core', 'profiles/full', 'scripts/ci/evidence', '.']
  .map(root => { const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')); return [manifest.name, { root, manifest }]; }));
const expected = new Map([...manifests].map(([name, {manifest}]) => [name, new Set(
  ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap(k => Object.keys(manifest[k] ?? {})).filter(n => manifests.has(n)))]));
const actual = new Map([...manifests].map(([name]) => [name, new Set((graph.dependencies[name] ?? []).map(e => e.target).filter(n => manifests.has(n)))]));
const sorted = set => [...set].sort();
const missingProjects = [...manifests.keys()].filter(n => !graph.nodes[n]);
const missingEdges = [...expected].flatMap(([n, deps]) => sorted(deps).filter(d => !actual.get(n).has(d)).map(d => [n, d]));
const extraEdges = [...actual].flatMap(([n, deps]) => sorted(deps).filter(d => !expected.get(n).has(d)).map(d => [n, d]));
function closure(roots, edges) {
  const seen = new Set();
  function visit(name) { if (seen.has(name)) return; seen.add(name); for (const d of edges.get(name) ?? []) visit(d); }
  roots.forEach(visit);
  return sorted(seen);
}
const profiles = ['core', 'full'].map(profile => {
  const roots = ['@codexia/profile-' + profile];
  const manifestClosure = closure(roots, expected);
  const nxClosure = closure(roots, actual);
  return { profile, manifestClosure, nxClosure, missing: manifestClosure.filter(n => !nxClosure.includes(n)), extra: nxClosure.filter(n => !manifestClosure.includes(n)) };
});
const files = execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
const pick = prefix => files.find(f => f.startsWith(prefix) && /\.(?:ts|tsx|sql)$/u.test(f) && !/\.(?:test|spec)\./u.test(f));
const sample = [
  ['contract', pick('packages/contracts/src/')],
  ['api', 'packages/api/src/server.ts'],
  ['search', pick('modules/search/src/')],
  ['desktop', 'app/src/api.ts'],
  ['database', pick('packages/persistence-postgres/migrations/')],
  ['lockfile', 'pnpm-lock.yaml'],
  ['ci-contract', 'scripts/ci/impact/contract.mjs'],
  ['requirements', 'docs/requirements/REQUIREMENT-REGISTER.md'],
];
const sha = execFileSync('git', ['rev-parse','HEAD'], {encoding:'utf8'}).trim();
const names = new Map(WORKSPACES.map(w => [w.id, JSON.parse(readFileSync(path.join(w.path,'package.json'), 'utf8')).name]));
const cases = [];
for (const [id, file] of sample) {
  assert.ok(file && files.includes(file), 'Missing benchmark input: ' + id);
  const started = performance.now();
  const affected = JSON.parse(nx('show','projects','--affected','--files='+file,'--json'));
  assert.ok(Array.isArray(affected), 'Nx affected schema');
  const plan = createVerificationPlan({files:[file], event:'pull_request', sha, base:sha});
  const canonicalUnits = plan.tasks.filter(t => t.startsWith('unit-')).map(t => names.get(t.slice(5))).filter(Boolean).sort();
  cases.push({id,file,nxAffected:affected.sort(),canonicalMode:plan.mode,canonicalTasks:plan.tasks,canonicalUnits,
    canonicalUnitsOutsideNx:canonicalUnits.filter(n => !affected.includes(n)), ms:Math.round(performance.now()-started)});
}
const report = {sha, graphMs, manifestProjects:manifests.size, nxProjects:Object.keys(graph.nodes).length,missingProjects,missingEdges,extraEdges,profiles,cases};
writeFileSync(path.join(out,'graph-comparison.json'), JSON.stringify(report,null,2)+'\n');
writeFileSync(path.join(out,'root-project-candidate.json'), JSON.stringify(rootManifest.nx,null,2)+'\n');
writeFileSync(path.join(out,'app-project-candidate.json'), JSON.stringify(graph.dependencies['@codexia/app'],null,2)+'\n');
console.log(JSON.stringify(report));
appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n### Nx graph and affected (observation only)\n' +
  '| Scenario | Nx projects | Canonical tasks | Canonical workspace units outside Nx |\n|---|---:|---:|---:|\n' +
  cases.map(c => '| '+c.id+' | '+c.nxAffected.length+' | '+c.canonicalTasks.length+' | '+c.canonicalUnitsOutsideNx.length+' |').join('\n') +
  '\n\nGraph '+graphMs+'ms; missing manifest edges '+missingEdges.length+'; extra inferred edges '+extraEdges.length+'.\n');
