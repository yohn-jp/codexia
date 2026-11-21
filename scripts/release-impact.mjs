import assert from 'node:assert/strict';
import { matchesGlob } from 'node:path';
import { readFileSync } from 'node:fs';

const pathScopes = JSON.parse(readFileSync(new URL('../deploy/release-impact-paths.json', import.meta.url), 'utf8'));

/** Retain the previous push.paths include/exclude behavior for workflow_run. */
export function componentReleaseAffected(component, files) {
  assert.ok(['frontend', 'backend'].includes(component), 'Unsupported release component');
  assert.ok(Array.isArray(files) && files.length > 0 && files.every(file =>
    typeof file === 'string' && file !== '' && !file.startsWith('/') &&
    !file.split('/').includes('..') && !file.includes('\\')), 'Invalid changed-file inventory');
  const patterns = pathScopes[component];
  assert.ok(Array.isArray(patterns) && patterns.length > 0, 'Missing release impact policy');
  return files.some(file => {
    let included = false;
    for (const expression of patterns) {
      const negative = expression.startsWith('!');
      if (matchesGlob(file, negative ? expression.slice(1) : expression)) included = !negative;
    }
    return included;
  });
}
