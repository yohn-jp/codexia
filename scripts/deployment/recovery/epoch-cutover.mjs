import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const receiptFormat = 'codexia-epoch-cutover-recovery/v1';
const authRecoveryFormat = 'codexia-epoch-cutover-auth-recovery/v1';
const sha256 = /^[a-f0-9]{64}$/u;
const fingerprint = /^sha256:[a-f0-9]{64}$/u;
const image = /^ghcr\.io\/yohn-jp\/codexia-backend@sha256:[a-f0-9]{64}$/u;
const label = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const bindingPatterns = {
  environment: label,
  hostname,
  maintenanceWindowId: label,
  sourceHostId: sha256,
  databaseSystemIdentifier: /^[1-9][0-9]{0,19}$/u,
  checksumManifestSha256: sha256,
  databaseFingerprint: sha256,
  historyFingerprint: sha256,
  priorImage: image,
  candidateImage: image,
  priorMigrationFingerprint: fingerprint,
  candidateMigrationFingerprint: fingerprint,
};
const authEvidenceFields = ['offVmCiphertext', 'postgresRoles', 'podmanSecrets', 'previousOwnerAuthentication', 'rollbackProcedure'];
const run = promisify(execFile);
const backupProgram = fileURLToPath(new URL('../../../deploy/backup/backup.sh', import.meta.url));

function matches(value, pattern) {
  return typeof value === 'string' && value.trim() === value && pattern.test(value);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function verifyBinding(binding, expected) {
  const fields = Object.keys(bindingPatterns);
  if (!exactKeys(binding, fields) || !fields.every(field => matches(binding[field], bindingPatterns[field])) ||
      binding.hostname.length > 253 || binding.priorImage === binding.candidateImage) {
    throw new Error('Invalid epoch cutover recovery binding');
  }
  if (expected && fields.some(field => binding[field] !== expected[field])) {
    throw new Error('Recovery proof does not match the stopped source and certified candidate');
  }
}

function time(value) {
  if (!matches(value, timestamp)) throw new Error('Invalid epoch cutover recovery timestamp');
  const date = new Date(value);
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(date.valueOf()) || normalized !== date.toISOString()) {
    throw new Error('Invalid epoch cutover recovery timestamp');
  }
  return date.valueOf();
}

function verifyWindow({ notBefore, notAfter, now = new Date().toISOString() }) {
  const start = time(notBefore);
  const end = time(notAfter);
  const observed = time(now);
  if (start >= end || observed < start || observed > end) {
    throw new Error('Recovery proof requires a current approved maintenance window');
  }
  return { start, observed };
}

function verifyIndependentHost(recoveryHostId, sourceHostId) {
  if (!matches(recoveryHostId, sha256) || recoveryHostId === sourceHostId) {
    throw new Error('Recovery proof requires an independent recovery host');
  }
}

function verifyAuthRecovery(authRecovery, binding, recoveryHostId, start, latest) {
  if (!exactKeys(authRecovery, ['format', 'binding', 'recoveryHostId', 'verifiedAt', 'evidence']) ||
      authRecovery.format !== authRecoveryFormat || !exactKeys(authRecovery.evidence, authEvidenceFields) ||
      authEvidenceFields.some(field => !matches(authRecovery.evidence[field], sha256))) {
    throw new Error('Missing protected roles, secrets, owner and rollback recovery evidence');
  }
  verifyBinding(authRecovery.binding, binding);
  if (authRecovery.recoveryHostId !== recoveryHostId) throw new Error('Authentication recovery evidence names a different recovery host');
  const verified = time(authRecovery.verifiedAt);
  if (verified < start || verified > latest) throw new Error('Authentication recovery evidence time is outside the verified window');
}

/** Recheck a receipt supplied by the protected recovery authority against live cutover and backup observations. */
export function validateEpochCutoverRecoveryReceipt(receipt, binding, window) {
  verifyBinding(binding);
  if (!exactKeys(receipt, ['format', 'binding', 'recoveryHostId', 'verifiedAt', 'authRecovery']) || receipt.format !== receiptFormat) {
    throw new Error('Invalid epoch cutover recovery receipt');
  }
  verifyBinding(receipt.binding, binding);
  verifyIndependentHost(receipt.recoveryHostId, binding.sourceHostId);
  const { start, observed } = verifyWindow(window);
  const verified = time(receipt.verifiedAt);
  if (verified < start || verified > observed) throw new Error('Recovery receipt time is outside the verified window');
  verifyAuthRecovery(receipt.authRecovery, binding, receipt.recoveryHostId, start, verified);
  return receipt;
}

async function readProtectedFile(filename) {
  try {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || ![0o400, 0o600].includes(stat.mode & 0o7777) || stat.size > 16_384) {
        throw new Error('Unsafe recovery input');
      }
      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('Recovery input must be a protected regular file owned by the current user');
  }
}

function parseRecoveryJson(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Recovery input must contain valid JSON');
  }
}

async function readProtectedJson(filename) {
  return parseRecoveryJson(await readProtectedFile(filename));
}

async function verifyAuthRecoveryRecords(directory, authRecovery, start) {
  const attestedAt = time(authRecovery.verifiedAt);
  for (const check of authEvidenceFields) {
    const bytes = await readProtectedFile(path.join(directory, `${check}.json`));
    if (createHash('sha256').update(bytes).digest('hex') !== authRecovery.evidence[check]) {
      throw new Error('Authentication recovery record digest differs from its protected attestation');
    }
    const record = parseRecoveryJson(bytes);
    if (!exactKeys(record, ['format', 'check', 'binding', 'recoveryHostId', 'verifiedAt', 'status', 'verificationEvidenceSha256']) ||
        record.format !== 'codexia-epoch-cutover-recovery-check/v1' || record.check !== check || record.status !== 'verified' ||
        record.recoveryHostId !== authRecovery.recoveryHostId || !matches(record.verificationEvidenceSha256, sha256)) {
      throw new Error('Invalid protected authentication recovery check record');
    }
    verifyBinding(record.binding, authRecovery.binding);
    const checkedAt = time(record.verifiedAt);
    if (checkedAt < start || checkedAt > attestedAt) throw new Error('Authentication recovery check record time is outside the verified window');
  }
}

export async function readEpochCutoverRecoveryReceipt(filename, binding, window) {
  return validateEpochCutoverRecoveryReceipt(await readProtectedJson(filename), binding, window);
}

async function runCanonicalDrill({ backupDirectory, ageIdentityFile, candidateImage }) {
  try {
    const result = await run('bash', [backupProgram, 'drill', backupDirectory, ageIdentityFile, '--approved', '--candidate-full-image', candidateImage]);
    return result.stdout;
  } catch {
    throw new Error('The canonical isolated restore drill failed');
  }
}

/** Run the canonical drill, and produce a digest-only receipt for protected handoff. */
export async function produceEpochCutoverRecoveryReceipt({
  binding, window, authRecovery, authEvidenceDirectory, recoveryHostId, backupDirectory, ageIdentityFile,
  runDrill = runCanonicalDrill, now = () => new Date().toISOString(),
}) {
  verifyBinding(binding);
  verifyIndependentHost(recoveryHostId, binding.sourceHostId);
  const { start, observed } = verifyWindow({ ...window, now: now() });
  verifyAuthRecovery(authRecovery, binding, recoveryHostId, start, observed);
  await verifyAuthRecoveryRecords(authEvidenceDirectory, authRecovery, start);

  const stdout = await runDrill({ backupDirectory, ageIdentityFile, candidateImage: binding.candidateImage });
  const lines = stdout.split('\n');
  const evidence = new Map([
    ['Isolated restore verified:', 'database and history fingerprints match'],
    ['Verified checksum manifest sha256:', binding.checksumManifestSha256],
    ['Verified database logical sha256:', binding.databaseFingerprint],
    ['Verified history logical sha256:', binding.historyFingerprint],
    ['Isolated maintenance rehearsal verified:', binding.candidateImage],
  ]);
  for (const [prefix, value] of evidence) {
    const matches = lines.filter(line => line.startsWith(prefix));
    if (matches.length !== 1 || matches[0] !== `${prefix} ${value}`) {
      throw new Error('The isolated restore drill did not verify the expected backup and candidate');
    }
  }
  const verifiedAt = now();
  return validateEpochCutoverRecoveryReceipt({ format: receiptFormat, binding, recoveryHostId, verifiedAt, authRecovery }, binding,
    { ...window, now: verifiedAt });
}

async function main() {
  const { values } = parseArgs({ options: {
    'binding-file': { type: 'string' }, 'auth-recovery-file': { type: 'string' }, 'auth-evidence-directory': { type: 'string' },
    'backup-directory': { type: 'string' }, 'age-identity-file': { type: 'string' },
    'receipt-file': { type: 'string' }, 'not-before': { type: 'string' }, 'not-after': { type: 'string' },
    approved: { type: 'boolean' },
  } });
  const paths = ['binding-file', 'auth-recovery-file', 'auth-evidence-directory', 'backup-directory', 'age-identity-file', 'receipt-file'];
  if (values.approved !== true || paths.some(field => typeof values[field] !== 'string' || !path.isAbsolute(values[field]))) {
    throw new Error('Provide absolute binding, authentication proof, backup, age identity and receipt paths with explicit drill approval');
  }
  const [binding, authRecovery, machineIdentity] = await Promise.all([
    readProtectedJson(values['binding-file']), readProtectedJson(values['auth-recovery-file']), readFile('/etc/machine-id', 'utf8'),
  ]);
  const machineId = machineIdentity.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/u.test(machineId)) throw new Error('Could not observe a stable recovery host identity');
  const receipt = await produceEpochCutoverRecoveryReceipt({
    binding, authRecovery, authEvidenceDirectory: values['auth-evidence-directory'],
    recoveryHostId: createHash('sha256').update(machineId).digest('hex'),
    window: { notBefore: values['not-before'], notAfter: values['not-after'] },
    backupDirectory: values['backup-directory'], ageIdentityFile: values['age-identity-file'],
  });
  await writeFile(values['receipt-file'], `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' }).catch(() => {
    throw new Error('Could not create a new protected recovery receipt');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => {
    console.error(error.code ? 'Could not collect epoch cutover recovery evidence' : error.message);
    process.exitCode = 1;
  });
}
