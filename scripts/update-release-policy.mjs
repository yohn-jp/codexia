// Pure compatibility policy. Inputs MUST already be authenticated by the
// standalone release publication/verification boundary. This module does not
// establish publisher identity, registry freshness, revocation or deployment authority.
const fields = [
  'format', 'channel', 'state', 'version', 'sourceSha', 'image', 'platform',
  'profile', 'migrationFingerprint', 'persistenceFormat', 'apiEpoch',
];
const digest = /^sha256:[a-f0-9]{64}$/u;
const backendImage = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) {
    throw new Error('Expected a stable semantic version');
  }
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Unsupported version component');
  return parts;
}

export function validateUpdateRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error('Invalid update release fields');
  }
  if (value.format !== 'codexia-update-release/v1' || value.channel !== 'stable' ||
      !['published', 'withdrawn'].includes(value.state)) throw new Error('Invalid release format, channel or state');
  versionParts(value.version);
  if (typeof value.sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(value.sourceSha)) throw new Error('Invalid source revision');
  if (typeof value.image !== 'string' || !backendImage.test(value.image)) throw new Error('Expected an immutable Codexia backend image');
  if (value.platform !== 'linux/amd64' || !['core', 'full'].includes(value.profile)) throw new Error('Unsupported release platform or profile');
  if (typeof value.migrationFingerprint !== 'string' || !digest.test(value.migrationFingerprint)) throw new Error('Invalid migration fingerprint');
  if (!positiveInteger(value.persistenceFormat) || !positiveInteger(value.apiEpoch)) throw new Error('Invalid compatibility epoch');
  return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
}

/**
 * Check an already authenticated candidate against the installed release and
 * deployed UI epoch. Throws on incompatible or non-forward releases.
 * Success is compatibility only, never authorization to activate an image.
 */
export function assertCompatibleUpdate(installedValue, candidateValue, deployedUiEpoch) {
  const installed = validateUpdateRelease(installedValue);
  const candidate = validateUpdateRelease(candidateValue);
  if (candidate.state !== 'published') throw new Error('Candidate release is withdrawn');
  const [major, minor, patch] = versionParts(installed.version);
  const [nextMajor, nextMinor, nextPatch] = versionParts(candidate.version);
  if (nextMajor !== major || (major === 0 && nextMinor !== minor)) throw new Error('Manual breaking-version update required');
  if (nextMinor < minor || (nextMinor === minor && nextPatch <= patch)) throw new Error('Candidate version must advance');
  if (candidate.image === installed.image || candidate.sourceSha === installed.sourceSha) throw new Error('Candidate must have a new image and source revision');
  if (candidate.profile !== installed.profile || candidate.platform !== installed.platform) throw new Error('Release profile or platform changed');
  if (candidate.migrationFingerprint !== installed.migrationFingerprint) throw new Error('Manual database migration required');
  if (candidate.persistenceFormat !== installed.persistenceFormat) throw new Error('Manual persistent-format update required');
  if (!positiveInteger(deployedUiEpoch) || installed.apiEpoch !== deployedUiEpoch || candidate.apiEpoch !== deployedUiEpoch) {
    throw new Error('Frontend/API compatibility epoch mismatch');
  }
  return candidate;
}
