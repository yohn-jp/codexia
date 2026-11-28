import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { ChangeOperation, ChangeProposal, SnapshotId } from '@codexia/contracts';
import { type ChangeSet, PersistenceError, type ProjectId } from '@codexia/persistence-contracts';
import { createPostgresPersistence, migratePostgresDatabase } from '@codexia/persistence-postgres';
import YAML from 'yaml';
import { CoreError, CoreStore } from './index.js';

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error('CODEXIA_TEST_DATABASE_URL is required for Core PostgreSQL integration tests');
const persistence = createPostgresPersistence(connectionString),
  core = new CoreStore({ persistence });
before(() => migratePostgresDatabase(connectionString));
after(() => persistence.close());
async function project() {
  return core.createProject({ title: `Core ${randomUUID()}` });
}
async function accept(projectId: string, operation: ChangeOperation, snapshot?: SnapshotId) {
  const proposal: ChangeProposal = {
    id: randomUUID(),
    snapshot: snapshot ?? { projectId, projectVersion: operation.baseProjectVersion },
    source: 'author',
    operations: [operation],
  };
  await core.propose(projectId, proposal);
  await core.approve(projectId, { proposalId: proposal.id, operationIds: [operation.id], authorScope: 'author' });
  return core.apply(projectId, operation);
}
async function approve(projectId: string, built: { operation: ChangeOperation; snapshot: SnapshotId }) {
  const proposal: ChangeProposal = { id: randomUUID(), snapshot: built.snapshot, source: 'author', operations: [built.operation] };
  await core.propose(projectId, proposal);
  await core.approve(projectId, { proposalId: proposal.id, operationIds: [built.operation.id], authorScope: 'author' });
  return proposal;
}
async function hierarchy() {
  const p = await project();
  await createHierarchy(p.id, { kind: 'volume', id: 'v1', title: 'Volume' });
  await createHierarchy(p.id, { kind: 'chapter', id: 'c1', title: 'Chapter', volumeId: 'v1' });
  await createHierarchy(p.id, { kind: 'scene', id: 's1', title: 'Scene', volumeId: 'v1', chapterId: 'c1', manuscriptBody: 'Text 😀\n' });
  return p;
}
const proposeReorder = async (projectId: ProjectId, input: Parameters<CoreStore['proposeHierarchyReorder']>[1]) => {
  const { snapshot } = await core.observe(projectId);
  return core.proposeHierarchyReorder(projectId, input, {
    projectVersion: snapshot.projectVersion,
    actorId: 'author',
    idempotencyKey: randomUUID(),
  });
};
const approveReorder = async (projectId: ProjectId, input: Parameters<CoreStore['proposeHierarchyReorder']>[1]) => {
  const { changeSet } = await proposeReorder(projectId, input);
  return persistence.transaction(tx =>
    tx.approveChangeSet({
      projectId,
      changeSetId: changeSet.id,
      expectedVersion: changeSet.version,
      approvedBy: 'author',
    }),
  );
};
const applyReorder = (changeSet: ChangeSet) =>
  persistence.transaction(tx =>
    tx.applyChangeSet({
      projectId: changeSet.projectId,
      changeSetId: changeSet.id,
      expectedVersion: changeSet.version,
    }),
  );
function operation(snapshot: SnapshotId, path: string, content: string | null, revision: string | null = null): ChangeOperation {
  return {
    id: randomUUID(),
    generation: 0,
    projectId: snapshot.projectId,
    baseProjectVersion: snapshot.projectVersion,
    effect: 'metadata',
    reads: [{ path, revision }],
    writes: [{ path, revision, content }],
    message: 'Write approved data',
  };
}
const proposeDelete = async (projectId: ProjectId, input: Parameters<CoreStore['proposeHierarchyDelete']>[1]) => {
  const { snapshot } = await core.observe(projectId);
  return core.proposeHierarchyDelete(projectId, input, {
    projectVersion: snapshot.projectVersion,
    actorId: 'author',
    idempotencyKey: randomUUID(),
  });
};
const approveDelete = async (projectId: ProjectId, input: Parameters<CoreStore['proposeHierarchyDelete']>[1]) => {
  const { changeSet } = await proposeDelete(projectId, input);
  return persistence.transaction(tx =>
    tx.approveChangeSet({
      projectId,
      changeSetId: changeSet.id,
      expectedVersion: changeSet.version,
      approvedBy: 'author',
    }),
  );
};
const applyNativeChangeSet = (changeSet: ChangeSet) =>
  persistence.transaction(tx =>
    tx.applyChangeSet({
      projectId: changeSet.projectId,
      changeSetId: changeSet.id,
      expectedVersion: changeSet.version,
    }),
  );
const proposeCreate = async (projectId: ProjectId, input: Parameters<CoreStore['proposeHierarchyCreate']>[1]) => {
  const { snapshot } = await core.observe(projectId);
  return core.proposeHierarchyCreate(projectId, input, {
    projectVersion: snapshot.projectVersion,
    actorId: 'author',
    idempotencyKey: randomUUID(),
  });
};
async function createHierarchy(projectId: ProjectId, input: Parameters<CoreStore['proposeHierarchyCreate']>[1]) {
  const { changeSet } = await proposeCreate(projectId, input);
  const approved = await persistence.transaction(tx =>
    tx.approveChangeSet({
      projectId,
      changeSetId: changeSet.id,
      expectedVersion: changeSet.version,
      approvedBy: 'author',
    }),
  );
  return applyNativeChangeSet(approved);
}

test('approved native create exposes the authored scene ID, immutable body and replayable receipt', async () => {
  const p = await hierarchy();
  const existing = await core.reader(p.id);
  const input = {
    kind: 'scene',
    id: 'native-scene',
    title: 'Scene',
    volumeId: 'v1',
    chapterId: 'c1',
    manuscriptBody: '原稿 🪶\n',
  } as const;
  const key = randomUUID();
  const options = { actorId: 'external-proposer', idempotencyKey: key, origin: 'external-agent' } as const;
  await persistence.transaction(tx =>
    tx.updateProject({
      projectId: p.id,
      expectedVersion: existing.snapshot.projectVersion,
      title: 'Changed before proposal',
    }),
  );
  await assert.rejects(core.proposeHierarchyCreate(p.id, input, { ...options, projectVersion: existing.snapshot.projectVersion }), {
    code: 'conflict',
  });
  const propose = async () =>
    core.proposeHierarchyCreate(p.id, input, {
      ...options,
      projectVersion: (await core.observe(p.id)).snapshot.projectVersion,
    });
  const { changeSet } = await propose();
  assert.equal(changeSet.operations[0]?.type, 'document.create');
  assert.equal((await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes.length, 1);
  await assert.rejects(applyNativeChangeSet(changeSet), { code: 'invalid_change_set_state' });
  const approved = await persistence.transaction(tx =>
    tx.approveChangeSet({
      projectId: p.id,
      changeSetId: changeSet.id,
      expectedVersion: changeSet.version,
      approvedBy: 'reviewing-author',
    }),
  );
  const applied = await applyNativeChangeSet(approved);
  const result = applied.results[0];
  assert.ok(result && 'revision' in result);
  assert.equal(result.revision.authorId, 'reviewing-author');
  assert.equal(result.revision.markdown, '原稿 🪶\n');
  assert.deepEqual(
    (await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes.map(scene => scene.id),
    ['s1', 'native-scene'],
  );
  const reader = await core.reader(p.id);
  assert.ok(reader.nativeStoryDocuments?.some(document => document.id === 'native-scene' && document.title === 'Scene'));
  assert.equal((await reader.read('manuscript/v1/c1/native-scene.md'))?.content, '原稿 🪶\n');
  assert.equal((await core.readScene(p.id, 'native-scene')).text, '原稿 🪶\n');
  assert.equal(await existing.read('manuscript/v1/c1/native-scene.md'), null);
  assert.deepEqual(await applyNativeChangeSet(approved), { ...applied, replayed: true });
  assert.deepEqual(await propose(), { changeSet: applied.changeSet, replayed: true });
});

test('native hierarchy reorder keeps manuscript revisions and applies once after approval', async () => {
  const p = await hierarchy();
  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const chapter = documents.find(document => document.kind === 'chapter')!;
  const original = documents.find(document => document.kind === 'scene')!;
  const { document: second } = await persistence.transaction(tx =>
    tx.createDocument({
      projectId: p.id,
      parentId: chapter.id,
      kind: 'scene',
      title: 'Second scene',
      orderKey: '2',
      markdown: 'Second body',
      authorId: 'author',
      idempotencyKey: randomUUID(),
    }),
  );
  const { snapshot } = await core.observe(p.id);
  const options = {
    projectVersion: snapshot.projectVersion,
    actorId: 'proposer',
    idempotencyKey: randomUUID(),
    origin: 'external-agent',
  } as const;
  const ordered = { kind: 'scene' as const, volumeId: 'v1', chapterId: 'c1', orderedIds: [second.id, 's1'] };
  await assert.rejects(() => core.proposeHierarchyReorder(p.id, { ...ordered, orderedIds: [original.id, 's1'] }, options), {
    code: 'invalid_hierarchy_order',
  });
  const propose = () => core.proposeHierarchyReorder(p.id, ordered, options);
  const { changeSet: proposal, replayed } = await propose();
  assert.equal(replayed, false);
  assert.equal(proposal.authorId, 'proposer');
  assert.equal(proposal.provenance.details.origin, 'external-agent');
  assert.deepEqual(proposal.operations, [
    {
      type: 'document.update',
      command: { projectId: p.id, documentId: second.id, expectedVersion: second.version, orderKey: '0000000000' },
    },
    {
      type: 'document.update',
      command: { projectId: p.id, documentId: original.id, expectedVersion: original.version, orderKey: '0000000001' },
    },
  ]);
  const order = async () =>
    (await persistence.read(reader => reader.listDocuments(p.id, chapter.id))).map(document => [document.id, document.headRevisionId]);
  assert.deepEqual(await order(), [
    [original.id, original.headRevisionId],
    [second.id, second.headRevisionId],
  ]);
  const apply = (expectedVersion: number) =>
    persistence.transaction(tx => tx.applyChangeSet({ projectId: p.id, changeSetId: proposal.id, expectedVersion }));
  await assert.rejects(() => apply(proposal.version), { code: 'invalid_change_set_state' });
  const approved = await persistence.transaction(tx =>
    tx.approveChangeSet({
      projectId: p.id,
      changeSetId: proposal.id,
      expectedVersion: proposal.version,
      approvedBy: 'reviewer',
    }),
  );
  await persistence.transaction(tx =>
    tx.updateProject({
      projectId: p.id,
      expectedVersion: snapshot.projectVersion,
      title: 'Unrelated project title change',
    }),
  );
  const applied = await apply(approved.version);
  assert.equal(applied.changeSet.approvedBy, 'reviewer');
  assert.deepEqual(await order(), [
    [second.id, second.headRevisionId],
    [original.id, original.headRevisionId],
  ]);
  assert.equal((await core.observe(p.id)).snapshot.projectVersion, snapshot.projectVersion + 2);
  assert.deepEqual(await apply(approved.version), { ...applied, replayed: true });
  assert.deepEqual(await propose(), { changeSet: applied.changeSet, replayed: true });
  await assert.rejects(() => core.proposeHierarchyReorder(p.id, { ...ordered, orderedIds: ['s1', second.id] }, options), {
    code: 'idempotency_conflict',
  });
});

test('native hierarchy reorder rejects stale membership and row versions atomically', async t => {
  for (const change of ['add', 'move', 'delete', 'edit', 'move parent'] as const) {
    await t.test(change, async () => {
      const p = await hierarchy();
      const documents = await persistence.read(reader => reader.listDocuments(p.id));
      const volume = documents.find(document => document.kind === 'volume')!;
      const chapter = documents.find(document => document.kind === 'chapter')!;
      const scene = documents.find(document => document.kind === 'scene')!;
      const { snapshot } = await core.observe(p.id);
      const { changeSet } = await core.proposeHierarchyReorder(
        p.id,
        {
          kind: 'scene',
          volumeId: volume.id,
          chapterId: chapter.id,
          orderedIds: [scene.id],
        },
        { projectVersion: snapshot.projectVersion, actorId: 'proposer', idempotencyKey: randomUUID() },
      );
      const approved = await persistence.transaction(tx =>
        tx.approveChangeSet({
          projectId: p.id,
          changeSetId: changeSet.id,
          expectedVersion: changeSet.version,
          approvedBy: 'reviewer',
        }),
      );
      await persistence.transaction(async tx => {
        if (change === 'add')
          await tx.createDocument({
            projectId: p.id,
            parentId: chapter.id,
            kind: 'scene',
            title: 'New sibling',
            orderKey: '2',
            markdown: '',
            authorId: 'author',
            idempotencyKey: randomUUID(),
          });
        if (change === 'move')
          await tx.updateDocument({ projectId: p.id, documentId: scene.id, expectedVersion: scene.version, parentId: null });
        if (change === 'delete') await tx.deleteDocument({ projectId: p.id, documentId: scene.id, expectedVersion: scene.version });
        if (change === 'edit')
          await tx.updateDocument({ projectId: p.id, documentId: scene.id, expectedVersion: scene.version, title: 'New scene title' });
        if (change === 'move parent') {
          const other = await tx.createDocument({
            projectId: p.id,
            parentId: null,
            kind: 'volume',
            title: 'Another volume',
            orderKey: '2',
            markdown: '',
            authorId: 'author',
            idempotencyKey: randomUUID(),
          });
          await tx.updateDocument({
            projectId: p.id,
            documentId: chapter.id,
            expectedVersion: chapter.version,
            parentId: other.document.id,
          });
        }
      });
      const read = () => persistence.read(reader => reader.listDocuments(p.id));
      const beforeApply = await read();
      await assert.rejects(
        () =>
          persistence.transaction(tx =>
            tx.applyChangeSet({
              projectId: p.id,
              changeSetId: changeSet.id,
              expectedVersion: approved.version,
            }),
          ),
        (error: unknown) =>
          error instanceof PersistenceError &&
          error.code === 'conflict' &&
          error.details?.resource === (change === 'edit' ? 'document' : 'hierarchy_siblings'),
      );
      assert.deepEqual(await read(), beforeApply);
      assert.equal(await persistence.read(reader => reader.getChangeSetReceipt(p.id, changeSet.id)), undefined);
      assert.equal((await persistence.read(reader => reader.getChangeSet(p.id, changeSet.id)))?.status, 'approved');
      await assert.rejects(
        () =>
          core.proposeHierarchyReorder(
            p.id,
            {
              kind: 'scene',
              volumeId: volume.id,
              chapterId: chapter.id,
              orderedIds: [scene.id],
            },
            { projectVersion: snapshot.projectVersion, actorId: 'proposer', idempotencyKey: randomUUID() },
          ),
        { code: 'conflict' },
      );
    });
  }
});

test('PostgreSQL is sole project authority, hierarchy creation preserves canonical scene bodies', async () => {
  const p = await hierarchy();
  assert.equal(
    (await core.listProjectsPage()).projects.some(x => x.id === p.id),
    true,
  );
  const tree = await core.tree(p.id);
  assert.equal(tree.volumes[0]?.chapters[0]?.scenes[0]?.id, 's1');
  assert.equal((await core.readScene(p.id, 's1')).text, 'Text 😀\n');
  const docs = await persistence.read(r => r.listDocuments(p.id));
  assert.equal(docs.length, 3);
  assert.equal(
    (
      await persistence.read(r =>
        r.getRevision(p.id, docs.find(d => d.kind === 'scene')!.id, docs.find(d => d.kind === 'scene')!.headRevisionId!),
      )
    )?.markdown,
    'Text 😀\n',
  );
});
test('Core scene snapshots preserve horizontal-rule Markdown and strip explicit YAML frontmatter', async () => {
  const p = await hierarchy();
  const path = 'manuscript/v1/c1/s1.md';
  const ordinaryMarkdown = '---\n普通の回想\n---\n「すぐに戻ります。」';
  const originalReader = await core.reader(p.id);
  const original = await originalReader.read(path);
  await accept(p.id, operation(originalReader.snapshot, path, ordinaryMarkdown, original!.revision));

  const ordinarySnapshot = await core.readSceneSnapshot(p.id, 's1');
  assert.equal(ordinarySnapshot.document.content, ordinaryMarkdown);
  assert.equal(ordinarySnapshot.scene.text, ordinaryMarkdown);

  const explicitMarkdown = '---\ntitle: Explicit title\nstatus: draft\n---\n本文です。';
  const currentReader = await core.reader(p.id);
  const current = await currentReader.read(path);
  await accept(p.id, operation(currentReader.snapshot, path, explicitMarkdown, current!.revision));
  assert.equal((await core.readSceneSnapshot(p.id, 's1')).scene.text, '本文です。');
});
test('native notes retain their manuscript and author identity without acquiring a scene projection', async () => {
  const p = await hierarchy();
  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const scene = documents.find(document => document.kind === 'scene')!;
  const chapter = documents.find(document => document.kind === 'chapter')!;
  const note = await persistence.transaction(transaction =>
    transaction.createDocument({
      projectId: p.id,
      kind: 'note',
      parentId: scene.id,
      title: 'Author note',
      orderKey: '0002',
      markdown: 'Private note body',
      authorId: 'owner',
      idempotencyKey: randomUUID(),
    }),
  );
  const reader = await core.reader(p.id);
  const misleadingPath = `plot/volumes/${chapter.id}/chapters/${scene.id}/scenes/${note.document.id}.yaml`;
  const bodyPath = `documents/${note.document.id}.md`;
  assert.equal(await reader.read(misleadingPath), null);
  assert.ok(!(await reader.list('')).includes(misleadingPath));
  const body = await reader.read(bodyPath);
  assert.equal(body?.content, 'Private note body');
  assert.equal(body?.revision, note.revision.sha256);
  assert.equal(body?.documentKind, 'note');
  await assert.rejects(core.readSceneSnapshot(p.id, note.document.id, reader.snapshot), { code: 'scene_not_found' });

  await persistence.transaction(tx =>
    tx.saveModuleRecord({
      projectId: p.id,
      moduleId: 'core.document-paths',
      key: note.document.id,
      value: { metadata: { id: 'author-note' } },
      expectedVersion: null,
    }),
  );
  const next = await core.reader(p.id);
  assert.equal(await next.read(misleadingPath), null);
  assert.equal((await core.resolveSnapshotDocument(p.id, bodyPath, next.snapshot)).documentId, note.document.id);
  assert.equal((await core.resolveSnapshotDocument(p.id, bodyPath, reader.snapshot)).documentId, note.document.id);
  assert.deepEqual(
    (await core.searchSnapshot(p.id, 'Private note body')).results.map(({ id, type }) => ({ id, type })),
    [{ id: 'author-note', type: 'note' }],
  );
  await assert.rejects(core.readSceneSnapshot(p.id, 'author-note'), { code: 'scene_not_found' });
  await persistence.transaction(tx =>
    tx.saveModuleRecord({
      projectId: p.id,
      moduleId: 'core.document-paths',
      key: note.document.id,
      value: { metadataPath: misleadingPath, metadata: { id: 'author-note', label: 'Author annotation' } },
      expectedVersion: 1,
    }),
  );
  const explicit = await core.reader(p.id);
  assert.deepEqual(YAML.parse((await explicit.read(misleadingPath))!.content).label, 'Author annotation');
  await assert.rejects(core.readSceneSnapshot(p.id, 'author-note', explicit.snapshot), { code: 'scene_not_found' });
  assert.equal(await next.read(misleadingPath), null);
  assert.equal((await core.readScene(p.id, 's1')).text, 'Text 😀\n');
  const tree = await core.tree(p.id);
  assert.deepEqual(
    tree.volumes.map(volume => volume.id),
    ['v1'],
  );
  assert.deepEqual(
    tree.volumes[0]?.chapters.map(chapter => chapter.id),
    ['c1'],
  );
  assert.deepEqual(
    tree.volumes[0]?.chapters[0]?.scenes.map(item => item.id),
    ['s1'],
  );
});
test('native document snapshots expose authoritative chapter and scene parent identities', async () => {
  const p = await project();
  const create = (kind: string, parentId: import('@codexia/persistence-contracts').DocumentId | null, title: string) =>
    persistence.transaction(tx =>
      tx.createDocument({
        projectId: p.id,
        kind,
        parentId,
        title,
        orderKey: '0001',
        markdown: '本文😀',
        authorId: 'owner',
        idempotencyKey: randomUUID(),
      }),
    );
  const volume = (await create('volume', null, 'Volume')).document;
  const chapter = (await create('chapter', volume.id, 'Chapter')).document;
  const scene = (await create('scene', chapter.id, 'Scene')).document;
  const reader = await core.reader(p.id);
  const chapterPath = `plot/volumes/${volume.id}/chapters/${chapter.id}/chapter.yaml`;
  const scenePath = `plot/volumes/${volume.id}/chapters/${chapter.id}/scenes/${scene.id}.yaml`;
  const chapterMeta = YAML.parse((await reader.read(chapterPath))!.content);
  const sceneFile = await reader.read(scenePath);
  assert.ok(sceneFile);
  const sceneMeta = YAML.parse(sceneFile.content);
  assert.equal(chapterMeta.volume, volume.id);
  assert.equal(sceneMeta.volume, volume.id);
  assert.equal(sceneMeta.chapter, chapter.id);
  assert.equal(sceneMeta.manuscript, `documents/${scene.id}.md`);
  const nativeScene = reader.nativeStoryDocuments?.find(document => document.id === scene.id);
  assert.deepEqual(
    {
      id: nativeScene?.id,
      kind: nativeScene?.kind,
      title: nativeScene?.title,
      orderKey: nativeScene?.orderKey,
      metadataPath: nativeScene?.metadataPath,
    },
    {
      id: scene.id,
      kind: 'scene',
      title: 'Scene',
      orderKey: scene.orderKey,
      metadataPath: scenePath,
    },
  );
  assert.equal(nativeScene?.metadataContent, sceneFile.content);
  assert.equal(nativeScene?.metadataRevision, createHash('sha256').update(sceneFile.content).digest('hex'));
  assert.equal(reader.nativeStoryDocuments?.length, 3);
  const historical = await core.reader(p.id, reader.snapshot);
  assert.deepEqual(
    historical.nativeStoryDocuments,
    reader.nativeStoryDocuments,
    'pinned typed projections retain the exact historical Story identity',
  );
  assert.equal((await reader.read(sceneMeta.manuscript))?.content, '本文😀');
  assert.equal(
    (await reader.read(sceneMeta.manuscript))?.documentKind,
    'scene',
    'native scene body reads expose their canonical PostgreSQL document kind',
  );
  assert.equal((await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes[0]?.id, scene.id);
});

test('mapped hierarchy preserves logical IDs and ignores conflicting stored parent metadata', async () => {
  const p = await hierarchy();
  const first = await core.reader(p.id);
  const path = 'plot/volumes/v1/chapters/c1/scenes/s1.yaml';
  const before = (await first.read(path))!;
  const meta = YAML.parse(before.content);
  assert.equal(meta.volume, 'v1');
  assert.equal(meta.chapter, 'c1');
  await accept(
    p.id,
    operation(first.snapshot, path, YAML.stringify({ ...meta, volume: 'unrelated', chapter: 'unrelated' }), before.revision),
  );
  const next = await core.reader(p.id);
  const actual = YAML.parse((await next.read(path))!.content);
  assert.equal(actual.volume, 'v1');
  assert.equal(actual.chapter, 'c1');
  assert.equal(actual.id, 's1');
  assert.equal(actual.manuscript, 'manuscript/v1/c1/s1.md');
  assert.equal(YAML.parse((await next.read('plot/volumes/v1/chapters/c1/chapter.yaml'))!.content).volume, 'v1');
  assert.equal(YAML.parse((await first.read(path))!.content).chapter, 'c1');
});

test('immutable pinned readers preserve exact manuscript bytes and hashes across edits and Core restart', async () => {
  const p = await hierarchy();
  const reader = await core.reader(p.id);
  const path = 'manuscript/v1/c1/s1.md';
  const bytes = Buffer.from('Text 😀\n', 'utf8');
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  const original = await reader.read(path);
  assert.ok(original);
  assert.equal(original.content, 'Text 😀\n');
  assert.equal(original.revision, expectedHash);
  const originalHead = await persistence.read(async tx => {
    const scene = (await tx.listDocuments(p.id)).find(document => document.kind === 'scene')!;
    return tx.getRevision(p.id, scene.id, scene.headRevisionId!);
  });
  assert.equal(originalHead?.sha256, expectedHash);
  const receipt = await accept(p.id, operation(reader.snapshot, path, 'Changed', original.revision));
  assert.deepEqual(receipt.revisions, [{ path, revision: createHash('sha256').update('Changed').digest('hex') }]);
  const restarted = new CoreStore({ persistence });
  const pinned = await restarted.reader(p.id, reader.snapshot);
  assert.deepEqual(await pinned.read(path, 'base64'), { ...original, content: bytes.toString('base64') });
  assert.deepEqual(await pinned.listRevisions?.(path), [{ path, revision: expectedHash }]);
  assert.equal((await core.readScene(p.id, 's1')).text, 'Changed');
});
test('pinned Knowledge projection retains original identity and anchored quote after Knowledge and body edits', async () => {
  const p = await hierarchy(),
    documents = await persistence.read(r => r.listDocuments(p.id)),
    scene = documents.find(document => document.kind === 'scene')!,
    revision = scene.headRevisionId!;
  const nodeId = randomUUID() as import('@codexia/persistence-contracts').KnowledgeNodeId,
    evidenceId = randomUUID() as import('@codexia/persistence-contracts').EvidenceId;
  await persistence.transaction(async tx => {
    await tx.saveKnowledgeNode({
      projectId: p.id,
      id: nodeId,
      type: 'lore',
      name: 'Original clue',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    await tx.saveEvidenceAnchor({
      projectId: p.id,
      id: evidenceId,
      documentId: scene.id,
      revisionId: revision,
      fromUtf16: 0,
      toUtf16: 'Text 😀\n'.length,
      quoteSha256: createHash('sha256').update('Text 😀\n').digest('hex'),
      status: 'confirmed',
      expectedVersion: null,
    });
    await tx.saveMentionLink({
      projectId: p.id,
      evidenceId,
      nodeId,
      status: 'confirmed',
      source: 'author',
      confidence: 1,
      extractorVersion: null,
    });
  });
  const pinned = await core.reader(p.id);
  const original = pinned.knowledge;
  assert.ok(original);
  assert.equal(await pinned.read('meta/scriptorium/knowledge-context/v1.json'), null);
  await persistence.transaction(tx =>
    tx.saveKnowledgeNode({
      projectId: p.id,
      id: nodeId,
      type: 'lore',
      name: 'Edited clue',
      attributes: {},
      status: 'confirmed',
      expectedVersion: 1,
    }),
  );
  const knowledgeEdited = await core.reader(p.id),
    manuscriptPath = 'manuscript/v1/c1/s1.md',
    body = (await knowledgeEdited.read(manuscriptPath))!;
  await accept(p.id, operation(knowledgeEdited.snapshot, manuscriptPath, 'Edited manuscript', body.revision));
  const currentReader = await core.reader(p.id);
  const current = currentReader.knowledge;
  assert.ok(current);
  assert.deepEqual(original.source.snapshot, pinned.snapshot);
  assert.deepEqual(current.source.snapshot, currentReader.snapshot);
  assert.notEqual(current.source.revision, original.source.revision);
  assert.equal(original.entries[0]?.node.name, 'Original clue');
  assert.equal(original.entries[0]?.evidence[0]?.quote, 'Text 😀\n');
  assert.equal(current.entries[0]?.node.name, 'Edited clue');
  assert.notEqual(current.entries[0]?.evidence[0]?.anchor.revisionId, revision);
  assert.equal(
    current.entries[0]?.evidence[0]?.quote,
    'Edited manuscript',
    'the current snapshot resolves only the new exact anchor quote',
  );
  assert.equal(current.entries[0]?.evidence[0]?.current, true);
  assert.deepEqual((await new CoreStore({ persistence }).reader(p.id, pinned.snapshot)).knowledge, original);
});

test('Knowledge proposal scope binds the exact projection without a global version fence', async () => {
  const p = await project();
  const reader = await core.reader(p.id);
  const revision = reader.knowledge?.source.revision;
  const other = (await core.reader((await project()).id)).knowledge;
  assert.ok(revision && other);
  const first = { ...operation(reader.snapshot, 'bible/first.yaml', 'Retain unrelated edits'), readKnowledgeRevision: revision };
  const invalid = { ...first, readKnowledgeRevision: other.source.revision };
  await assert.rejects(approve(p.id, { operation: invalid, snapshot: reader.snapshot }), { code: 'scope_conflict' });
  await approve(p.id, { operation: first, snapshot: reader.snapshot });
  await assert.rejects(core.apply(p.id, invalid), { code: 'operation_not_approved' });
  await persistence.transaction(tx =>
    tx.updateProject({
      projectId: p.id,
      expectedVersion: reader.snapshot.projectVersion,
      title: 'Unrelated project title',
    }),
  );
  const current = await core.reader(p.id);
  assert.notEqual(current.snapshot.projectVersion, reader.snapshot.projectVersion);
  assert.equal(current.knowledge?.source.revision, revision);
  const second = { ...operation(current.snapshot, 'bible/second.yaml', 'Do not apply stale Knowledge'), readKnowledgeRevision: revision };
  await approve(p.id, { operation: second, snapshot: current.snapshot });
  await core.apply(p.id, first);
  await persistence.transaction(tx =>
    tx.saveKnowledgeNode({
      projectId: p.id,
      id: randomUUID() as import('@codexia/persistence-contracts').KnowledgeNodeId,
      type: 'lore',
      name: 'Changed evidence scope',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    }),
  );
  await assert.rejects(core.apply(p.id, second), { code: 'scope_conflict' });
  const latest = await core.reader(p.id);
  assert.equal((await latest.read('bible/first.yaml'))?.content, 'Retain unrelated edits');
  assert.equal(await latest.read('bible/second.yaml'), null);
});
test('proposal approval binds exact payload and durable replay receipts', async () => {
  const p = await project(),
    reader = await core.reader(p.id),
    op = operation(reader.snapshot, 'bible/notes.yaml', 'name: A\n');
  await assert.rejects(core.apply(p.id, op), /approved/);
  const receipt = await accept(p.id, op);
  assert.deepEqual(await core.apply(p.id, op), receipt);
  await assert.rejects(core.apply(p.id, { ...op, writes: [{ ...op.writes[0]!, content: 'forged' }] }), /approved/);
  assert.equal((await new CoreStore({ persistence }).listProposals(p.id))[0]?.state, 'applied');
});
test('duplicate proposal identities reject changed envelopes', async () => {
  const p = await project(),
    reader = await core.reader(p.id),
    op = operation(reader.snapshot, 'bible/a.yaml', 'A');
  const proposal: ChangeProposal = { id: randomUUID(), snapshot: reader.snapshot, operations: [op], source: 'author' };
  await core.propose(p.id, proposal);
  assert.deepEqual(await core.propose(p.id, proposal), proposal);
  await assert.rejects(core.propose(p.id, { ...proposal, source: 'module' }), /different payload/);
});
test('proposal registration and approval preserve content project version', async () => {
  const p = await project(),
    snapshot = (await core.observe(p.id)).snapshot,
    op = operation(snapshot, 'bible/a.yaml', 'A'),
    proposal: ChangeProposal = { id: randomUUID(), snapshot, operations: [op], source: 'author' };
  await core.propose(p.id, proposal);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [op.id], authorScope: 'owner' });
  assert.deepEqual((await core.observe(p.id)).snapshot, snapshot);
  await core.apply(p.id, op);
  assert.equal((await core.observe(p.id)).snapshot.projectVersion, snapshot.projectVersion + 1);
});
test('unapproved and cross-project operations cannot change canonical records', async () => {
  const p = await project(),
    other = await project(),
    reader = await core.reader(p.id),
    op = operation(reader.snapshot, 'bible/a.yaml', 'A');
  await assert.rejects(core.apply(other.id, op), /another project/);
  await assert.rejects(core.reader(other.id, reader.snapshot), /another project/);
  await assert.rejects(core.approve(p.id, { proposalId: randomUUID(), operationIds: [op.id], authorScope: 'owner' }), /not found/);
  assert.equal(await (await core.reader(p.id)).read('bible/a.yaml'), null);
});
test('stale proposal cannot overwrite a newer canonical body', async () => {
  const p = await hierarchy(),
    reader = await core.reader(p.id),
    path = 'manuscript/v1/c1/s1.md',
    old = await reader.read(path),
    a = operation(reader.snapshot, path, 'A', old!.revision),
    b = operation(reader.snapshot, path, 'B', old!.revision);
  const proposal: ChangeProposal = { id: randomUUID(), snapshot: reader.snapshot, operations: [b], source: 'author' };
  await core.propose(p.id, proposal);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [b.id], authorScope: 'owner' });
  await accept(p.id, a);
  await assert.rejects(core.apply(p.id, b));
  assert.equal((await core.readScene(p.id, 's1')).text, 'A');
});
test('disjoint operations approved together can apply in sequence', async () => {
  const p = await project(),
    reader = await core.reader(p.id),
    a = operation(reader.snapshot, 'bible/a.yaml', 'A'),
    b = operation(reader.snapshot, 'bible/b.yaml', 'B'),
    proposal: ChangeProposal = { id: randomUUID(), snapshot: reader.snapshot, operations: [a, b], source: 'author' };
  await core.propose(p.id, proposal);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [a.id, b.id], authorScope: 'owner' });
  await core.apply(p.id, a);
  await core.apply(p.id, b);
  assert.equal((await (await core.reader(p.id)).read('bible/b.yaml'))?.content, 'B');
});
test('binary module artifacts preserve exact bytes and metadata-backed revisions', async () => {
  const p = await project(),
    reader = await core.reader(p.id),
    op = operation(reader.snapshot, 'assets/image.bin', Buffer.from([0, 255, 128, 32]).toString('base64'));
  op.writes[0]!.encoding = 'base64';
  await accept(p.id, op);
  const next = await core.reader(p.id);
  assert.equal((await next.read('assets/image.bin', 'base64'))?.content, op.writes[0]!.content);
  assert.deepEqual(await next.listRevisions!('assets'), [
    { path: 'assets/image.bin', revision: (await next.read('assets/image.bin'))!.revision },
  ]);
});
test('approved operations cannot change preserved module artifacts, and applied receipts remain replayable', async () => {
  const p = await project();
  const archivePath = 'meta/scriptorium/modules/story/legacy/files/bible/locations/harbor.yaml';
  const livePath = 'meta/scriptorium/modules/story/locations/harbor.yaml';
  const preserved = 'id: harbor\nname: Preserved harbor\n';
  await persistence.transaction(tx =>
    tx.saveModuleRecord({
      projectId: p.id,
      moduleId: 'core.artifacts',
      key: archivePath,
      value: { content: preserved, encoding: 'utf8' },
      expectedVersion: null,
    }),
  );
  const reader = await core.reader(p.id);
  const { snapshot } = reader;
  const prior = await reader.read(archivePath);
  assert.ok(prior);
  const readArtifact = (path: string) => persistence.read(source => source.getModuleRecord(p.id, 'core.artifacts', path));
  const before = await readArtifact(archivePath);
  for (const [path, content, revision] of [
    [archivePath, 'replacement', prior.revision],
    [archivePath, null, prior.revision],
    ['meta/scriptorium/modules/nlp/legacy/files/new.txt', 'new archive', null],
  ] as const) {
    const pending = operation(snapshot, path, content, revision);
    pending.reads.unshift({ path: livePath, revision: null });
    pending.writes.unshift({ path: livePath, revision: null, content: 'live edit' });
    const proposal = await approve(p.id, { snapshot, operation: pending });
    await assert.rejects(core.apply(p.id, pending), { status: 409, code: 'preservation_archive_read_only' });
    assert.equal(await readArtifact(livePath), undefined);
    assert.deepEqual(await readArtifact(archivePath), before);
    if (path !== archivePath) assert.equal(await readArtifact(path), undefined);
    assert.equal((await core.getProposal(p.id, proposal.id))?.state, 'approved');
    assert.deepEqual((await core.getProposal(p.id, proposal.id))?.applications, []);
    assert.deepEqual((await core.observe(p.id)).snapshot, snapshot);
  }

  const archived = operation(snapshot, archivePath, preserved, prior.revision);
  const proposal = await approve(p.id, { snapshot, operation: archived });
  const authority = 'core.authority.proposals';
  const key = `proposal:${proposal.id}`;
  const record = await persistence.read(source => source.getModuleRecord(p.id, authority, key));
  assert.ok(record);
  const receipt = {
    operationId: archived.id,
    generation: archived.generation,
    projectVersion: snapshot.projectVersion,
    revisions: [{ path: archivePath, revision: prior.revision }],
  };
  const applied = await persistence.transaction(tx =>
    tx.saveModuleRecord({
      projectId: p.id,
      moduleId: authority,
      key,
      expectedVersion: record.version,
      value: { ...record.value, state: 'applied', appliedOperationIds: [archived.id], applications: [receipt] },
    }),
  );
  assert.deepEqual(await core.apply(p.id, archived), receipt);
  assert.deepEqual(await persistence.read(source => source.getModuleRecord(p.id, authority, key)), applied);
  assert.deepEqual(await readArtifact(archivePath), before);
  await accept(p.id, operation(snapshot, livePath, 'live edit'));
  assert.equal((await readArtifact(livePath))?.value.content, 'live edit');
});
test('retired settings file writes require a new proposal and retain applied receipts', async t => {
  const oldSettings = [
    { path: 'meta/scriptorium/modules/publishing/episodes.yaml', content: 'episodes: []\n', code: 'publishing_reproposal_required' },
    { path: 'meta/project.yaml', content: 'title: New project title\n', code: 'project_settings_reproposal_required' },
    {
      path: 'meta/scriptorium/modules/nlp/feature-settings.json',
      content: '{"externalEnabled":{}}',
      code: 'nlp_feature_settings_reproposal_required',
    },
  ] as const;
  for (const { path, content, code } of oldSettings)
    await t.test(path, async () => {
      const p = await project();
      const { snapshot } = await core.observe(p.id);
      const change = operation(snapshot, path, content);
      const proposal: ChangeProposal = { id: randomUUID(), snapshot, operations: [change], source: 'author' };
      await assert.rejects(core.propose(p.id, proposal), { code });
      const key = `proposal:${proposal.id}`;
      const authority = 'core.authority.proposals';
      const approvedOperationIds = [change.id];
      const legacy = await persistence.transaction(tx =>
        tx.saveModuleRecord({
          projectId: p.id,
          moduleId: authority,
          key,
          expectedVersion: null,
          value: {
            proposal,
            state: 'approved',
            approvedOperationIds,
            approvedBy: 'author',
            applications: [],
            appliedOperationIds: [],
            stale: false,
          } as unknown as import('@codexia/persistence-contracts').JsonObject,
        }),
      );
      await assert.rejects(core.apply(p.id, change), { code });
      assert.deepEqual(await persistence.read(reader => reader.getModuleRecord(p.id, authority, key)), legacy);
      assert.equal(await persistence.read(reader => reader.getModuleRecord(p.id, 'core.artifacts', path)), undefined);
      assert.deepEqual(await persistence.read(reader => reader.getProject(p.id)), p);
      const receipt = {
        operationId: change.id,
        generation: change.generation,
        projectVersion: snapshot.projectVersion,
        revisions: [{ path, revision: createHash('sha256').update(content).digest('hex') }],
      };
      const applied = await persistence.transaction(tx =>
        tx.saveModuleRecord({
          projectId: p.id,
          moduleId: authority,
          key,
          expectedVersion: legacy.version,
          value: { ...legacy.value, state: 'applied', applications: [receipt], appliedOperationIds: approvedOperationIds },
        }),
      );
      assert.deepEqual(await core.apply(p.id, change), receipt);
      assert.deepEqual(await persistence.read(reader => reader.getModuleRecord(p.id, authority, key)), applied);
    });
});

test('search and writing statistics share immutable Unicode-aware scene data', async () => {
  const p = await hierarchy(),
    reader = await core.reader(p.id),
    search = await core.searchSnapshot(p.id, '😀', 20, reader.snapshot),
    stats = await core.writingStatsSnapshot(p.id, reader.snapshot);
  assert.equal(search.results[0]?.offset, 5);
  assert.equal(stats.stats.totalCharCount, 5);
  assert.deepEqual(stats.snapshot, search.snapshot);
});
test('recursive deletion after native reorder preserves manuscript revision history', async () => {
  const p = await hierarchy();
  await createHierarchy(p.id, {
    kind: 'scene',
    id: 's2',
    title: 'Second',
    volumeId: 'v1',
    chapterId: 'c1',
    manuscriptBody: 'Second',
  });
  await applyReorder(await approveReorder(p.id, { kind: 'scene', volumeId: 'v1', chapterId: 'c1', orderedIds: ['s2', 's1'] }));
  assert.deepEqual(
    (await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes.map(scene => scene.id),
    ['s2', 's1'],
  );
  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const scene = documents.find(document => document.title === 'Scene')!;
  await applyNativeChangeSet(await approveDelete(p.id, { kind: 'volume', id: 'v1' }));
  assert.equal((await core.tree(p.id)).volumes.length, 0);
  assert.equal((await persistence.read(reader => reader.getRevision(p.id, scene.id, scene.headRevisionId!)))?.markdown, 'Text 😀\n');
});
test('scene reorder rejects a chapter that belongs to a different volume', async () => {
  const p = await hierarchy();
  await createHierarchy(p.id, { kind: 'volume', id: 'v2', title: 'Other volume' });
  await assert.rejects(
    proposeReorder(p.id, {
      kind: 'scene',
      volumeId: 'v2',
      chapterId: 'c1',
      orderedIds: ['s1'],
    }),
    (error: unknown) => error instanceof CoreError && error.code === 'invalid_hierarchy_parent',
  );
  assert.deepEqual(
    (await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes.map(scene => scene.id),
    ['s1'],
  );
});
test('PostgreSQL append keys preserve creation order across digit boundaries and reordered siblings', async () => {
  const p = await project();
  const create = (input: Parameters<typeof core.proposeHierarchyCreate>[1]) => createHierarchy(p.id, input);
  const volumeIds = Array.from({ length: 10 }, (_, index) => `volume-${index + 1}`);
  for (const [index, id] of volumeIds.entries()) await create({ kind: 'volume', id, title: `Volume ${index + 1}` });
  const chapterIds = Array.from({ length: 10 }, (_, index) => `chapter-${index + 1}`);
  for (const [index, id] of chapterIds.entries())
    await create({
      kind: 'chapter',
      id,
      title: `Chapter ${index + 1}`,
      volumeId: volumeIds[0]!,
    });
  const sceneIds = Array.from({ length: 10 }, (_, index) => `scene-${index + 1}`);
  for (const [index, id] of sceneIds.entries())
    await create({
      kind: 'scene',
      id,
      title: `Scene ${index + 1}`,
      volumeId: volumeIds[0]!,
      chapterId: chapterIds[0]!,
    });

  const before = await persistence.read(reader => reader.listDocuments(p.id));
  assert.deepEqual(
    (await core.tree(p.id)).volumes.map(volume => volume.id),
    volumeIds,
  );
  assert.deepEqual(
    (await core.tree(p.id)).volumes[0]?.chapters.map(chapter => chapter.id),
    chapterIds,
  );
  assert.deepEqual(
    (await core.tree(p.id)).volumes[0]?.chapters[0]?.scenes.map(scene => scene.id),
    sceneIds,
  );
  assert.equal(before.find(document => document.kind === 'volume' && document.title === 'Volume 10')?.orderKey, '0000000010');
  assert.equal(before.find(document => document.kind === 'chapter' && document.title === 'Chapter 10')?.orderKey, '0000000010');
  assert.equal(before.find(document => document.kind === 'scene' && document.title === 'Scene 10')?.orderKey, '0000000010');

  await applyReorder(await approveReorder(p.id, { kind: 'volume', orderedIds: [...volumeIds].reverse() }));
  const beforeAppend = await persistence.read(reader => reader.listDocuments(p.id));
  const oldVolumeKeys = new Map(
    beforeAppend.filter(document => document.kind === 'volume').map(document => [document.title, document.orderKey]),
  );
  await create({ kind: 'volume', id: 'volume-11', title: 'Volume 11' });
  const afterAppend = await persistence.read(reader => reader.listDocuments(p.id));
  for (const document of afterAppend.filter(document => document.kind === 'volume' && document.title !== 'Volume 11')) {
    assert.equal(document.orderKey, oldVolumeKeys.get(document.title), 'append does not rewrite existing order keys');
  }
  assert.equal(afterAppend.find(document => document.kind === 'volume' && document.title === 'Volume 11')?.orderKey, '0000000010');
  assert.deepEqual(
    (await core.tree(p.id)).volumes.map(volume => volume.id),
    [...volumeIds].reverse().concat('volume-11'),
  );
});
test('reordering a moved scene preserves its authoritative PostgreSQL parent', async () => {
  const p = await hierarchy();
  await createHierarchy(p.id, {
    kind: 'chapter',
    id: 'c2',
    title: 'Second chapter',
    volumeId: 'v1',
  });
  await createHierarchy(p.id, {
    kind: 'scene',
    id: 's2',
    title: 'Second scene',
    volumeId: 'v1',
    chapterId: 'c2',
  });

  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const scene = documents.find(document => document.kind === 'scene' && document.title === 'Scene')!;
  const chapter = documents.find(document => document.kind === 'chapter' && document.id !== scene.parentId)!;
  await persistence.transaction(tx =>
    tx.updateDocument({
      projectId: p.id,
      documentId: scene.id,
      parentId: chapter.id,
      expectedVersion: scene.version,
    }),
  );

  const reorder = await approveReorder(p.id, {
    kind: 'scene',
    volumeId: 'v1',
    chapterId: 'c2',
    orderedIds: ['s1', 's2'],
  });
  await applyReorder(reorder);
  const after = await persistence.read(reader => reader.getDocument(p.id, scene.id));
  assert.equal(after?.parentId, chapter.id);
  assert.deepEqual(
    (await core.tree(p.id)).volumes[0]?.chapters.find(item => item.id === 'c2')?.scenes.map(item => item.id),
    ['s1', 's2'],
  );
});

test('hierarchy create resolves a moved chapter by its current PostgreSQL parent', async () => {
  const p = await hierarchy();
  await createHierarchy(p.id, { kind: 'volume', id: 'v2', title: 'Volume 2' });
  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const volume = documents.find(document => document.kind === 'volume' && document.title === 'Volume 2')!;
  const chapter = documents.find(document => document.kind === 'chapter')!;
  await persistence.transaction(tx =>
    tx.updateDocument({
      projectId: p.id,
      documentId: chapter.id,
      parentId: volume.id,
      expectedVersion: chapter.version,
    }),
  );

  await createHierarchy(p.id, {
    kind: 'scene',
    id: 'moved-child',
    title: 'Added after move',
    volumeId: 'v2',
    chapterId: 'c1',
    manuscriptBody: 'New text',
  });
  const scene = (await persistence.read(reader => reader.listDocuments(p.id))).find(document => document.title === 'Added after move')!;
  assert.equal(scene.parentId, chapter.id);
  assert.equal((await core.readScene(p.id, 'moved-child')).text, 'New text');
});

test('hierarchy create rejects a chapter moved after proposal construction', async () => {
  const p = await hierarchy();
  await createHierarchy(p.id, { kind: 'volume', id: 'v2', title: 'Volume 2' });
  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const volume = documents.find(document => document.kind === 'volume' && document.title === 'Volume 2')!;
  const chapter = documents.find(document => document.kind === 'chapter')!;
  await persistence.transaction(tx =>
    tx.updateDocument({
      projectId: p.id,
      documentId: chapter.id,
      parentId: volume.id,
      expectedVersion: chapter.version,
    }),
  );
  const { changeSet: addition } = await proposeCreate(p.id, {
    kind: 'scene',
    id: 'stale-child',
    title: 'Must not be added',
    volumeId: 'v2',
    chapterId: 'c1',
  });
  const approved = await persistence.transaction(tx =>
    tx.approveChangeSet({
      projectId: p.id,
      changeSetId: addition.id,
      expectedVersion: addition.version,
      approvedBy: 'author',
    }),
  );
  await persistence.transaction(tx =>
    tx.updateDocument({
      projectId: p.id,
      documentId: chapter.id,
      parentId: documents.find(document => document.kind === 'volume')!.id,
      expectedVersion: chapter.version + 1,
    }),
  );
  await assert.rejects(
    applyNativeChangeSet(approved),
    (error: unknown) =>
      error instanceof PersistenceError && error.code === 'conflict' && error.details?.resource === 'hierarchy_parent_changed',
  );
  assert.equal(
    (await persistence.read(reader => reader.listDocuments(p.id))).some(document => document.title === 'Must not be added'),
    false,
  );
});

test('hierarchy delete validates the requested parent at proposal and apply time', async () => {
  const p = await hierarchy();
  await createHierarchy(p.id, { kind: 'volume', id: 'v2', title: 'Volume 2' });
  let documents = await persistence.read(reader => reader.listDocuments(p.id));
  const volumeA = documents.find(document => document.kind === 'volume')!;
  const volumeB = documents.find(document => document.kind === 'volume' && document.title === 'Volume 2')!;
  const chapter = documents.find(document => document.kind === 'chapter')!;
  const scene = documents.find(document => document.kind === 'scene')!;
  await persistence.transaction(tx =>
    tx.updateDocument({
      projectId: p.id,
      documentId: chapter.id,
      parentId: volumeB.id,
      expectedVersion: chapter.version,
    }),
  );
  await assert.rejects(
    proposeDelete(p.id, { kind: 'chapter', id: 'c1', volumeId: 'v1' }),
    (error: unknown) => error instanceof CoreError && error.code === 'hierarchy_parent_changed',
  );
  const chapterDelete = await approveDelete(p.id, { kind: 'chapter', id: 'c1', volumeId: 'v2' });
  await persistence.transaction(tx =>
    tx.updateDocument({
      projectId: p.id,
      documentId: chapter.id,
      parentId: volumeA.id,
      expectedVersion: chapter.version + 1,
    }),
  );
  await assert.rejects(applyNativeChangeSet(chapterDelete), { code: 'conflict' });

  documents = await persistence.read(reader => reader.listDocuments(p.id));
  const chapterA = documents.find(document => document.kind === 'chapter')!;
  await createHierarchy(p.id, {
    kind: 'chapter',
    id: 'c2',
    title: 'Chapter 2',
    volumeId: 'v2',
  });
  const chapterB = (await persistence.read(reader => reader.listDocuments(p.id))).find(document => document.title === 'Chapter 2')!;
  await persistence.transaction(tx =>
    tx.updateDocument({
      projectId: p.id,
      documentId: scene.id,
      parentId: chapterB.id,
      expectedVersion: scene.version,
    }),
  );
  await assert.rejects(
    proposeDelete(p.id, {
      kind: 'scene',
      id: 's1',
      volumeId: 'v2',
      chapterId: 'c1',
    }),
    (error: unknown) => error instanceof CoreError && error.code === 'hierarchy_parent_changed',
  );
  const sceneDelete = await approveDelete(p.id, {
    kind: 'scene',
    id: 's1',
    volumeId: 'v2',
    chapterId: 'c2',
  });
  await persistence.transaction(tx =>
    tx.updateDocument({
      projectId: p.id,
      documentId: scene.id,
      parentId: chapterA.id,
      expectedVersion: scene.version + 1,
    }),
  );
  await assert.rejects(applyNativeChangeSet(sceneDelete), { code: 'conflict' });

  await applyNativeChangeSet(
    await approveDelete(p.id, {
      kind: 'scene',
      id: 's1',
      volumeId: 'v1',
      chapterId: 'c1',
    }),
  );
  assert.equal(
    (await persistence.read(reader => reader.listDocuments(p.id))).some(document => document.id === scene.id),
    false,
  );
  await applyNativeChangeSet(
    await approveDelete(p.id, {
      kind: 'chapter',
      id: 'c1',
      volumeId: 'v1',
    }),
  );
  assert.equal(
    (await persistence.read(reader => reader.listDocuments(p.id))).some(document => document.id === chapter.id),
    false,
  );
});

test('approved reorder rejects a changed sibling set atomically', async () => {
  const p = await hierarchy();
  await createHierarchy(p.id, {
    kind: 'scene',
    id: 's2',
    title: 'Second',
    volumeId: 'v1',
    chapterId: 'c1',
  });
  const reorder = await approveReorder(p.id, {
    kind: 'scene',
    volumeId: 'v1',
    chapterId: 'c1',
    orderedIds: ['s2', 's1'],
  });
  await createHierarchy(p.id, {
    kind: 'scene',
    id: 's3',
    title: 'Third',
    volumeId: 'v1',
    chapterId: 'c1',
  });
  const before = await persistence.read(reader => reader.listDocuments(p.id));
  await assert.rejects(applyReorder(reorder), /sibling set changed/);
  const after = await persistence.read(reader => reader.listDocuments(p.id));
  assert.deepEqual(
    after.map(document => [document.id, document.parentId, document.orderKey]),
    before.map(document => [document.id, document.parentId, document.orderKey]),
  );
});

test('approved reorder detects a sibling moved in from another compatibility path', async () => {
  const p = await hierarchy();
  await createHierarchy(p.id, {
    kind: 'chapter',
    id: 'c2',
    title: 'Second chapter',
    volumeId: 'v1',
  });
  await createHierarchy(p.id, {
    kind: 'scene',
    id: 's2',
    title: 'Second',
    volumeId: 'v1',
    chapterId: 'c2',
  });
  await createHierarchy(p.id, {
    kind: 'scene',
    id: 's4',
    title: 'Fourth',
    volumeId: 'v1',
    chapterId: 'c2',
  });
  await createHierarchy(p.id, {
    kind: 'scene',
    id: 's3',
    title: 'Third',
    volumeId: 'v1',
    chapterId: 'c1',
  });

  const reorder = await approveReorder(p.id, {
    kind: 'scene',
    volumeId: 'v1',
    chapterId: 'c2',
    orderedIds: ['s4', 's2'],
  });
  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  const moved = documents.find(document => document.kind === 'scene' && document.title === 'Third')!;
  const destination = documents.find(document => document.kind === 'chapter' && document.title === 'Second chapter')!;
  await persistence.transaction(tx =>
    tx.updateDocument({
      projectId: p.id,
      documentId: moved.id,
      parentId: destination.id,
      expectedVersion: moved.version,
    }),
  );
  const staleParentPath = 'plot/volumes/v1/chapters/c1/scenes/s3.yaml';
  assert.ok(await (await core.reader(p.id)).read(staleParentPath));

  const before = await persistence.read(reader => reader.listDocuments(p.id));
  await assert.rejects(applyReorder(reorder), /sibling set changed/);
  const after = await persistence.read(reader => reader.listDocuments(p.id));
  assert.deepEqual(
    after.map(document => [document.id, document.parentId, document.orderKey]),
    before.map(document => [document.id, document.parentId, document.orderKey]),
  );
});

test('legacy reorders without sibling preconditions require a new proposal and preserve prior receipts', async t => {
  for (const state of ['current', 'stale', 'applied'] as const) {
    await t.test(state, async () => {
      const p = await hierarchy();
      const reader = await core.reader(p.id);
      const path = 'plot/volumes/v1/chapters/c1/scenes/s1.yaml';
      const file = await reader.read(path);
      assert.ok(file);
      const reorder: ChangeOperation = {
        ...operation(reader.snapshot, path, 'id: s1\ntitle: Scene\norder: "0000000000"\n', file.revision),
        effect: 'structure',
        message: 'Reorder hierarchy',
      };
      const proposal = await approve(p.id, { operation: reorder, snapshot: reader.snapshot });
      const authority = 'core.authority.proposals';
      const key = `proposal:${proposal.id}`;
      const readRecord = () => persistence.read(source => source.getModuleRecord(p.id, authority, key));
      const readDocuments = () => persistence.read(source => source.listDocuments(p.id));
      if (state === 'stale') {
        await persistence.transaction(tx =>
          tx.updateProject({
            projectId: p.id,
            expectedVersion: reader.snapshot.projectVersion,
            title: 'Later project title',
          }),
        );
      }
      if (state === 'applied') {
        const record = await readRecord();
        assert.ok(record);
        const receipt = {
          operationId: reorder.id,
          generation: reorder.generation,
          projectVersion: reader.snapshot.projectVersion + 1,
          revisions: [{ path, revision: createHash('sha256').update(reorder.writes[0]!.content!).digest('hex') }],
        };
        await persistence.transaction(tx =>
          tx.saveModuleRecord({
            projectId: p.id,
            moduleId: authority,
            key,
            expectedVersion: record.version,
            value: { ...record.value, state: 'applied', appliedOperationIds: [reorder.id], applications: [receipt] },
          }),
        );
        const beforeReplay = await readRecord();
        const before = await readDocuments();
        assert.deepEqual((await core.getProposal(p.id, proposal.id))?.applications, [receipt]);
        assert.deepEqual(await core.apply(p.id, reorder), receipt);
        assert.deepEqual(await readRecord(), beforeReplay);
        assert.deepEqual(await readDocuments(), before);
        return;
      }
      const before = await readDocuments();
      const record = await readRecord();
      await assert.rejects(core.apply(p.id, reorder), { status: 409, code: 'hierarchy_reproposal_required' });
      assert.deepEqual(await readDocuments(), before);
      assert.deepEqual(await readRecord(), record);
    });
  }
});
test('native manuscript restore requires approval, appends an attributed revision, and replays exactly', async () => {
  const p = await project();
  const originalText = '元の本文 😀\n';
  const currentText = '保存済みの改稿\n';
  const createScene = (title: string) =>
    persistence.transaction(tx =>
      tx.createDocument({
        projectId: p.id,
        kind: 'scene',
        title,
        orderKey: '1',
        markdown: originalText,
        authorId: 'author',
        idempotencyKey: randomUUID(),
      }),
    );
  const original = await createScene('Original manuscript');
  const other = await createScene('A different manuscript');
  const olderSnapshot = (await core.reader(p.id)).snapshot;
  const documentId = original.document.id;
  const save = (baseRevisionId: typeof original.revision.id, prior: string, markdown: string) =>
    persistence.transaction(tx =>
      tx.saveDocument({
        projectId: p.id,
        documentId,
        baseRevisionId,
        authorId: 'author',
        clientId: 'testing',
        idempotencyKey: randomUUID(),
        changes: [{ fromUtf16: 0, toUtf16: prior.length, insert: markdown }],
        resultingSha256: createHash('sha256').update(markdown).digest('hex'),
      }),
    );
  const current = await save(original.revision.id, originalText, currentText);
  const input = { documentId, baseRevisionId: current.revision.id, sourceRevisionId: original.revision.id };
  const options = {
    actorId: 'external-proposer',
    idempotencyKey: randomUUID(),
    origin: 'external-agent',
    snapshot: (await core.reader(p.id)).snapshot,
  } as const;
  await assert.rejects(() => core.proposeManuscriptRestore(p.id, input, { ...options, snapshot: olderSnapshot }), {
    code: 'revision_conflict',
  });
  await assert.rejects(() => core.proposeManuscriptRestore(p.id, { ...input, sourceRevisionId: other.revision.id }, options), {
    code: 'revision_not_found',
  });
  await assert.rejects(() => core.proposeManuscriptRestore(p.id, { ...input, baseRevisionId: original.revision.id }, options), {
    code: 'revision_conflict',
  });
  assert.deepEqual(await persistence.read(reader => reader.listChangeSets(p.id)), []);

  const propose = () => core.proposeManuscriptRestore(p.id, input, options);
  const { changeSet, replayed } = await propose();
  assert.equal(replayed, false);
  assert.equal(changeSet.authorId, 'external-proposer');
  assert.equal(changeSet.provenance.details.origin, 'external-agent');
  assert.deepEqual(
    changeSet.operations.map(operation => operation.type),
    ['document.restore'],
  );
  const approve = (proposal: ChangeSet) =>
    persistence.transaction(tx =>
      tx.approveChangeSet({
        projectId: p.id,
        changeSetId: proposal.id,
        expectedVersion: proposal.version,
        approvedBy: 'reviewing-author',
      }),
    );
  const apply = (proposal: ChangeSet) =>
    persistence.transaction(tx =>
      tx.applyChangeSet({
        projectId: p.id,
        changeSetId: proposal.id,
        expectedVersion: proposal.version,
      }),
    );
  await assert.rejects(() => apply(changeSet), { code: 'invalid_change_set_state' });
  const approved = await approve(changeSet);
  const applied = await apply(approved);
  const restored = applied.results[0];
  assert.ok(restored && 'revision' in restored);
  assert.notEqual(restored.revision.id, original.revision.id);
  assert.equal(restored.revision.parentRevisionId, current.revision.id);
  assert.equal(restored.revision.markdown, originalText);
  assert.equal(restored.revision.authorId, 'reviewing-author');
  const history = (await persistence.read(reader => reader.listRevisions(p.id, documentId, 10))).revisions;
  assert.deepEqual(
    history.map(revision => revision.id),
    [restored.revision.id, current.revision.id, original.revision.id],
  );
  assert.deepEqual(await apply(approved), { ...applied, replayed: true });
  assert.deepEqual(await propose(), { changeSet: applied.changeSet, replayed: true });
  const freshSnapshot = (await core.observe(p.id)).snapshot;
  assert.deepEqual(await core.proposeManuscriptRestore(p.id, input, { ...options, snapshot: freshSnapshot }), {
    changeSet: applied.changeSet,
    replayed: true,
  });
  await assert.rejects(() => core.proposeManuscriptRestore(p.id, { ...input, sourceRevisionId: current.revision.id }, options), {
    code: 'idempotency_conflict',
  });

  const { changeSet: stale } = await core.proposeManuscriptRestore(
    p.id,
    {
      ...input,
      baseRevisionId: restored.revision.id,
      sourceRevisionId: current.revision.id,
    },
    { ...options, snapshot: undefined, idempotencyKey: randomUUID() },
  );
  const approvedStale = await approve(stale);
  const intervening = await save(restored.revision.id, originalText, 'Intervening editor save');
  await assert.rejects(
    () => apply(approvedStale),
    (error: unknown) => error instanceof PersistenceError && error.code === 'conflict' && error.details?.resource === 'document_revision',
  );
  assert.equal((await persistence.read(reader => reader.getDocument(p.id, documentId)))?.headRevisionId, intervening.revision.id);
  assert.equal(await persistence.read(reader => reader.getChangeSetReceipt(p.id, stale.id)), undefined);
  assert.equal((await persistence.read(reader => reader.getChangeSet(p.id, stale.id)))?.status, 'approved');
});
test('native restore preserves confirmed evidence for identical text and reviews changed quotes', async () => {
  const restore = async (projectId: ProjectId, input: Parameters<CoreStore['proposeManuscriptRestore']>[1]) => {
    const { changeSet } = await core.proposeManuscriptRestore(projectId, input, { actorId: 'author', idempotencyKey: randomUUID() });
    const approved = await persistence.transaction(tx =>
      tx.approveChangeSet({
        projectId,
        changeSetId: changeSet.id,
        expectedVersion: changeSet.version,
        approvedBy: 'author',
      }),
    );
    await persistence.transaction(tx => tx.applyChangeSet({ projectId, changeSetId: approved.id, expectedVersion: approved.version }));
  };
  const makeAnchoredProject = async (markdown: string) => {
    const p = await project();
    const volume = (
      await persistence.transaction(tx =>
        tx.createDocument({
          projectId: p.id,
          kind: 'volume',
          title: 'Volume',
          orderKey: '0001',
          markdown: '',
          authorId: 'author',
          idempotencyKey: randomUUID(),
        }),
      )
    ).document;
    const chapter = (
      await persistence.transaction(tx =>
        tx.createDocument({
          projectId: p.id,
          kind: 'chapter',
          parentId: volume.id,
          title: 'Chapter',
          orderKey: '0001',
          markdown: '',
          authorId: 'author',
          idempotencyKey: randomUUID(),
        }),
      )
    ).document;
    const scene = (
      await persistence.transaction(tx =>
        tx.createDocument({
          projectId: p.id,
          kind: 'scene',
          parentId: chapter.id,
          title: 'Scene',
          orderKey: '0001',
          markdown,
          authorId: 'author',
          idempotencyKey: randomUUID(),
        }),
      )
    ).document;
    return { p, scene };
  };
  const attachConfirmedEvidence = async (
    p: { id: string },
    scene: { id: string },
    revisionId: string,
    fromUtf16: number,
    toUtf16: number,
    quote: string,
  ) => {
    const nodeId = randomUUID() as import('@codexia/persistence-contracts').KnowledgeNodeId;
    const evidenceId = randomUUID() as import('@codexia/persistence-contracts').EvidenceId;
    await persistence.transaction(async tx => {
      await tx.saveKnowledgeNode({
        projectId: p.id as import('@codexia/persistence-contracts').ProjectId,
        id: nodeId,
        type: 'character',
        name: 'Entity',
        attributes: {},
        status: 'confirmed',
        expectedVersion: null,
      });
      await tx.saveEvidenceAnchor({
        projectId: p.id as import('@codexia/persistence-contracts').ProjectId,
        id: evidenceId,
        documentId: scene.id as import('@codexia/persistence-contracts').DocumentId,
        revisionId: revisionId as import('@codexia/persistence-contracts').RevisionId,
        fromUtf16,
        toUtf16,
        quoteSha256: createHash('sha256').update(quote).digest('hex'),
        status: 'confirmed',
        expectedVersion: null,
      });
      await tx.saveMentionLink({
        projectId: p.id as import('@codexia/persistence-contracts').ProjectId,
        evidenceId,
        nodeId,
        status: 'confirmed',
        source: 'author',
        confidence: 1,
        extractorVersion: null,
      });
    });
    return evidenceId;
  };

  const same = await makeAnchoredProject('ABCDEF');
  const sameHead = same.scene.headRevisionId!;
  const sameEvidence = await attachConfirmedEvidence(same.p, same.scene, sameHead, 1, 3, 'BC');
  const duplicate = await persistence.transaction(tx =>
    tx.saveDocument({
      projectId: same.p.id as import('@codexia/persistence-contracts').ProjectId,
      documentId: same.scene.id,
      baseRevisionId: sameHead,
      changes: [],
      resultingSha256: createHash('sha256').update('ABCDEF').digest('hex'),
      authorId: 'author',
      clientId: 'test',
      idempotencyKey: randomUUID(),
    }),
  );
  await restore(same.p.id, { documentId: same.scene.id, baseRevisionId: duplicate.revision.id, sourceRevisionId: sameHead });
  const sameState = await persistence.read(async reader => {
    const head = await reader.getDocument(same.p.id as import('@codexia/persistence-contracts').ProjectId, same.scene.id);
    const revision = head?.headRevisionId
      ? await reader.getRevision(same.p.id as import('@codexia/persistence-contracts').ProjectId, same.scene.id, head.headRevisionId)
      : null;
    return {
      anchor: await reader.getEvidenceAnchor(same.p.id as import('@codexia/persistence-contracts').ProjectId, sameEvidence),
      links: await reader.listMentionLinks(same.p.id as import('@codexia/persistence-contracts').ProjectId, sameEvidence),
      head,
      revision,
    };
  });
  assert.notEqual(sameState.head?.headRevisionId, duplicate.revision.id);
  assert.equal(sameState.revision?.parentRevisionId, duplicate.revision.id);
  assert.equal(sameState.revision?.markdown, 'ABCDEF');
  assert.equal(sameState.anchor?.revisionId, sameState.head?.headRevisionId);
  assert.equal(sameState.anchor?.fromUtf16, 1);
  assert.equal(sameState.anchor?.toUtf16, 3);
  assert.equal(sameState.anchor?.quoteSha256, createHash('sha256').update('BC').digest('hex'));
  assert.equal(sameState.anchor?.status, 'confirmed');
  assert.equal(sameState.links[0]?.status, 'confirmed');

  const changed = await makeAnchoredProject('ABXDEF');
  const sourceRevisionId = changed.scene.headRevisionId!;
  const changedSave = await persistence.transaction(tx =>
    tx.saveDocument({
      projectId: changed.p.id as import('@codexia/persistence-contracts').ProjectId,
      documentId: changed.scene.id,
      baseRevisionId: sourceRevisionId,
      changes: [{ fromUtf16: 2, toUtf16: 3, insert: 'C' }],
      resultingSha256: createHash('sha256').update('ABCDEF').digest('hex'),
      authorId: 'author',
      clientId: 'test',
      idempotencyKey: randomUUID(),
    }),
  );
  const changedEvidence = await attachConfirmedEvidence(changed.p, changed.scene, changedSave.revision.id, 1, 3, 'BC');
  await restore(changed.p.id, { documentId: changed.scene.id, baseRevisionId: changedSave.revision.id, sourceRevisionId });
  const changedState = await persistence.read(async reader => ({
    anchor: await reader.getEvidenceAnchor(changed.p.id as import('@codexia/persistence-contracts').ProjectId, changedEvidence),
    links: await reader.listMentionLinks(changed.p.id as import('@codexia/persistence-contracts').ProjectId, changedEvidence),
  }));
  assert.equal(changedState.anchor?.status, 'needs_review');
  assert.equal(changedState.links[0]?.status, 'proposed');
});
test('unsafe paths and unbound manuscript artifacts cannot bypass canonical documents', async () => {
  const p = await project(),
    reader = await core.reader(p.id);
  await assert.rejects(reader.read('../secret'));
  await assert.rejects(accept(p.id, operation(reader.snapshot, 'manuscript/unbound.md', 'illegal')), /canonical document/);
  assert.equal(await (await core.reader(p.id)).read('manuscript/unbound.md'), null);
});
test('independent approved proposals survive unrelated project changes', async () => {
  const projectRecord = await project();
  const reader = await core.reader(projectRecord.id);
  const operations = [operation(reader.snapshot, 'bible/a.yaml', 'A'), operation(reader.snapshot, 'bible/b.yaml', 'B')];

  for (const currentOperation of operations) {
    const proposal: ChangeProposal = {
      id: randomUUID(),
      snapshot: reader.snapshot,
      operations: [currentOperation],
      source: 'author',
    };
    await core.propose(projectRecord.id, proposal);
    await core.approve(projectRecord.id, {
      proposalId: proposal.id,
      operationIds: [currentOperation.id],
      authorScope: 'owner',
    });
  }

  await core.apply(projectRecord.id, operations[0]!);
  await core.apply(projectRecord.id, operations[1]!);
  assert.equal((await (await core.reader(projectRecord.id)).read('bible/b.yaml'))?.content, 'B');
});

test('concurrent exact Core retries replay one durable approval receipt', async () => {
  const projectRecord = await project();
  const reader = await core.reader(projectRecord.id);
  const currentOperation = operation(reader.snapshot, 'bible/a.yaml', 'A');
  const proposal: ChangeProposal = {
    id: randomUUID(),
    snapshot: reader.snapshot,
    operations: [currentOperation],
    source: 'author',
  };
  await core.propose(projectRecord.id, proposal);
  await core.approve(projectRecord.id, {
    proposalId: proposal.id,
    operationIds: [currentOperation.id],
    authorScope: 'owner',
  });

  const receipts = await Promise.all([core.apply(projectRecord.id, currentOperation), core.apply(projectRecord.id, currentOperation)]);

  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal((await core.observe(projectRecord.id)).snapshot.projectVersion, reader.snapshot.projectVersion + 1);
});

test('scope membership changes reject the entire approved operation', async () => {
  const { snapshotScopeRevision } = await import('@codexia/contracts');
  const projectRecord = await project();
  const reader = await core.reader(projectRecord.id);
  const currentOperation = operation(reader.snapshot, 'meta/result.yaml', 'computed');
  currentOperation.readScopes = [
    {
      prefix: 'bible',
      revision: await snapshotScopeRevision(reader, 'bible'),
    },
  ];
  const proposal: ChangeProposal = {
    id: randomUUID(),
    snapshot: reader.snapshot,
    operations: [currentOperation],
    source: 'author',
  };
  await core.propose(projectRecord.id, proposal);
  await core.approve(projectRecord.id, {
    proposalId: proposal.id,
    operationIds: [currentOperation.id],
    authorScope: 'owner',
  });
  await accept(projectRecord.id, operation(reader.snapshot, 'bible/new.yaml', 'new'));

  await assert.rejects(core.apply(projectRecord.id, currentOperation), /scope changed/);
  assert.equal(await (await core.reader(projectRecord.id)).read('meta/result.yaml'), null);
});
test('scope-bound evidence revisions are checked when proposing and applying', async () => {
  const { snapshotScopeRevision } = await import('@codexia/contracts');
  const projectRecord = await project();
  const reader = await core.reader(projectRecord.id);
  const evidencePath = 'bible/source.yaml';
  const operationRecord = operation(reader.snapshot, 'meta/result.yaml', 'computed');
  operationRecord.readScopes = [{ prefix: 'bible', revision: await snapshotScopeRevision(reader, 'bible') }];
  operationRecord.evidenceIds = ['source-evidence'];

  const proposal: ChangeProposal = {
    id: randomUUID(),
    snapshot: reader.snapshot,
    operations: [operationRecord],
    source: 'author',
    evidence: [
      {
        id: 'source-evidence',
        snapshot: reader.snapshot,
        module: 'story',
        kind: 'source_entity',
        paths: [{ path: evidencePath, revision: 'a'.repeat(64) }],
        details: {},
      },
    ],
  };
  await assert.rejects(core.propose(projectRecord.id, proposal), /evidence revision changed/);

  proposal.evidence![0]!.paths[0]!.revision = null;
  await core.propose(projectRecord.id, proposal);
  await core.approve(projectRecord.id, {
    proposalId: proposal.id,
    operationIds: [operationRecord.id],
    authorScope: 'owner',
  });
  await accept(projectRecord.id, operation(reader.snapshot, evidencePath, 'source'));

  await assert.rejects(core.apply(projectRecord.id, operationRecord), /evidence revision changed/);
  assert.equal(await (await core.reader(projectRecord.id)).read('meta/result.yaml'), null);
});

test('partial approvals preserve each actor in immutable PostgreSQL revisions', async () => {
  const p = await project();
  await createHierarchy(p.id, { kind: 'volume', id: 'vol-actor', title: 'Volume' });
  await createHierarchy(p.id, { kind: 'chapter', id: 'chapter-actor', title: 'Chapter', volumeId: 'vol-actor' });
  for (const [id, title] of [
    ['scene-alice', 'Alice'],
    ['scene-bob', 'Bob'],
  ]) {
    await createHierarchy(p.id, { kind: 'scene', id: id!, title: title!, volumeId: 'vol-actor', chapterId: 'chapter-actor' });
  }
  const reader = await core.reader(p.id);
  const edits = await Promise.all(
    ['alice', 'bob'].map(async author => {
      const path = `manuscript/vol-actor/chapter-actor/scene-${author}.md`;
      const file = await reader.read(path);
      assert.ok(file);
      return { ...operation(reader.snapshot, path, `${author}'s manuscript`, file.revision), effect: 'manuscript' as const };
    }),
  );
  const [one, two] = edits;
  const proposal: ChangeProposal = {
    id: randomUUID(),
    snapshot: reader.snapshot,
    source: 'author',
    operations: edits,
  };
  // The HTTP owner maps to "owner". The Core port also preserves an opaque actor ID.
  const aliceApprover = 'owner';
  const bobApprover = '01JBGQ7R5X1T4H8X85P9MN4CT8';
  await core.propose(p.id, proposal);
  await core.approve(p.id, {
    proposalId: proposal.id,
    operationIds: [one!.id],
    authorScope: aliceApprover,
  });
  await core.approve(p.id, {
    proposalId: proposal.id,
    operationIds: [two!.id],
    authorScope: bobApprover,
  });
  for (const edit of edits) await core.apply(p.id, edit);
  const documents = await persistence.read(reader => reader.listDocuments(p.id));
  for (const [title, expectedAuthor] of [
    ['Alice', aliceApprover],
    ['Bob', bobApprover],
  ]) {
    const document = documents.find(candidate => candidate.title === title);
    assert.ok(document?.headRevisionId);
    const revision = await persistence.read(reader => reader.getRevision(p.id, document.id, document.headRevisionId!));
    assert.equal(revision?.authorId, expectedAuthor);
  }
});

test('re-approving an already applied proposal does not regress its durable status', async () => {
  const p = await project();
  const snapshot = (await core.reader(p.id)).snapshot;
  const op = operation(snapshot, 'bible/reapproval.yaml', 'preserved');
  const proposal: ChangeProposal = { id: randomUUID(), snapshot, operations: [op], source: 'author' };
  await core.propose(p.id, proposal);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [op.id], authorScope: 'owner' });
  const receipt = await core.apply(p.id, op);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [op.id], authorScope: 'owner' });
  const after = await core.getProposal(p.id, proposal.id);
  assert.equal(after?.state, 'applied');
  assert.deepEqual(after?.applications, [receipt]);
  assert.equal(after?.approvedByOperationId?.[op.id], 'owner');
});

test('approval bookkeeping handles allowed operation IDs that inherit object properties', async () => {
  const p = await project();
  const snapshot = (await core.reader(p.id)).snapshot;
  const op = { ...operation(snapshot, 'bible/inherited-key.yaml', 'preserved'), id: 'constructor' };
  const proposal: ChangeProposal = { id: randomUUID(), snapshot, operations: [op], source: 'author' };
  await core.propose(p.id, proposal);
  await core.approve(p.id, { proposalId: proposal.id, operationIds: [op.id], authorScope: 'owner' });
  const after = await core.getProposal(p.id, proposal.id);
  assert.equal(Object.hasOwn(after?.approvedByOperationId ?? {}, 'constructor'), true);
  assert.equal(after?.approvedByOperationId?.constructor, 'owner');
});

test('duplicate approved proposals share one manuscript application and settle on replay', async () => {
  const p = await hierarchy();
  const reader = await core.reader(p.id);
  const path = 'manuscript/v1/c1/s1.md';
  const current = (await reader.read(path))!;
  const op: ChangeOperation = {
    ...operation(reader.snapshot, path, 'One new manuscript revision', current.revision),
    effect: 'manuscript',
  };
  const proposals: ChangeProposal[] = Array.from({ length: 3 }, () => ({
    id: randomUUID(),
    snapshot: reader.snapshot,
    operations: [op],
    source: 'author',
  }));
  for (const proposal of proposals) await core.propose(p.id, proposal);
  const approveDuplicate = (proposal: ChangeProposal) =>
    core.approve(p.id, {
      proposalId: proposal.id,
      operationIds: [op.id],
      authorScope: 'owner',
    });
  await approveDuplicate(proposals[0]!);
  await approveDuplicate(proposals[1]!);
  const [receipt, retried] = await Promise.all([core.apply(p.id, op), core.apply(p.id, op)]);
  assert.deepEqual(retried, receipt);
  assert.equal((await core.getProposal(p.id, proposals[2]!.id))?.state, 'proposed');
  for (const proposal of proposals.slice(0, 2)) {
    const status = await core.getProposal(p.id, proposal.id);
    assert.equal(status?.state, 'applied');
    assert.deepEqual(status?.applications, [receipt]);
  }
  await approveDuplicate(proposals[2]!);
  assert.deepEqual(await core.apply(p.id, op), receipt);
  assert.deepEqual((await core.getProposal(p.id, proposals[2]!.id))?.applications, [receipt]);
  assert.equal((await core.reader(p.id)).snapshot.projectVersion, receipt.projectVersion);
  const history = await core.listManuscriptSnapshots(p.id, 's1');
  assert.equal(history.snapshots.length, 2, 'replay wrote a second manuscript revision');
  assert.equal((await core.readScene(p.id, 's1')).text, 'One new manuscript revision');
});

test('applying an already absent hierarchy deletion records a durable project version', async () => {
  const p = await project();
  const { snapshot } = await core.observe(p.id);
  const path = 'plot/volumes/absent/volume.yaml';
  const op: ChangeOperation = { ...operation(snapshot, path, null), effect: 'structure' };
  const proposal = await approve(p.id, { operation: op, snapshot });

  const receipt = await core.apply(p.id, op);
  assert.equal(receipt.projectVersion, snapshot.projectVersion);
  assert.deepEqual(receipt.revisions, [{ path, revision: null }]);
  assert.deepEqual((await core.reader(p.id, { projectId: p.id, projectVersion: receipt.projectVersion })).snapshot, snapshot);
  assert.deepEqual((await core.getProposal(p.id, proposal.id))?.applications, [receipt]);
  assert.deepEqual(await core.apply(p.id, op), receipt);
});

test('pinned manuscript history excludes future revisions and rejects their body reads', async () => {
  const p = await hierarchy();
  const old = await core.reader(p.id);
  const path = 'manuscript/v1/c1/s1.md';
  const initial = (await core.listManuscriptSnapshots(p.id, 's1', undefined, old.snapshot)).snapshots;
  await accept(p.id, operation(old.snapshot, path, 'Future revision', (await old.read(path))!.revision));
  const currentVersion = (await core.observe(p.id)).snapshot.projectVersion;
  const currentManifest = () =>
    persistence.read(reader => reader.getModuleRecord(p.id, 'core.authority.snapshots', `snapshot:${currentVersion}`));
  assert.equal(await currentManifest(), undefined);
  const currentHistory = await core.history(p.id);
  assert.equal(await currentManifest(), undefined, 'revision history does not materialize a file snapshot');
  const current = await core.listManuscriptSnapshots(p.id, 's1');
  const future = current.snapshots.find(item => !initial.some(previous => previous.id === item.id))!;
  assert.ok(future);
  assert.ok(currentHistory.some(item => item.hash === future.id));
  assert.deepEqual((await core.listManuscriptSnapshots(p.id, 's1', undefined, old.snapshot)).snapshots, initial);
  assert.equal(
    (await core.readManuscriptSnapshot(p.id, initial[0]!.id, 's1', undefined, old.snapshot)).manuscriptSnapshot.body,
    'Text 😀\n',
  );
  await assert.rejects(core.readManuscriptSnapshot(p.id, future.id, 's1', undefined, old.snapshot), { code: 'revision_not_found' });
  assert.ok(!(await core.history(p.id, old.snapshot)).some(item => item.hash === future.id));
});

test('review queue preserves proposal ordering, scope and stale semantics', async () => {
  const first = await project(),
    second = await project(),
    outside = await project();
  for (const p of [first, second, outside]) {
    const snapshot = (await core.observe(p.id)).snapshot;
    for (const id of ['z-review', 'a-review']) {
      await core.propose(p.id, { id, snapshot, source: 'author', operations: [operation(snapshot, `bible/${id}.yaml`, 'A')] });
    }
  }
  const secondSnapshot = (await core.observe(second.id)).snapshot;
  await accept(second.id, operation(secondSnapshot, 'bible/other.yaml', 'B'));
  const page = await core.reviewQueue([second.id, first.id]);
  assert.equal(page.unresolvedCount, 4);
  assert.deepEqual(
    page.items.map(({ projectId, proposal }) => ({
      projectId,
      id: proposal.proposal.id,
      state: proposal.state,
      stale: proposal.stale,
    })),
    [
      { projectId: second.id, id: 'a-review', state: 'proposed', stale: true },
      { projectId: second.id, id: 'z-review', state: 'proposed', stale: true },
      { projectId: first.id, id: 'a-review', state: 'proposed', stale: false },
      { projectId: first.id, id: 'z-review', state: 'proposed', stale: false },
    ],
  );
});

test('literal search maps lowercase expansions to original UTF-16 ranges', async () => {
  const p = await hierarchy(),
    reader = await core.reader(p.id),
    path = 'manuscript/v1/c1/s1.md';
  await accept(p.id, operation(reader.snapshot, path, 'İX 😀', (await reader.read(path))!.revision));
  for (const [query, offset, length] of [
    ['x', 1, 1],
    ['i', 0, 1],
    ['İX', 0, 2],
    ['😀', 3, 2],
  ] as const) {
    const result = (await core.searchSnapshot(p.id, query)).results.find(item => item.field === 'body');
    assert.ok(result);
    assert.equal(result.offset, offset);
    assert.equal(result.length, length);
  }
});
test('proposal detail, list and review queue agree after a content revision', async () => {
  const p = await project(),
    snapshot = (await core.observe(p.id)).snapshot;
  const proposal: ChangeProposal = { id: randomUUID(), snapshot, source: 'author', operations: [operation(snapshot, 'bible/a.yaml', 'A')] };
  await core.propose(p.id, proposal);
  assert.equal((await core.getProposal(p.id, proposal.id))?.stale, false);
  await accept(p.id, operation(snapshot, 'bible/b.yaml', 'B'));
  const detail = await core.getProposal(p.id, proposal.id);
  assert.equal(detail?.stale, true);
  assert.deepEqual(
    (await core.listProposals(p.id)).find(item => item.proposal.id === proposal.id),
    detail,
  );
  assert.deepEqual((await core.reviewQueue([p.id])).items.find(item => item.proposal.proposal.id === proposal.id)?.proposal, detail);
});

test('two approved hierarchy creates with the same logical ID cannot both apply', async () => {
  const p = await hierarchy();
  await createHierarchy(p.id, {
    kind: 'chapter',
    id: 'c2',
    title: 'Second chapter',
    volumeId: 'v1',
  });
  const { changeSet: first } = await proposeCreate(p.id, {
    kind: 'scene',
    id: 'duplicate-scene',
    title: 'First proposal',
    volumeId: 'v1',
    chapterId: 'c1',
    manuscriptBody: 'First body',
  });
  const { changeSet: second } = await proposeCreate(p.id, {
    kind: 'scene',
    id: 'duplicate-scene',
    title: 'Second proposal',
    volumeId: 'v1',
    chapterId: 'c2',
    manuscriptBody: 'Second body',
  });
  const approveCreation = (changeSet: ChangeSet) =>
    persistence.transaction(tx =>
      tx.approveChangeSet({
        projectId: p.id,
        changeSetId: changeSet.id,
        expectedVersion: changeSet.version,
        approvedBy: 'author',
      }),
    );
  const firstApproved = await approveCreation(first);
  const secondApproved = await approveCreation(second);
  await applyNativeChangeSet(firstApproved);
  const readState = () =>
    persistence.read(async reader => {
      const documents = await reader.listDocuments(p.id, undefined, 1000);
      const history: Array<readonly [string, string[]]> = [];
      for (const document of documents) {
        history.push([document.id, (await reader.listRevisions(p.id, document.id, 100)).revisions.map(revision => revision.id)]);
      }
      return { documents: documents.map(document => document.id), history };
    });
  const before = await readState();
  await assert.rejects(
    applyNativeChangeSet(secondApproved),
    (error: unknown) => error instanceof PersistenceError && error.code === 'conflict' && error.details?.resource === 'hierarchy_id_exists',
  );
  assert.deepEqual(await readState(), before, 'a rejected logical duplicate must leave no document or revision history');
});

test('existing duplicate logical IDs keep their first-match reads', async () => {
  const p = await project();
  await persistence.transaction(async transaction => {
    const volume = (
      await transaction.createDocument({
        projectId: p.id,
        kind: 'volume',
        title: 'Legacy volume',
        orderKey: '0001',
        markdown: '',
        authorId: 'author',
        idempotencyKey: randomUUID(),
      })
    ).document;
    const chapter = (
      await transaction.createDocument({
        projectId: p.id,
        parentId: volume.id,
        kind: 'chapter',
        title: 'Legacy chapter',
        orderKey: '0001',
        markdown: '',
        authorId: 'author',
        idempotencyKey: randomUUID(),
      })
    ).document;
    for (const [suffix, orderKey, markdown] of [
      ['first', '0001', 'First legacy body'],
      ['second', '0002', 'Second legacy body'],
    ] as const) {
      const sceneId = randomUUID() as import('@codexia/persistence-contracts').DocumentId;
      const metadataPath = `plot/volumes/v-legacy/chapters/c-legacy/scenes/${suffix}.yaml`;
      const manuscriptPath = `manuscript/v-legacy/c-legacy/${suffix}.md`;
      const scene = (
        await transaction.createDocument({
          projectId: p.id,
          documentId: sceneId,
          parentId: chapter.id,
          kind: 'scene',
          title: suffix,
          orderKey,
          markdown,
          authorId: 'author',
          idempotencyKey: randomUUID(),
        })
      ).document;
      await transaction.saveModuleRecord({
        projectId: p.id,
        moduleId: 'core.document-paths',
        key: scene.id,
        value: {
          metadataPath,
          manuscriptPath,
          metadata: { id: 'legacy-duplicate', title: suffix, order: orderKey },
        },
        expectedVersion: null,
      });
    }
    await transaction.saveModuleRecord({
      projectId: p.id,
      moduleId: 'core.document-paths',
      key: volume.id,
      value: { metadataPath: 'plot/volumes/v-legacy/volume.yaml', metadata: { id: 'v-legacy', title: 'Legacy volume' } },
      expectedVersion: null,
    });
    await transaction.saveModuleRecord({
      projectId: p.id,
      moduleId: 'core.document-paths',
      key: chapter.id,
      value: {
        metadataPath: 'plot/volumes/v-legacy/chapters/c-legacy/chapter.yaml',
        metadata: { id: 'c-legacy', title: 'Legacy chapter' },
      },
      expectedVersion: null,
    });
  });

  const tree = await core.tree(p.id);
  assert.deepEqual(
    tree.volumes[0]?.chapters[0]?.scenes.map(scene => scene.id),
    ['legacy-duplicate', 'legacy-duplicate'],
  );
  assert.equal((await core.readScene(p.id, 'legacy-duplicate')).text, 'First legacy body');
});

test('native hierarchy deletion preserves revisions, evidence, reservations and replay receipts', async () => {
  const p = await hierarchy();
  const scene = (await persistence.read(reader => reader.listDocuments(p.id))).find(document => document.kind === 'scene')!;
  const revisionId = scene.headRevisionId!;
  const evidenceId = randomUUID() as import('@codexia/persistence-contracts').EvidenceId;
  await persistence.transaction(transaction =>
    transaction.saveEvidenceAnchor({
      projectId: p.id,
      id: evidenceId,
      documentId: scene.id,
      revisionId,
      fromUtf16: 0,
      toUtf16: 'Text 😀\n'.length,
      quoteSha256: createHash('sha256').update('Text 😀\n').digest('hex'),
      status: 'confirmed',
      expectedVersion: null,
    }),
  );
  const volume = (await persistence.read(reader => reader.listDocuments(p.id))).find(document => document.kind === 'volume')!;
  const propose = async () =>
    core.proposeHierarchyDelete(
      p.id,
      { kind: 'volume', id: 'v1' },
      {
        projectVersion: (await core.observe(p.id)).snapshot.projectVersion,
        actorId: 'author',
        idempotencyKey: 'remove-volume',
      },
    );
  const { changeSet } = await propose();
  assert.equal(changeSet.operations.length, 3);
  assert.equal((await persistence.read(reader => reader.listDocuments(p.id))).length, 3);
  const apply = (expectedVersion: number) =>
    persistence.transaction(tx =>
      tx.applyChangeSet({
        projectId: p.id,
        changeSetId: changeSet.id,
        expectedVersion,
      }),
    );
  await assert.rejects(apply(changeSet.version), { code: 'invalid_change_set_state' });
  const approved = await persistence.transaction(tx =>
    tx.approveChangeSet({
      projectId: p.id,
      changeSetId: changeSet.id,
      expectedVersion: changeSet.version,
      approvedBy: 'author',
    }),
  );
  const { snapshot } = await core.observe(p.id);
  await persistence.transaction(tx =>
    tx.updateProject({
      projectId: p.id,
      expectedVersion: snapshot.projectVersion,
      title: 'Unrelated project edit',
    }),
  );
  const applied = await apply(approved.version);
  assert.deepEqual(
    applied.results.map(result => 'kind' in result && result.kind),
    ['scene', 'chapter', 'volume'],
  );
  assert.deepEqual(await apply(approved.version), { ...applied, replayed: true });
  assert.deepEqual(await propose(), { changeSet: applied.changeSet, replayed: true });

  assert.equal(await persistence.read(reader => reader.getDocument(p.id, volume.id)), undefined);
  assert.deepEqual(await persistence.read(reader => reader.listDocuments(p.id)), []);
  assert.equal((await persistence.read(reader => reader.getRevision(p.id, scene.id, revisionId)))?.markdown, 'Text 😀\n');
  assert.ok((await persistence.read(reader => reader.listEvidenceDocumentIds(p.id))).includes(scene.id));
  assert.equal((await persistence.read(reader => reader.getEvidenceAnchor(p.id, evidenceId)))?.documentId, scene.id);
  await assert.rejects(
    proposeCreate(p.id, { kind: 'volume', id: 'v1', title: 'Recreated volume' }),
    (error: unknown) => error instanceof CoreError && error.code === 'hierarchy_path_reserved',
  );
});

test('native hierarchy deletion rejects changed membership and ancestor moves atomically', async t => {
  for (const change of ['sibling added', 'descendant added', 'ancestor moved'] as const) {
    await t.test(change, async () => {
      const p = await hierarchy();
      const documents = await persistence.read(reader => reader.listDocuments(p.id));
      const volume = documents.find(document => document.kind === 'volume')!;
      const chapter = documents.find(document => document.kind === 'chapter')!;
      const target =
        change === 'ancestor moved'
          ? ({ kind: 'scene', id: 's1', volumeId: 'v1', chapterId: 'c1' } as const)
          : ({ kind: 'chapter', id: 'c1', volumeId: 'v1' } as const);
      const { snapshot } = await core.observe(p.id);
      const { changeSet } = await core.proposeHierarchyDelete(p.id, target, {
        projectVersion: snapshot.projectVersion,
        actorId: 'author',
        idempotencyKey: randomUUID(),
      });
      const approved = await persistence.transaction(tx =>
        tx.approveChangeSet({
          projectId: p.id,
          changeSetId: changeSet.id,
          expectedVersion: changeSet.version,
          approvedBy: 'author',
        }),
      );
      await persistence.transaction(async tx => {
        const result = await tx.createDocument({
          projectId: p.id,
          ...(change === 'sibling added'
            ? { kind: 'chapter', parentId: volume.id }
            : change === 'descendant added'
              ? { kind: 'scene', parentId: chapter.id }
              : { kind: 'volume' }),
          title: 'Intervening document',
          orderKey: '999',
          markdown: '',
          authorId: 'author',
          idempotencyKey: randomUUID(),
        });
        if (change === 'ancestor moved')
          await tx.updateDocument({
            projectId: p.id,
            documentId: chapter.id,
            parentId: result.document.id,
            expectedVersion: chapter.version,
          });
      });
      const current = await persistence.read(reader => reader.listDocuments(p.id));
      await assert.rejects(
        persistence.transaction(tx =>
          tx.applyChangeSet({
            projectId: p.id,
            changeSetId: approved.id,
            expectedVersion: approved.version,
          }),
        ),
        (error: unknown) =>
          error instanceof PersistenceError &&
          error.code === 'conflict' &&
          error.details?.resource === (change === 'descendant added' ? 'hierarchy_subtree' : 'hierarchy_siblings'),
      );
      assert.deepEqual(await persistence.read(reader => reader.listDocuments(p.id)), current);
      assert.equal(await persistence.read(reader => reader.getChangeSetReceipt(p.id, changeSet.id)), undefined);
    });
  }
});

test('a path deleted after proposal approval is rejected before recreating its retained document row', async () => {
  const p = await project();
  const { changeSet: pending } = await proposeCreate(p.id, { kind: 'volume', id: 'raced-volume', title: 'Pending' });
  const approved = await persistence.transaction(tx =>
    tx.approveChangeSet({
      projectId: p.id,
      changeSetId: pending.id,
      expectedVersion: pending.version,
      approvedBy: 'author',
    }),
  );
  await createHierarchy(p.id, { kind: 'volume', id: 'raced-volume', title: 'Competing' });
  const existing = (await persistence.read(reader => reader.listDocuments(p.id))).find(document => document.kind === 'volume')!;
  await applyNativeChangeSet(await approveDelete(p.id, { kind: 'volume', id: 'raced-volume' }));

  await assert.rejects(
    applyNativeChangeSet(approved),
    (error: unknown) =>
      error instanceof PersistenceError && error.code === 'conflict' && error.details?.resource === 'hierarchy_path_reserved',
  );
  assert.deepEqual(await persistence.read(reader => reader.listDocuments(p.id)), []);
  assert.ok(await persistence.read(reader => reader.getRevision(p.id, existing.id, existing.headRevisionId!)));
});
