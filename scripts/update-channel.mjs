import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { assertCompatibleUpdate, validateUpdateRelease } from './update-release-policy.mjs';

const FORMAT = 'codexia-update-channel/v1';
const verifiedChannels = new WeakSet();
const MAX_BYTES = 1024 * 1024;
const MAX_VALIDITY = 24 * 60 * 60 * 1000;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const positive = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new Error('Invalid channel timestamp');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('Invalid channel timestamp');
  return time;
}

function validatePayload(value, now) {
  if (!exact(value, ['format', 'sequence', 'issuedAt', 'expiresAt', 'releases']) ||
      value.format !== FORMAT || !positive(value.sequence) || !Array.isArray(value.releases) || value.releases.length > 1000) {
    throw new Error('Invalid stable channel payload');
  }
  const issued = timestamp(value.issuedAt);
  const expires = timestamp(value.expiresAt);
  if (!Number.isSafeInteger(now) || issued > now || expires <= now || expires <= issued || expires - issued > MAX_VALIDITY) {
    throw new Error('Channel is expired, not yet valid, or exceeds its validity window');
  }
  const releases = value.releases.map(validateUpdateRelease);
  const seen = new Set();
  for (const release of releases) {
    const scope = `${release.platform}/${release.profile}`;
    for (const identity of [`version:${release.version}`, `image:${release.image}`, `source:${release.sourceSha}`]) {
      const key = `${scope}/${identity}`;
      if (seen.has(key)) throw new Error('Duplicate release identity in stable channel');
      seen.add(key);
    }
  }
  return Object.freeze({ ...value, releases: Object.freeze(releases) });
}

function decode(value, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || value.length === 0) throw new Error('Invalid channel encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || bytes.toString('base64') !== value) throw new Error('Invalid channel encoding');
  return bytes;
}

function keyFor(pem, privateKey) {
  if (typeof pem !== 'string') throw new Error('Expected a pinned Ed25519 PEM key');
  const key = privateKey ? createPrivateKey(pem) : createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 key');
  return key;
}

/** Caller must independently certify and bind each artifact before signing. */
export function signUpdateChannel(value, privateKeyPem, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify(validatePayload(value, now)), 'utf8');
  if (payload.length > MAX_BYTES) throw new Error('Channel exceeds size limit');
  return { payload: payload.toString('base64'), signature: sign(null, payload, keyFor(privateKeyPem, true)).toString('base64') };
}

function authenticatedPayload(envelope, publicKeyPem) {
  if (!exact(envelope, ['payload', 'signature'])) throw new Error('Invalid signed channel envelope');
  const bytes = decode(envelope.payload, MAX_BYTES);
  const signature = decode(envelope.signature, 64);
  if (signature.length !== 64 || !verify(null, bytes, keyFor(publicKeyPem, false), signature)) throw new Error('Invalid channel signature');
  return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
}

/** Publisher-only: authenticate an expired predecessor without treating it as a deployable channel. */
export function authenticateHistoricalChannel(envelope, publicKeyPem) {
  const { value } = authenticatedPayload(envelope, publicKeyPem);
  return validatePayload(value, timestamp(value.issuedAt));
}

/** Verify exact bytes before JSON interpretation. Persist the returned checkpoint atomically before acting. */
export function verifyUpdateChannel(envelope, publicKeyPem, previous = null, now = Date.now()) {
  const { bytes, value } = authenticatedPayload(envelope, publicKeyPem);
  const payload = validatePayload(value, now);
  const checkpoint = Object.freeze({ sequence: payload.sequence, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
  if (previous !== null) {
    if (!exact(previous, ['sequence', 'sha256']) || !positive(previous.sequence) || typeof previous.sha256 !== 'string' || !SHA.test(previous.sha256)) throw new Error('Invalid stored channel checkpoint');
    if (checkpoint.sequence < previous.sequence || (checkpoint.sequence === previous.sequence && checkpoint.sha256 !== previous.sha256)) throw new Error('Channel rollback or equivocation');
  }
  const verified = Object.freeze({ payload, checkpoint });
  verifiedChannels.add(verified);
  return verified;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

/** Only pass a channel returned by verifyUpdateChannel; this is not deployment authority. */
export function selectUpdateCandidate(verified, installedValue, uiEpoch) {
  if (!verifiedChannels.has(verified)) throw new Error('Channel has not been authenticated');
  const installed = validateUpdateRelease(installedValue);
  const candidates = verified.payload.releases.filter(release => release.profile === installed.profile && release.platform === installed.platform);
  const withdrawn = candidates.filter(release => release.state === 'withdrawn');
  const forward = candidates.filter(release => release.state === 'published' && compareVersions(release.version, installed.version) > 0)
    .sort((left, right) => compareVersions(right.version, left.version));
  const newest = forward[0];
  if (!newest) return null;
  if (withdrawn.some(release => release.image === newest.image || release.sourceSha === newest.sourceSha)) throw new Error('Candidate reuses a withdrawn artifact');
  return assertCompatibleUpdate(installed, newest, uiEpoch);
}
