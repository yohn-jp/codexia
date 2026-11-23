import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve a dependency exactly as Node does from an installed package: walk
 * package ancestors and follow pnpm's package-local links.
 */
export async function resolveDependency(directory, name) {
  let current = directory;
  while (true) {
    const candidate = path.join(current, 'node_modules', name);
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved) return resolved;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`missing runtime dependency ${name} from ${directory}`);
    current = parent;
  }
}

/** Returns actual package roots reachable through production dependencies. */
export async function productionClosure(roots) {
  const closure = new Map();
  const visited = new Set();
  async function visit(directory) {
    const resolved = await realpath(directory);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const manifest = JSON.parse(await readFile(path.join(resolved, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`invalid runtime package manifest: ${resolved}`);
    }
    closure.set(resolved, { name: manifest.name, version: manifest.version, directory: resolved, manifest });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await visit(await resolveDependency(resolved, dependency));
    }
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      const optional = manifest.peerDependenciesMeta?.[dependency]?.optional === true;
      const location = await resolveDependency(resolved, dependency).catch((error) => {
        if (!optional) throw error;
        return null;
      });
      if (location) await visit(location);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      const location = await resolveDependency(resolved, dependency).catch(() => null);
      if (location) await visit(location);
    }
  }
  for (const root of roots) await visit(root);
  return closure;
}
