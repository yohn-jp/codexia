/** Write-only S3 credentials sealed to a protected executor RSA key. */
import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';

export interface BackupCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SealedBackupCredential {
  version: 1;
  algorithm: 'RSA-OAEP-256+A256GCM';
  keyId: string;
  encryptedKey: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

const b64 = (value: Buffer) => value.toString('base64url');

export function backupCredentialKeyId(publicKeyPem: string): string {
  if (typeof publicKeyPem !== 'string' || /-----BEGIN [^-]*PRIVATE KEY-----/u.test(publicKeyPem)) {
    throw new TypeError('Executor public key PEM is required');
  }
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'rsa' || Number(key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new TypeError('Executor key must be RSA with at least 2048 bits');
  }
  const der = key.export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

export function backupCredentialBinding(destination: {
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  addressing: string;
}): string {
  const { provider, endpoint, region, bucket, prefix, addressing } = destination;
  return JSON.stringify([provider, endpoint, region, bucket, prefix, addressing]);
}

export function sealBackupCredential(publicKeyPem: string, credential: BackupCredential, binding = ''): SealedBackupCredential {
  validateBackupCredential(credential);
  const keyId = backupCredentialKeyId(publicKeyPem);
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`codexia-backup-credential/v1:${keyId}:${binding}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'RSA-OAEP-256+A256GCM',
    keyId,
    encryptedKey: b64(publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)),
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
    tag: b64(cipher.getAuthTag()),
  };
}

export function validateBackupCredential(value: BackupCredential): void {
  if (
    !value ||
    typeof value.accessKeyId !== 'string' ||
    !value.accessKeyId ||
    typeof value.secretAccessKey !== 'string' ||
    !value.secretAccessKey ||
    (value.sessionToken !== undefined && typeof value.sessionToken !== 'string')
  ) {
    throw new TypeError('Invalid S3 credential input');
  }
  if (Object.keys(value).some(key => !['accessKeyId', 'secretAccessKey', 'sessionToken'].includes(key))) {
    throw new TypeError('Unsupported S3 credential field');
  }
}
