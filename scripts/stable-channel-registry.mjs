import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { validateUpdateRelease } from './update-release-policy.mjs';

const FORMAT = 'codexia-stable-channel-registry/v1';
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_REGISTRY_BYTES = 64 * 1024 * 1024;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const keyFor = (pem, isPrivate) => {
  const key = isPrivate ? createPrivateKey(pem) : createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 key');
  return key;
};

function validateRegistry(value) {
  if (!exact(value, ['format', 'channelSequence', 'channelSha256', 'releases']) || value.format !== FORMAT ||
      !positive(value.channelSequence) || typeof value.channelSha256 !== 'string' || !HASH.test(value.channelSha256) ||
      !Array.isArray(value.releases)) throw new Error('Invalid stable channel registry');
  const releases = value.releases.map(validateUpdateRelease);
  const seen = new Set();
  for (const release of releases) {
    const scope = `${release.platform}/${release.profile}`;
    for (const identity of [`version:${release.version}`, `image:${release.image}`, `source:${release.sourceSha}`]) {
      const key = `${scope}/${identity}`;
      if (seen.has(key)) throw new Error('Duplicate historical release identity');
      seen.add(key);
    }
  }
  return { ...value, releases };
}

function channelBinding(channelBytes, sequence) {
  const text = Buffer.isBuffer(channelBytes) ? channelBytes : Buffer.from(channelBytes);
  let envelope;
  try { envelope = JSON.parse(text.toString('utf8')); } catch { throw new Error('Invalid stable channel document'); }
  if (!envelope || typeof envelope.payload !== 'string') throw new Error('Invalid stable channel document');
  const payload = Buffer.from(envelope.payload, 'base64');
  let body;
  try { body = JSON.parse(payload.toString('utf8')); } catch { throw new Error('Invalid stable channel payload'); }
  if (body.sequence !== sequence) throw new Error('Registry channel sequence mismatch');
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** Authenticate history against the exact signed channel bytes stored in the same Git commit. */
export function verifyStableChannelRegistry(envelope, publicKeyPem, channelBytes) {
  if (!exact(envelope, ['payload', 'signature']) || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Invalid stable channel registry envelope');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (bytes.length > MAX_REGISTRY_BYTES || bytes.toString('base64') !== envelope.payload) throw new Error('Invalid stable channel registry encoding');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature || !verify(null, bytes, keyFor(publicKeyPem, false), signature)) throw new Error('Invalid stable channel registry signature');
  const registry = validateRegistry(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (registry.channelSha256 !== channelBinding(channelBytes, registry.channelSequence)) throw new Error('Stable channel registry does not bind current channel');
  return Object.freeze({ ...registry, releases: Object.freeze(registry.releases) });
}

export function signStableChannelRegistry(value, privateKeyPem, channelBytes) {
  const registry = validateRegistry({ ...value, channelSha256: channelBinding(channelBytes, value.channelSequence) });
  const bytes = Buffer.from(JSON.stringify(registry), 'utf8');
  if (bytes.length > MAX_REGISTRY_BYTES) throw new Error('Stable channel registry exceeds size limit');
  return { payload: bytes.toString('base64'), signature: sign(null, bytes, keyFor(privateKeyPem, true)).toString('base64') };
}

export function initialStableChannelRegistry(channel, channelBytes) {
  return { format: FORMAT, channelSequence: channel.sequence,
    channelSha256: channelBinding(channelBytes, channel.sequence), releases: channel.releases.map(validateUpdateRelease) };
}

export function nextStableChannelRegistry(registry, channel, channelBytes, releases = registry.releases) {
  return { format: FORMAT, channelSequence: channel.sequence,
    channelSha256: channelBinding(channelBytes, channel.sequence), releases: releases.map(validateUpdateRelease) };
}

export const stableChannelRegistryFormat = FORMAT;
