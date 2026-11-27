import assert from 'node:assert/strict';
import test from 'node:test';
import { setOAuthAccessToken } from '../api-transport';
import { createBackupConsoleClient } from './backup-client';

const runId = '0a000000-0000-4000-8000-000000000000';
const requestId = '0b000000-0000-4000-8000-000000000000';

test('owner Console reconciles the exact request with same-origin cookie and no bearer', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createBackupConsoleClient(async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      activeRevision: 7,
      enabled: true,
      status: 'ACTIVE',
      degraded: false,
      appliedAt: '2026-11-27T01:00:00.000Z',
      staging: 'unknown',
      lastVerifiedOffVmBackup: 'unknown',
      restoreDrill: 'unknown',
      operation: {
        operationId: runId,
        requestId,
        revision: 7,
        status: 'APPLIED',
        phase: 'activate',
        observedAt: '2026-11-27T01:00:00.000Z',
        reasonCode: null,
      },
    });
  });
  setOAuthAccessToken('manuscript-token');
  try {
    assert.equal((await client.status(requestId)).operation?.operationId, runId);
    assert.equal(requests[0]?.url, '/api/console/backups/status?requestId=' + requestId);
    assert.equal(requests[0]?.init?.credentials, 'same-origin');
    assert.equal(requests[0]?.init?.redirect, 'error');
    assert.equal(new Headers(requests[0]?.init?.headers).has('authorization'), false);
  } finally {
    setOAuthAccessToken(null);
  }
});

test('manual acceptance sends the existing request ID and CSRF header, and is only a receipt', async () => {
  const client = createBackupConsoleClient(async (input, init) => {
    assert.equal(input, '/api/console/backups/runs');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('idempotency-key'), requestId);
    assert.equal(new Headers(init?.headers).get('x-codexia-csrf'), '1');
    assert.deepEqual(JSON.parse(String(init?.body)), { maintenanceWindowId: 'morning', confirmed: true });
    return Response.json({ runId, state: 'queued', createdAt: '2026-11-27T01:00:00Z' }, { status: 202 });
  });
  assert.deepEqual(await client.runRequest('morning', requestId), {
    runId,
    state: 'queued',
    createdAt: '2026-11-27T01:00:00Z',
  });
});

test('a run without the independent receipt is not displayed as remotely verified', async () => {
  const client = createBackupConsoleClient(async () =>
    Response.json({
      runId,
      requestId,
      revision: 7,
      maintenanceWindowId: 'morning',
      status: 'REMOTE_VERIFIED',
      phase: 'complete',
      reasonCode: null,
      sourceSha: 'a'.repeat(40),
      imageDigest: 'sha256:' + 'b'.repeat(64),
      candidateSourceSha: null,
      candidateImageDigest: null,
      manifestSha256: 'c'.repeat(64),
      offVmConfirmation: { offVmMethod: 's3', markerSha256: 'd'.repeat(64) },
      observedAt: '2026-11-27T01:00:00Z',
      createdAt: '2026-11-27T01:00:00Z',
    }),
  );
  await assert.rejects(client.run(runId), { status: 502, code: 'INVALID_RESPONSE' });
});
