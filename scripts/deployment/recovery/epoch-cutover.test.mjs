import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  produceEpochCutoverRecoveryReceipt,
  readEpochCutoverRecoveryReceipt,
  validateEpochCutoverRecoveryReceipt,
} from './epoch-cutover.mjs';

const hash = character => character.repeat(64);
const image = character => `ghcr.io/yohn-jp/codexia-backend@sha256:${hash(character)}`;
const binding = {
  environment: 'isolated', hostname: 'codexia.example.test', maintenanceWindowId: 'fixture-window',
  sourceHostId: hash('1'), databaseSystemIdentifier: '7522436994441088668',
  checksumManifestSha256: hash('2'), databaseFingerprint: hash('3'), historyFingerprint: hash('4'),
  priorImage: image('5'), candidateImage: image('6'),
  priorMigrationFingerprint: `sha256:${hash('7')}`, candidateMigrationFingerprint: `sha256:${hash('7')}`,
};
const window = {
  notBefore: '2026-11-23T12:00:00.000Z', notAfter: '2026-11-23T16:00:00.000Z', now: '2026-11-23T13:00:00.000Z',
};
const authRecovery = {
  format: 'codexia-epoch-cutover-auth-recovery/v1', binding, recoveryHostId: hash('8'),
  verifiedAt: '2026-11-23T12:55:00.000Z',
  evidence: {
    offVmCiphertext: hash('9'), postgresRoles: hash('a'), podmanSecrets: hash('b'),
    previousOwnerAuthentication: hash('c'), rollbackProcedure: hash('d'),
  },
};
const receipt = {
  format: 'codexia-epoch-cutover-recovery/v1', binding, recoveryHostId: hash('8'), verifiedAt: window.now, authRecovery,
};
const drillOutput = [
  'Isolated restore verified: database and history fingerprints match',
  `Verified checksum manifest sha256: ${binding.checksumManifestSha256}`,
  `Verified database logical sha256: ${binding.databaseFingerprint}`,
  `Verified history logical sha256: ${binding.historyFingerprint}`,
  `Isolated maintenance rehearsal verified: ${binding.candidateImage}`,
].join('\n');

async function writeAuthEvidence(directory, transactionBinding) {
  const evidence = {};
  for (const check of Object.keys(authRecovery.evidence)) {
    const record = JSON.stringify({ format: 'codexia-epoch-cutover-recovery-check/v1', check,
      binding: transactionBinding, recoveryHostId: authRecovery.recoveryHostId,
      verifiedAt: authRecovery.verifiedAt, status: 'verified', verificationEvidenceSha256: hash('e') });
    await writeFile(path.join(directory, `${check}.json`), record, { mode: 0o600 });
    evidence[check] = createHash('sha256').update(record).digest('hex');
  }
  return { ...authRecovery, binding: transactionBinding, evidence };
}

test('admits only an independent and timely recovery receipt bound to the stopped source', () => {
  assert.deepEqual(validateEpochCutoverRecoveryReceipt(receipt, binding, window), receipt);
  for (const [field, value] of Object.entries({
    environment: 'other', hostname: 'other.example.test', sourceHostId: hash('0'),
    maintenanceWindowId: 'another-window', databaseSystemIdentifier: '7522436994441088669', checksumManifestSha256: hash('0'),
    databaseFingerprint: hash('0'), historyFingerprint: hash('0'), priorImage: image('0'), candidateImage: image('0'),
    priorMigrationFingerprint: `sha256:${hash('0')}`, candidateMigrationFingerprint: `sha256:${hash('0')}`,
  })) {
    assert.throws(() => validateEpochCutoverRecoveryReceipt(receipt, { ...binding, [field]: value }, window), /does not match/u);
  }
  assert.throws(() => validateEpochCutoverRecoveryReceipt({ ...receipt, recoveryHostId: binding.sourceHostId }, binding, window), /independent/u);
  assert.throws(() => validateEpochCutoverRecoveryReceipt({ ...receipt, verifiedAt: '2026-11-23T13:01:00.000Z' }, binding, window), /time/u);
  assert.throws(() => validateEpochCutoverRecoveryReceipt(receipt, binding, { ...window, now: '2026-11-23T16:01:00.000Z' }), /window/u);
  assert.throws(() => validateEpochCutoverRecoveryReceipt({ ...receipt, verifiedAt: '2026-11-23T10:00:00.000Z' }, binding, window), /time/u);
  const { podmanSecrets, ...incomplete } = authRecovery.evidence;
  assert.throws(() => validateEpochCutoverRecoveryReceipt({ ...receipt, authRecovery: { ...authRecovery, evidence: incomplete } }, binding, window), /recovery evidence/u);
});

test('produces a receipt only after the canonical isolated drill verifies the recorded backup and candidate', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-cutover-recovery-evidence-'));
  try {
    const protectedAuthRecovery = await writeAuthEvidence(directory, binding);
    const { evidence } = protectedAuthRecovery;
    const options = { binding, window, authRecovery: protectedAuthRecovery, authEvidenceDirectory: directory,
      recoveryHostId: hash('8'), runDrill: async () => drillOutput, now: () => window.now };
    assert.deepEqual(await produceEpochCutoverRecoveryReceipt(options), { ...receipt, authRecovery: protectedAuthRecovery });
    for (const line of drillOutput.split('\n')) {
      await assert.rejects(produceEpochCutoverRecoveryReceipt({ ...options, runDrill: async () => drillOutput.replace(line, '') }), /restore drill did not verify/u);
    }
    const mustNotRun = async () => assert.fail('untrusted auth proof must reject before drill');
    await assert.rejects(produceEpochCutoverRecoveryReceipt({ ...options, runDrill: async () => `${drillOutput}\nVerified history logical sha256: ${hash('0')}` }), /restore drill did not verify/u);
    await assert.rejects(produceEpochCutoverRecoveryReceipt({ ...options, authRecovery: { ...protectedAuthRecovery, recoveryHostId: hash('0') }, runDrill: mustNotRun }), /recovery host/u);

    const roleRecord = path.join(directory, 'postgresRoles.json');
    const alteredRecord = JSON.stringify({ format: 'codexia-epoch-cutover-recovery-check/v1', check: 'podmanSecrets', binding,
      recoveryHostId: authRecovery.recoveryHostId, verifiedAt: authRecovery.verifiedAt, status: 'verified',
      verificationEvidenceSha256: hash('e') });
    await writeFile(roleRecord, alteredRecord);
    await assert.rejects(produceEpochCutoverRecoveryReceipt({ ...options, runDrill: mustNotRun }), /digest/u);
    const changedEvidence = { ...evidence, postgresRoles: createHash('sha256').update(alteredRecord).digest('hex') };
    await assert.rejects(produceEpochCutoverRecoveryReceipt({ ...options, authRecovery: { ...protectedAuthRecovery, evidence: changedEvidence }, runDrill: mustNotRun }), /check record/u);
    await rm(roleRecord);
    await assert.rejects(produceEpochCutoverRecoveryReceipt({ ...options, runDrill: mustNotRun }), /protected regular file/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('new recovery evidence binds the exact plan and an API-only or first-activation restore', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-pair-recovery-'));
  try {
    const apiOnly = { ...binding, planSha256: hash('f'), migration: null };
    const activation = { ...apiOnly, priorImage: null, priorMigrationFingerprint: null };
    const readOnlyLedgerProof = `Isolated candidate ledger verified: ${binding.candidateMigrationFingerprint}`;
    const noConversionOutput = drillOutput.replace(`Isolated maintenance rehearsal verified: ${binding.candidateImage}`, readOnlyLedgerProof);
    for (const currentBinding of [apiOnly, activation]) {
      const proof = await writeAuthEvidence(directory, currentBinding);
      const options = { binding: currentBinding, window, authRecovery: proof, authEvidenceDirectory: directory,
        recoveryHostId: hash('8'), now: () => window.now,
        runDrill: async input => {
          assert.deepEqual(input, { backupDirectory: undefined, ageIdentityFile: undefined,
            candidateImage: binding.candidateImage, candidateMigrationFingerprint: binding.candidateMigrationFingerprint, migration: null });
          return noConversionOutput;
        } };
      const result = await produceEpochCutoverRecoveryReceipt(options);
      assert.deepEqual(result.binding, currentBinding);
      assert.throws(() => validateEpochCutoverRecoveryReceipt(result, { ...currentBinding, planSha256: hash('0') }, window), /does not match/u);
      assert.throws(() => validateEpochCutoverRecoveryReceipt(receipt, currentBinding, window), /does not match/u);
      await assert.rejects(produceEpochCutoverRecoveryReceipt({ ...options, runDrill: async () => drillOutput }), /restore drill did not verify/u);
      await assert.rejects(produceEpochCutoverRecoveryReceipt({
        ...options, runDrill: async () => `${noConversionOutput}\nIsolated maintenance rehearsal verified: ${binding.candidateImage}`,
      }), /restore drill did not verify/u);
    }

    const conversion = { ...apiOnly, migration: 'snapshot-history-v2' };
    const conversionProof = await writeAuthEvidence(directory, conversion);
    const options = { binding: conversion, window, authRecovery: conversionProof, authEvidenceDirectory: directory,
      recoveryHostId: hash('8'), now: () => window.now };
    assert.deepEqual((await produceEpochCutoverRecoveryReceipt({ ...options, runDrill: async () => `${drillOutput}\n${readOnlyLedgerProof}` })).binding, conversion);
    await assert.rejects(produceEpochCutoverRecoveryReceipt({ ...options, runDrill: async () => noConversionOutput }), /restore drill did not verify/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects partial, unknown and unsupported pair recovery bindings before the drill', async () => {
  const pair = { ...binding, planSha256: hash('f'), migration: null };
  for (const invalid of [
    { ...binding, migration: null }, { ...binding, planSha256: hash('f') },
    { ...pair, migration: 'unknown' }, { ...pair, priorImage: null },
    { ...pair, priorMigrationFingerprint: null },
    { ...pair, priorImage: null, priorMigrationFingerprint: null, migration: 'snapshot-history-v2' },
    { ...pair, priorMigrationFingerprint: `sha256:${hash('8')}` },
  ]) await assert.rejects(produceEpochCutoverRecoveryReceipt({ binding: invalid, window }), /binding/u);
});

test('reads receipts only from protected regular files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codexia-cutover-recovery-'));
  try {
    const file = path.join(directory, 'receipt.json');
    await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
    assert.deepEqual(await readEpochCutoverRecoveryReceipt(file, binding, window), receipt);
    const alias = path.join(directory, 'alias.json');
    await symlink(file, alias);
    await assert.rejects(readEpochCutoverRecoveryReceipt(alias, binding, window), /protected/u);
    const exposed = path.join(directory, 'exposed.json');
    await writeFile(exposed, JSON.stringify(receipt), { mode: 0o644 });
    await chmod(exposed, 0o644);
    await assert.rejects(readEpochCutoverRecoveryReceipt(exposed, binding, window), /protected/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
