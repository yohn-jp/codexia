import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspaceGraph } from './workspace-graph.mjs';
import { WORKSPACES } from './contract.mjs';

const manifests = () => new Map(WORKSPACES.map(({ id }) => [id, { name: '@fixture/' + id }]));
test('dependency closure and affected consumers use the same transitive workspace edges', () => {
  const data = manifests();
  data.get('app').dependencies = { '@fixture/api': 'workspace:*' };
  data.get('api').devDependencies = { '@fixture/core': 'workspace:*' };
  data.get('core').optionalDependencies = { '@fixture/contracts': 'workspace:*' };
  const graph = createWorkspaceGraph(data);
  assert.deepEqual(graph.buildDependencies(['app']), ['contracts', 'core', 'api']);
  assert.deepEqual(graph.typecheckClosure('typecheck-app'), ['api', 'app', 'contracts', 'core']);
  assert.ok(graph.affectedTypechecks('packages/contracts/src/index.ts').includes('typecheck-app'));
  assert.ok(graph.affectedTypechecks('packages/contracts/src/index.ts').includes('typecheck-core-api'));
  assert.ok(!graph.affectedTypechecks('modules/story/src/index.ts').includes('typecheck-app'));
});
test('unresolved workspace references and cycles cannot produce a narrow closure', () => {
  const data = manifests();
  data.get('app').dependencies = { '@fixture/unknown': 'workspace:*' };
  assert.throws(() => createWorkspaceGraph(data), /Unresolved workspace dependency/u);
  data.get('app').dependencies = { '@fixture/api': 'workspace:*' };
  data.get('api').peerDependencies = { '@fixture/app': 'workspace:*' };
  assert.throws(() => createWorkspaceGraph(data).closure(['app']), /cycle/u);
});
