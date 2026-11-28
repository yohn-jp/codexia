import assert from 'node:assert/strict';
import { CONFORMANCE_TASKS, TEST_TYPECHECK_SCOPES, TYPECHECK_TARGETS, WORKSPACES } from './contract.mjs';

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
  // One task-to-workspace mapping owns both dependency preparation and
  // the declared part of impact / proof input closure. Non-workspace and
  // implicit inputs are deliberately retained by the caller.
  function taskRoots(task) {
    if (task === 'coverage') return { roots: [], buildRoots: [] };
    if (task === 'unit-root' || task === 'db-contract' || Object.hasOwn(CONFORMANCE_TASKS, task) || task === 'safety') {
      return { roots: ['api'], buildRoots: ['api'] };
    }
    if (task.startsWith('unit-') && byId.has(task.slice(5))) return { roots: [task.slice(5)], buildRoots: [] };
    const target = TYPECHECK_TARGETS.find(item => task === 'typecheck-' + item.id);
    if (target) return { roots: target.workspaces, buildRoots: [] };
    if (task === 'test-types-app-e2e') return { roots: ['app', 'api'], buildRoots: ['api'] };
    const scope = task.startsWith('test-types-') ? task.slice(11) : null;
    if (scope && TEST_TYPECHECK_SCOPES.includes(scope)) {
      return { roots: workspaces.filter(workspace => workspace.path.startsWith(scope + '/')).map(workspace => workspace.id), buildRoots: [] };
    }
    return null;
  }
  function taskWorkspaceClosure(task) {
    const input = taskRoots(task);
    return input ? closure(input.roots) : null;
  }
  function taskPrerequisites(task) {
    const input = taskRoots(task);
    if (!input) throw new Error('Unknown workspace preparation task: ' + task);
    return [...new Set([...buildDependencies(input.roots), ...input.buildRoots])];
  }
  function affectedTasks(file, tasks) {
    const id = owner(file);
    if (!id) return [];
    return tasks.filter(task => taskWorkspaceClosure(task)?.includes(id));
  }
  function affectedTypechecks(file) {
    return affectedTasks(file, TYPECHECK_TARGETS.map(target => 'typecheck-' + target.id));
  }
  return { dependenciesOf, buildDependencies, closure, owner, taskWorkspaceClosure, taskPrerequisites, affectedTasks, affectedTypechecks };
}
