import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ownerSetupWranglerConfig, stageOwnerSetupAssets } from '../../build/frontend/owner-setup-assets.mjs';
import { createCloudflareCutover, ownerSetupArtifactTag } from '../../release/cutover/cloudflare.mjs';
import { digestEvidence } from '../cutover/coordinator.mjs';
import { parsePreflightRequest } from '../preflight/run.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);

async function main(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, 'yohn-jp/codexia');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
  assert.ok(env.GH_TOKEN && env.CODEXIA_OWNER_SETUP_WORKER_TOKEN, 'Protected staging credentials required');
  const assertCurrentMain = async () => {
    const { stdout } = await run('gh', ['api', 'repos/yohn-jp/codexia/git/ref/heads/main', '--jq', '.object.sha'],
      { timeout: 30_000 });
    assert.equal(stdout.trim(), env.GITHUB_SHA, 'Main changed after protected setup asset dispatch');
  };
  await assertCurrentMain();
  const request = parsePreflightRequest(env.CODEXIA_PREFLIGHT_REQUEST ?? '');
  assert.equal(request.intent, 'install', 'Owner setup assets require install intent');
  const candidate = JSON.parse(await readFile(join(env.RUNNER_TEMP, 'codexia-lifecycle-candidate.json'), 'utf8'));
  assert.equal(candidate.sourceSha, env.GITHUB_SHA);
  assert.equal(candidate.runId, Number(env.GITHUB_RUN_ID));
  assert.equal(candidate.attempt, Number(env.GITHUB_RUN_ATTEMPT));
  assert.equal(candidate.requestSha256, digestEvidence(request));
  const artifactDigest = candidate.candidateFrontend.artifactDigest;
  assert.equal(artifactDigest, request.frontend.artifactDigest);
  const config = JSON.parse(env.CODEXIA_CUTOVER_CLOUDFLARE_TARGET);
  const edge = createCloudflareCutover({ ...config, origin: env.CODEXIA_PUBLIC_ORIGIN,
    readToken: env.CODEXIA_CUTOVER_CLOUDFLARE_READ_TOKEN });
  const scratch = await mkdtemp(join(env.RUNNER_TEMP, 'codexia-owner-setup-'));
  try {
    const directory = join(scratch, 'assets');
    await stageOwnerSetupAssets(join(root, 'app/dist'), directory);
    const wranglerConfig = join(scratch, 'wrangler.json');
    await writeFile(wranglerConfig, JSON.stringify(ownerSetupWranglerConfig(directory)), { mode: 0o600, flag: 'wx' });
    const before = await edge.assertOwnerSetupDetached();
    assert.equal(before.publicProtocolEnabled, false, 'Disable the public protocol bypass before staging owner setup');
    await assertCurrentMain();
    await run(join(root, 'edge/frontend/node_modules/.bin/wrangler'), ['deploy', '--config', wranglerConfig,
      '--tag', ownerSetupArtifactTag(artifactDigest), '--no-autoconfig', '--strict'], {
      cwd: scratch,
      env: { PATH: env.PATH, HOME: env.HOME, CI: 'true', WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_ACCOUNT_ID: config.accountId, CLOUDFLARE_API_TOKEN: env.CODEXIA_OWNER_SETUP_WORKER_TOKEN },
      timeout: 5 * 60_000,
    });
    const [staged, after] = await Promise.all([edge.observeOwnerSetup(artifactDigest), edge.assertOwnerSetupDetached()]);
    assert.equal(after.ingressDigest, before.ingressDigest, 'Ingress changed while staging the detached Worker');
    assert.deepEqual(after.deployment, before.deployment, 'The normal frontend changed during owner setup staging');
    console.log(`Exact owner setup artifact staged on detached Worker version ${staged.versionId}.`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch {
    console.error('Protected owner setup staging failed or could not be verified. No route changes were requested.');
    process.exitCode = 1;
  }
}
