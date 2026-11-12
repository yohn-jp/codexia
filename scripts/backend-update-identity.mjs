import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = filename => JSON.parse(readFileSync(filename, 'utf8'));
const keys = ['apiEpoch', 'format', 'migrationFingerprint', 'persistenceFormat', 'platform', 'profile', 'sourceSha', 'version'];
export const fingerprintProbe = 'import { packagedMigrationFingerprint } from "@codexia/api"; console.log(await packagedMigrationFingerprint());';

export function validateBackendIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      Object.keys(identity).sort().join(',') !== keys.join(',') ||
      identity.format !== 'codexia-backend-identity/v1' ||
      typeof identity.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(identity.version) ||
      typeof identity.sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(identity.sourceSha) ||
      !['core', 'full'].includes(identity.profile) ||
      identity.platform !== 'linux/amd64' ||
      typeof identity.migrationFingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(identity.migrationFingerprint) ||
      !Number.isSafeInteger(identity.apiEpoch) || identity.apiEpoch < 1 ||
      !Number.isSafeInteger(identity.persistenceFormat) || identity.persistenceFormat < 1) {
    throw new Error('Invalid backend update identity');
  }
  return identity;
}

export function assertBackendIdentity(identity, expected, observation) {
  validateBackendIdentity(identity);
  validateBackendIdentity(expected);
  for (const key of keys) {
    if (identity[key] !== expected[key]) throw new Error('Backend identity mismatch: ' + key);
  }
  if (observation.platform !== identity.platform || observation.sourceSha !== identity.sourceSha ||
      observation.migrationFingerprint !== identity.migrationFingerprint ||
      observation.api?.name !== 'codexia' || observation.api?.version !== identity.version ||
      observation.api?.profile !== identity.profile || observation.api?.hosted !== false) {
    throw new Error('Backend runtime does not match embedded identity');
  }
}

function expectedIdentity(profile, sourceSha, migrationFingerprint) {
  const { version } = readJson(path.join(root, 'package.json'));
  const compatibility = readJson(path.join(root, 'deploy/update-compatibility.json'));
  return validateBackendIdentity({ format: 'codexia-backend-identity/v1', version, sourceSha, profile,
    platform: 'linux/amd64', migrationFingerprint, ...compatibility });
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build' && args.length === 3) {
    const [runtime, profile, sourceSha] = args;
    const manifest = readJson(path.join(runtime, 'package.json'));
    if (manifest.name !== '@codexia/profile-' + profile ||
        manifest.version !== readJson(path.join(root, 'package.json')).version ||
        process.platform !== 'linux' || process.arch !== 'x64') {
      throw new Error('Packaged profile, version or architecture mismatch');
    }
    const fingerprint = execFileSync(process.execPath, ['--input-type=module', '-e', fingerprintProbe], {
      cwd: runtime, encoding: 'utf8',
    }).trim();
    writeFileSync(path.join(runtime, 'update-identity.json'), JSON.stringify(expectedIdentity(profile, sourceSha, fingerprint)) + '\n');
  } else if (command === 'verify' && args.length === 7) {
    const [embedded, api, platform, label, fingerprint, sourceSha, profile] = args;
    const identity = JSON.parse(embedded);
    assertBackendIdentity(identity, expectedIdentity(profile, sourceSha, fingerprint), {
      api: JSON.parse(api), platform, sourceSha: label, migrationFingerprint: fingerprint,
    });
    console.log('Backend update identity verified');
  } else {
    throw new Error('Usage: backend-update-identity.mjs build <runtime> <profile> <sha> | verify <identity> <api> <platform> <label> <fingerprint> <sha> <profile>');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
