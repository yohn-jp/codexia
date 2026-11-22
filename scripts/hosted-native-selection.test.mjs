import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHostedNativeReport, hostedNativeComposeCases, parseHostedNativeSelection } from './hosted-native-selection.mjs';

const fullProfile = JSON.parse(await readFile(new URL('../profiles/full.json', import.meta.url), 'utf8'));

test('Hosted Native selection defaults to all catalog and composition checks', () => {
  assert.equal(parseHostedNativeSelection([]), 'all');
  assert.deepEqual(hostedNativeComposeCases('all').map(({ name }) => name), ['core', 'selected', 'full']);
});

test('Hosted Native matrix selections isolate catalog and each composition', () => {
  for (const selection of ['catalog', 'core', 'selected', 'full']) {
    assert.equal(parseHostedNativeSelection(['--selection', selection]), selection);
  }
  assert.deepEqual(hostedNativeComposeCases('catalog'), []);
  assert.deepEqual(hostedNativeComposeCases('core'), [{ name: 'core', requestedModules: [] }]);
  assert.deepEqual(hostedNativeComposeCases('selected'), [{ name: 'selected', requestedModules: ['story', 'mcp', 'search'] }]);
  const [full] = hostedNativeComposeCases('full');
  assert.equal(full.name, 'full');
  assert.deepEqual(full.requestedModules.toSorted(), fullProfile.modules.toSorted());
});

test('Hosted Native selection rejects malformed or unknown CLI arguments', () => {
  for (const args of [
    ['--selection'], ['--selection', 'all'], ['--selection', 'unknown'], ['--selection', 'core', '--selection', 'full'], ['--other'],
  ]) assert.throws(() => parseHostedNativeSelection(args), /Usage:/u);
  assert.throws(() => hostedNativeComposeCases('unknown'), /Unknown Hosted Native selection/u);
});

test('Hosted Native report binds source, recipe and OCI identities while retaining explicit scope', () => {
  const sourceSha = 'a'.repeat(40);
  const dockerfileSha256 = 'b'.repeat(64);
  const runtimeBaseDigest = `sha256:${'c'.repeat(64)}`;
  const buildKitDigest = `sha256:${'d'.repeat(64)}`;
  const report = createHostedNativeReport({
    selection: 'core', sourceSha, dockerfileSha256, runtimeBaseDigest, buildKitDigest,
    catalog: {
      producerRevision: sourceSha,
      sourceDigest: `sha256:${'e'.repeat(64)}`,
      recipeDigest: `sha256:${'f'.repeat(64)}`,
      lockDigest: `sha256:${'1'.repeat(64)}`,
      moduleCount: fullProfile.modules.length,
    },
    compositions: [{ selection: 'core', requestedModules: [], resolvedModules: [], buildKey: `sha256:${'2'.repeat(64)}`, composeMode: 'OFFLINE' }],
  });

  assert.equal(report.sourceSha, sourceSha);
  assert.equal(report.dockerfileSha256, dockerfileSha256);
  assert.equal(report.runtimeBaseDigest, runtimeBaseDigest);
  assert.equal(report.buildKitDigest, buildKitDigest);
  assert.equal(report.catalog.producerRevision, sourceSha);
  assert.equal(report.catalog.result, 'PASS');
  assert.equal(report.publication, false);
  assert.equal(report.hostedRuntimeAcceptance, 'NOT_CHECKED');
});
