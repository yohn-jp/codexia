import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { ChangeOperation, ChangeProposal } from '@codexia/contracts';
import { CoreError, CoreStore } from '@codexia/core';
import type {
  ChangeSet,
  DocumentId,
  EvidenceId,
  KnowledgeNodeId,
  Persistence,
  PersistenceTransaction,
  ProjectId,
} from '@codexia/persistence-contracts';
import { createPostgresPersistence, migratePostgresDatabase } from '@codexia/persistence-postgres';
import { handlePersistenceOperation } from './persistence-routes.js';
import { exportWorkArchive, importWorkArchive } from './work-archive.js';

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error('CODEXIA_TEST_DATABASE_URL is required for portable work integration tests');
const persistence = createPostgresPersistence(connectionString);
const core = new CoreStore({ persistence });
before(async () => {
  await migratePostgresDatabase(connectionString);
});
after(() => persistence.close());

test('a portable work round trip reconstitutes manuscript, hierarchy, knowledge, evidence and author state', async () => {
  const projectId = randomUUID() as import('@codexia/persistence-contracts').ProjectId;
  const documentId = randomUUID() as DocumentId;
  const parentId = randomUUID() as DocumentId;
  const nodeId = randomUUID() as KnowledgeNodeId;
  const otherNodeId = randomUUID() as KnowledgeNodeId;
  const evidenceId = randomUUID() as EvidenceId;
  const quote = '東京';
  const markdown = '序章 😀 東京の朝\n';
  await persistence.transaction(async tx => {
    await tx.createProject({ id: projectId, title: '日本語の作品', settings: { theme: 'night' } });
    await tx.createDocument({
      projectId,
      documentId: parentId,
      kind: 'chapter',
      title: '第一章',
      orderKey: '0001',
      markdown: '',
      authorId: 'owner',
      idempotencyKey: 'fixture-parent-' + parentId,
    });
    const scene = await tx.createDocument({
      projectId,
      documentId,
      parentId,
      kind: 'scene',
      title: '始まり',
      orderKey: '0002',
      markdown,
      authorId: 'owner',
      idempotencyKey: 'fixture-scene-' + documentId,
    });
    for (const [id, name] of [
      [nodeId, '東京'],
      [otherNodeId, '都市'],
    ] as const) {
      await tx.saveKnowledgeNode({
        projectId,
        id,
        name,
        type: 'place',
        attributes: { locale: 'ja' },
        status: 'confirmed',
        expectedVersion: null,
      });
    }
    await tx.saveKnowledgeAlias({
      projectId,
      id: randomUUID() as import('@codexia/persistence-contracts').KnowledgeAliasId,
      nodeId,
      surface: '東都',
      normalized: '東都',
      scope: null,
      status: 'confirmed',
    });
    await tx.saveKnowledgeRelation({
      projectId,
      id: randomUUID() as import('@codexia/persistence-contracts').KnowledgeRelationId,
      sourceId: nodeId,
      targetId: otherNodeId,
      type: 'is-a',
      attributes: {},
      validity: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    const fromUtf16 = markdown.indexOf(quote);
    await tx.saveEvidenceAnchor({
      projectId,
      id: evidenceId,
      documentId,
      revisionId: scene.revision.id,
      fromUtf16,
      toUtf16: fromUtf16 + quote.length,
      quoteSha256: createHash('sha256').update(quote).digest('hex'),
      status: 'confirmed',
      expectedVersion: null,
    });
    await tx.saveMentionLink({
      projectId,
      evidenceId,
      nodeId,
      status: 'confirmed',
      source: 'author',
      confidence: null,
      extractorVersion: null,
    });
    const assertionId = randomUUID() as import('@codexia/persistence-contracts').AssertionId;
    await tx.saveAssertion({
      projectId,
      id: assertionId,
      proposition: { text: '東京は都市' },
      modality: 'stated',
      perspective: 'narrator',
      narrativeTime: {},
      confidence: 1,
      status: 'confirmed',
      expectedVersion: null,
    });
    await tx.linkAssertionEvidence({ projectId, assertionId, evidenceId, role: 'supports' });
    await tx.saveModuleRecord({
      projectId,
      moduleId: 'story',
      key: 'character-corrections',
      value: { editorNote: '保持' },
      expectedVersion: null,
    });
    await tx.saveModuleRecord({
      projectId,
      moduleId: 'assistant',
      key: 'settings',
      value: { provider: 'local', credentials: { apiKey: 'private-api-key' } },
      expectedVersion: null,
    });
    await tx.saveModuleRecord({
      projectId,
      moduleId: 'core.artifacts',
      key: 'meta/scriptorium/modules/publishing/share-grants.jsonl',
      value: { content: 'sensitive-grant' },
      expectedVersion: null,
    });
    await tx.saveModuleRecord({
      projectId,
      moduleId: 'core.authority.proposals',
      key: 'proposal:private',
      value: { draft: 'not portable' },
      expectedVersion: null,
    });
  });
  const archive = await exportWorkArchive(persistence, projectId);
  assert.equal(archive.format, 'codexia-work/v1');
  assert.equal(archive.documents.find(d => d.id === documentId)?.markdown, markdown);
  assert.equal(archive.knowledge.nodes.length, 2);
  assert.equal(archive.evidence.anchors.length, 1);
  assert.equal(archive.moduleRecords.length, 1);
  assert.ok(archive.omittedRecords.some(item => item.includes('share-grants')));
  assert.equal(JSON.stringify(archive).includes('sensitive-grant'), false);
  assert.equal(JSON.stringify(archive).includes('not portable'), false);
  assert.equal(JSON.stringify(archive).includes('private-api-key'), false);
  assert.ok(archive.omittedRecords.some(item => item.includes('assistant:settings')));
  const result = await importWorkArchive(persistence, archive, 'owner');
  assert.equal(result.replayed, false);
  assert.notEqual(result.project.id, projectId);
  assert.deepEqual(
    result.project,
    await persistence.read(reader => reader.getProject(result.project.id)),
    'import response must expose the committed version',
  );
  const repeat = await importWorkArchive(persistence, archive, 'owner');
  assert.equal(repeat.replayed, true);
  assert.equal(repeat.project.id, result.project.id);
  const restored = await exportWorkArchive(persistence, result.project.id);
  assert.equal(restored.project.title, archive.project.title);
  assert.deepEqual(restored.project.settings, archive.project.settings);
  assert.deepEqual(
    restored.documents.map(d => [d.id, d.parentId, d.kind, d.title, d.orderKey, d.markdown]),
    archive.documents.map(d => [d.id, d.parentId, d.kind, d.title, d.orderKey, d.markdown]),
  );
  assert.deepEqual(restored.knowledge, archive.knowledge);
  assert.deepEqual(restored.evidence.mentions, archive.evidence.mentions);
  assert.deepEqual(restored.evidence.assertionEvidence, archive.evidence.assertionEvidence);
  assert.equal(restored.evidence.anchors[0]?.id, evidenceId);
  assert.equal(restored.moduleRecords[0]?.value.editorNote, '保持');
});

test('portable NLP consent keeps native settings and refuses the retired source record', async () => {
  const project = await core.createProject({ title: 'Portable NLP settings ' + randomUUID() });
  const settings = { externalEnabled: { 'setting-qa': false, futureFeature: true }, nextPolicy: { notes: '保持' } };
  const retired = { moduleId: 'core.artifacts', key: 'meta/scriptorium/modules/nlp/feature-settings.json' };
  await persistence.transaction(async tx => {
    await tx.saveModuleRecord({ projectId: project.id, moduleId: 'nlp', key: 'feature-settings', value: settings, expectedVersion: null });
    await tx.saveModuleRecord({ projectId: project.id, ...retired, value: { deleted: true }, expectedVersion: null });
  });
  const archive = await exportWorkArchive(persistence, project.id);
  assert.deepEqual(archive.moduleRecords, [{ moduleId: 'nlp', key: 'feature-settings', value: settings }]);
  const restored = await importWorkArchive(persistence, archive, 'owner');
  assert.deepEqual((await exportWorkArchive(persistence, restored.project.id)).moduleRecords, archive.moduleRecords);

  await assert.rejects(
    importWorkArchive(
      persistence,
      {
        ...archive,
        moduleRecords: [...archive.moduleRecords, { ...retired, value: { content: JSON.stringify(settings) } }],
      },
      'owner',
    ),
    { code: 'RETIRED_NLP_FEATURE_SETTINGS_ARCHIVE_FORMAT' },
  );
  await assert.rejects(
    importWorkArchive(
      persistence,
      {
        ...archive,
        moduleRecords: [{ moduleId: 'nlp', key: 'feature-settings', value: { externalEnabled: [] } }],
      },
      'owner',
    ),
    { code: 'INVALID_WORK_ARCHIVE' },
  );
});

test('portable import keeps deleted mapped hierarchy paths reserved in PostgreSQL', async () => {
  const source = await core.createProject({ title: 'Archive reservation ' + randomUUID() });
  const proposeCreation = async (projectId: ProjectId, input: Parameters<CoreStore['proposeHierarchyCreate']>[1]) => {
    const { snapshot } = await core.observe(projectId);
    return core.proposeHierarchyCreate(projectId, input, {
      projectVersion: snapshot.projectVersion,
      actorId: 'owner',
      idempotencyKey: randomUUID(),
    });
  };
  const approveAndApply = async (changeSet: ChangeSet) => {
    const approved = await persistence.transaction(tx =>
      tx.approveChangeSet({
        projectId: changeSet.projectId,
        changeSetId: changeSet.id,
        expectedVersion: changeSet.version,
        approvedBy: 'owner',
      }),
    );
    await persistence.transaction(tx =>
      tx.applyChangeSet({
        projectId: changeSet.projectId,
        changeSetId: changeSet.id,
        expectedVersion: approved.version,
      }),
    );
  };
  for (const input of [
    { kind: 'volume', id: 'reserve-volume', title: 'Volume' },
    { kind: 'chapter', id: 'reserve-chapter', title: 'Chapter', volumeId: 'reserve-volume' },
    {
      kind: 'scene',
      id: 'reserve-scene',
      title: 'Scene',
      volumeId: 'reserve-volume',
      chapterId: 'reserve-chapter',
      manuscriptBody: 'Retained text',
    },
  ] as const) {
    await approveAndApply((await proposeCreation(source.id, input)).changeSet);
  }

  const archive = await exportWorkArchive(persistence, source.id);
  const imported = await importWorkArchive(persistence, archive, 'owner');
  const { snapshot: deletionSnapshot } = await core.observe(imported.project.id);
  const { changeSet: deletion } = await core.proposeHierarchyDelete(
    imported.project.id,
    {
      kind: 'scene',
      id: 'reserve-scene',
      volumeId: 'reserve-volume',
      chapterId: 'reserve-chapter',
    },
    { projectVersion: deletionSnapshot.projectVersion, actorId: 'owner', idempotencyKey: randomUUID() },
  );
  await approveAndApply(deletion);

  await assert.rejects(
    proposeCreation(imported.project.id, {
      kind: 'scene',
      id: 'reserve-scene',
      title: 'Reused',
      volumeId: 'reserve-volume',
      chapterId: 'reserve-chapter',
    }),
    (error: unknown) => error instanceof CoreError && error.code === 'hierarchy_path_reserved',
  );
  const newScene = await proposeCreation(imported.project.id, {
    kind: 'scene',
    id: 'unused-scene',
    title: 'Unused path',
    volumeId: 'reserve-volume',
    chapterId: 'reserve-chapter',
  });
  await approveAndApply(newScene.changeSet);

  const sourceScene = archive.documents.find(document => document.kind === 'scene')!;
  assert.ok(
    await persistence.read(reader =>
      reader.getRevision(
        source.id,
        sourceScene.id as DocumentId,
        sourceScene.revisionId as import('@codexia/persistence-contracts').RevisionId,
      ),
    ),
  );
  assert.equal(
    (await exportWorkArchive(persistence, imported.project.id)).documents.some(document => document.id === sourceScene.id),
    false,
  );
  assert.ok(
    await persistence
      .read(reader => reader.listDocuments(imported.project.id))
      .then(documents => documents.some(document => document.title === 'Unused path')),
  );

  // Exercise the transactional guard independently of proposal-time validation:
  // construct an approved hierarchy write and require apply to reject the retained mapping.
  const snapshot = (await core.observe(imported.project.id)).snapshot;
  const path = 'plot/volumes/reserve-volume/chapters/reserve-chapter/scenes/reserve-scene.yaml';
  const operation: ChangeOperation = {
    id: randomUUID(),
    generation: 0,
    projectId: imported.project.id,
    baseProjectVersion: snapshot.projectVersion,
    effect: 'structure',
    reads: [{ path, revision: null }],
    writes: [{ path, revision: null, content: 'id: reserve-scene\ntitle: Reused\n' }],
    message: 'Attempt reserved path',
  };
  const proposal: ChangeProposal = { id: randomUUID(), snapshot, operations: [operation], source: 'author' };
  await core.propose(imported.project.id, proposal);
  await core.approve(imported.project.id, { proposalId: proposal.id, operationIds: [operation.id], authorScope: 'owner' });
  await assert.rejects(
    core.apply(imported.project.id, operation),
    (error: unknown) => error instanceof CoreError && error.code === 'hierarchy_path_reserved',
  );
});

test('invalid imported references fail without creating a partial work', async () => {
  const projectId = randomUUID() as import('@codexia/persistence-contracts').ProjectId;
  const title = `Invalid archive source ${projectId}`;
  await persistence.transaction(tx => tx.createProject({ id: projectId, title }));
  const archive = await exportWorkArchive(persistence, projectId);
  const corrupt = structuredClone(archive);
  corrupt.documents.push({
    id: randomUUID(),
    parentId: randomUUID(),
    kind: 'scene',
    title: 'Broken',
    orderKey: '0',
    markdown: 'x',
    revisionId: randomUUID(),
  });
  await assert.rejects(importWorkArchive(persistence, corrupt, 'owner'), /parent|reference|archive/i);
  assert.equal((await exportWorkArchive(persistence, projectId)).documents.length, 0);
  const matchingWork = (await persistence.read(reader => reader.listProjectPage!(200))).filter(project => project.title === title);
  assert.deepEqual(
    matchingWork.map(project => project.id),
    [projectId],
    'a rejected import creates no partial copy',
  );
});

test('superseded evidence remains in an explicit unresolved archive section', async () => {
  const projectId = randomUUID() as import('@codexia/persistence-contracts').ProjectId;
  const documentId = randomUUID() as DocumentId;
  const evidenceId = randomUUID() as EvidenceId;
  await persistence.transaction(async tx => {
    await tx.createProject({ id: projectId, title: 'Evidence history' });
    const first = await tx.createDocument({
      projectId,
      documentId,
      kind: 'scene',
      title: 'Evidence',
      orderKey: '0',
      markdown: '猫',
      authorId: 'owner',
      idempotencyKey: 'fixture-stale-first-' + documentId,
    });
    await tx.saveEvidenceAnchor({
      projectId,
      id: evidenceId,
      documentId,
      revisionId: first.revision.id,
      fromUtf16: 0,
      toUtf16: 1,
      quoteSha256: createHash('sha256').update('猫').digest('hex'),
      status: 'confirmed',
      expectedVersion: null,
    });
    await tx.saveDocument({
      projectId,
      documentId,
      baseRevisionId: first.revision.id,
      changes: [{ fromUtf16: 0, toUtf16: 1, insert: '' }],
      resultingSha256: createHash('sha256').update('').digest('hex'),
      authorId: 'owner',
      clientId: 'test',
      idempotencyKey: 'fixture-stale-second-' + documentId,
    });
  });
  const archive = await exportWorkArchive(persistence, projectId);
  assert.equal(archive.evidence.anchors.length, 0);
  assert.equal(archive.evidence.unresolved.anchors.length, 1);
  const imported = await importWorkArchive(persistence, archive, 'owner');
  assert.equal(imported.unresolvedAnchors, 1);
  const again = await exportWorkArchive(persistence, imported.project.id);
  assert.equal(again.evidence.unresolved.anchors[0]?.id, evidenceId);
});
test('nested settings arrays never expose sensitive keys in the exported archive', async () => {
  const projectId = randomUUID() as import('@codexia/persistence-contracts').ProjectId;
  await persistence.transaction(tx =>
    tx.createProject({
      id: projectId,
      title: 'Nested settings',
      settings: {
        connections: [[{ apiKey: 'synthetic-secret', label: 'keep' }], { nested: [[{ password: 'synthetic-password', enabled: true }]] }],
        theme: 'night',
      },
    }),
  );
  const archive = await exportWorkArchive(persistence, projectId);
  assert.deepEqual(archive.project.settings, { connections: [[{ label: 'keep' }], { nested: [[{ enabled: true }]] }], theme: 'night' });
  assert.deepEqual(archive.omittedRecords, [
    'project.settings.connections[0][0].apiKey',
    'project.settings.connections[1].nested[0][0].password',
  ]);
  assert.doesNotMatch(JSON.stringify(archive), /synthetic-secret|synthetic-password/);
  const imported = await importWorkArchive(persistence, archive, 'owner');
  assert.deepEqual((await exportWorkArchive(persistence, imported.project.id)).project.settings, archive.project.settings);
});

test('evidence on a deleted document round trips as unresolved without restoring the document', async () => {
  const projectId = randomUUID() as import('@codexia/persistence-contracts').ProjectId;
  const documentId = randomUUID() as DocumentId;
  const evidenceId = randomUUID() as EvidenceId;
  const nodeId = randomUUID() as KnowledgeNodeId;
  const assertionId = randomUUID() as import('@codexia/persistence-contracts').AssertionId;
  await persistence.transaction(async tx => {
    await tx.createProject({ id: projectId, title: 'Deleted evidence source' });
    const created = await tx.createDocument({
      projectId,
      documentId,
      kind: 'scene',
      title: 'Deleted',
      orderKey: '0',
      markdown: '猫',
      authorId: 'owner',
      idempotencyKey: 'deleted-evidence-' + documentId,
    });
    await tx.saveKnowledgeNode({
      projectId,
      id: nodeId,
      type: 'animal',
      name: '猫',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    await tx.saveEvidenceAnchor({
      projectId,
      id: evidenceId,
      documentId,
      revisionId: created.revision.id,
      fromUtf16: 0,
      toUtf16: 1,
      quoteSha256: createHash('sha256').update('猫').digest('hex'),
      status: 'confirmed',
      expectedVersion: null,
    });
    await tx.saveMentionLink({
      projectId,
      evidenceId,
      nodeId,
      source: 'author',
      confidence: null,
      extractorVersion: null,
      status: 'confirmed',
    });
    await tx.saveAssertion({
      projectId,
      id: assertionId,
      proposition: { nodeId },
      modality: 'stated',
      perspective: 'author',
      narrativeTime: {},
      confidence: null,
      status: 'confirmed',
      expectedVersion: null,
    });
    await tx.linkAssertionEvidence({ projectId, assertionId, evidenceId, role: 'supports' });
    const doc = await tx.getDocument(projectId, documentId);
    assert.ok(doc);
    await tx.deleteDocument({ projectId, documentId, expectedVersion: doc.version });
  });
  const archive = await exportWorkArchive(persistence, projectId);
  assert.equal(archive.documents.length, 0);
  assert.equal(archive.evidence.anchors.length, 0);
  assert.deepEqual(
    archive.evidence.unresolved.anchors.map(a => [a.id, a.documentId]),
    [[evidenceId, documentId]],
  );
  assert.deepEqual(
    archive.evidence.unresolved.mentions.map(m => [m.evidenceId, m.nodeId]),
    [[evidenceId, nodeId]],
  );
  assert.deepEqual(archive.evidence.unresolved.assertionEvidence, [{ assertionId, evidenceId, role: 'supports' }]);
  const result = await importWorkArchive(persistence, archive, 'owner');
  const restored = await exportWorkArchive(persistence, result.project.id);
  assert.equal(restored.documents.length, 0);
  assert.deepEqual(restored.evidence.unresolved, archive.evidence.unresolved);
  assert.deepEqual(restored.evidence.assertions, archive.evidence.assertions);
});

test('unresolved evidence links require bundled anchors and graph records before import', async () => {
  const sourceId = randomUUID() as ProjectId;
  const title = `Unresolved link validation ${sourceId}`;
  await persistence.transaction(tx => tx.createProject({ id: sourceId, title }));
  const archive = await exportWorkArchive(persistence, sourceId);
  const anchorId = randomUUID() as EvidenceId;
  const nodeId = randomUUID() as KnowledgeNodeId;
  const assertionId = randomUUID() as import('@codexia/persistence-contracts').AssertionId;
  const unresolvedAnchor = {
    id: anchorId,
    documentId: randomUUID(),
    revisionId: randomUUID(),
    fromUtf16: 0,
    toUtf16: 1,
    quoteSha256: 'a'.repeat(64),
    status: 'orphaned' as const,
  };
  archive.evidence.unresolved.anchors.push(unresolvedAnchor);
  archive.evidence.unresolved.mentions.push({
    evidenceId: anchorId,
    nodeId,
    status: 'confirmed',
    source: 'author',
    confidence: null,
    extractorVersion: null,
  });
  archive.evidence.unresolved.assertionEvidence.push({ assertionId, evidenceId: anchorId, role: 'supports' });
  await assert.rejects(importWorkArchive(persistence, archive, 'owner'), /missing evidence or knowledge|missing evidence or assertion/u);
  const projects = await persistence.read(reader => reader.listProjectPage!(200));
  assert.deepEqual(
    projects.filter(project => project.title === title).map(project => project.id),
    [sourceId],
  );

  archive.knowledge.nodes.push({ id: nodeId, type: 'place', name: '旧地点', attributes: {}, status: 'confirmed' });
  archive.evidence.assertions.push({
    id: assertionId,
    proposition: { text: '旧記録' },
    modality: 'stated',
    perspective: 'author',
    narrativeTime: {},
    confidence: null,
    status: 'confirmed',
  });
  const imported = await importWorkArchive(persistence, archive, 'owner');
  const restored = await exportWorkArchive(persistence, imported.project.id);
  assert.deepEqual(restored.evidence.unresolved.anchors, [unresolvedAnchor]);
  assert.deepEqual(restored.evidence.unresolved.mentions, archive.evidence.unresolved.mentions);
  assert.deepEqual(restored.evidence.unresolved.assertionEvidence, archive.evidence.unresolved.assertionEvidence);
});

test('overlapping identical portable import requests replay the committed project', { timeout: 15000 }, async () => {
  const sourceId = randomUUID() as ProjectId;
  await persistence.transaction(tx => tx.createProject({ id: sourceId, title: 'Concurrent ' + sourceId }));
  const archive = await exportWorkArchive(persistence, sourceId);
  let arrivals = 0;
  let release!: () => void;
  const bothReadyToInsert = new Promise<void>(resolve => {
    release = resolve;
  });
  // Both independent PostgreSQL transactions complete their identity lookups
  // before either can attempt the INSERT.
  const overlapping: Persistence = {
    read: work => persistence.read(work),
    transaction: <T>(work: (tx: PersistenceTransaction) => Promise<T>) =>
      persistence.transaction(tx =>
        work(
          new Proxy(tx, {
            get(target, key, receiver) {
              if (key === 'createProject')
                return async (command: Parameters<PersistenceTransaction['createProject']>[0]) => {
                  assert.ok(command.id);
                  assert.equal(await target.getProject(command.id), undefined);
                  arrivals++;
                  if (arrivals === 2) release();
                  await bothReadyToInsert;
                  assert.equal(arrivals, 2);
                  return target.createProject(command);
                };
              const value = Reflect.get(target, key, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        ),
      ),
    close: async () => {},
  };
  const request = () =>
    handlePersistenceOperation('persistence_import_post', {
      persistence: overlapping,
      params: {},
      query: new URLSearchParams(),
      body: archive,
      requestHeaders: {},
      requireAuthor: async () => 'owner',
    });
  const timer = setTimeout(release, 5000);
  try {
    const responses = await Promise.all([request(), request()]);
    assert.equal(arrivals, 2);
    for (const response of responses) assert.equal(response?.status, 201);
    const results = responses.map(response => response!.body as Awaited<ReturnType<typeof importWorkArchive>>);
    assert.equal(results[0]!.project.id, results[1]!.project.id);
    assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
    assert.deepEqual(results[0]!.project, await persistence.read(reader => reader.getProject(results[0]!.project.id)));
    assert.deepEqual(results[1]!.project, results[0]!.project);
  } finally {
    clearTimeout(timer);
    release();
  }
});

test('a conflicting portable import receipt does not authorize replay or overwrite', async () => {
  const sourceId = randomUUID() as ProjectId;
  await persistence.transaction(tx => tx.createProject({ id: sourceId, title: 'Receipt ' + sourceId }));
  const archive = await exportWorkArchive(persistence, sourceId);
  const imported = await importWorkArchive(persistence, archive, 'owner');
  const original = await persistence.read(reader => reader.getModuleRecord(imported.project.id, 'core.portable.archive', 'import-receipt'));
  assert.ok(original);
  await persistence.transaction(tx =>
    tx.saveModuleRecord({
      projectId: imported.project.id,
      moduleId: 'core.portable.archive',
      key: 'import-receipt',
      value: { payloadSha256: 'different', archiveFormat: archive.format },
      expectedVersion: 1,
    }),
  );
  const before = await persistence.read(reader => reader.getProject(imported.project.id));
  await assert.rejects(importWorkArchive(persistence, archive, 'owner'), /conflicts with this import identity/u);
  assert.deepEqual(await persistence.read(reader => reader.getProject(imported.project.id)), before);
  const corrupted = await persistence.read(reader =>
    reader.getModuleRecord(imported.project.id, 'core.portable.archive', 'import-receipt'),
  );
  assert.ok(corrupted);
  await persistence.transaction(tx =>
    tx.saveModuleRecord({
      projectId: imported.project.id,
      moduleId: 'core.portable.archive',
      key: 'import-receipt',
      value: { ...original.value, archiveFormat: 'wrong-format' },
      expectedVersion: corrupted.version,
    }),
  );
  await assert.rejects(importWorkArchive(persistence, archive, 'owner'), /conflicts with this import identity/u);
});
