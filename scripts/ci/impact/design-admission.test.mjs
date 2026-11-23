import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectDesignAdmission, isDesignFixture } from './design-admission.mjs';

test('Impeccable selects source changes but skips isolated design test inputs', () => {
  for (const file of [
    'app/src/workspace/persistence.test.ts',
    'app/src/editorial.spec.tsx',
    'app/src/editor/test/fixture.ts',
    'modules/publishing/src/publishing.test.ts',
    'modules/mcp/src/entry/tests/fixture.ts',
  ]) {
    assert.equal(isDesignFixture(file), true, file);
    assert.equal(selectDesignAdmission([file]).selected, false, file);
  }
  for (const file of [
    'app/src/shells/editorial.css',
    'modules/publishing/src/browser.tsx',
    '.impeccable/overrides.json',
    '.github/workflows/impeccable.yml',
    'app/package.json',
  ]) assert.equal(selectDesignAdmission([file]).selected, true, file);
  assert.equal(selectDesignAdmission(['app/src/workspace/persistence.test.ts', 'app/src/shells/editorial.css']).selected, true);
});
test('unavailable, unknown and main input scopes require the design scan', () => {
  for (const files of [null, ['/app/src/test/foo.ts'], ['../unsafe'], ['']]) {
    assert.equal(selectDesignAdmission(files).selected, true);
  }
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal(selectDesignAdmission(['app/src/editor.test.ts'], event).selected, true);
  }
});
