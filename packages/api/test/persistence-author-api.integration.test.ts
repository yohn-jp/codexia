import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import type { ChangeSetId, DocumentId, ProjectId } from '@codexia/persistence-contracts';
import { createPostgresPersistence } from '@codexia/persistence-postgres';
import { TextWriter, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js';
import { startBetterAuthFixture } from './fixtures/better-auth-server.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface PublicApiAdapter {
  persistenceProjectPage(limit?: number): Promise<unknown>;
  createPersistenceProject(command: { title: string; settings: Record<string, unknown> }): Promise<{ project: { id: string } }>;
  createPersistenceDocument(
    projectId: string,
    command: {
      kind: 'scene';
      title: string;
      orderKey: string;
      markdown: string;
      idempotencyKey: string;
    },
  ): Promise<{ document: { id: string }; revision: { id: string; markdown: string }; replayed: boolean }>;
  savePersistenceDocument(
    projectId: string,
    documentId: string,
    command: {
      baseRevisionId: string;
      changes: Array<{ fromUtf16: number; toUtf16: number; insert: string }>;
      resultingSha256: string;
      clientId: string;
      idempotencyKey: string;
    },
  ): Promise<{ revision: { id: string; markdown: string }; replayed: boolean }>;
  persistenceDocument(projectId: string, documentId: string): Promise<{ revision: { id: string; markdown: string } | null }>;
  downloadOpenWorkExport(projectId: string): Promise<Blob>;
}

async function exercisePublicApiAdapter(base: string, token: string) {
  const publicApi = (await import(new URL('../../../app/src/api.ts', import.meta.url).href)) as unknown as {
    api: PublicApiAdapter;
    setOAuthAccessToken(token: string | null): void;
  };
  const { api, setOAuthAccessToken } = publicApi;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (typeof target === 'string' && target.startsWith('/api/')) {
      return originalFetch(new URL(target, base), init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    setOAuthAccessToken(null);
    await assert.rejects(
      api.persistenceProjectPage(20),
      (error: unknown) =>
        error instanceof Error && 'status' in error && error.status === 401 && 'code' in error && error.code === 'UNAUTHORIZED',
    );

    setOAuthAccessToken(token);
    const title = `orval-public-api-${randomUUID()}`;
    const { project } = await api.createPersistenceProject({ title, settings: { language: 'ja' } });
    const initialMarkdown = '前😀 東京\n';
    const idempotencyKey = `orval-api-save-${randomUUID()}`;
    const created = await api.createPersistenceDocument(project.id, {
      kind: 'scene',
      title: 'Orval adapter scene',
      orderKey: '0001',
      markdown: initialMarkdown,
      idempotencyKey: `orval-api-create-${randomUUID()}`,
    });
    assert.equal(created.revision.markdown, initialMarkdown);

    const prefix = '😀追記 ';
    const updatedMarkdown = prefix + initialMarkdown;
    const saveCommand = {
      baseRevisionId: created.revision.id,
      changes: [{ fromUtf16: 0, toUtf16: 0, insert: prefix }],
      resultingSha256: sha256(updatedMarkdown),
      clientId: 'orval-public-api-test',
      idempotencyKey,
    };
    const firstSave = await api.savePersistenceDocument(project.id, created.document.id, saveCommand);
    assert.equal(firstSave.revision.markdown, updatedMarkdown);
    assert.equal(firstSave.replayed, false);

    const replay = await api.savePersistenceDocument(project.id, created.document.id, saveCommand);
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision.id, firstSave.revision.id);

    await assert.rejects(
      api.savePersistenceDocument(project.id, created.document.id, {
        baseRevisionId: created.revision.id,
        changes: [{ fromUtf16: 0, toUtf16: 0, insert: 'stale' }],
        resultingSha256: sha256(`stale${initialMarkdown}`),
        clientId: 'orval-public-api-test',
        idempotencyKey: `orval-api-conflict-${randomUUID()}`,
      }),
      (error: unknown) =>
        error instanceof Error && 'status' in error && error.status === 409 && 'code' in error && error.code === 'PERSISTENCE_CONFLICT',
    );

    await assert.rejects(
      api.savePersistenceDocument(project.id, created.document.id, {
        ...saveCommand,
        changes: [{ fromUtf16: 0, toUtf16: 0, insert: 'another edit' }],
        resultingSha256: sha256(`another edit${initialMarkdown}`),
      }),
      (error: unknown) =>
        error instanceof Error && 'status' in error && error.status === 409 && 'code' in error && error.code === 'IDEMPOTENCY_CONFLICT',
    );

    const current = await api.persistenceDocument(project.id, created.document.id);
    assert.equal(current.revision?.id, firstSave.revision.id);
    assert.equal(current.revision?.markdown, updatedMarkdown);
    const archive = await api.downloadOpenWorkExport(project.id);
    assert.equal(archive.type, 'application/zip');
    const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await archive.arrayBuffer())));
    try {
      const files = await zip.getEntries();
      const manifest = files.find(file => file.filename === 'manifest.json');
      assert.ok(manifest && !manifest.directory);
      assert.equal(JSON.parse(await manifest.getData(new TextWriter(), { checkCrc32: true })).projectId, project.id);
      const original = files.find(file => file.filename.endsWith(created.revision.id + '.md'));
      assert.ok(original && !original.directory);
      assert.equal(await original.getData(new TextWriter(), { checkCrc32: true }), initialMarkdown);
    } finally {
      await zip.close();
    }
    await assert.rejects(api.downloadOpenWorkExport(randomUUID()), { status: 404 });
  } finally {
    setOAuthAccessToken(null);
    globalThis.fetch = originalFetch;
  }
}

async function startAuthorApi(t: TestContext) {
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'CODEXIA_AUTH_TEST_DATABASE_URL must name an explicitly disposable PostgreSQL auth database');
  const fixture = await startBetterAuthFixture({ databaseUrl, usePostgresPersistence: true });
  t.after(() => fixture.close());
  const persistence = createPostgresPersistence(databaseUrl);
  t.after(() => persistence.close());
  const base = fixture.apiOrigin;
  const ownerHeaders = { Authorization: `Bearer ${await fixture.issueOwnerAccessToken()}`, 'Content-Type': 'application/json' };
  const session = await fetch(`${base}/api/session`, { headers: ownerHeaders });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true, authorScope: 'owner' });
  return { base, ownerHeaders, persistence, fixture };
}

test('authenticated PostgreSQL API saves, replays, follows Evidence, conflicts and restores', async t => {
  const { base, ownerHeaders, persistence, fixture } = await startAuthorApi(t);
  await exercisePublicApiAdapter(base, await fixture.issueOwnerAccessToken());
  const unauthorized = await fetch(`${base}/api/v1/persistence/projects`);
  assert.equal(unauthorized.status, 401);
  const unauthorizedExport = await fetch(`${base}/api/v1/persistence/projects/${randomUUID()}/open-export`);
  assert.equal(unauthorizedExport.status, 401);
  const forbiddenTitle = `forbidden-${randomUUID()}`;
  const bearerWrite = await fetch(`${base}/api/v1/persistence/projects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await fixture.issueForeignClientAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: forbiddenTitle }),
  });
  assert.equal(bearerWrite.status, 403);
  assert.equal(((await bearerWrite.json()) as { code: string }).code, 'OAUTH_CLIENT_NOT_ALLOWED');
  assert.ok(!(await persistence.read(reader => reader.listProjectPage!(200))).some(project => project.title === forbiddenTitle));

  const projectResponse = await fetch(`${base}/api/v1/persistence/projects`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ title: `api-${randomUUID()}`, settings: { language: 'ja' } }),
  });
  assert.equal(projectResponse.status, 201);
  const { project } = (await projectResponse.json()) as { project: { id: string } };
  const initialMarkdown = '前😀 東京\n';
  const documentResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents`, {
    method: 'POST',
    headers: { ...ownerHeaders, 'Idempotency-Key': `create-${randomUUID()}` },
    body: JSON.stringify({ kind: 'scene', title: 'Scene', orderKey: '0001', markdown: initialMarkdown }),
  });
  assert.equal(documentResponse.status, 201);
  const created = (await documentResponse.json()) as {
    document: { id: string; headRevisionId: string };
    revision: { id: string; markdown: string };
  };
  const documentId = created.document.id;
  const initialRevision = created.revision.id;
  assert.equal(created.revision.markdown, initialMarkdown);
  const pinnedRevision = await fetch(
    `${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}?revision=${initialRevision}`,
    { headers: ownerHeaders },
  );
  assert.equal(pinnedRevision.status, 200);
  assert.equal(((await pinnedRevision.json()) as { revision: { id: string; markdown: string } }).revision.markdown, initialMarkdown);

  const prefix = '😀追記 ';
  const afterPrefix = prefix + initialMarkdown;
  const firstSaveCommand = {
    baseRevisionId: initialRevision,
    changes: [{ fromUtf16: 0, toUtf16: 0, insert: prefix }],
    resultingSha256: sha256(afterPrefix),
    clientId: 'browser-test',
  };
  const idempotencyKey = `edit-${randomUUID()}`;
  const firstSave = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: 'PATCH',
    headers: { ...ownerHeaders, 'Idempotency-Key': idempotencyKey, 'X-Client-Id': 'browser-test' },
    body: JSON.stringify(firstSaveCommand),
  });
  assert.equal(firstSave.status, 200);
  const saved = (await firstSave.json()) as {
    document: { headRevisionId: string };
    revision: { id: string; markdown: string };
    replayed: boolean;
  };
  assert.equal(saved.revision.markdown, afterPrefix);
  assert.equal(saved.replayed, false);
  const replay = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: 'PATCH',
    headers: { ...ownerHeaders, 'Idempotency-Key': idempotencyKey, 'X-Client-Id': 'browser-test' },
    body: JSON.stringify(firstSaveCommand),
  });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);

  const nodeId = randomUUID();
  const nodeResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/nodes/${nodeId}`, {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({ type: 'place', name: '東京', attributes: {}, status: 'confirmed', expectedVersion: null }),
  });
  assert.equal(nodeResponse.status, 200);
  const anchorId = randomUUID();
  const quoteStart = afterPrefix.indexOf('東京');
  const anchorResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      id: anchorId,
      revisionId: saved.revision.id,
      fromUtf16: quoteStart,
      toUtf16: quoteStart + 2,
      status: 'confirmed',
      nodeId,
    }),
  });
  assert.equal(anchorResponse.status, 201);
  const anchorsBefore = await fetch(
    `${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors?revision=${saved.revision.id}`,
    { headers: ownerHeaders },
  );
  assert.equal(anchorsBefore.status, 200);
  const anchorListBefore = (await anchorsBefore.json()) as {
    anchors: Array<{
      anchor: { status: string };
      quote: string;
      mentions: Array<{ link: { status: string }; node: { status: string } | null }>;
    }>;
  };
  assert.equal(anchorListBefore.anchors[0]?.quote, '東京');
  assert.equal(anchorListBefore.anchors[0]?.anchor.status, 'confirmed');
  assert.equal(anchorListBefore.anchors[0]?.mentions[0]?.link.status, 'confirmed');
  assert.equal(anchorListBefore.anchors[0]?.mentions[0]?.node?.status, 'confirmed');

  const rawMentionResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ id: randomUUID(), revisionId: saved.revision.id, fromUtf16: 0, toUtf16: 2, status: 'proposed' }),
  });
  assert.equal(rawMentionResponse.status, 201);
  const rawMention = (await rawMentionResponse.json()) as { nodeId: string | null };
  assert.equal(rawMention.nodeId, null);
  const anchorsWithUnlinked = await fetch(
    `${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors?revision=${saved.revision.id}`,
    { headers: ownerHeaders },
  );
  const unlinkedView = ((await anchorsWithUnlinked.json()) as { anchors: Array<{ quote: string; mentions: unknown[] }> }).anchors.find(
    entry => entry.quote === '😀',
  );
  assert.ok(unlinkedView);
  assert.deepEqual(unlinkedView.mentions, []);

  const assertionId = randomUUID();
  const assertionResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/assertions/${assertionId}`, {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({
      proposition: { statement: '東京にある' },
      modality: 'fact',
      perspective: 'narrator',
      narrativeTime: {},
      confidence: null,
      status: 'proposed',
      expectedVersion: null,
    }),
  });
  assert.equal(assertionResponse.status, 200);
  const assertionEvidenceResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/assertions/${assertionId}/evidence`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ evidenceId: anchorId, role: 'supports' }),
  });
  assert.equal(assertionEvidenceResponse.status, 201);
  const anchorsWithAssertion = await fetch(
    `${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors?revision=${saved.revision.id}`,
    { headers: ownerHeaders },
  );
  const assertionAnchor = (
    (await anchorsWithAssertion.json()) as {
      anchors: Array<{ anchor: { id: string }; assertions: Array<{ assertion: { status: string } | null; link: { role: string } }> }>;
    }
  ).anchors.find(entry => entry.anchor.id === anchorId)!;
  assert.equal(assertionAnchor.assertions[0]?.assertion?.status, 'proposed');
  assert.equal(assertionAnchor.assertions[0]?.link.role, 'supports');

  const afterShift = `💠${afterPrefix}`;
  const shiftResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: 'PATCH',
    headers: { ...ownerHeaders, 'Idempotency-Key': `shift-${randomUUID()}`, 'X-Client-Id': 'browser-test' },
    body: JSON.stringify({
      baseRevisionId: saved.revision.id,
      changes: [{ fromUtf16: 0, toUtf16: 0, insert: '💠' }],
      resultingSha256: sha256(afterShift),
      clientId: 'browser-test',
    }),
  });
  assert.equal(shiftResponse.status, 200);
  const shifted = (await shiftResponse.json()) as { revision: { id: string; markdown: string } };
  const shiftedEvidence = await fetch(
    `${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors?revision=${shifted.revision.id}`,
    { headers: ownerHeaders },
  );
  const shiftedAnchors = (
    (await shiftedEvidence.json()) as { anchors: Array<{ anchor: { id: string; fromUtf16: number; status: string } }> }
  ).anchors;
  const shiftedAnchor = shiftedAnchors.find(item => item.anchor.id === anchorId)!.anchor;
  assert.equal(shiftedAnchor.fromUtf16, quoteStart + '💠'.length);
  assert.equal(shiftedAnchor.status, 'confirmed');

  const editStart = shiftedAnchor.fromUtf16;
  const afterTouch = `${afterShift.slice(0, editStart)}大阪${afterShift.slice(editStart + 2)}`;
  const touchResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: 'PATCH',
    headers: { ...ownerHeaders, 'Idempotency-Key': `touch-${randomUUID()}`, 'X-Client-Id': 'browser-test' },
    body: JSON.stringify({
      baseRevisionId: shifted.revision.id,
      changes: [{ fromUtf16: editStart, toUtf16: editStart + 2, insert: '大阪' }],
      resultingSha256: sha256(afterTouch),
      clientId: 'browser-test',
    }),
  });
  assert.equal(touchResponse.status, 200);
  const touched = (await touchResponse.json()) as { revision: { id: string; markdown: string } };
  const evidenceResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/nodes/${nodeId}/evidence`, {
    headers: ownerHeaders,
  });
  const evidence = (await evidenceResponse.json()) as {
    evidence: Array<{
      anchor: { status: string };
      quote: string;
      mentions: Array<{ link: { status: string }; node: { status: string } | null }>;
    }>;
  };
  assert.equal(evidence.evidence[0]?.quote, '大阪');
  assert.equal(evidence.evidence[0]?.anchor.status, 'needs_review');
  assert.equal(evidence.evidence[0]?.mentions[0]?.link.status, 'proposed');
  assert.equal(evidence.evidence[0]?.mentions[0]?.node?.status, 'confirmed');

  const conflict = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: 'PATCH',
    headers: { ...ownerHeaders, 'Idempotency-Key': `stale-${randomUUID()}`, 'X-Client-Id': 'browser-test' },
    body: JSON.stringify({
      baseRevisionId: saved.revision.id,
      changes: [{ fromUtf16: 0, toUtf16: 0, insert: 'stale' }],
      resultingSha256: sha256(`stale${afterPrefix}`),
      clientId: 'browser-test',
    }),
  });
  assert.equal(conflict.status, 409);
  const conflictBody = (await conflict.json()) as { current: { document: { headRevisionId: string }; revision: { markdown: string } } };
  assert.equal(conflictBody.current.document.headRevisionId, touched.revision.id);
  assert.equal(conflictBody.current.revision.markdown, afterTouch);

  const restore = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/restore`, {
    method: 'POST',
    headers: { ...ownerHeaders, 'Idempotency-Key': `restore-${randomUUID()}` },
    body: JSON.stringify({ baseRevisionId: touched.revision.id, sourceRevisionId: initialRevision }),
  });
  assert.equal(restore.status, 200);
  const restored = (await restore.json()) as { document: { headRevisionId: string }; revision: { id: string; markdown: string } };
  assert.equal(restored.revision.markdown, initialMarkdown);
  assert.equal(restored.document.headRevisionId, restored.revision.id);
});

test('authenticated PostgreSQL API rejects stale manuscript restore approval without side effects', async t => {
  const { base, ownerHeaders, persistence } = await startAuthorApi(t);
  const projectResponse = await fetch(`${base}/api/v1/persistence/projects`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ title: `restore-approval-${randomUUID()}`, settings: { language: 'ja' } }),
  });
  assert.equal(projectResponse.status, 201);
  const { project } = (await projectResponse.json()) as { project: { id: string } };

  const originalMarkdown = 'Original manuscript';
  const initialResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents`, {
    method: 'POST',
    headers: { ...ownerHeaders, 'Idempotency-Key': `restore-create-${randomUUID()}` },
    body: JSON.stringify({ kind: 'scene', title: 'Restore target', orderKey: '0001', markdown: originalMarkdown }),
  });
  assert.equal(initialResponse.status, 201);
  const initial = (await initialResponse.json()) as { document: { id: string }; revision: { id: string; markdown: string } };
  const documentId = initial.document.id;
  const save = async (baseRevisionId: string, previousMarkdown: string, markdown: string) => {
    const response = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
      method: 'PATCH',
      headers: {
        ...ownerHeaders,
        'Idempotency-Key': `restore-save-${randomUUID()}`,
        'X-Client-Id': 'restore-approval-integration',
      },
      body: JSON.stringify({
        baseRevisionId,
        changes: [{ fromUtf16: 0, toUtf16: previousMarkdown.length, insert: markdown }],
        resultingSha256: sha256(markdown),
        clientId: 'restore-approval-integration',
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { revision: { id: string; markdown: string } };
  };
  const proposedBase = await save(initial.revision.id, originalMarkdown, 'Manuscript before proposal');
  const proposeRestore = async (baseRevisionId: string, sourceRevisionId: string) => {
    const response = await fetch(`${base}/api/projects/${project.id}/actions/core.operation.restore`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        input: { documentId, baseRevisionId, sourceRevisionId, idempotencyKey: `restore-proposal-${randomUUID()}` },
      }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      ok: boolean;
      data?: {
        changeSet: {
          id: string;
          version: number;
          status: string;
          readSet: unknown[];
          operations: Array<{ type: string; command: { baseRevisionId: string } }>;
        };
        replayed: boolean;
      };
      error?: unknown;
    };
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.data);
    return result.data.changeSet;
  };
  const transition = (changeSetId: string, action: 'approve' | 'reject' | 'apply', expectedVersion: number) =>
    fetch(`${base}/api/v1/persistence/projects/${project.id}/changesets/${changeSetId}/${action}`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ expectedVersion }),
    });
  const readHead = () =>
    persistence.read(async reader => {
      const document = await reader.getDocument(project.id as ProjectId, documentId as DocumentId);
      if (!document?.headRevisionId) return null;
      const revision = await reader.getRevision(project.id as ProjectId, documentId as DocumentId, document.headRevisionId);
      return revision ? { headRevisionId: document.headRevisionId, markdown: revision.markdown } : null;
    });
  const readChangeSet = (id: string) => persistence.read(reader => reader.getChangeSet(project.id as ProjectId, id as ChangeSetId));
  const readReceipt = (id: string) => persistence.read(reader => reader.getChangeSetReceipt(project.id as ProjectId, id as ChangeSetId));

  const staleProposal = await proposeRestore(proposedBase.revision.id, initial.revision.id);
  assert.equal(staleProposal.status, 'proposed');
  assert.deepEqual(staleProposal.readSet, []);
  assert.equal(staleProposal.operations[0]?.command.baseRevisionId, proposedBase.revision.id);
  const changedBeforeApproval = await save(proposedBase.revision.id, proposedBase.revision.markdown, 'Edited after proposal');
  const staleApproval = await transition(staleProposal.id, 'approve', staleProposal.version);
  assert.equal(staleApproval.status, 409);
  assert.equal(((await staleApproval.json()) as { code: string }).code, 'PERSISTENCE_CONFLICT');
  assert.equal((await readChangeSet(staleProposal.id))?.status, 'proposed');
  assert.equal(await readReceipt(staleProposal.id), undefined);
  assert.deepEqual(await readHead(), {
    headRevisionId: changedBeforeApproval.revision.id,
    markdown: changedBeforeApproval.revision.markdown,
  });

  const rejection = await transition(staleProposal.id, 'reject', staleProposal.version);
  assert.equal(rejection.status, 200);
  assert.equal((await readChangeSet(staleProposal.id))?.status, 'rejected');
  assert.equal(await readReceipt(staleProposal.id), undefined);
  assert.deepEqual(await readHead(), {
    headRevisionId: changedBeforeApproval.revision.id,
    markdown: changedBeforeApproval.revision.markdown,
  });

  const validProposal = await proposeRestore(changedBeforeApproval.revision.id, initial.revision.id);
  const approval = await transition(validProposal.id, 'approve', validProposal.version);
  assert.equal(approval.status, 200);
  assert.equal(await readReceipt(validProposal.id), undefined);
  const application = await transition(validProposal.id, 'apply', validProposal.version + 1);
  assert.equal(application.status, 200);
  const applied = (await application.json()) as { changeSet: { status: string }; results: Array<{ revision?: { markdown: string } }> };
  assert.equal(applied.changeSet.status, 'applied');
  assert.equal(applied.results[0]?.revision?.markdown, originalMarkdown);
  assert.equal((await readChangeSet(validProposal.id))?.status, 'applied');
  assert.ok(await readReceipt(validProposal.id));
  const restored = await readHead();
  assert.ok(restored);
  assert.equal(restored.markdown, originalMarkdown);

  const applyAfterEditProposal = await proposeRestore(restored.headRevisionId, changedBeforeApproval.revision.id);
  const applyAfterEditApproval = await transition(applyAfterEditProposal.id, 'approve', applyAfterEditProposal.version);
  assert.equal(applyAfterEditApproval.status, 200);
  const editedAfterApproval = await save(restored.headRevisionId, originalMarkdown, 'Edited after approval');
  const rejectedApplication = await transition(applyAfterEditProposal.id, 'apply', applyAfterEditProposal.version + 1);
  assert.equal(rejectedApplication.status, 409);
  assert.equal((await readChangeSet(applyAfterEditProposal.id))?.status, 'approved');
  assert.equal(await readReceipt(applyAfterEditProposal.id), undefined);
  assert.deepEqual(await readHead(), { headRevisionId: editedAfterApproval.revision.id, markdown: editedAfterApproval.revision.markdown });
});

test('document mutations distinguish missing and soft-deleted targets from stale versions', async t => {
  const { base, ownerHeaders } = await startAuthorApi(t);
  const projectResponse = await fetch(`${base}/api/v1/persistence/projects`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ title: `Mutation status ${randomUUID()}` }),
  });
  assert.equal(projectResponse.status, 201);
  const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id;
  const documentsPath = `${base}/api/v1/persistence/projects/${projectId}/documents`;
  const missingId = randomUUID();
  const missingMetadata = await fetch(`${documentsPath}/${missingId}/metadata`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: 1, title: 'Missing' }),
  });
  assert.equal(missingMetadata.status, 404);
  assert.equal(((await missingMetadata.json()) as { code: string }).code, 'PERSISTENCE_NOT_FOUND');
  const missingDelete = await fetch(`${documentsPath}/${missingId}`, {
    method: 'DELETE',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(missingDelete.status, 404);
  assert.equal(((await missingDelete.json()) as { code: string }).code, 'PERSISTENCE_NOT_FOUND');

  const otherProjectResponse = await fetch(`${base}/api/v1/persistence/projects`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ title: `Other scope ${randomUUID()}` }),
  });
  assert.equal(otherProjectResponse.status, 201);
  const otherProjectId = ((await otherProjectResponse.json()) as { project: { id: string } }).project.id;
  const foreignResponse = await fetch(`${base}/api/v1/persistence/projects/${otherProjectId}/documents`, {
    method: 'POST',
    headers: { ...ownerHeaders, 'Idempotency-Key': `create-${randomUUID()}` },
    body: JSON.stringify({ kind: 'scene', title: 'Foreign', orderKey: '0001', markdown: '' }),
  });
  assert.equal(foreignResponse.status, 201);
  const foreign = ((await foreignResponse.json()) as { document: { id: string; version: number } }).document;
  const foreignThroughWrongProject = await fetch(`${documentsPath}/${foreign.id}`, {
    method: 'DELETE',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: foreign.version }),
  });
  assert.equal(foreignThroughWrongProject.status, 404);
  assert.equal(((await foreignThroughWrongProject.json()) as { code: string }).code, 'PERSISTENCE_NOT_FOUND');

  const createDocument = async (title: string) => {
    const response = await fetch(documentsPath, {
      method: 'POST',
      headers: { ...ownerHeaders, 'Idempotency-Key': `create-${randomUUID()}` },
      body: JSON.stringify({ kind: 'scene', title, orderKey: '0001', markdown: '' }),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { document: { id: string; version: number } }).document;
  };
  const removed = await createDocument('Removed');
  const deleted = await fetch(`${documentsPath}/${removed.id}`, {
    method: 'DELETE',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: removed.version }),
  });
  assert.equal(deleted.status, 200);
  const deletedMetadata = await fetch(`${documentsPath}/${removed.id}/metadata`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: removed.version, title: 'Still removed' }),
  });
  assert.equal(deletedMetadata.status, 404);
  assert.equal(((await deletedMetadata.json()) as { code: string }).code, 'PERSISTENCE_NOT_FOUND');
  const deletedAgain = await fetch(`${documentsPath}/${removed.id}`, {
    method: 'DELETE',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: removed.version }),
  });
  assert.equal(deletedAgain.status, 404);
  assert.equal(((await deletedAgain.json()) as { code: string }).code, 'PERSISTENCE_NOT_FOUND');

  const stale = await createDocument('Stale');
  const updated = await fetch(`${documentsPath}/${stale.id}/metadata`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: stale.version, title: 'Updated' }),
  });
  assert.equal(updated.status, 200);
  const staleMetadata = await fetch(`${documentsPath}/${stale.id}/metadata`, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: stale.version, title: 'Stale update' }),
  });
  assert.equal(staleMetadata.status, 409);
  const staleDelete = await fetch(`${documentsPath}/${stale.id}`, {
    method: 'DELETE',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: stale.version }),
  });
  assert.equal(staleDelete.status, 409);
});

test('concurrent document POSTs stay within 999 active documents and deletion frees a slot', async t => {
  const { base, ownerHeaders, persistence } = await startAuthorApi(t);
  const projectResponse = await fetch(`${base}/api/v1/persistence/projects`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ title: `Document cap ${randomUUID()}` }),
  });
  assert.equal(projectResponse.status, 201);
  const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id;

  let firstSeed: { id: string; version: number } | undefined;
  await persistence.transaction(async transaction => {
    for (let index = 0; index < 998; index++) {
      const created = await transaction.createDocument({
        projectId: projectId as ProjectId,
        kind: 'volume',
        title: `Seed ${index + 1}`,
        orderKey: String(index + 1).padStart(4, '0'),
        markdown: '',
        authorId: 'test-owner',
        idempotencyKey: `seed-${index}-${randomUUID()}`,
      });
      if (index === 0) firstSeed = { id: created.document.id, version: created.document.version };
    }
  });
  assert.ok(firstSeed);

  const documentPath = `${base}/api/v1/persistence/projects/${projectId}/documents`;
  const createRequest = (title: string, key: string) =>
    fetch(documentPath, {
      method: 'POST',
      headers: { ...ownerHeaders, 'Idempotency-Key': key },
      body: JSON.stringify({ kind: 'volume', title, orderKey: '0999', markdown: '' }),
    });
  const attempts = await Promise.all([createRequest('Concurrent A', 'document-cap-a'), createRequest('Concurrent B', 'document-cap-b')]);
  assert.deepEqual(attempts.map(response => response.status).sort(), [201, 409]);
  const successfulIndex = attempts.findIndex(response => response.status === 201);
  const failedIndex = 1 - successfulIndex;
  const created = (await attempts[successfulIndex]!.json()) as { document: { id: string }; replayed: boolean };
  const rejected = (await attempts[failedIndex]!.json()) as { code: string; error: string };
  assert.equal(created.replayed, false);
  assert.equal(rejected.code, 'PERSISTENCE_CONFLICT');
  assert.match(rejected.error, /at most 999 active documents/u);

  const replay = await createRequest(
    successfulIndex === 0 ? 'Concurrent A' : 'Concurrent B',
    successfulIndex === 0 ? 'document-cap-a' : 'document-cap-b',
  );
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), { ...created, replayed: true });

  const treeResponse = await fetch(`${base}/api/projects/${projectId}/tree`, { headers: ownerHeaders });
  assert.equal(treeResponse.status, 200);
  assert.equal(((await treeResponse.json()) as { tree: { volumes: unknown[] } }).tree.volumes.length, 999);
  const archiveResponse = await fetch(`${base}/api/v1/persistence/projects/${projectId}/archive`, { headers: ownerHeaders });
  assert.equal(archiveResponse.status, 200);
  assert.equal(((await archiveResponse.json()) as { documents: unknown[] }).documents.length, 999);

  const deletion = await fetch(`${documentPath}/${firstSeed.id}`, {
    method: 'DELETE',
    headers: ownerHeaders,
    body: JSON.stringify({ expectedVersion: firstSeed.version }),
  });
  assert.equal(deletion.status, 200);
  const afterDelete = await createRequest('After deletion', 'document-cap-after-delete');
  assert.equal(afterDelete.status, 201);
  const finalArchive = await fetch(`${base}/api/v1/persistence/projects/${projectId}/archive`, { headers: ownerHeaders });
  assert.equal(finalArchive.status, 200);
  assert.equal(((await finalArchive.json()) as { documents: unknown[] }).documents.length, 999);
});

test("Web append creates at the canonical end of each parent's ordered siblings", async t => {
  const { base, ownerHeaders: headers, persistence } = await startAuthorApi(t);
  const projectResponse = await fetch(`${base}/api/v1/persistence/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: `Append ${randomUUID()}` }),
  });
  assert.equal(projectResponse.status, 201);
  const projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id as ProjectId;
  const parents: Record<string, string> = {};
  await persistence.transaction(async transaction => {
    const volume = (
      await transaction.createDocument({
        projectId,
        kind: 'volume',
        title: 'Volume',
        orderKey: '0001',
        markdown: '',
        authorId: 'test-owner',
        idempotencyKey: randomUUID(),
      })
    ).document;
    for (const id of ['empty', 'mixed', 'wide', 'concurrent'] as const) {
      const chapter = (
        await transaction.createDocument({
          projectId,
          parentId: volume.id,
          kind: 'chapter',
          title: id,
          orderKey: String(Object.keys(parents).length + 1).padStart(4, '0'),
          markdown: '',
          authorId: 'test-owner',
          idempotencyKey: randomUUID(),
        })
      ).document;
      parents[id] = chapter.id;
    }
    for (const [parent, kind, orderKey, title] of [
      ['mixed', 'scene', '0000000009', 'Nine A'],
      ['mixed', 'scene', '0000000002', 'Two'],
      ['mixed', 'scene', '0000000009', 'Nine B'],
      ['mixed', 'note', '0000000015', 'Other kind last'],
      ['wide', 'scene', '00001000', 'Wide order'],
      ['concurrent', 'scene', '0000000008', 'Before concurrency'],
    ] as const) {
      await transaction.createDocument({
        projectId,
        parentId: parents[parent] as DocumentId,
        kind,
        orderKey,
        title,
        markdown: '',
        authorId: 'test-owner',
        idempotencyKey: randomUUID(),
      });
    }
  });

  const documentsPath = `${base}/api/v1/persistence/projects/${projectId}/documents`;
  const append = (parent: keyof typeof parents, title: string, key: string) =>
    fetch(documentsPath, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body: JSON.stringify({ kind: 'scene', title, parentId: parents[parent], markdown: '', orderKey: '0000', appendToEnd: true }),
    });
  const empty = await append('empty', 'First scene', 'append-empty');
  assert.equal(empty.status, 201);
  const emptyResult = (await empty.json()) as { document: { id: string; orderKey: string }; replayed: boolean };
  assert.equal(emptyResult.document.orderKey, '0000000001');
  assert.equal(emptyResult.replayed, false);
  const emptyReplay = await append('empty', 'First scene', 'append-empty');
  assert.equal(emptyReplay.status, 201);
  assert.deepEqual(await emptyReplay.json(), { ...emptyResult, replayed: true });

  const mixed = await append('mixed', 'After mixed siblings', 'append-mixed');
  assert.equal(mixed.status, 201);
  const mixedResult = (await mixed.json()) as { document: { id: string; orderKey: string } };
  assert.equal(mixedResult.document.orderKey, '0000000016', 'append considers all same-parent kinds and the actual maximum key');
  const mixedRead = await fetch(`${documentsPath}?parentId=${encodeURIComponent(parents.mixed)}`, {
    headers: { Authorization: headers.Authorization },
  });
  assert.equal(mixedRead.status, 200);
  const mixedDocuments = ((await mixedRead.json()) as { documents: Array<{ id: string; orderKey: string }> }).documents;
  assert.equal(
    mixedDocuments.at(-1)?.id,
    mixedResult.document.id,
    'the authoritative PostgreSQL ordered read places the new document last',
  );

  const wide = await append('wide', 'After wide key', 'append-wide');
  assert.equal(wide.status, 201);
  assert.equal(((await wide.json()) as { document: { orderKey: string } }).document.orderKey, '00001001');

  const concurrent = await Promise.all([
    append('concurrent', 'Concurrent A', 'append-concurrent-a'),
    append('concurrent', 'Concurrent B', 'append-concurrent-b'),
  ]);
  assert.deepEqual(
    concurrent.map(response => response.status),
    [201, 201],
  );
  const concurrentResults = await Promise.all(
    concurrent.map(response => response.json() as Promise<{ document: { id: string; orderKey: string }; replayed: boolean }>),
  );
  assert.deepEqual(concurrentResults.map(result => result.document.orderKey).sort(), ['0000000009', '0000000010']);
  assert.ok(concurrentResults.every(result => !result.replayed));
  const concurrentRead = await fetch(`${documentsPath}?parentId=${encodeURIComponent(parents.concurrent)}`, {
    headers: { Authorization: headers.Authorization },
  });
  const concurrentDocuments = ((await concurrentRead.json()) as { documents: Array<{ id: string; orderKey: string }> }).documents;
  assert.deepEqual(
    concurrentDocuments
      .slice(-2)
      .map(document => document.id)
      .sort(),
    concurrentResults.map(result => result.document.id).sort(),
  );

  const explicitKey = 'explicit-order-compatible';
  const explicitBody = { kind: 'scene', title: 'Explicit key', parentId: parents.empty, orderKey: '0000000017', markdown: '' };
  const explicit = await fetch(documentsPath, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': explicitKey },
    body: JSON.stringify(explicitBody),
  });
  assert.equal(explicit.status, 201);
  const explicitResult = (await explicit.json()) as { document: { id: string; orderKey: string }; replayed: boolean };
  assert.equal(explicitResult.document.orderKey, '0000000017');
  assert.equal(explicitResult.replayed, false);
  const explicitReplay = await fetch(documentsPath, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': explicitKey },
    body: JSON.stringify(explicitBody),
  });
  assert.deepEqual(
    await explicitReplay.json(),
    { ...explicitResult, replayed: true },
    'legacy explicit-key retries retain their original idempotency digest',
  );
});
