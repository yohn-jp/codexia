import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channelUrl = 'https://api.github.com/repos/yohn-jp/codexia/contents/stable-channel.json?ref=codexia-stable-channel';
const frontendUrl = 'https://codexia-phase-f.fixture.invalid/desktop/update-identity.json';

test('Standalone updater acceptance runs only on demand, without duplicating Full-model OCI', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/standalone-updater-acceptance.yml'), 'utf8');
  const proxyQuadlet = await readFile(path.join(root, 'deploy/updater/codexia-api-proxy.container.example'), 'utf8');
  const evidenceDoc = await readFile(path.join(root, 'docs/deployment/PHASE-F-DISPOSABLE-CI.md'), 'utf8');
  const continuity = await readFile(path.join(root, 'deploy/ansible/test-phase-f-ansible-continuity.sh'), 'utf8');
  const appContinuity = await readFile(path.join(root, 'deploy/ansible/test-phase-f-ansible-app.sh'), 'utf8');
  const runtimeJob = workflow.split('  rootless-updater-lifecycle:', 2)[1];
  assert.match(workflow, /runs-on: ubuntu-26\.04/u);
  assert.match(workflow, /\n  workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /\n  (?:pull_request|push|schedule|workflow_run):/u);
  assert.doesNotMatch(workflow, /full-model-oci-acceptance\.yml/u);
  assert.match(workflow, /cancel-in-progress: true/u);
  assert.match(workflow, /test-phase-f-ansible-continuity\.sh/u);
  assert.match(workflow, /bash -n deploy\/ansible\/test-phase-f-ansible-app\.sh/u);
  assert.match(workflow, /sudo python3 -m venv \/opt\/codexia-ansible/u);
  assert.match(workflow, /ANSIBLE_PLAYBOOK: \/opt\/codexia-ansible\/bin\/ansible-playbook/u);
  const appRepoRoot = appContinuity.indexOf('repo_root=$(cd');
  const appAccessibleCwd = appContinuity.indexOf('\ncd /tmp\n');
  const appChannelGeneration = appContinuity.indexOf('sudo -H -u "$service_user" env', appAccessibleCwd);
  assert.ok(appRepoRoot >= 0 && appAccessibleCwd > appRepoRoot && appChannelGeneration > appAccessibleCwd,
    'Resolve checkout paths before fixture-user sudo, then run from an accessible cwd');
  const serviceAnsibleProbe = appContinuity.indexOf('service_ansible_version=$(as_service "$ansible_playbook" --version)');
  const firstSecretsStage = appContinuity.indexOf('apply_runner secrets');
  assert.ok(serviceAnsibleProbe >= 0 && firstSecretsStage > serviceAnsibleProbe,
    'Verify the service account can run the pinned Ansible controller before database setup');
  assert.match(workflow, /ansible-core|requirements\.txt/u);
  assert.match(proxyQuadlet, /^PodmanArgs=--image-volume=ignore$/mu);
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /actions: read/u);
  assert.match(workflow, /packages: read/u);
  assert.match(workflow, /\$\{\{ runner\.temp \}\}\/codexia-phase-f-evidence\//u);
  assert.match(workflow, /if-no-files-found: error/u);
  const obsoleteWorkflow = await readFile(path.join(root, '.github/workflows/phase-f-disposable.yml'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  assert.equal(obsoleteWorkflow, null, 'The redundant automatic workflow must be removed');
  assert.match(runtimeJob, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read\s*\n\s+packages: read/u);
  assert.doesNotMatch(runtimeJob, /(?:contents|actions|packages):\s*write/u);
  assert.doesNotMatch(workflow, /environment:\s*codexia-production|CODEXIA_CHANNEL_SIGNING_KEY|CODEXIA_PRODUCTION_SSH|terraform apply|ansible_host:/u);
  for (const marker of ['NOT_CHECKED', 'same Ubuntu 26.04 runner', 'complete serving-host drift', 'VM reboot']) {
    assert.ok(evidenceDoc.includes(marker), 'Missing evidence boundary: ' + marker);
  }
  const continuitySyntax = spawnSync('bash', ['-n', path.join(root, 'deploy/ansible/test-phase-f-ansible-continuity.sh')], { encoding: 'utf8' });
  assert.equal(continuitySyntax.status, 0, continuitySyntax.stderr);
  const appSyntax = spawnSync('bash', ['-n', path.join(root, 'deploy/ansible/test-phase-f-ansible-app.sh')], { encoding: 'utf8' });
  assert.equal(appSyntax.status, 0, appSyntax.stderr);
  for (const marker of [
    'test-host-integration.sh',
    'test-base-secrets-integration.sh',
    'test-base-runtime-integration.sh',
    'test-phase-f-disposable.sh',
    'CODEXIA_HOST_PROOF_MODE=actions-fixture',
    'CODEXIA_SERVICE_USER=$service_user',
    "format: 'codexia-phase-f-ansible-continuity/v1'",
    'identityContinuity',
    'workflowRunId',
    'notChecked',
  ]) assert.ok(continuity.includes(marker), 'Missing same-host Ansible continuity proof: ' + marker);
  for (const marker of [
    'install_fixture_manager_xdg',
    'phase_f_xdg_generator_path',
    'manager XDG environment verified after systemd environment generation',
    'tar -C "$repo_root" -cf - deploy scripts packages/persistence-postgres/migrations',
    'service_ansible_version=$(as_service "$ansible_playbook" --version)',
    'codexia_stage=$stage',
    'apply_runner secrets',
    'apply_runner base',
    'apply_service prepare',
    'apply_service initialize-schema',
    'apply_service initialize-fresh',
    'apply_service enable',
    'apply_service pause',
    "fetch(origin + '/api/v1/persistence/projects'",
    '"$phase_dir/release-0.1.455.json" "$tmp/release-0.1.455.json"',
    'PHASE_F_RELEASE_FILE="$tmp/release-0.1.455.json"',
    'migration_ledger',
    'pg_control_system()',
    'codexia-api-proxy',
    'SSL_CERT_FILE',
    'identity-server.mjs',
    'anonymous:403',
    'authenticated:200',
    'ansible-enable:200',
    'disable codexia-updater.timer',
    'Phase F Ansible application continuity',
    'refusing adoption',
    'notChecked',
    'app-convergence-results.json',
  ]) assert.ok(appContinuity.includes(marker), 'Missing fresh application continuity proof: ' + marker);
  assert.doesNotMatch(appContinuity, /origin \+ '\/api\/projects'/u,
    'Application continuity must verify writes through the PostgreSQL persistence API');
  assert.match(continuity, /test-phase-f-ansible-app\.sh/u);
});

test('Phase F release provenance uses publication time inside the exact successful run window', async () => {
  const channelFactory = await readFile(path.join(root, 'scripts/phase-f-test-channel.mjs'), 'utf8');
  assert.match(channelFactory, /publicationInWorkflowWindow\(releaseApiRecord, run\)/u);
});

test('Phase F integration helper is valid shell and exercises the existing locked updater paths', async () => {
  const helper = await readFile(path.join(root, 'deploy/ansible/test-phase-f-disposable.sh'), 'utf8');
  const baseRuntime = await readFile(path.join(root, 'deploy/ansible/base-runtime.yml'), 'utf8');
  const syntax = spawnSync('bash', ['-n', path.join(root, 'deploy/ansible/test-phase-f-disposable.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const marker of [
    'CODEXIA_DISPOSABLE_HOST=phase-f-integration',
    'acceptance-update',
    'acceptance-rollback',
    'Interrupted update recovered from durable journal',
    'verify-resume',
    'Only the supported recovered-update error may be cleared by resume',
    'Proxy route mismatch',
    '503',
    'notChecked',
    'NOT_CHECKED',
    'lifecycle-results.json',
    'test-channel-public.pem',
    'journalctl --user --unit=codexia-db.service',
    'status codexia-db.service --no-pager',
    'postgres-init-access.txt',
    'rootless unshare sh -c',
    'uid_map',
    'gid_map',
    '--user postgres',
    'test -r /docker-entrypoint-initdb.d/010-create-app-role.sh',
    'as_service tee "$evidence_dir/postgres-init-access.txt"',
  ]) assert.ok(helper.includes(marker), 'Missing integration proof: ' + marker);
  const evidenceAllowlist = helper.match(/evidence_files=\(\s*([\s\S]*?)\s*\)/u)?.[1];
  assert.ok(evidenceAllowlist, 'Missing explicit artifact evidence allowlist');
  assert.match(evidenceAllowlist, /release-identities\.json lifecycle-results\.json/u);
  assert.match(evidenceAllowlist, /postgres-init-access\.txt/u);
  assert.doesNotMatch(evidenceAllowlist, /private|secret|token|github-read/i);
  assert.match(helper, /Successful Phase F run is missing uploaded evidence/u);
  assert.match(helper, /sudo test -d "\$evidence_dir"[\s\S]*?sudo test -f "\$evidence_source"[\s\S]*?sudo install -m 0644 -- "\$evidence_source" "\$evidence_copy\/\$evidence_file"[\s\S]*?sudo chown "\$\(id -u\):\$\(id -g\)"/u);
  assert.match(helper, /sudo test -L "\$evidence_source"/u);
  assert.match(helper, /Successful Phase F run is missing source evidence/u);
  assert.doesNotMatch(helper, /sudo cp -a "\$evidence_dir/u);
  const repoRoot = helper.indexOf('repo_root=$(cd');
  const accessibleCwd = helper.indexOf('\ncd /tmp\n');
  const privilegeProbe = helper.indexOf('sudo -H -u "$service_user" sudo -n true');
  const provenanceCommand = helper.indexOf('sudo --preserve-env=GH_TOKEN,GITHUB_SHA -H -u "$service_user" env');
  assert.ok(repoRoot >= 0 && accessibleCwd > repoRoot && privilegeProbe > accessibleCwd && provenanceCommand > accessibleCwd,
    'Resolve all repository paths before moving to an accessible cwd for fixture-user sudo');
  assert.doesNotMatch(helper, /sudo [^\n]*-D "\$service_home"/u);
  assert.doesNotMatch(helper, /as_service install -m [^\n]*"\$(?:repo_root|test_root)\//u,
    'Fixture-user install must not read the private checkout or root-only temp directory');
  assert.match(helper, /sudo install -o "\$service_user" -g "\$service_group" -m 0600 "\$source_dir\/deploy\/quadlet\/\$file"/u);
  assert.match(helper, /sudo install -o "\$service_user" -g "\$service_group" -m 0600 "\$test_root\/updater-config\.json"/u);
  const productionInitDirectory = baseRuntime.match(/- name: Create the protected PostgreSQL init-script directory([\s\S]*?)(?=\n- name:)/u)?.[1];
  const productionInitFile = baseRuntime.match(/- name: Install the canonical app-role initializer only when absent([\s\S]*?)(?=\n- name:)/u)?.[1];
  assert.ok(productionInitDirectory && productionInitFile, 'Missing canonical PostgreSQL initializer policy');
  assert.match(productionInitDirectory, /path: \/etc\/codexia\/postgres[\s\S]*?owner: "\{\{ codexia_service_user \}\}"[\s\S]*?group: root[\s\S]*?mode: '0750'/u);
  assert.match(productionInitFile, /dest: \/etc\/codexia\/postgres\/010-create-app-role\.sh[\s\S]*?owner: "\{\{ codexia_service_user \}\}"[\s\S]*?group: root[\s\S]*?mode: '0555'/u);
  assert.match(helper, /postgres_init_script=\$postgres_init_dir\/010-create-app-role\.sh/u);
  assert.match(helper, /sudo install -d -o "\$service_user" -g root -m 0750 "\$postgres_init_dir"/u);
  assert.match(helper, /sudo install -o "\$service_user" -g root -m 0555 "\$source_dir\/deploy\/postgres\/010-create-app-role\.sh" "\$postgres_init_script"/u);
  assert.match(helper, /sudo stat --printf='host-file=%n mode=%a uid=%u gid=%g owner=%U group=%G\\n' "\$postgres_init_script"/u);
  assert.match(helper, /rootless run --rm --user postgres --entrypoint \/bin\/sh[\s\S]*?--volume "\$postgres_init_script:\/docker-entrypoint-initdb\.d\/010-create-app-role\.sh:ro,Z"[\s\S]*?test -r \/docker-entrypoint-initdb\.d\/010-create-app-role\.sh[\s\S]*?user_systemctl start codexia-db\.service/u);
  assert.match(helper, /postgres_image=\$\(sed -n 's\/\^Image=\/\/p' "\$source_dir\/deploy\/quadlet\/codexia-db\.container"\)/u);
  assert.equal((helper.match(/as_service \/usr\/bin\/jq -r \.image "\$evidence_dir\/release-0\.1\.(?:236|245|254)\.json"/gu) ?? []).length, 3,
    'Read private release fixtures as their owner, not as the unrelated GitHub runner account');
  assert.match(helper, /user_systemctl start codexia-data-volume\.service codexia-history-volume\.service[\s\S]*?user_systemctl start codexia-db\.service[\s\S]*?data_volume_before=/u,
    'Create the data/history volume fixtures before recording their runtime identities');
  assert.match(helper, /sh "\$updater" "\$@"/u, 'Invoke the mode-0600 updater wrapper the same way as the canonical Ansible stage');
  assert.match(helper, /PATH="\$crash_bin:\$node_path:/u, 'Keep the pinned Node runtime on the injected crash path');
  assert.match(helper, /\[\[ "\$interrupt_status" == 137 \]\] && as_service test -s "\$fixture_data\/interruption-injected"/u,
    'Inspect the service-private interruption marker as its owner');
  assert.equal((helper.match(/process\.argv\.slice\(2\)/gu) ?? []).length, 3,
    'Skip Node’s executable and stdin marker when reading script arguments');
  assert.match(helper, /as_service "\$node_bin" --input-type=module - "\$evidence_dir"/u,
    'Write lifecycle evidence as its directory owner');
  assert.match(helper, /if ! run_updater init[\s\S]*?safe state detail follows[\s\S]*?\.lastError \/\/ empty[\s\S]*?\.journal\.phase/u,
    'Expose only safe controller state when fixture initialization fails');
  assert.match(helper, /Disposable proxy image identities \(digest and content IDs only\)[\s\S]*?imageID=\{\{\.Id\}\} repoDigests=\{\{json \.RepoDigests\}\}[\s\S]*?containerImage=\{\{\.Image\}\} containerImageName=\{\{\.ImageName\}\}[\s\S]*?proxyMounts=\{\{json \.Mounts\}\}/u);
  assert.match(helper, /codexia-updater(?:\.sh)?/u);
  assert.match(helper, /ansible-convergence-results\.json/u);
});

test('Phase F channel factory derives signed sequences from certified embedded release identities', async () => {
  const { bindCertifiedImage, createSignedTestChannels, parseComponentRelease } = await import('./phase-f-test-channel.mjs');
  const compatibility = { apiEpoch: 1, persistenceFormat: 1 };
  const source = char => char.repeat(40);
  const image = char => 'ghcr.io/yohn-jp/codexia-backend@sha256:' + char.repeat(64);
  const releaseInfo = (version, sha, digest) => ({
    tag_name: 'backend-v' + version,
    draft: false,
    prerelease: false,
    body: 'Certified component release.\n\n```json\n' + JSON.stringify({
      component: 'backend', version, sourceSha: sha, providedApiEpoch: 1, persistenceFormat: 1,
      images: { core: image(digest), full: image(digest === 'a' ? 'd' : 'e') },
    }) + '\n```',
  });
  const records = ['a', 'b', 'c'].map((char, index) => {
    const version = '0.1.' + (index + 1);
    const sourceSha = source(char);
    const coreImage = image(char);
    const fullImage = image(char === 'a' ? 'd' : 'e');
    const metadata = parseComponentRelease(releaseInfo(version, sourceSha, char), version, sourceSha, coreImage, fullImage, compatibility);
    return bindCertifiedImage({
      format: 'codexia-backend-identity/v1', version, sourceSha, platform: 'linux/amd64', profile: 'core',
      migrationFingerprint: 'sha256:' + 'c'.repeat(64), persistenceFormat: 1, apiEpoch: 1,
    }, metadata, coreImage, compatibility);
  });
  const freshSchemaRelease = {
    ...records[2], version: '0.1.4', sourceSha: source('d'), image: image('d'),
    migrationFingerprint: 'sha256:' + 'd'.repeat(64),
  };
  const channels = createSignedTestChannels(records, {
    now: Date.parse('2026-11-16T12:00:00.000Z'), freshSchemaRelease,
  });
  assert.equal(channels.first.verified.payload.sequence, 1);
  assert.equal(channels.second.verified.payload.sequence, 2);
  assert.equal(channels.first.candidate.version, '0.1.2');
  assert.equal(channels.second.candidate.version, '0.1.3');
  assert.equal(JSON.parse(Buffer.from(channels.freshSchema.envelope.payload, 'base64').toString('utf8')).releases[0].version, '0.1.4');
  assert.throws(() => parseComponentRelease(releaseInfo('0.1.2', source('a'), 'b'), '0.1.2', source('b'), image('b'), image('e'), compatibility), /release metadata|source/i);
  assert.throws(() => parseComponentRelease(releaseInfo('0.1.1', source('a'), 'a'), '0.1.1', source('a'), image('a'), image('f'), compatibility), /Full image digest/i);
  assert.throws(() => parseComponentRelease({ ...releaseInfo('0.1.1', source('a'), 'a'), prerelease: true }, '0.1.1', source('a'), image('a'), image('d'), compatibility), /prerelease/i);

  const mainSha=source('f'),producerSha=source('e'),tree=source('d'),base=source('c'),version='0.1.4';
  const promotedProducer={event:'pull_request',sourceSha:producerSha,version,workflowRunId:100,workflowRunNumber:99,workflowAttempt:2,
    workflowId:72,prNumber:23,verifyRunId:101,proofRunId:102,verifyAttempt:1,planDigest:'a'.repeat(64),sourceTree:tree,mergeBaseSha:base,
    artifacts:{core:{id:201,digest:'sha256:'+'b'.repeat(64),producerAttempt:2,archiveSha256:'c'.repeat(64)},
      full:{id:202,digest:'sha256:'+'d'.repeat(64),producerAttempt:2,archiveSha256:'e'.repeat(64)}}};
  const promotedMetadata={component:'backend',version,sourceSha:mainSha,providedApiEpoch:1,persistenceFormat:1,
    images:{core:image('f'),full:image('a')},producer:promotedProducer};
  const promotedRelease={tag_name:'backend-v'+version,draft:false,prerelease:false,
    body:'Certified component release.\n\n```json\n'+JSON.stringify(promotedMetadata)+'\n```'};
  const parsedPromotion=parseComponentRelease(promotedRelease,version,producerSha,image('f'),image('a'),compatibility);
  const promotedIdentity={format:'codexia-backend-identity/v1',version,sourceSha:producerSha,platform:'linux/amd64',profile:'core',
    migrationFingerprint:'sha256:'+'9'.repeat(64),persistenceFormat:1,apiEpoch:1};
  const promotedChannelRelease=bindCertifiedImage(promotedIdentity,parsedPromotion,image('f'),compatibility);
  assert.equal(promotedChannelRelease.sourceSha,producerSha);
  assert.equal(parsedPromotion.sourceSha,mainSha);
  assert.throws(()=>parseComponentRelease({...promotedRelease,body:'Certified component release.\n\n```json\n'+JSON.stringify({...promotedMetadata,producer:{...promotedProducer,sourceSha:mainSha}})+'\n```'},
    version,producerSha,image('f'),image('a'),compatibility),/source/i);

  const mainProducer={event:'push',sourceSha:mainSha,version,workflowRunId:103,workflowRunNumber:99,sourceTree:tree,
    artifacts:{core:{id:203,digest:'sha256:'+'1'.repeat(64),producerAttempt:1,archiveSha256:'2'.repeat(64)},
      full:{id:204,digest:'sha256:'+'3'.repeat(64),producerAttempt:1,archiveSha256:'4'.repeat(64)}}};
  const mainRelease={tag_name:'backend-v'+version,draft:false,prerelease:false,
    body:'Certified component release.\n\n```json\n'+JSON.stringify({...promotedMetadata,producer:mainProducer})+'\n```'};
  const parsedMain=parseComponentRelease(mainRelease,version,mainSha,image('f'),image('a'),compatibility);
  assert.equal(parsedMain.producer.event,'push');
  const duplicateIdMetadata={...promotedMetadata,producer:{...mainProducer,
    artifacts:{...mainProducer.artifacts,full:{...mainProducer.artifacts.full,id:203}}}};
  assert.throws(()=>parseComponentRelease({...mainRelease,body:'Certified component release.\n\n```json\n'+JSON.stringify(duplicateIdMetadata)+'\n```'},
    version,mainSha,image('f'),image('a'),compatibility),/distinct/);
});

test('Phase F fetch loader intercepts only exact disposable channel and identity URLs', { timeout: 15_000 }, async t => {
  const loaderPath = path.join(root, 'scripts/phase-f-fetch-loader.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-phase-f-loader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const channelFile = path.join(directory, 'channel.json');
  const identityFile = path.join(directory, 'identity.json');
  await writeFile(channelFile, '{"fixture":"signed-channel"}');
  await writeFile(identityFile, '{"fixture":"frontend-identity"}');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('fetch-passthrough');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const address = server.address();
  const probe = `
    const read = async (url) => (await fetch(url)).text();
    const values = [
      await read(${JSON.stringify(channelUrl)}),
      await read(${JSON.stringify(frontendUrl)}),
      await read(${JSON.stringify(`http://127.0.0.1:${address.port}/other`)}),
    ];
    if (values.join('|') !== '{"fixture":"signed-channel"}|{"fixture":"frontend-identity"}|fetch-passthrough') process.exit(9);
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loaderPath, '--input-type=module', '-e', probe], {
      env: {
        ...process.env,
        CODEXIA_PHASE_F_CHANNEL_FILE: channelFile,
        CODEXIA_PHASE_F_FRONTEND_URL: frontendUrl,
        CODEXIA_PHASE_F_FRONTEND_IDENTITY_FILE: identityFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status: status ?? (signal ? 128 : 1), signal, stdout, stderr }));
  });
  assert.equal(result.status, 0, result.stderr);
});
