import { readRegularFile } from '../shared/read-regular-file.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';

const repositoryRequire = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { parse } = repositoryRequire('yaml');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function hasPlayStructure(document) {
  return Array.isArray(document) && document.some(play => isRecord(play) && typeof play.hosts === 'string');
}

function staticIncludeValue(value, sourcePath, field, violations) {
  const filename = typeof value === 'string' ? value : isRecord(value) && typeof value.file === 'string' ? value.file : null;
  if (!filename || /\{\{|\}\}|\$\{/u.test(filename)) {
    violations.push(`Unresolved ${field} in Ansible source ${sourcePath}; only literal YAML includes are inventoried.`);
    return null;
  }
  if (path.posix.isAbsolute(filename)) {
    violations.push(`Absolute ${field} path in Ansible source ${sourcePath}: ${filename}`);
    return null;
  }
  return normalizeRelative(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), filename)));
}

function collectIncludes(value, sourcePath, violations, includes = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectIncludes(item, sourcePath, violations, includes);
    return includes;
  }
  if (!isRecord(value)) return includes;
  for (const [key, item] of Object.entries(value)) {
    if (['ansible.builtin.include_tasks', 'include_tasks', 'ansible.builtin.import_tasks', 'import_tasks', 'ansible.builtin.include', 'include'].includes(key)) {
      const target = staticIncludeValue(item, sourcePath, key, violations);
      if (target) includes.add(target);
      continue;
    }
    if (['ansible.builtin.include_role', 'include_role', 'ansible.builtin.import_role', 'import_role', 'roles'].includes(key)) {
      violations.push(`Unsupported Ansible role inclusion in ${sourcePath}; StrictDoc source graph currently requires literal task/playbook file includes.`);
      continue;
    }
    if (key === 'import_playbook') {
      const target = staticIncludeValue(item, sourcePath, key, violations);
      if (target) includes.add(target);
      continue;
    }
    collectIncludes(item, sourcePath, violations, includes);
  }
  return includes;
}

/** Derive individual Ansible source memberships from declared entrypoints and literal YAML includes. */
export async function discoverAnsibleSourceGraph({
  repositoryRoot,
  ansibleRoot = 'deploy/ansible',
  groups = [],
  overrides = [],
  yamlFiles = [],
} = {}) {
  const root = path.resolve(repositoryRoot);
  const violations = [];
  const filePaths = yamlFiles.length > 0
    ? [...yamlFiles]
    : await (async () => {
      async function walk(relative) {
        const absolute = path.join(root, relative);
        let entries;
        try { entries = await readdir(absolute, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        const files = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const child = path.posix.join(relative, entry.name);
          if (entry.isDirectory()) files.push(...await walk(child));
          else if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) files.push(child);
          else if (entry.isSymbolicLink()) throw new Error(`Ansible source tree contains a symbolic link: ${child}`);
          else if (/\.ya?ml$/u.test(entry.name)) throw new Error(`Ansible YAML source is not a regular file: ${child}`);
        }
        return files;
      }
      return walk(ansibleRoot);
    })();
  const sources = new Map();
  for (const file of filePaths) {
    try {
      const source = await readRegularFile(path.join(root, file));
      sources.set(file, { document: parse(source) });
    } catch (error) {
      violations.push(`Unable to parse Ansible YAML source ${file}: ${error.message}`);
    }
  }

  const groupIds = new Set();
  const overridesByPath = new Map();
  for (const group of groups) {
    if (!group || typeof group.id !== 'string' || !group.id.trim() || groupIds.has(group.id)) {
      violations.push(`Invalid or duplicate Ansible entrypoint group id: ${String(group?.id)}`);
      continue;
    }
    groupIds.add(group.id);
    if (group.mappingBasis !== 'derivable') violations.push(`Ansible entrypoint group ${group.id} must declare mappingBasis "derivable"`);
    if (typeof group.classification !== 'string' || !group.classification.trim()) violations.push(`Missing classification for Ansible entrypoint group ${group.id}`);
    const entrypoint = group.entrypoint;
    if (typeof entrypoint !== 'string' || !entrypoint.startsWith(`${ansibleRoot}/`) || path.posix.normalize(entrypoint) !== entrypoint) {
      violations.push(`Ansible entrypoint group ${group.id} must name a normalized source under ${ansibleRoot}`);
      continue;
    }
    if (!sources.has(entrypoint)) {
      violations.push(`Ansible entrypoint source is missing or invalid: ${entrypoint}`);
      continue;
    }
    if (!hasPlayStructure(sources.get(entrypoint).document)) {
      violations.push(`Declared Ansible entrypoint has no native play structure: ${entrypoint}`);
    }
  }

  for (const override of overrides) {
    if (!override || typeof override.id !== 'string' || !override.id.trim() || groupIds.has(override.id)) {
      violations.push(`Invalid or duplicate Ansible semantic override id: ${String(override?.id)}`);
      continue;
    }
    groupIds.add(override.id);
    if (override.mappingBasis !== 'semantic') violations.push(`Ansible source override ${override.id} must declare mappingBasis "semantic"`);
    if (typeof override.classification !== 'string' || !override.classification.trim()) violations.push(`Missing classification for Ansible source override ${override.id}`);
    if (typeof override.path !== 'string' || !override.path.startsWith(`${ansibleRoot}/`) || path.posix.normalize(override.path) !== override.path) {
      violations.push(`Ansible source override ${override.id} must name a normalized source under ${ansibleRoot}`);
      continue;
    }
    if (!sources.has(override.path)) {
      violations.push(`Ansible source override path is missing or invalid: ${override.path}`);
      continue;
    }
    if (overridesByPath.has(override.path)) violations.push(`Duplicate Ansible source override for ${override.path}`);
    overridesByPath.set(override.path, override);
  }

  const edges = new Map();
  for (const [file, { document }] of sources) {
    edges.set(file, collectIncludes(document, file, violations));
  }
  const memberships = new Map([...sources.keys()].map(file => [file, new Set()]));
  for (const group of groups) {
    const visited = new Set();
    const queue = [group.entrypoint];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      if (!sources.has(current)) {
        violations.push(`Ansible include target is missing or outside the discovered source tree: ${current}`);
        continue;
      }
      memberships.get(current)?.add(group.id);
      for (const target of edges.get(current) ?? []) queue.push(target);
    }
  }

  const surfaces = [];
  for (const [file] of sources) {
    const override = overridesByPath.get(file);
    const inventoryGroups = override
      ? [override]
      : groups.filter(group => memberships.get(file)?.has(group.id));
    if (inventoryGroups.length === 0) {
      violations.push(`Ansible source is not reachable from a declared entrypoint or semantic override: ${file}`);
    }
    const candidateRequirementIds = [...new Set(inventoryGroups.flatMap(group => group.classification.match(/REQ-[A-Z]+-\d{3}/gu) ?? []))];
    surfaces.push({
      kind: 'ansibleSource',
      id: file,
      source: { path: file },
      provenance: 'Parsed Ansible YAML source; membership is derived from declared playbook entrypoints and literal include reachability. This does not prove host execution or desired-state convergence.',
      inventoryGroups: inventoryGroups.map(group => group.id),
      inventoryClassification: inventoryGroups.map(group => group.classification).join(' | '),
      candidateRequirementIds,
      mappingBasis: override ? 'semantic' : inventoryGroups.length > 0 ? 'derivable' : 'unclassified',
    });
  }
  return { surfaces, violations };
}
