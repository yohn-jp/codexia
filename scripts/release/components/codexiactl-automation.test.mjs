import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPublishedCodexiactlRelease, isCodexiactlReleaseInput,
  latestCodexiactlTag, releaseVerifiedCodexiactl } from './codexiactl-automation.mjs';

const sha = 'a'.repeat(40);
const prior = 'b'.repeat(40);
const tag = version => ({ name: 'v0.1.' + version, commit: { sha: prior } });
const completeRelease = name => ({ tag_name: name, immutable: true, draft: false, assets: [
  'codexiactl-linux-amd64', 'codexiactl-linux-amd64.sha256',
].map(asset => ({ name: asset, state: 'uploaded', digest: 'sha256:' + 'e'.repeat(64), size: 20 })) });
const event = { path: '.github/workflows/verify.yml', event: 'push', head_branch: 'main',
  status: 'completed', conclusion: 'success', head_sha: sha,
  repository: { full_name: 'yohn-jp/codexia' },
  head_repository: { full_name: 'yohn-jp/codexia' } };

function fixture({tags = [], files = ['cmd/codexiactl/main.go'], current = sha, published = null,
  failTag = false, remoteTagSha = sha} = {}) {
  const calls = [];
  const logger = { info: message => calls.push(['info', message]), notice: message => calls.push(['notice', message]) };
  const github = {
    rest: {
      repos: {
        getBranch: async () => ({ data: { commit: { sha: current } } }),
        listTags: async () => {},
        getReleaseByTag: async () => {
          if (published) return { data: published };
          throw Object.assign(new Error('not found'), { status: 404 });
        },
      },
      git: {
        createRef: async arg => {
          calls.push(['create', arg.ref, arg.sha]);
          if (failTag) throw Object.assign(new Error('lost response'), { status: 502 });
        },
        getRef: async () => ({ data: { object: { type: 'commit', sha: remoteTagSha } } }),
      },
      actions: {
        createWorkflowDispatch: async arg => { calls.push(['dispatch', arg.ref]); },
      },
    },
    paginate: async () => tags,
  };
  const git = (...args) => {
    if (args[0] === 'rev-parse') return sha + '\n';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'diff') return files.join('\0') + (files.length ? '\0' : '');
    throw Error('Unexpected git command: ' + args.join(' '));
  };
  return { calls, params: {github, context: {
    repo: {owner: 'yohn-jp', repo: 'codexia'}, payload: {workflow_run: {
      ...event, repository: {...event.repository}, head_repository: {...event.head_repository},
    }} },
    core: logger, sha, git} };
}

test('release inputs and latest version are deterministic', () => {
  assert.ok(isCodexiactlReleaseInput('cmd/codexiactl/main.go'));
  assert.ok(isCodexiactlReleaseInput('scripts/release/components/codexiactl-automation.mjs'));
  assert.ok(!isCodexiactlReleaseInput('packages/api/src/server.ts'));
  assert.equal(latestCodexiactlTag([tag(3), tag(12), tag(9)]).patch, 12);
  assert.equal(latestCodexiactlTag([]), null);
});

test('every exact-match contract input selects a new official CLI release', async () => {
  const paths = JSON.parse(readFileSync(new URL('../../../cmd/codexiactl/release-contract.json', import.meta.url), 'utf8'));
  assert.ok(paths.includes('cmd/codexiactl/release-contract.json'));
  assert.ok(paths.includes('docs/deployment/ANSIBLE-BASE-RUNTIME.sdoc'));
  assert.ok(!paths.includes('deploy/production.json'));
  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths) {
    const file = path.endsWith('/') ? path + 'fixture' : path;
    const f = fixture({ tags: [tag(2)], published: completeRelease('v0.1.2'), files: [file] });
    assert.ok(isCodexiactlReleaseInput(file), file);
    assert.equal(await releaseVerifiedCodexiactl(f.params), 'dispatched', file);
    assert.deepEqual(f.calls.filter(c => c[0] === 'create'), [['create', 'refs/tags/v0.1.3', sha]], file);
    assert.deepEqual(f.calls.filter(c => c[0] === 'dispatch'), [['dispatch', 'v0.1.3']], file);
  }
  for (const file of ['deploy/production.json', 'docs/authoring.sdoc', 'docs/deployment/ANSIBLE-BASE-RUNTIME.sdoc.bak',
    'scripts/deployment-other/example.mjs', 'packages/api/src/server.ts']) {
    const f = fixture({ tags: [tag(2)], published: completeRelease('v0.1.2'), files: [file] });
    assert.equal(await releaseVerifiedCodexiactl(f.params), 'unaffected', file);
    assert.ok(!f.calls.some(c => c[0] === 'create' || c[0] === 'dispatch'), file);
  }
});

test('release binary admission requires the publisher variable to match the official public App', t => {
  const directory = mkdtempSync(join(tmpdir(), 'codexiactl-app-pin-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const modulePath = join(directory, 'cmd', 'codexiactl');
  mkdirSync(modulePath, { recursive: true });
  writeFileSync(join(modulePath, 'go.mod'), 'module codexiactl-build-fixture\n\ngo 1.2.3\n');
  const executable = (name, body) => writeFileSync(join(directory, name), '#!/bin/bash\n' + body, { mode: 0o700 });
  executable('git', `echo '${sha}'\n`);
  executable('go', '[[ "$*" == "env GOVERSION" ]] || exit 98\necho go1.2.3\n');
  executable('gofmt', 'echo "Reached build verification" >&2\nexit 97\n');
  executable('gh', [
    '[[ "$1 $2 $3 $4" == "api --hostname github.com apps/codexiactl" ]] || exit 98',
    '[[ -n "$CODEXIACTL_FIXTURE_OFFICIAL_ID" ]] || exit 1',
    'echo "$CODEXIACTL_FIXTURE_OFFICIAL_ID"',
  ].join('\n'));

  const verify = fileURLToPath(new URL('../../ci/execution/verify-codexiactl.sh', import.meta.url));
  const appID = 'Iv23liAppFixture0001';
  for (const [version, configuredID, publishedID, status, diagnostic] of [
    ['v0.1.6', '', appID, 1, /Set the official App public Client ID/u],
    ['v0.1.6', 'malformed', appID, 1, /invalid GitHub App Client ID format/u],
    ['v0.1.6', 'Iv23liAppFixture0002', appID, 1, /does not match the official/u],
    ['v0.1.6', appID, '', 1, /Could not verify the public CodexiaCTL/u],
    ['v0.1.6', appID, appID, 97, /Reached build verification/u],
    ['dev', '', '', 97, /Reached build verification/u],
  ]) {
    const result = spawnSync('bash', [verify], {
      cwd: directory,
      env: {
        PATH: directory + delimiter + process.env.PATH,
        CODEXIACTL_BUILD_VERSION: version,
        CODEXIACTL_BUILD_APP_CLIENT_ID: configuredID,
        CODEXIACTL_FIXTURE_OFFICIAL_ID: publishedID,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, diagnostic);
    assert.ok(!result.stderr.includes(appID));
  }
});

test('first verified CLI source creates the initial tag and dispatches with built-in credentials', async () => {
  const f = fixture({ files: [] });
  assert.equal(await releaseVerifiedCodexiactl(f.params), 'dispatched');
  assert.deepEqual(f.calls.filter(c => c[0] === 'create'), [['create', 'refs/tags/v0.1.1', sha]]);
  assert.deepEqual(f.calls.filter(c => c[0] === 'dispatch'), [['dispatch', 'v0.1.1']]);
});

test('unrelated latest commit does not hide prior CLI changes since last tag', async () => {
  const f = fixture({ tags: [tag(2)], published: completeRelease('v0.1.2'),
    files: ['docs/README.md', 'cmd/codexiactl/terminal.go'] });
  assert.equal(await releaseVerifiedCodexiactl(f.params), 'dispatched');
  assert.deepEqual(f.calls.filter(c => c[0] === 'create'), [['create', 'refs/tags/v0.1.3', sha]]);
  assert.deepEqual(f.calls.filter(c => c[0] === 'dispatch'), [['dispatch', 'v0.1.3']]);
  const other = fixture({ tags: [tag(2)], published: completeRelease('v0.1.2'), files: ['docs/README.md'] });
  assert.equal(await releaseVerifiedCodexiactl(other.params), 'unaffected');
  assert.ok(!other.calls.some(c => c[0] === 'create' || c[0] === 'dispatch'));
});

test('an existing same-source tag resumes a lost dispatch but never mints a new patch', async () => {
  const f = fixture({ tags: [{ ...tag(5), commit: {sha} }] });
  assert.equal(await releaseVerifiedCodexiactl(f.params), 'resumed');
  assert.deepEqual(f.calls.filter(c => c[0] === 'dispatch'), [['dispatch', 'v0.1.5']]);
  assert.ok(!f.calls.some(c => c[0] === 'create'));
});

test('a fully immutable existing Release is not dispatched again', async () => {
  const published = completeRelease('v0.1.5');
  assert.doesNotThrow(() => assertPublishedCodexiactlRelease(published, 'v0.1.5'));
  const f = fixture({ tags: [{ ...tag(5), commit: {sha} }], published });
  assert.equal(await releaseVerifiedCodexiactl(f.params), 'published');
  assert.ok(!f.calls.some(c => c[0] === 'create' || c[0] === 'dispatch'));
  assert.throws(() => assertPublishedCodexiactlRelease({ ...published, immutable: false }, 'v0.1.5'));
});

test('missing Release for an earlier tag is resumed even after an unrelated main merge', async () => {
  const f = fixture({tags: [tag(4)], files: ['docs/README.md']});
  assert.equal(await releaseVerifiedCodexiactl(f.params), 'resumed');
  assert.deepEqual(f.calls.filter(c => c[0] === 'dispatch'), [['dispatch', 'v0.1.4']]);
  assert.ok(!f.calls.some(c => c[0] === 'create'));
});

test('superseded main, foreign verification and ambiguous tag writes cannot publish', async () => {
  const newer = fixture({ current: 'c'.repeat(40) });
  assert.equal(await releaseVerifiedCodexiactl(newer.params), 'superseded');
  assert.ok(!newer.calls.some(c => c[0] === 'create'));
  const other = fixture();
  other.params.context.payload.workflow_run.repository.full_name = 'foreign/repo';
  await assert.rejects(releaseVerifiedCodexiactl(other.params), /Expected values to be strictly equal/);
  const conflict = fixture({ failTag: true, remoteTagSha: 'd'.repeat(40) });
  await assert.rejects(releaseVerifiedCodexiactl(conflict.params), /conflicts with a different source/);
  assert.ok(!conflict.calls.some(c => c[0] === 'dispatch'));
});

test('tag API result loss is reconciled and dispatched only for the same source', async () => {
  const f = fixture({ failTag: true });
  assert.equal(await releaseVerifiedCodexiactl(f.params), 'dispatched');
  assert.deepEqual(f.calls.filter(c => c[0] === 'dispatch'), [['dispatch', 'v0.1.1']]);
});
