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
