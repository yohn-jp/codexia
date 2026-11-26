/** Executor-only decryption. The API path must never load a private key. */
import { constants, createDecipheriv, createPublicKey, privateDecrypt } from 'node:crypto';
import {
  type BackupCredential,
  backupCredentialKeyId,
  type SealedBackupCredential,
  validateBackupCredential,
} from './backup-credential-envelope.js';

const fromB64 = (value: string) => Buffer.from(value, 'base64url');

export function openBackupCredential(privateKeyPem: string, envelope: SealedBackupCredential, binding = ''): BackupCredential {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'RSA-OAEP-256+A256GCM') {
    throw new TypeError('Unsupported backup credential envelope');
  }
  const key = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    fromB64(envelope.encryptedKey),
  );
  const publicPem = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  if (backupCredentialKeyId(publicPem) !== envelope.keyId) throw new Error('Backup credential key ID mismatch');
  const decipher = createDecipheriv('aes-256-gcm', key, fromB64(envelope.nonce));
  decipher.setAAD(Buffer.from(`codexia-backup-credential/v1:${envelope.keyId}:${binding}`, 'utf8'));
  decipher.setAuthTag(fromB64(envelope.tag));
  const plaintext = Buffer.concat([decipher.update(fromB64(envelope.ciphertext)), decipher.final()]);
  const credential = JSON.parse(plaintext.toString('utf8')) as BackupCredential;
  validateBackupCredential(credential);
  return credential;
}

/** Select an active or retiring executor key by fingerprint, without trial decryption. */
export function openBackupCredentialWithKeyring(
  privateKeysById: ReadonlyMap<string, string>,
  envelope: SealedBackupCredential,
  binding = '',
): BackupCredential {
  const privateKeyPem = privateKeysById.get(envelope.keyId);
  if (!privateKeyPem) throw new Error('Backup credential key ID is unavailable');
  return openBackupCredential(privateKeyPem, envelope, binding);
}
