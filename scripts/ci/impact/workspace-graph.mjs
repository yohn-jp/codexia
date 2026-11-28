import assert from 'node:assert/strict';
import { WORKSPACES, TYPECHECK_TARGETS } from './contract.mjs';

const sections = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'];

// The same manifest graph is used for workspace preparation, impact and
// task fingerprints. Missing/unknown workspace declarations are never an
// empty dependency graph.
export function createWorkspaceGraph(manifests, workspaces = WORKSPACES) {
  const byId = new Map(workspaces.map(workspace => [workspace.id, workspace]));
  const byName = new Map();
  assert.equal(byId.size, workspaces.length, 'Duplicate workspace ID');
  for (const workspace of workspaces) {
    const manifest = manifests.get(workspace.id);
    assert.ok(typeof manifest?.name === 'string' && manifest.name.length && !byName.has(manifest.name),
      'Missing or duplicate workspace name: ' + workspace.path);
    byName.set(manifest.name, workspace.id);
  }
  const edges = new Map(workspaces.map(({ id }) => {
    const dependencies = new Set();
    for (const section of sections) {
      for (const [name, version] of Object.entries(manifests.get(id)[section] ?? {})) {
        const dependency = byName.get(name);
        if (dependency) dependencies.add(dependency);
        else if (typeof version === 'string' && version.startsWith('workspace:')) {
          throw new Error('Unresolved workspace dependency: ' + name);
        }
      }
    }
    return [id, [...dependencies]];
  }));
  function dependenciesOf(id) {
    assert.ok(edges.has(id), 'Unknown workspace: ' + id);
    return edges.get(id);
  }
  function buildDependencies(ids) {
    const required = new Set();
    const scanned = new Set();
    const active = new Set();
    function collect(id) {
      if (active.has(id)) throw new Error('Workspace build dependency cycle includes ' + id);
      if (scanned.has(id)) return;
      active.add(id);
      for (const dependency of dependenciesOf(id)) {
        required.add(dependency);
        collect(dependency);
      }
      active.delete(id);
      scanned.add(id);
    }
    for (const id of ids) collect(id);
    const ordered = [];
    const built = new Set();
    function order(id) {
      if (built.has(id)) return;
      for (const dependency of dependenciesOf(id)) if (required.has(dependency)) order(dependency);
      built.add(id);
      ordered.push(id);
    }
    for (const id of required) order(id);
    return ordered;
  }
  function closure(ids) {
    return [...new Set([...ids, ...buildDependencies(ids)])].sort();
  }
  function owner(file) {
    return workspaces.find(workspace => file.startsWith(workspace.path + '/'))?.id;
  }
  function typecheckClosure(task) {
    const roots = TYPECHECK_TARGETS.find(item => task === 'typecheck-' + item.id)?.workspaces;
    return roots ? closure(roots) : null;
  }
  function affectedTypechecks(file) {
    const id = owner(file);
    if (!id) return [];
    return TYPECHECK_TARGETS.filter(target => closure(target.workspaces).includes(id))
      .map(target => 'typecheck-' + target.id);
  }
  return { dependenciesOf, buildDependencies, closure, owner, typecheckClosure, affectedTypechecks };
}
