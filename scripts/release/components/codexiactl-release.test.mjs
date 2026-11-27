import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileCodexiactlRelease, assertImmutableReleaseSetting, readTaggedRelease } from './codexiactl-release.mjs';

const tag = 'v1.2.3';
const binary = { name: 'codexiactl-linux-amd64', digest: `sha256:${'a'.repeat(64)}`, size: 100 };
const checksum = { name: 'codexiactl-linux-amd64.sha256', digest: `sha256:${'b'.repeat(64)}`, size: 88 };
const expected = [binary, checksum];
const validRelease = () => ({
  tag_name: tag,
  immutable: true,
  draft: false,
  published_at: '2026-11-27T12:00:00Z',
  assets: [
    { name: 'codexia-full.oci.tar.gz', state: 'uploaded' },
    ...expected.map(asset => ({ ...asset, state: 'uploaded' })),
  ],
});

function fixture({ release = validRelease(), created = validRelease(), disabled = false, readError, attestError } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      tag,
      assets: expected,
      async readRelease() {
        calls.push('read');
        if (readError) throw readError;
        return calls.includes('create') ? created : release;
      },
      async verifySource() { calls.push('tag'); },
      async verifyBuildProvenance() { calls.push('build-attestation'); },
      async verifyReleaseAsset(asset) {
        calls.push(asset.name);
        if (attestError) throw attestError;
      },
      async checkSetting() {
        calls.push('setting');
        assertImmutableReleaseSetting({ enabled: !disabled, enforced_by_owner: false });
      },
      async createRelease() { calls.push('create'); },
    },
  };
}

test('an existing release is accepted only with matching immutable assets and both attestations', async () => {
  const { calls, options } = fixture();
  assert.equal(await reconcileCodexiactlRelease(options), 'verified-existing');
  assert.deepEqual(calls, ['read', 'tag', 'build-attestation', binary.name, checksum.name]);

  const failed = fixture({ attestError: new Error('bad release attestation') });
  await assert.rejects(reconcileCodexiactlRelease(failed.options), /bad release attestation/u);
  assert.ok(!failed.calls.includes('create'));
});

test('mutable, incomplete, mismatched, draft and foreign existing releases are refused without replacement', async () => {
  for (const breakRelease of [
    release => { release.immutable = false; },
    release => { release.draft = true; },
    release => { release.tag_name = 'v1.2.4'; },
    release => { release.assets = [release.assets[0]]; },
    release => { release.assets.pop(); },
    release => { release.assets[1].digest = `sha256:${'c'.repeat(64)}`; },
    release => { release.assets[1].size++; },
    release => { release.assets[1].state = 'starter'; },
    release => { release.assets.push(release.assets[1]); },
  ]) {
    const release = validRelease();
    breakRelease(release);
    const { options, calls } = fixture({ release });
    await assert.rejects(reconcileCodexiactlRelease(options), /Use a new verified version tag/u);
    assert.ok(!calls.includes('create'));
  }
});

test('settings are checked before a new Release is created and existing failures do not turn into absence', async () => {
  const disabled = fixture({ release: null, disabled: true });
  await assert.rejects(reconcileCodexiactlRelease(disabled.options), /Immutable Releases must be enabled/u);
  assert.ok(!disabled.calls.includes('create'));
  const inaccessible = fixture({ readError: new Error('HTTP 403') });
  await assert.rejects(reconcileCodexiactlRelease(inaccessible.options), /403/u);
  assert.deepEqual(inaccessible.calls, ['read']);
  const allowed = fixture({ release: null });
  assert.equal(await reconcileCodexiactlRelease(allowed.options), 'published');
  assert.deepEqual(allowed.calls, ['read', 'tag', 'build-attestation', 'setting', 'create', 'read', 'tag', binary.name, checksum.name]);
  const invalidAfterCreate = fixture({ release: null, created: { ...validRelease(), immutable: false } });
  await assert.rejects(reconcileCodexiactlRelease(invalidAfterCreate.options), /Use a new verified version tag/u);
  assert.equal(invalidAfterCreate.calls.filter(call => call === 'create').length, 1);
});

test('absence requires a complete authenticated Release inventory that includes drafts', async () => {
  function github(pages, error) {
    return { rest: { repos: { listReleases() {} } }, paginate: {
      async *iterator(_method, parameters) {
        assert.deepEqual(parameters, { owner: 'yohn-jp', repo: 'codexia', per_page: 100 });
        for (const data of pages) yield { data };
        if (error) throw error;
      },
    } };
  }
  const otherRelease = { ...validRelease(), tag_name: 'v3.0.0' };
  assert.equal(await readTaggedRelease(github([[otherRelease], []]), tag), null);
  const draft = { ...validRelease(), draft: true };
  assert.equal(await readTaggedRelease(github([[otherRelease], [draft]]), tag), draft);
  await assert.rejects(readTaggedRelease(github([[draft], [validRelease()]]), tag), /ambiguous/u);
  await assert.rejects(readTaggedRelease(github([[otherRelease]], { status: 403 }), tag), /HTTP 403/u);
});
