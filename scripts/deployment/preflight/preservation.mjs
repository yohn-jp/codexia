import { digestEvidence } from './evidence-digest.mjs';

const hash = /^[a-f0-9]{64}$/u;

// This assertion is supplied by the protected preservation authority, never
// by a deployment request. The exact stopped backup is proved separately.
export function readPreservationEvidence(raw, host) {
  if (!raw) return null;
  const evidence = JSON.parse(raw);
  if (!evidence || evidence.format !== 'codexia-deployment-preservation/v1' ||
      evidence.sourceHostId !== host?.hostId || evidence.databaseSha256 !== digestEvidence(host?.database ?? null) ||
      !hash.test(evidence.independentBackupEvidenceSha256 ?? '') ||
      Object.keys(evidence).length !== 4) return null;
  return evidence;
}

export function initialBackupBinding(host) {
  if (host?.H !== 'ready' || host.transaction !== null || host.backend?.state !== 'absent' ||
      host.database?.authState !== 'ready' || host.database.state !== 'initialized' ||
      !/^sha256:[a-f0-9]{64}$/u.test(host.database.ownerBindingSha256 ?? '') ||
      !hash.test(host.database.settingsSha256 ?? '') || !hash.test(host.hostId ?? '')) return null;
  const secretIds = host.topology?.secretHashes;
  if (!secretIds || !Object.values(secretIds).some(value => hash.test(value ?? ''))) return null;
  return { sourceHostId: host.hostId, databaseSha256: digestEvidence(host.database), secretSetSha256: digestEvidence(secretIds) };
}

export function trustedInitialBackupRun(run, sha) {
  return run.head_sha === sha && run.head_branch === 'main' && run.event === 'workflow_dispatch' &&
    run.repository?.full_name === 'yohn-jp/codexia' && run.head_repository?.full_name === 'yohn-jp/codexia' &&
    ['.github/workflows/production-bootstrap.yml', '.github/workflows/initial-preservation.yml'].includes(run.path) &&
    run.status === 'completed' && run.conclusion === 'success' && run.run_attempt === 1;
}

// The verification job publishes this small receipt only after a real S3
// download and a successful database/history restore on a separate runner.
export async function findPreservationEvidence(host) {
  const binding = initialBackupBinding(host);
  if (!binding) return null;
  const { createGitHubOctokit } = await import('../../github/octokit.mjs');
  const { downloadArtifact, extractJsonEntry } = await import('../../ci/evidence/download-artifacts.mjs');
  const { GITHUB_SHA: sha, GH_TOKEN: token } = process.env;
  const client = createGitHubOctokit({ token });
  const repository = { owner: 'yohn-jp', repo: 'codexia' };
  const name = 'initial-preservation-' + binding.sourceHostId + '-' + binding.databaseSha256;
  for await (const page of client.paginate.iterator(client.rest.actions.listArtifactsForRepo, { ...repository, name, per_page: 100 })) {
    for (const artifact of page.data) {
      if (artifact.expired || artifact.name !== name || artifact.workflow_run?.head_sha !== sha) continue;
      const { data: run } = await client.rest.actions.getWorkflowRun({ ...repository, run_id: artifact.workflow_run.id });
      if (!trustedInitialBackupRun(run, sha)) continue;
      const bytes = await downloadArtifact(artifact, 'yohn-jp/codexia', token, fetch, { maxArchive: 8192 });
      const evidence = JSON.parse(await extractJsonEntry(bytes, 'preservation.json'));
      if (evidence.format === 'codexia-initial-preservation/v1' && evidence.sourceSha === sha &&
          evidence.runId === run.id && evidence.attempt === run.run_attempt &&
          evidence.sourceHostId === binding.sourceHostId && evidence.databaseSha256 === binding.databaseSha256 &&
          evidence.secretSetSha256 === binding.secretSetSha256 &&
          [evidence.independentBackupEvidenceSha256, evidence.databaseFingerprint, evidence.historyFingerprint]
            .every(value => hash.test(value ?? ''))) return evidence;
    }
  }
  return null;
}
