// Canonical verification inventory: workflow matrices, coverage and release eligibility share these names.
// These tracked inputs replace the generated YAML, Fastify map and client sources in impact decisions.
const httpToolchainInputs = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/http-contract/package.json']);
/** @param {string} file */
export function isOpenApiGenerationInput(file) {
  return httpToolchainInputs.has(file) || file === 'packages/http-contract/tspconfig.yaml' ||
    (file.startsWith('packages/http-contract/src/') && file.endsWith('.tsp')) ||
    /^packages\/http-contract\/scripts\/(?:generate-openapi|generated-file)\.mjs$/u.test(file);
}
/** @param {string} file */
export function isFastifyGenerationInput(file) {
  return isOpenApiGenerationInput(file) || file === 'packages/http-contract/src/fastify-schema.mjs' ||
    file === 'packages/http-contract/scripts/generate-fastify.mjs';
}

export const WORKSPACES = [
  ...['contracts', 'persistence-contracts', 'persistence-postgres', 'module-runtime', 'core', 'api', 'http-contract'].map(id => ({ id, path: `packages/${id}` })),
  { id: 'app', path: 'app' },
  ...['story', 'nlp', 'diagnostics', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp', 'search'].map(id => ({ id, path: `modules/${id}` })),
];
export const UNIT_TARGETS = [...WORKSPACES, { id: 'root', path: '.' }];
export const TYPECHECK_TARGETS = [
  { id: 'foundations', workspaces: ['contracts', 'persistence-contracts', 'persistence-postgres', 'module-runtime'] },
  { id: 'core-api', workspaces: ['core', 'api'] },
  { id: 'http-contract', workspaces: ['http-contract'] },
  { id: 'app', workspaces: ['app'] },
  { id: 'modules-a', workspaces: ['story', 'nlp', 'diagnostics', 'semantic', 'speaker'] },
  { id: 'modules-b', workspaces: ['assistant', 'publishing', 'mcp', 'search'] },
];
export const TEST_TYPECHECK_SCOPES = ['app-e2e', 'packages', 'modules'];
export const PROFILES = ['core', 'full'];
export const CONFORMANCE_TASKS = Object.freeze({
  'http-conformance': 'tests/conformance/http/run.mjs',
  'mcp-conformance': 'tests/conformance/mcp/run.mjs',
});
export const BROWSER_SHARDS = [
  { id: 'auth-recovery', project: 'chromium', file: 'auth-recovery.acceptance.spec.ts' },
  { id: 'backup-console', project: 'chromium', file: 'backup-console.acceptance.spec.ts' },
  { id: 'oauth-web', project: 'chromium', file: 'oauth-web.acceptance.spec.ts' },
  { id: 'passkey-bootstrap', project: 'chromium', file: 'passkey-bootstrap.acceptance.spec.ts' },
  ...['core', 'outline-headings', 'job-inbox', 'modular-workspace', 'native-review', 'persistence-database', 'recent-activity', 'redesign-visual', 'review-contributions', 'ui-v1'].map(id => ({ id, project: 'chromium', file: `${id}.acceptance.spec.ts` })),
];
export const VERIFICATION_TASKS = [
  ...UNIT_TARGETS.map(({ id }) => `unit-${id}`),
  'db-contract',
  ...Object.keys(CONFORMANCE_TASKS),
  ...TYPECHECK_TARGETS.map(({ id }) => `typecheck-${id}`),
  ...TEST_TYPECHECK_SCOPES.map(id => `test-types-${id}`),
  'safety', 'build-core', 'build-full', 'audit-core', 'oci-core', 'oci-full',
  ...PROFILES.flatMap(profile => BROWSER_SHARDS.map(({ id }) => `browser-${profile}-${id}`)),
  'coverage', 'biome-ci', 'architecture-g5', 'requirements-trace', 'swift-linux',
];
// Execution groups batch work without removing any validation obligation.
// All three browser lanes use Chromium; UI acceptance keeps its dedicated lane.
// Group measured longer specs across the three existing lanes, never share mutable fixtures.
// Start the two long-running specs together in each browser lane; fill shorter lanes before adding a tail.
export const VERIFICATION_GROUPS = {
  biome: ['biome-ci'],
  'unit-core': ['contracts', 'persistence-contracts', 'persistence-postgres', 'module-runtime', 'core', 'http-contract', 'root'].map(id => `unit-${id}`),
  // API integration and the rootless DB contract each own mutable fixtures.
  // They execute on distinct runners instead of serial exclusive barriers.
  'unit-api': ['unit-api', ...Object.keys(CONFORMANCE_TASKS)],
  'unit-db': ['db-contract'],
  'unit-modules': ['app', ...WORKSPACES.filter(item => item.path.startsWith('modules/')).map(item => item.id)].map(id => `unit-${id}`),
  'unit-architecture': ['architecture-g5', 'swift-linux'],
  'types-sources': [...TYPECHECK_TARGETS.map(item => `typecheck-${item.id}`), 'safety'],
  'types-tests': [...TEST_TYPECHECK_SCOPES.map(id => `test-types-${id}`), 'coverage'],
  'types-trace': ['requirements-trace'],
  'build-core': ['build-core', 'audit-core'],
  'build-full': ['build-full'],
  'oci-core': ['oci-core'],
  'oci-full': ['oci-full'],
  ...Object.fromEntries(PROFILES.flatMap(profile => [
    [`browser-${profile}-writing`, ['core', 'persistence-database'].map(id => `browser-${profile}-${id}`)],
    // Run the performance-sensitive visual shard only after the shorter
    // reference tasks, avoiding an exclusive tail on the critical writing lane.
    [`browser-${profile}-reference`, ['modular-workspace', 'recent-activity', 'auth-recovery', 'backup-console', 'native-review', 'oauth-web', 'outline-headings', 'passkey-bootstrap', 'review-contributions', 'job-inbox', 'redesign-visual'].map(id => `browser-${profile}-${id}`)],
    [`browser-${profile}-ui-v1`, ['ui-v1'].map(id => `browser-${profile}-${id}`)],
  ])),
};
// A single dependency authority for profile artifact consumers and certification.
/** @param {string} group */
export function requiredBuildProfile(group) {
  if (group.startsWith('browser-')) return group.split('-')[1];
  return null;
}
export const VERIFICATION_LEAF_JOBS = ['plan', ...Object.keys(VERIFICATION_GROUPS)];
export const REQUIRED_VERIFICATION_JOBS = [...VERIFICATION_LEAF_JOBS, 'certification'];
export const CERTIFICATION_DEPENDENCIES = Object.freeze(['plan', 'biome', 'unit', 'types', 'profile_core', 'profile_full', 'oci']);

/** @param {string[]} tasks */
export function requiresWorkspacePreparation(tasks) {
  return tasks.some(task => task.startsWith('unit-') || task.startsWith('typecheck-') ||
    task.startsWith('test-types-') || task === 'safety' || task === 'db-contract' || Object.hasOwn(CONFORMANCE_TASKS, task));
}
