import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVisualContextCatalog } from './catalog.mjs';

test('visual targets resolve canonical Desktop screen and Atlas scenario IDs, covering every adopted screen', () => {
  const catalog = loadVisualContextCatalog();
  assert.equal(catalog.themes.join(','), 'light,dark,paper');
  assert.ok(catalog.targets.length >= 15);
  assert.equal(new Set(catalog.targets.map(target => target.id)).size, catalog.targets.length);
  for (const target of catalog.targets) {
    assert.match(target.screenId, /^[A-Z]+-\d{2}$/u);
    assert.match(target.scenarioId, /^atlas-/u);
    assert.ok(target.purpose);
    assert.ok(target.operations.length > 0);
  }
  assert.ok(catalog.targets.some(target => target.id === 'library-empty' && target.screenId === 'LIB-01'));
  assert.ok(catalog.targets.some(target => target.id === 'security-dialog' && target.screenId === 'PREF-01'));
  assert.ok(catalog.exclusions.some(item => item.id === 'focus-mode'));
  assert.ok(catalog.exclusions.some(item => item.id === 'cross-shell'));
});
