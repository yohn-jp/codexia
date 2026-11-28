import { actionsRepository } from '../../github/repository.mjs';
import { digestEvidence } from './evidence-digest.mjs';

const hash = /^[a-f0-9]{64}$/u;

// This assertion is supplied by the protected preservation authority, never
// by a deployment request. The exact stopped backup is proved separately.
export function readPreservationEvidence(raw, host, context = actionsRepository()) {
  if (!raw) return null;
  let evidence;
  try {
    evidence = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!evidence || evidence.format !== 'codexia-deployment-preservation/v1' ||
      evidence.repository !== context.repository || evidence.repositoryId !== context.repositoryId ||
      evidence.ownerId !== context.ownerId || evidence.sourceHostId !== host?.hostId || evidence.databaseSha256 !== digestEvidence(host?.database ?? null) ||
      !hash.test(evidence.independentBackupEvidenceSha256 ?? '') ||
      Object.keys(evidence).length !== 7) return null;
  return evidence;
}
