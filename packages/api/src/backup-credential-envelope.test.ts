import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { backupCredentialKeyId, sealBackupCredential } from './backup-credential-envelope.js';
import { openBackupCredential, openBackupCredentialWithKeyring } from './backup-credential-worker.js';

test('sealed backup credentials round trip and bind to a key ID', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const credential = { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret', sessionToken: 'fixture-session' };
  const envelope = sealBackupCredential(publicPem, credential, 'fixture-destination-one');
  assert.equal(envelope.keyId, backupCredentialKeyId(publicPem));
  assert.notEqual(envelope.ciphertext.includes('fixture-secret'), true);
  assert.deepEqual(openBackupCredential(privatePem, envelope, 'fixture-destination-one'), credential);
  assert.deepEqual(
    openBackupCredentialWithKeyring(new Map([[envelope.keyId, privatePem]]), envelope, 'fixture-destination-one'),
    credential,
  );
  assert.throws(() => openBackupCredential(privatePem, envelope, 'fixture-destination-two'));
});

test('credential envelope rejects a tampered key ID and supports rotation by public key', () => {
  const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const firstPublic = first.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const secondPublic = second.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const envelope = sealBackupCredential(secondPublic, { accessKeyId: 'a', secretAccessKey: 'b' });
  assert.notEqual(backupCredentialKeyId(firstPublic), envelope.keyId);
  const firstPrivate = first.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const secondPrivate = second.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.deepEqual(
    openBackupCredentialWithKeyring(
      new Map([
        [backupCredentialKeyId(firstPublic), firstPrivate],
        [envelope.keyId, secondPrivate],
      ]),
      envelope,
    ),
    { accessKeyId: 'a', secretAccessKey: 'b' },
  );
  assert.throws(() => openBackupCredential(first.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), envelope));
  envelope.keyId = backupCredentialKeyId(firstPublic);
  assert.throws(() => openBackupCredential(second.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), envelope));
});
