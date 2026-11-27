import assert from 'node:assert/strict';
import test from 'node:test';
import { BackupPasskeyError, requireFreshBackupOwner } from './backup-actions';

test('an expired but readable owner session allows Passkey and requires a newly confirmed owner', async () => {
  const calls: string[] = [];
  let current: string | null = null;
  await requireFreshBackupOwner({
    async readToken() {
      calls.push('read');
      return current;
    },
    async signIn() {
      calls.push('passkey');
      current = 'new-session';
    },
    async confirm() {
      calls.push('owner');
      return 'owner';
    },
  });
  assert.deepEqual(calls, ['read', 'passkey', 'read', 'owner']);
});

test('an unreadable session or unchanged token blocks the write', async () => {
  await assert.rejects(
    requireFreshBackupOwner({
      async readToken() {
        throw new TypeError('Offline');
      },
      async signIn() {
        assert.fail('Cannot prompt on an unreadable session');
      },
      async confirm() {
        return 'owner';
      },
    }),
    BackupPasskeyError,
  );
  await assert.rejects(
    requireFreshBackupOwner({
      readToken: async () => 'old-session',
      signIn: async () => undefined,
      confirm: async () => 'owner',
    }),
    BackupPasskeyError,
  );
});
