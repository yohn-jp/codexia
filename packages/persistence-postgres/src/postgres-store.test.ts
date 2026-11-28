import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ChangeSetOperation,
  type CreateDocumentCommand,
  type DocumentId,
  type EvidenceId,
  type KnowledgeAliasId,
  type KnowledgeNodeId,
  type KnowledgeProjectionBatch,
  PersistenceError,
  type ProjectId,
  type ProjectPageCursor,
  type RevisionId,
  type SaveDocumentCommand,
} from '@codexia/persistence-contracts';
import { Pool } from 'pg';
import {
  createPostgresPersistence,
  initializeFreshPostgresSchema,
  inspectFreshPostgresSchema,
  migratePostgresDatabase,
  packagedMigrationFingerprint,
  verifyPostgresSchema,
} from './index.js';

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error('CODEXIA_TEST_DATABASE_URL is required for PostgreSQL integration tests');

const persistence = createPostgresPersistence(connectionString);
const directPool = new Pool({ connectionString });

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function createProject(title: string) {
  return persistence.transaction(transaction => transaction.createProject({ title }));
}

async function createDocument(projectId: ProjectId, markdown: string, idempotencyKey = randomUUID()) {
  return persistence.transaction(transaction =>
    transaction.createDocument({
      projectId,
      kind: 'scene',
      title: 'Scene',
      orderKey: '0001',
      markdown,
      authorId: 'author',
      idempotencyKey,
    }),
  );
}

function saveCommand(
  projectId: ProjectId,
  documentId: DocumentId,
  baseRevisionId: RevisionId,
  markdown: string,
  changes: SaveDocumentCommand['changes'],
  idempotencyKey: string = randomUUID(),
): SaveDocumentCommand {
  return {
    projectId,
    documentId,
    baseRevisionId,
    changes,
    resultingSha256: sha256(markdown),
    authorId: 'author',
    clientId: 'test-client',
    idempotencyKey,
  };
}

before(async () => {
  await migratePostgresDatabase(connectionString);
  assert.deepEqual(await migratePostgresDatabase(connectionString), []);
});

after(async () => {
  await persistence.close();
  await directPool.end();
});

test('fresh schema initialization is transactional, repeatable and rejects untracked or partial schemas', async t => {
  const db = 'codexia_fresh_' + randomUUID().replaceAll('-', '');
  await directPool.query(`CREATE DATABASE "${db}"`);
  const target = new URL(connectionString);
  target.pathname = '/' + db;
  const pool = new Pool({ connectionString: target.toString() });
  t.after(async () => {
    await pool.end();
    // Let PostgreSQL wait for the just-closed connections instead of forcibly
    // terminating sockets that pg is still finishing asynchronously.
    await directPool.query(`DROP DATABASE "${db}"`);
  });
  assert.deepEqual(await inspectFreshPostgresSchema(target.toString()), {
    pristine: true,
    fingerprint: await packagedMigrationFingerprint(),
  });
  await pool.query('CREATE TABLE public.untracked (value text)');
  await assert.rejects(initializeFreshPostgresSchema(target.toString()), /untracked database objects/);
  await assert.rejects(inspectFreshPostgresSchema(target.toString()), /untracked database objects/);
  assert.equal((await pool.query("SELECT to_regclass('public.codexia_schema_migrations') AS ledger")).rows[0].ledger, null);
  await pool.query('DROP TABLE public.untracked');
  await pool.query('CREATE COLLATION public.untracked FROM "C"');
  await assert.rejects(initializeFreshPostgresSchema(target.toString()), /untracked database objects/);
  assert.equal((await pool.query("SELECT to_regclass('public.codexia_schema_migrations') AS ledger")).rows[0].ledger, null);
  await pool.query('DROP COLLATION public.untracked');
  const applied = await initializeFreshPostgresSchema(target.toString());
  assert.ok(applied.length > 0);
  assert.deepEqual(await initializeFreshPostgresSchema(target.toString()), []);
  assert.deepEqual(await inspectFreshPostgresSchema(target.toString()), {
    pristine: false,
    fingerprint: await packagedMigrationFingerprint(),
  });
  assert.equal(await verifyPostgresSchema(target.toString()), await packagedMigrationFingerprint());
  await pool.query(
    'DELETE FROM public.codexia_schema_migrations WHERE version = (SELECT max(version) FROM public.codexia_schema_migrations)',
  );
  await assert.rejects(initializeFreshPostgresSchema(target.toString()), /Missing applied migration/);
  assert.equal(Number((await pool.query('SELECT count(*) FROM public.codexia_schema_migrations')).rows[0].count), applied.length - 1);
});

test('the exact migration ledger can be verified with read-only database transactions', async () => {
  const expected = await packagedMigrationFingerprint();
  assert.match(expected, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(await verifyPostgresSchema({ connectionString, options: '-c default_transaction_read_only=on' }), expected);
});

test('packaged fingerprint works without a database and verified fingerprint works on a read-only ledger', () => {
  const cli = fileURLToPath(new URL('../dist/migrate.js', import.meta.url));
  const packaged = execFileSync(process.execPath, [cli, '--fingerprint'], {
    encoding: 'utf8',
    env: { ...process.env, CODEXIA_DATABASE_URL: '' },
  });
  assert.match(packaged, /^sha256:[a-f0-9]{64}\n$/u);
  const verified = execFileSync(process.execPath, [cli, '--verify-fingerprint'], {
    encoding: 'utf8',
    env: { ...process.env, CODEXIA_DATABASE_URL: connectionString, PGOPTIONS: '-c default_transaction_read_only=on' },
  });
  assert.equal(verified, packaged);
});

test('[TEST-DATA-004-001] read-only schema verification rejects missing, altered and newer migration ledgers', async t => {
  // Use a disposable namespace rather than modifying the shared integration ledger.
  const schema = `migration_gate_${randomUUID().replaceAll('-', '')}`;
  const ledger = `"${schema}".codexia_schema_migrations`;
  await directPool.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    await directPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  });
  const config = { connectionString, options: `-c search_path=${schema} -c default_transaction_read_only=on` };
  await assert.rejects(verifyPostgresSchema(config), { code: '42P01' });
  const cli = fileURLToPath(new URL('../dist/migrate.js', import.meta.url));
  const missingLedger = spawnSync(process.execPath, [cli, '--verify-fingerprint'], {
    encoding: 'utf8',
    env: { ...process.env, CODEXIA_DATABASE_URL: connectionString, PGOPTIONS: config.options },
  });
  assert.equal(missingLedger.error, undefined);
  assert.equal(missingLedger.status, 1);
  assert.equal(missingLedger.stdout, '', 'a failed read-only verification must never emit a fingerprint');
  const absent = await directPool.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', [
    `${schema}.codexia_schema_migrations`,
  ]);
  assert.equal(absent.rows[0]?.relation, null);

  await directPool.query(`CREATE TABLE ${ledger} AS SELECT version, checksum FROM codexia_schema_migrations`);
  await verifyPostgresSchema(config);
  await directPool.query(`UPDATE ${ledger} SET checksum = repeat('0', 64)`);
  await assert.rejects(verifyPostgresSchema(config), /has changed/);
  await directPool.query(`TRUNCATE ${ledger}`);
  await assert.rejects(verifyPostgresSchema(config), /Missing applied migration/);
  await directPool.query(`INSERT INTO ${ledger} SELECT version, checksum FROM codexia_schema_migrations`);
  await directPool.query(`INSERT INTO ${ledger} (version, checksum) VALUES ($1, $2)`, ['999999999-future.sql', 'f'.repeat(64)]);
  await assert.rejects(verifyPostgresSchema(config), /Unexpected applied migration/);
});

test('[TEST-DATA-002-001] migrations are repeatable and document revisions stay immutable', async () => {
  const project = await persistence.transaction(transaction =>
    transaction.createProject({
      title: `migration-${randomUUID()}`,
      settings: { language: 'ja' },
    }),
  );
  assert.deepEqual((await persistence.read(reader => reader.getProject(project.id)))?.settings, { language: 'ja' });
  const initial = await createDocument(project.id, '章😀\uFE0F e\u0301\r\n');
  assert.equal(initial.revision.sha256, sha256(initial.revision.markdown));

  await assert.rejects(
    directPool.query("UPDATE document_revision SET markdown = 'changed' WHERE project_id = $1 AND id = $2", [
      project.id,
      initial.revision.id,
    ]),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '55000'),
  );
});

test('document head revisions are fetched as an ordered exact-key set within project scope', async () => {
  const firstProject = await createProject(`head-batch-a-${randomUUID()}`);
  const secondProject = await createProject(`head-batch-b-${randomUUID()}`);
  const first = await createDocument(firstProject.id, 'First head');
  const second = await createDocument(firstProject.id, 'Second head');

  const keys = [
    { documentId: second.document.id, revisionId: second.revision.id },
    { documentId: first.document.id, revisionId: second.revision.id },
    { documentId: first.document.id, revisionId: first.revision.id },
    { documentId: second.document.id, revisionId: second.revision.id },
  ];
  const lookups = await persistence.read(reader => reader.getDocumentHeadRevisions(firstProject.id, keys));

  assert.deepEqual(
    lookups.map(({ documentId, revisionId, revision }) => ({
      documentId,
      revisionId,
      markdown: revision?.markdown ?? null,
    })),
    [
      { documentId: second.document.id, revisionId: second.revision.id, markdown: 'Second head' },
      { documentId: first.document.id, revisionId: second.revision.id, markdown: null },
      { documentId: first.document.id, revisionId: first.revision.id, markdown: 'First head' },
      { documentId: second.document.id, revisionId: second.revision.id, markdown: 'Second head' },
    ],
  );
  assert.deepEqual(
    await persistence.read(reader =>
      reader.getDocumentHeadRevisions(secondProject.id, [{ documentId: first.document.id, revisionId: first.revision.id }]),
    ),
    [{ documentId: first.document.id, revisionId: first.revision.id, revision: null }],
  );
  assert.deepEqual(await persistence.read(reader => reader.getDocumentHeadRevisions(firstProject.id, [])), []);
  assert.deepEqual(await persistence.read(reader => reader.getDocumentHeadRevisionHashes(firstProject.id, keys)), [
    { ...keys[0], sha256: sha256('Second head') },
    { ...keys[1], sha256: null },
    { ...keys[2], sha256: sha256('First head') },
    { ...keys[3], sha256: sha256('Second head') },
  ]);
  assert.deepEqual(await persistence.read(reader => reader.getDocumentHeadRevisionHashes(secondProject.id, [keys[0]!])), [
    { ...keys[0], sha256: null },
  ]);
});

test('project revision history is globally bounded, metadata only and pinned to exact heads', async () => {
  const project = await createProject('Bounded revision history');
  const foreign = await createProject('Foreign history');
  const first = await createDocument(project.id, 'first');
  const second = await createDocument(project.id, 'second');
  const other = await createDocument(foreign.id, 'foreign');
  const next = await persistence.transaction(tx =>
    tx.saveDocument(saveCommand(project.id, first.document.id, first.revision.id, 'first!', [{ fromUtf16: 5, toUtf16: 5, insert: '!' }])),
  );
  const heads = [
    { documentId: first.document.id, revisionId: first.revision.id },
    { documentId: second.document.id, revisionId: second.revision.id },
    { documentId: other.document.id, revisionId: other.revision.id },
  ];
  const rows = await persistence.read(reader => reader.listProjectRevisionHistory(project.id, heads, 2));
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(row => row.id)), new Set([first.revision.id, second.revision.id]));
  assert.ok(rows.every(row => !('markdown' in row)));
  assert.ok(!rows.some(row => row.id === next.revision.id));
  const bounded = await persistence.read(reader => reader.listProjectRevisionHistory(project.id, heads, 1));
  assert.deepEqual(bounded, rows.slice(0, 1));
});

test('PostgreSQL health checks and Knowledge lists use the canonical project records', async () => {
  const project = await createProject(`knowledge-list-${randomUUID()}`);
  const nodeIds = [randomUUID() as KnowledgeNodeId, randomUUID() as KnowledgeNodeId];
  await persistence.transaction(async transaction => {
    await transaction.saveKnowledgeNode({
      projectId: project.id,
      id: nodeIds[0]!,
      type: 'character',
      name: 'Zebra',
      attributes: {},
      status: 'proposed',
      expectedVersion: null,
    });
    await transaction.saveKnowledgeNode({
      projectId: project.id,
      id: nodeIds[1]!,
      type: 'character',
      name: 'Apple',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
  });

  await persistence.checkHealth();
  const nodes = await persistence.read(reader => reader.listKnowledgeNodes(project.id));
  assert.deepEqual(
    nodes.map(node => node.name),
    ['Apple', 'Zebra'],
  );
  assert.deepEqual(
    (await persistence.read(reader => reader.listKnowledgeNodes(project.id, 1))).map(node => node.name),
    ['Apple'],
  );
});

test('Knowledge browse searches literals and aliases, pages 501 nodes in stable order, and stays project scoped', async () => {
  const project = await createProject(`knowledge-browse-${randomUUID()}`);
  const otherProject = await createProject(`knowledge-browse-decoy-${randomUUID()}`);
  const ids = Array.from({ length: 501 }, () => randomUUID() as KnowledgeNodeId);
  await persistence.transaction(async transaction => {
    for (let index = 0; index < ids.length; index += 1) {
      await transaction.saveKnowledgeNode({
        projectId: project.id,
        id: ids[index]!,
        type: index % 2 ? 'person' : 'place',
        name: `Browse ${String(index).padStart(4, '0')}`,
        attributes: {},
        status: index % 2 ? 'confirmed' : 'proposed',
        expectedVersion: null,
      });
    }
    await transaction.saveKnowledgeAlias({
      projectId: project.id,
      id: randomUUID() as KnowledgeAliasId,
      nodeId: ids[500]!,
      surface: 'Literal%_!Alias',
      normalized: 'literal%_!alias',
      scope: null,
      status: 'confirmed',
    });
    const decoyId = randomUUID() as KnowledgeNodeId;
    await transaction.saveKnowledgeNode({
      projectId: otherProject.id,
      id: decoyId,
      type: 'person',
      name: 'Unrelated',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveKnowledgeAlias({
      projectId: otherProject.id,
      id: randomUUID() as KnowledgeAliasId,
      nodeId: decoyId,
      surface: 'Literal%_!Alias',
      normalized: 'literal%_!alias',
      scope: null,
      status: 'confirmed',
    });
  });

  const loaded: string[] = [];
  let after: { name: string; id: KnowledgeNodeId } | undefined;
  for (const expectedCount of [101, 101, 101, 101, 97]) {
    const page = await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { limit: 101, after }));
    assert.equal(page.length, expectedCount);
    loaded.push(...page.map(node => node.id));
    const last = page.at(-1)!;
    after = { name: last.name, id: last.id };
  }
  assert.deepEqual(await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { limit: 101, after })), []);
  assert.deepEqual(loaded, ids);
  const literal = await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { query: '%_!', limit: 10 }));
  assert.deepEqual(
    literal.map(node => node.id),
    [ids[500]],
  );
  const alias = await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { query: 'literal%_!alias', limit: 10 }));
  assert.deepEqual(
    alias.map(node => node.id),
    [ids[500]],
  );
  const scoped = await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { query: 'Unrelated', limit: 10 }));
  assert.deepEqual(scoped, []);
  const filtered = await persistence.read(reader =>
    reader.searchKnowledgeNodes!(project.id, { type: 'person', status: 'confirmed', limit: 10 }),
  );
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every(node => node.type === 'person' && node.status === 'confirmed'));
});

test('Knowledge search returns retired nodes only for the explicit retired filter', async () => {
  const project = await createProject(`knowledge-retired-${randomUUID()}`);
  const nodes = [];
  for (const name of ['Retired Ada One', 'Retired Ada Two']) {
    const id = randomUUID() as KnowledgeNodeId;
    await persistence.transaction(transaction =>
      transaction.saveKnowledgeNode({
        projectId: project.id,
        id,
        type: 'person',
        name,
        attributes: {},
        status: 'confirmed',
        expectedVersion: null,
      }),
    );
    const current = await persistence.read(reader => reader.getKnowledgeNode(project.id, id));
    await persistence.transaction(transaction =>
      transaction.saveKnowledgeNode({
        projectId: project.id,
        id,
        type: 'person',
        name,
        attributes: {},
        status: 'retired',
        expectedVersion: current!.version,
      }),
    );
    nodes.push(await persistence.read(reader => reader.getKnowledgeNode(project.id, id)));
  }
  const firstPage = await persistence.read(reader =>
    reader.searchKnowledgeNodes!(project.id, { status: 'retired', query: 'Ada', limit: 1 }),
  );
  assert.equal(firstPage.length, 1);
  const secondPage = await persistence.read(reader =>
    reader.searchKnowledgeNodes!(project.id, {
      status: 'retired',
      query: 'Ada',
      limit: 10,
      after: { name: firstPage[0]!.name, id: firstPage[0]!.id },
    }),
  );
  assert.deepEqual(
    [firstPage[0], ...secondPage].map(node => node.id),
    nodes.map(node => node!.id),
  );
  assert.deepEqual(await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { status: 'confirmed', limit: 10 })), []);
  assert.deepEqual(await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { limit: 10 })), []);
});

test('Knowledge keyset cursors use PostgreSQL lower semantics and preserve custom node types', async () => {
  const project = await createProject(`knowledge-unicode-${randomUUID()}`);
  const names = ['İstanbul', 'istanbul', 'Istanbul', 'ıstanbul'];
  const ids = names.map(() => randomUUID() as KnowledgeNodeId);
  await persistence.transaction(async transaction => {
    for (let index = 0; index < names.length; index += 1) {
      await transaction.saveKnowledgeNode({
        projectId: project.id,
        id: ids[index]!,
        type: 'my_custom_type',
        name: names[index]!,
        attributes: {},
        status: 'confirmed',
        expectedVersion: null,
      });
    }
  });
  const all = await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { limit: 10 }));
  assert.deepEqual(
    all.map(node => node.type),
    names.map(() => 'my_custom_type'),
  );
  const paged: KnowledgeNodeId[] = [];
  let after: { name: string; id: KnowledgeNodeId } | undefined;
  for (let count = 0; count < names.length; count++) {
    const page = await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { limit: 1, after }));
    assert.equal(page.length, 1);
    const last = page[0]!;
    paged.push(last.id);
    after = { name: last.name, id: last.id };
  }
  assert.deepEqual(await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { limit: 1, after })), []);
  assert.deepEqual(
    paged,
    all.map(node => node.id),
  );
  assert.deepEqual(new Set(paged), new Set(ids));
  const custom = await persistence.read(reader => reader.searchKnowledgeNodes!(project.id, { type: 'my_custom_type', limit: 10 }));
  assert.equal(custom.length, names.length);
});

test('[TEST-DATA-003-001] database foreign keys prevent Knowledge relations from crossing projects', async () => {
  const firstProject = await createProject(`scope-a-${randomUUID()}`);
  const secondProject = await createProject(`scope-b-${randomUUID()}`);
  const firstNodeId = randomUUID() as KnowledgeNodeId;
  const secondNodeId = randomUUID() as KnowledgeNodeId;
  await persistence.transaction(async transaction => {
    await transaction.saveKnowledgeNode({
      projectId: firstProject.id,
      id: firstNodeId,
      type: 'character',
      name: 'First',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveKnowledgeNode({
      projectId: secondProject.id,
      id: secondNodeId,
      type: 'character',
      name: 'Second',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
  });

  await assert.rejects(
    directPool.query(
      `INSERT INTO knowledge_relation(project_id, id, source_id, target_id, type, attributes, validity, status)
       VALUES ($1, $2, $3, $4, 'knows', '{}'::jsonb, '{}'::jsonb, 'proposed')`,
      [firstProject.id, randomUUID(), firstNodeId, secondNodeId],
    ),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23503'),
  );
});

test('[TEST-DATA-002-002] UTF-16 edits, idempotency, revision restoration and stale-head conflicts', async () => {
  const project = await createProject(`revision-${randomUUID()}`);
  const originalMarkdown = '前😀\uFE0F章 e\u0301\r\n';
  const initial = await createDocument(project.id, originalMarkdown);
  const insertionPoint = originalMarkdown.indexOf('章');
  const editedMarkdown = `${originalMarkdown.slice(0, insertionPoint)}改${originalMarkdown.slice(insertionPoint)}`;
  const command = saveCommand(
    project.id,
    initial.document.id,
    initial.revision.id,
    editedMarkdown,
    [{ fromUtf16: insertionPoint, toUtf16: insertionPoint, insert: '改' }],
    'save-once',
  );

  const saved = await persistence.transaction(transaction => transaction.saveDocument(command));
  const replay = await persistence.transaction(transaction => transaction.saveDocument(command));
  assert.equal(saved.revision.markdown, editedMarkdown);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision.id, saved.revision.id);
  assert.equal(replay.document.headRevisionId, saved.revision.id);

  const badOffset = editedMarkdown.indexOf('😀') + 1;
  const invalidCommand = saveCommand(
    project.id,
    initial.document.id,
    saved.revision.id,
    `${editedMarkdown.slice(0, badOffset)}?${editedMarkdown.slice(badOffset)}`,
    [{ fromUtf16: badOffset, toUtf16: badOffset, insert: '?' }],
    'split-surrogate',
  );
  await assert.rejects(
    persistence.transaction(transaction => transaction.saveDocument(invalidCommand)),
    (error: unknown) => error instanceof PersistenceError && error.code === 'validation',
  );

  const restored = await persistence.transaction(transaction =>
    transaction.restoreDocumentRevision({
      projectId: project.id,
      documentId: initial.document.id,
      baseRevisionId: saved.revision.id,
      sourceRevisionId: initial.revision.id,
      authorId: 'author',
      idempotencyKey: 'restore-once',
    }),
  );
  assert.equal(restored.revision.markdown, originalMarkdown);
  assert.equal(restored.revision.parentRevisionId, saved.revision.id);
  assert.notEqual(restored.revision.id, initial.revision.id);

  const replayAfterRestore = await persistence.transaction(transaction => transaction.saveDocument(command));
  assert.equal(replayAfterRestore.replayed, true);
  assert.equal(replayAfterRestore.document.headRevisionId, saved.revision.id);
  assert.equal(
    (await persistence.read(reader => reader.getDocument(project.id, initial.document.id)))?.headRevisionId,
    restored.revision.id,
  );

  const firstPage = await persistence.read(reader => reader.listRevisions(project.id, initial.document.id, 1));
  assert.equal(firstPage.revisions.length, 1);
  assert.ok(firstPage.nextBefore);
  const secondPage = await persistence.read(reader =>
    reader.listRevisions(project.id, initial.document.id, 1, firstPage.nextBefore ?? undefined),
  );
  assert.equal(secondPage.revisions.length, 1);
  assert.notEqual(firstPage.revisions[0]?.id, secondPage.revisions[0]?.id);

  await assert.rejects(
    persistence.transaction(transaction =>
      transaction.saveDocument({ ...command, idempotencyKey: 'save-once', changes: [], resultingSha256: sha256('') }),
    ),
    (error: unknown) => error instanceof PersistenceError && error.code === 'idempotency_conflict',
  );
});

test('native restore of identical text keeps confirmed evidence and mentions', async () => {
  const project = await createProject(`native-restore-anchor-${randomUUID()}`);
  const initial = await createDocument(project.id, 'ABCDEF');
  const evidenceId = randomUUID() as EvidenceId;
  const nodeId = randomUUID() as KnowledgeNodeId;
  await persistence.transaction(async transaction => {
    await transaction.saveKnowledgeNode({
      projectId: project.id,
      id: nodeId,
      type: 'character',
      name: 'Entity',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: evidenceId,
      documentId: initial.document.id,
      revisionId: initial.revision.id,
      fromUtf16: 1,
      toUtf16: 3,
      quoteSha256: sha256('BC'),
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveMentionLink({
      projectId: project.id,
      evidenceId,
      nodeId,
      status: 'confirmed',
      source: 'author',
      confidence: 1,
      extractorVersion: null,
    });
  });
  const duplicate = await persistence.transaction(transaction =>
    transaction.saveDocument(saveCommand(project.id, initial.document.id, initial.revision.id, 'ABCDEF', [], 'native-identical-save')),
  );
  const restored = await persistence.transaction(transaction =>
    transaction.restoreDocumentRevision({
      projectId: project.id,
      documentId: initial.document.id,
      baseRevisionId: duplicate.revision.id,
      sourceRevisionId: initial.revision.id,
      authorId: 'author',
      idempotencyKey: 'native-identical-restore',
    }),
  );
  const state = await persistence.read(async reader => ({
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    links: await reader.listMentionLinks(project.id, evidenceId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
  }));
  assert.equal(restored.revision.markdown, 'ABCDEF');
  assert.equal(state.anchor?.revisionId, restored.revision.id);
  assert.equal(state.anchor?.fromUtf16, 1);
  assert.equal(state.anchor?.toUtf16, 3);
  assert.equal(state.anchor?.quoteSha256, sha256('BC'));
  assert.equal(state.anchor?.status, 'confirmed');
  assert.equal(state.links[0]?.status, 'confirmed');
  assert.equal(state.history.length, 3);

  const changedSource = await createDocument(project.id, 'ABXDEF');
  const changed = await persistence.transaction(transaction =>
    transaction.saveDocument(
      saveCommand(
        project.id,
        changedSource.document.id,
        changedSource.revision.id,
        'ABCDEF',
        [{ fromUtf16: 2, toUtf16: 3, insert: 'C' }],
        'native-changed-save',
      ),
    ),
  );
  const changedEvidence = randomUUID() as EvidenceId;
  const changedNode = randomUUID() as KnowledgeNodeId;
  await persistence.transaction(async transaction => {
    await transaction.saveKnowledgeNode({
      projectId: project.id,
      id: changedNode,
      type: 'character',
      name: 'Changed entity',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: changedEvidence,
      documentId: changedSource.document.id,
      revisionId: changed.revision.id,
      fromUtf16: 1,
      toUtf16: 3,
      quoteSha256: sha256('BC'),
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveMentionLink({
      projectId: project.id,
      evidenceId: changedEvidence,
      nodeId: changedNode,
      status: 'confirmed',
      source: 'author',
      confidence: 1,
      extractorVersion: null,
    });
  });
  const changedRestore = await persistence.transaction(transaction =>
    transaction.restoreDocumentRevision({
      projectId: project.id,
      documentId: changedSource.document.id,
      baseRevisionId: changed.revision.id,
      sourceRevisionId: changedSource.revision.id,
      authorId: 'author',
      idempotencyKey: 'native-changed-restore',
    }),
  );
  const changedState = await persistence.read(async reader => ({
    anchor: await reader.getEvidenceAnchor(project.id, changedEvidence),
    links: await reader.listMentionLinks(project.id, changedEvidence),
  }));
  assert.equal(changedRestore.revision.markdown, 'ABXDEF');
  assert.equal(changedState.anchor?.status, 'needs_review');
  assert.equal(changedState.links[0]?.status, 'proposed');
});

test('native restore retains confirmed evidence across an unambiguous edit outside its range', async () => {
  const project = await createProject(`native-restore-unaffected-${randomUUID()}`);
  const initial = await createDocument(project.id, '😀文🧭証拠');
  const edited = await persistence.transaction(transaction =>
    transaction.saveDocument(
      saveCommand(project.id, initial.document.id, initial.revision.id, '😁🪶文🧭証拠', [{ fromUtf16: 0, toUtf16: 2, insert: '😁🪶' }]),
    ),
  );
  const evidenceId = randomUUID() as EvidenceId;
  const editedEvidenceId = randomUUID() as EvidenceId;
  const nodeId = randomUUID() as KnowledgeNodeId;
  await persistence.transaction(async transaction => {
    await transaction.saveKnowledgeNode({
      projectId: project.id,
      id: nodeId,
      type: 'character',
      name: 'Entity',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: evidenceId,
      documentId: initial.document.id,
      revisionId: edited.revision.id,
      fromUtf16: 5,
      toUtf16: 9,
      quoteSha256: sha256('🧭証拠'),
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: editedEvidenceId,
      documentId: initial.document.id,
      revisionId: edited.revision.id,
      fromUtf16: 2,
      toUtf16: 4,
      quoteSha256: sha256('🪶'),
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveMentionLink({
      projectId: project.id,
      evidenceId,
      nodeId,
      status: 'confirmed',
      source: 'author',
      confidence: 1,
      extractorVersion: null,
    });
  });

  const restored = await persistence.transaction(transaction =>
    transaction.restoreDocumentRevision({
      projectId: project.id,
      documentId: initial.document.id,
      baseRevisionId: edited.revision.id,
      sourceRevisionId: initial.revision.id,
      authorId: 'author',
      idempotencyKey: randomUUID(),
    }),
  );
  const state = await persistence.read(async reader => ({
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    editedAnchor: await reader.getEvidenceAnchor(project.id, editedEvidenceId),
    link: await reader.getMentionLink(project.id, evidenceId, nodeId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
  }));
  assert.equal(restored.revision.markdown, '😀文🧭証拠');
  assert.equal(state.anchor?.revisionId, restored.revision.id);
  assert.equal(state.anchor?.fromUtf16, 3);
  assert.equal(state.anchor?.toUtf16, 7);
  assert.equal(state.anchor?.quoteSha256, sha256('🧭証拠'));
  assert.equal(state.anchor?.status, 'confirmed');
  assert.equal(state.link?.status, 'confirmed');
  assert.equal(state.history.length, 2);
  assert.equal(state.history[1]?.revisionId, restored.revision.id);
  assert.equal(state.history[1]?.status, 'confirmed');
  assert.equal(state.editedAnchor?.status, 'needs_review');
  assert.equal(state.editedAnchor?.fromUtf16, 0);
  assert.equal(state.editedAnchor?.toUtf16, 2);
  assert.equal(state.editedAnchor?.quoteSha256, sha256('😀'));
});

test('native restore requires review when repeating text makes the retained anchor ambiguous', async () => {
  const project = await createProject(`native-restore-ambiguous-${randomUUID()}`);
  const initial = await createDocument(project.id, '前🧭後');
  const edited = await persistence.transaction(transaction =>
    transaction.saveDocument(
      saveCommand(project.id, initial.document.id, initial.revision.id, '前🧭🧭後', [{ fromUtf16: 3, toUtf16: 3, insert: '🧭' }]),
    ),
  );
  const evidenceId = randomUUID() as EvidenceId;
  await persistence.transaction(transaction =>
    transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: evidenceId,
      documentId: initial.document.id,
      revisionId: edited.revision.id,
      fromUtf16: 1,
      toUtf16: 3,
      quoteSha256: sha256('🧭'),
      status: 'confirmed',
      expectedVersion: null,
    }),
  );

  const restored = await persistence.transaction(transaction =>
    transaction.restoreDocumentRevision({
      projectId: project.id,
      documentId: initial.document.id,
      baseRevisionId: edited.revision.id,
      sourceRevisionId: initial.revision.id,
      authorId: 'author',
      idempotencyKey: randomUUID(),
    }),
  );
  const anchor = await persistence.read(reader => reader.getEvidenceAnchor(project.id, evidenceId));
  assert.equal(anchor?.revisionId, restored.revision.id);
  assert.equal(anchor?.status, 'needs_review');
  assert.equal(anchor?.fromUtf16, 1);
  assert.equal(anchor?.toUtf16, 3);
});

test('document saves advance persistent anchors atomically and revoke stale mention confirmation', async () => {
  const project = await createProject(`anchor-follow-${randomUUID()}`);
  const initial = await createDocument(project.id, '前文 東京 の後文');
  const quoteStart = initial.revision.markdown.indexOf('東京');
  const nodeId = randomUUID() as KnowledgeNodeId;
  const evidenceId = randomUUID() as EvidenceId;
  await persistence.transaction(async transaction => {
    await transaction.saveKnowledgeNode({
      projectId: project.id,
      id: nodeId,
      type: 'character',
      name: '東京',
      attributes: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: evidenceId,
      documentId: initial.document.id,
      revisionId: initial.revision.id,
      fromUtf16: quoteStart,
      toUtf16: quoteStart + '東京'.length,
      quoteSha256: sha256('東京'),
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveMentionLink({
      projectId: project.id,
      evidenceId,
      nodeId,
      status: 'confirmed',
      source: 'author',
      confidence: 1,
      extractorVersion: null,
    });
  });

  const prefix = '😀追記';
  const afterPrefix = `${prefix}${initial.revision.markdown}`;
  const prefixSave = saveCommand(
    project.id,
    initial.document.id,
    initial.revision.id,
    afterPrefix,
    [{ fromUtf16: 0, toUtf16: 0, insert: prefix }],
    'anchor-shift',
  );
  const shifted = await persistence.transaction(transaction => transaction.saveDocument(prefixSave));
  let evidence = await persistence.read(async reader => ({
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    links: await reader.listMentionLinks(project.id, evidenceId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
    documentAnchors: await reader.listDocumentEvidence(project.id, initial.document.id, shifted.revision.id),
  }));
  assert.equal(evidence.anchor?.revisionId, shifted.revision.id);
  assert.equal(evidence.anchor?.fromUtf16, quoteStart + prefix.length);
  assert.equal(evidence.anchor?.toUtf16, quoteStart + prefix.length + '東京'.length);
  assert.equal(evidence.anchor?.status, 'confirmed');
  assert.equal(evidence.links[0]?.status, 'confirmed');
  assert.equal(evidence.history.length, 2);

  const range = { fromUtf16: evidence.anchor!.fromUtf16, toUtf16: evidence.anchor!.toUtf16 };
  const afterReplacement = `${afterPrefix.slice(0, range.fromUtf16)}大阪${afterPrefix.slice(range.toUtf16)}`;
  const replacementSave = saveCommand(
    project.id,
    initial.document.id,
    shifted.revision.id,
    afterReplacement,
    [{ ...range, insert: '大阪' }],
    'anchor-needs-review',
  );
  const reviewed = await persistence.transaction(transaction => transaction.saveDocument(replacementSave));
  evidence = await persistence.read(async reader => ({
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    links: await reader.listMentionLinks(project.id, evidenceId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
    documentAnchors: await reader.listDocumentEvidence(project.id, initial.document.id, reviewed.revision.id),
  }));
  assert.equal(evidence.anchor?.revisionId, reviewed.revision.id);
  assert.equal(evidence.anchor?.status, 'needs_review');
  assert.equal(evidence.anchor?.quoteSha256, sha256('大阪'));
  assert.equal(evidence.links[0]?.status, 'proposed');
  assert.equal(evidence.history.length, 3);

  const currentAnchor = evidence.anchor!;
  const afterDelete = `${afterReplacement.slice(0, currentAnchor.fromUtf16)}${afterReplacement.slice(currentAnchor.toUtf16)}`;
  const deleteSave = saveCommand(
    project.id,
    initial.document.id,
    reviewed.revision.id,
    afterDelete,
    [{ fromUtf16: currentAnchor.fromUtf16, toUtf16: currentAnchor.toUtf16, insert: '' }],
    'anchor-orphaned',
  );
  const deleted = await persistence.transaction(transaction => transaction.saveDocument(deleteSave));
  evidence = await persistence.read(async reader => ({
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    links: await reader.listMentionLinks(project.id, evidenceId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
    documentAnchors: await reader.listDocumentEvidence(project.id, initial.document.id, deleted.revision.id),
  }));
  assert.equal(evidence.anchor?.revisionId, deleted.revision.id);
  assert.equal(evidence.anchor?.status, 'orphaned');
  assert.equal(evidence.anchor?.fromUtf16, evidence.anchor?.toUtf16);
  assert.equal(evidence.history.length, 4);
  assert.equal(evidence.documentAnchors[0]?.status, 'orphaned');
});

test('compound edits keep adjacent replacements outside the evidence they delete or revise', async () => {
  const project = await createProject('adjacent evidence edits');
  for (const replacement of ['', '新']) {
    const initial = await createDocument(project.id, 'abc');
    const id = randomUUID() as EvidenceId;
    await persistence.transaction(tx =>
      tx.saveEvidenceAnchor({
        projectId: project.id,
        id,
        documentId: initial.document.id,
        revisionId: initial.revision.id,
        fromUtf16: 1,
        toUtf16: 2,
        quoteSha256: sha256('b'),
        status: 'confirmed',
        expectedVersion: null,
      }),
    );
    const markdown = '前😀' + replacement + '後';
    const command = saveCommand(project.id, initial.document.id, initial.revision.id, markdown, [
      { fromUtf16: 0, toUtf16: 1, insert: '前' },
      { fromUtf16: 1, toUtf16: 1, insert: '😀' },
      { fromUtf16: 1, toUtf16: 2, insert: replacement },
      { fromUtf16: 2, toUtf16: 3, insert: '後' },
    ]);
    const saved = await persistence.transaction(tx => tx.saveDocument(command));
    const anchor = await persistence.read(reader => reader.getEvidenceAnchor(project.id, id));
    assert.ok(anchor);
    assert.equal(anchor.revisionId, saved.revision.id);
    assert.equal(anchor.status, replacement ? 'needs_review' : 'orphaned');
    assert.deepEqual([anchor.fromUtf16, anchor.toUtf16], [3, 3 + replacement.length]);
    assert.equal(anchor.quoteSha256, sha256(replacement || 'b'));
  }
});

test('concurrent exact retries replay one document creation and one edit', async () => {
  const project = await createProject(`retry-${randomUUID()}`);
  const creation: CreateDocumentCommand = {
    projectId: project.id,
    kind: 'scene',
    title: 'Retry-safe',
    orderKey: '0001',
    markdown: 'original',
    authorId: 'author',
    idempotencyKey: `create-${randomUUID()}`,
  };
  const created = await Promise.all([
    persistence.transaction(tx => tx.createDocument(creation)),
    persistence.transaction(tx => tx.createDocument(creation)),
  ]);
  assert.equal(created[0]!.document.id, created[1]!.document.id);
  assert.equal(created[0]!.revision.id, created[1]!.revision.id);
  assert.deepEqual(created.map(x => x.replayed).sort(), [false, true]);

  const command = saveCommand(
    project.id,
    created[0]!.document.id,
    created[0]!.revision.id,
    'original edited',
    [{ fromUtf16: 8, toUtf16: 8, insert: ' edited' }],
    `save-${randomUUID()}`,
  );
  const saved = await Promise.all([
    persistence.transaction(tx => tx.saveDocument(command)),
    persistence.transaction(tx => tx.saveDocument(command)),
  ]);
  assert.equal(saved[0]!.revision.id, saved[1]!.revision.id);
  assert.deepEqual(saved.map(x => x.replayed).sort(), [false, true]);
  const history = await persistence.read(reader => reader.listRevisions(project.id, created[0]!.document.id, 10));
  assert.equal(history.revisions.length, 2);
});

test('concurrent document saves use compare-and-swap on the observed revision', async () => {
  const project = await createProject(`concurrency-${randomUUID()}`);
  const initial = await createDocument(project.id, 'base');
  const left = saveCommand(project.id, initial.document.id, initial.revision.id, 'leftbase', [
    { fromUtf16: 0, toUtf16: 0, insert: 'left' },
  ]);
  const right = saveCommand(project.id, initial.document.id, initial.revision.id, 'baseright', [
    { fromUtf16: 4, toUtf16: 4, insert: 'right' },
  ]);
  const results = await Promise.allSettled([
    persistence.transaction(transaction => transaction.saveDocument(left)),
    persistence.transaction(transaction => transaction.saveDocument(right)),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof PersistenceError);
  assert.equal(rejected.reason.code, 'conflict');

  const winner = results.find(result => result.status === 'fulfilled');
  assert.ok(winner);
  const durable = await persistence.read(async reader => ({
    head: await reader.getDocument(project.id, initial.document.id),
    history: await reader.listRevisions(project.id, initial.document.id, 10),
  }));
  assert.equal(durable.head?.headRevisionId, winner.value.revision.id);
  assert.deepEqual(
    durable.history.revisions.map(revision => revision.id),
    [winner.value.revision.id, initial.revision.id],
  );
});

test('transaction failures roll back document, revision and idempotency rows', async () => {
  const project = await createProject(`rollback-${randomUUID()}`);
  const beforeProject = await persistence.read(reader => reader.getProject(project.id));
  const documentId = randomUUID() as DocumentId;
  const command: CreateDocumentCommand = {
    projectId: project.id,
    documentId,
    kind: 'scene',
    title: 'Rolled back',
    orderKey: '0001',
    markdown: 'rollback body',
    authorId: 'author',
    idempotencyKey: 'rollback-create',
  };

  await assert.rejects(
    persistence.transaction(async transaction => {
      await transaction.createDocument(command);
      throw new Error('force rollback');
    }),
    /force rollback/u,
  );
  assert.equal(await persistence.read(reader => reader.getDocument(project.id, documentId)), undefined);
  assert.equal((await persistence.read(reader => reader.getProject(project.id)))?.version, beforeProject?.version);

  const retried = await persistence.transaction(transaction => transaction.createDocument(command));
  assert.equal(retried.document.id, documentId);
  assert.equal(retried.replayed, false);
});

test('ChangeSet application is atomic, versioned and idempotent', async () => {
  const project = await createProject(`changeset-${randomUUID()}`);
  const document = await createDocument(project.id, 'Evidence text');
  const failedNodeId = randomUUID() as KnowledgeNodeId;
  const failedChange = await persistence.transaction(transaction =>
    transaction.createChangeSet({
      projectId: project.id,
      authorId: 'author',
      idempotencyKey: 'failed-change-set',
      readSet: [],
      writeSet: [
        { resource: 'knowledge_node', id: failedNodeId },
        { resource: 'document', id: document.document.id },
      ],
      provenance: { source: 'author', actorId: 'author', details: { purpose: 'rollback test' } },
      operations: [
        {
          type: 'knowledge.node.save',
          command: {
            projectId: project.id,
            id: failedNodeId,
            type: 'character',
            name: 'Temporary',
            attributes: {},
            status: 'proposed',
            expectedVersion: null,
          },
        },
        {
          type: 'document.save',
          command: saveCommand(project.id, document.document.id, randomUUID() as RevisionId, 'bad', [], 'stale-save'),
        },
      ],
    }),
  );
  const approvedFailure = await persistence.transaction(transaction =>
    transaction.approveChangeSet({
      projectId: project.id,
      changeSetId: failedChange.changeSet.id,
      expectedVersion: failedChange.changeSet.version,
      approvedBy: 'author',
    }),
  );
  await assert.rejects(
    persistence.transaction(transaction =>
      transaction.applyChangeSet({
        projectId: project.id,
        changeSetId: approvedFailure.id,
        expectedVersion: approvedFailure.version,
      }),
    ),
    (error: unknown) => error instanceof PersistenceError && error.code === 'conflict',
  );
  assert.equal(await persistence.read(reader => reader.getKnowledgeNode(project.id, failedNodeId)), undefined);
  assert.equal((await persistence.read(reader => reader.getChangeSet(project.id, approvedFailure.id)))?.status, 'approved');

  const staleReadNodeId = randomUUID() as KnowledgeNodeId;
  const staleReadChange = await persistence.transaction(transaction =>
    transaction.createChangeSet({
      projectId: project.id,
      authorId: 'author',
      idempotencyKey: 'stale-read-set',
      operations: [
        {
          type: 'knowledge.node.save',
          command: {
            projectId: project.id,
            id: staleReadNodeId,
            type: 'character',
            name: 'Must not apply',
            attributes: {},
            status: 'proposed',
            expectedVersion: null,
          },
        },
      ],
      readSet: [
        {
          resource: 'document',
          id: document.document.id,
          expectedVersion: document.document.version,
          expectedRevisionId: randomUUID() as RevisionId,
        },
      ],
      writeSet: [{ resource: 'knowledge_node', id: staleReadNodeId }],
      provenance: { source: 'author', actorId: 'author', details: {} },
    }),
  );
  await assert.rejects(
    persistence.transaction(transaction =>
      transaction.approveChangeSet({
        projectId: project.id,
        changeSetId: staleReadChange.changeSet.id,
        expectedVersion: staleReadChange.changeSet.version,
        approvedBy: 'author',
      }),
    ),
    (error: unknown) => error instanceof PersistenceError && error.code === 'conflict',
  );
  assert.equal((await persistence.read(reader => reader.getChangeSet(project.id, staleReadChange.changeSet.id)))?.status, 'proposed');
  assert.equal(await persistence.read(reader => reader.getKnowledgeNode(project.id, staleReadNodeId)), undefined);

  const nodeId = randomUUID() as KnowledgeNodeId;
  const secondNodeId = randomUUID() as KnowledgeNodeId;
  const evidenceId = randomUUID() as EvidenceId;
  const assertionId = randomUUID() as import('@codexia/persistence-contracts').AssertionId;
  const aliasId = randomUUID() as import('@codexia/persistence-contracts').KnowledgeAliasId;
  const relationId = randomUUID() as import('@codexia/persistence-contracts').KnowledgeRelationId;
  const anchorHash = sha256(document.revision.markdown);
  const operations: ChangeSetOperation[] = [
    {
      type: 'knowledge.node.save',
      command: {
        projectId: project.id,
        id: nodeId,
        type: 'character',
        name: 'Aoi',
        attributes: { canon: true },
        status: 'confirmed',
        expectedVersion: null,
      },
    },
    {
      type: 'knowledge.node.save',
      command: {
        projectId: project.id,
        id: secondNodeId,
        type: 'place',
        name: 'Station',
        attributes: {},
        status: 'proposed',
        expectedVersion: null,
      },
    },
    {
      type: 'knowledge.alias.save',
      command: {
        projectId: project.id,
        id: aliasId,
        nodeId,
        surface: 'あおい',
        normalized: 'あおい',
        scope: null,
        status: 'confirmed',
      },
    },
    {
      type: 'knowledge.relation.save',
      command: {
        projectId: project.id,
        id: relationId,
        sourceId: nodeId,
        targetId: secondNodeId,
        type: 'visits',
        attributes: {},
        validity: {},
        status: 'confirmed',
        expectedVersion: null,
      },
    },
    {
      type: 'evidence.anchor.save',
      command: {
        projectId: project.id,
        id: evidenceId,
        documentId: document.document.id,
        revisionId: document.revision.id,
        fromUtf16: 0,
        toUtf16: document.revision.markdown.length,
        quoteSha256: anchorHash,
        status: 'confirmed',
        expectedVersion: null,
      },
    },
    {
      type: 'evidence.mention.save',
      command: {
        projectId: project.id,
        evidenceId,
        nodeId,
        status: 'confirmed',
        source: 'author',
        confidence: 1,
        extractorVersion: null,
      },
    },
    {
      type: 'evidence.assertion.save',
      command: {
        projectId: project.id,
        id: assertionId,
        proposition: { subject: nodeId, predicate: 'visited', object: secondNodeId },
        modality: 'certain',
        perspective: 'author',
        narrativeTime: { scene: document.document.id },
        confidence: null,
        status: 'confirmed',
        expectedVersion: null,
      },
    },
    {
      type: 'evidence.assertion.link',
      command: {
        projectId: project.id,
        assertionId,
        evidenceId,
        role: 'supports',
      },
    },
  ];
  const change = await persistence.transaction(transaction =>
    transaction.createChangeSet({
      projectId: project.id,
      authorId: 'author',
      idempotencyKey: 'approved-canonical-change',
      operations,
      readSet: [
        {
          resource: 'document',
          id: document.document.id,
          expectedVersion: document.document.version,
          expectedRevisionId: document.revision.id,
        },
      ],
      writeSet: [
        { resource: 'knowledge_node', id: nodeId },
        { resource: 'knowledge_node', id: secondNodeId },
        { resource: 'knowledge_alias', id: aliasId },
        { resource: 'knowledge_relation', id: relationId },
        { resource: 'evidence_anchor', id: evidenceId },
        { resource: 'mention_link', id: `${evidenceId}:${nodeId}` },
        { resource: 'assertion', id: assertionId },
        { resource: 'assertion_evidence', id: `${assertionId}:${evidenceId}` },
      ],
      provenance: { source: 'author', actorId: 'author', details: { reason: 'reviewed narrative fact' } },
    }),
  );
  const replayedProposal = await persistence.transaction(transaction =>
    transaction.createChangeSet({
      projectId: project.id,
      authorId: 'author',
      idempotencyKey: 'approved-canonical-change',
      operations,
      readSet: [
        {
          resource: 'document',
          id: document.document.id,
          expectedVersion: document.document.version,
          expectedRevisionId: document.revision.id,
        },
      ],
      writeSet: [
        { resource: 'knowledge_node', id: nodeId },
        { resource: 'knowledge_node', id: secondNodeId },
        { resource: 'knowledge_alias', id: aliasId },
        { resource: 'knowledge_relation', id: relationId },
        { resource: 'evidence_anchor', id: evidenceId },
        { resource: 'mention_link', id: `${evidenceId}:${nodeId}` },
        { resource: 'assertion', id: assertionId },
        { resource: 'assertion_evidence', id: `${assertionId}:${evidenceId}` },
      ],
      provenance: { source: 'author', actorId: 'author', details: { reason: 'reviewed narrative fact' } },
    }),
  );
  assert.equal(replayedProposal.replayed, true);

  const approved = await persistence.transaction(transaction =>
    transaction.approveChangeSet({
      projectId: project.id,
      changeSetId: change.changeSet.id,
      expectedVersion: change.changeSet.version,
      approvedBy: 'author',
    }),
  );
  const applied = await persistence.transaction(transaction =>
    transaction.applyChangeSet({
      projectId: project.id,
      changeSetId: approved.id,
      expectedVersion: approved.version,
    }),
  );
  assert.equal(applied.changeSet.status, 'applied');
  assert.equal(applied.results.length, operations.length);
  const replayedApplication = await persistence.transaction(transaction =>
    transaction.applyChangeSet({
      projectId: project.id,
      changeSetId: approved.id,
      expectedVersion: approved.version,
    }),
  );
  assert.equal(replayedApplication.replayed, true);

  const readBack = await persistence.read(async reader => ({
    node: await reader.getKnowledgeNode(project.id, nodeId),
    aliases: await reader.listKnowledgeAliases(project.id, nodeId),
    relations: await reader.listKnowledgeRelations(project.id, nodeId),
    anchor: await reader.getEvidenceAnchor(project.id, evidenceId),
    history: await reader.listEvidenceHistory(project.id, evidenceId),
    mentions: await reader.listMentionLinks(project.id, evidenceId),
    assertion: await reader.getAssertion(project.id, assertionId),
    assertionEvidence: await reader.listAssertionEvidence(project.id, assertionId),
    appliedChangeSet: await reader.getChangeSet(project.id, change.changeSet.id),
  }));
  assert.equal(readBack.node?.status, 'confirmed');
  assert.equal(readBack.aliases.length, 1);
  assert.equal(readBack.relations.length, 1);
  assert.equal(readBack.anchor?.revisionId, document.revision.id);
  assert.equal(readBack.history.length, 1);
  assert.equal(readBack.mentions[0]?.nodeId, nodeId);
  assert.equal(readBack.assertion?.status, 'confirmed');
  assert.equal(readBack.assertionEvidence[0]?.role, 'supports');
  assert.equal(readBack.appliedChangeSet?.provenance.source, 'author');
  assert.equal(readBack.appliedChangeSet?.readSet[0]?.expectedRevisionId, document.revision.id);
  assert.equal(readBack.appliedChangeSet?.writeSet.length, operations.length);

  await persistence.transaction(async transaction => {
    await transaction.saveKnowledgeAlias({
      projectId: project.id,
      id: randomUUID() as import('@codexia/persistence-contracts').KnowledgeAliasId,
      nodeId,
      surface: 'Aoi',
      normalized: 'aoi',
      scope: null,
      status: 'confirmed',
    });
    await transaction.saveKnowledgeAlias({
      projectId: project.id,
      id: randomUUID() as import('@codexia/persistence-contracts').KnowledgeAliasId,
      nodeId: secondNodeId,
      surface: 'Station',
      normalized: 'station',
      scope: null,
      status: 'confirmed',
    });
    await transaction.saveMentionLink({
      projectId: project.id,
      evidenceId,
      nodeId: secondNodeId,
      status: 'confirmed',
      source: 'author',
      confidence: 1,
      extractorVersion: null,
    });
  });
  const historicalDocument = await createDocument(project.id, 'Historical source quote');
  const latestHistoricalBody = 'A later revision has different text';
  const historicalEvidenceId = randomUUID() as EvidenceId;
  await persistence.transaction(async transaction => {
    await transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: historicalEvidenceId,
      documentId: historicalDocument.document.id,
      revisionId: historicalDocument.revision.id,
      fromUtf16: 0,
      toUtf16: historicalDocument.revision.markdown.length,
      quoteSha256: sha256(historicalDocument.revision.markdown),
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveMentionLink({
      projectId: project.id,
      evidenceId: historicalEvidenceId,
      nodeId,
      status: 'confirmed',
      source: 'author',
      confidence: 1,
      extractorVersion: null,
    });
  });
  const latestHistoricalRevision = await persistence.transaction(transaction =>
    transaction.saveDocument(
      saveCommand(project.id, historicalDocument.document.id, historicalDocument.revision.id, latestHistoricalBody, [
        { fromUtf16: 0, toUtf16: historicalDocument.revision.markdown.length, insert: latestHistoricalBody },
      ]),
    ),
  );

  // Both anchors have two assertion links, including a shared assertion.
  // A global LIMIT 1 would lose one parent; deduplication must not lose links.
  const additionalAssertionId = randomUUID() as import('@codexia/persistence-contracts').AssertionId;
  await persistence.transaction(async transaction => {
    await transaction.saveAssertion({
      projectId: project.id,
      id: additionalAssertionId,
      proposition: { subject: nodeId, predicate: 'recalls', object: secondNodeId },
      modality: 'certain',
      perspective: 'author',
      narrativeTime: {},
      confidence: null,
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.linkAssertionEvidence({ projectId: project.id, assertionId, evidenceId: historicalEvidenceId, role: 'supports' });
    for (const selectedEvidenceId of [evidenceId, historicalEvidenceId]) {
      await transaction.linkAssertionEvidence({
        projectId: project.id,
        assertionId: additionalAssertionId,
        evidenceId: selectedEvidenceId,
        role: 'supports',
      });
    }
  });
  // UUIDs are project-scoped, not globally unique. Seed colliding identities
  // and a foreign-only node with real dependent records in another project.
  const foreignProject = await createProject('Foreign batch projection');
  const foreignDocument = await createDocument(foreignProject.id, 'Foreign evidence must not enter the selected project');
  const foreignOnlyNodeId = randomUUID() as KnowledgeNodeId;
  await persistence.transaction(async transaction => {
    for (const id of [nodeId, foreignOnlyNodeId]) {
      await transaction.saveKnowledgeNode({
        projectId: foreignProject.id,
        id,
        type: 'character',
        name: 'Foreign node',
        attributes: {},
        status: 'confirmed',
        expectedVersion: null,
      });
      await transaction.saveKnowledgeAlias({
        projectId: foreignProject.id,
        id: randomUUID() as import('@codexia/persistence-contracts').KnowledgeAliasId,
        nodeId: id,
        surface: 'Foreign',
        normalized: 'foreign',
        scope: null,
        status: 'confirmed',
      });
    }
    await transaction.saveKnowledgeRelation({
      projectId: foreignProject.id,
      id: relationId,
      sourceId: nodeId,
      targetId: foreignOnlyNodeId,
      type: 'visits',
      attributes: {},
      validity: {},
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.saveEvidenceAnchor({
      projectId: foreignProject.id,
      id: evidenceId,
      documentId: foreignDocument.document.id,
      revisionId: foreignDocument.revision.id,
      fromUtf16: 0,
      toUtf16: foreignDocument.revision.markdown.length,
      quoteSha256: sha256(foreignDocument.revision.markdown),
      status: 'confirmed',
      expectedVersion: null,
    });
    for (const id of [nodeId, foreignOnlyNodeId]) {
      await transaction.saveMentionLink({
        projectId: foreignProject.id,
        evidenceId,
        nodeId: id,
        status: 'confirmed',
        source: 'author',
        confidence: 1,
        extractorVersion: null,
      });
    }
    await transaction.saveAssertion({
      projectId: foreignProject.id,
      id: assertionId,
      proposition: { subject: 'foreign' },
      modality: 'certain',
      perspective: 'author',
      narrativeTime: {},
      confidence: null,
      status: 'confirmed',
      expectedVersion: null,
    });
    await transaction.linkAssertionEvidence({ projectId: foreignProject.id, assertionId, evidenceId, role: 'supports' });
  });

  const batchComparison = await persistence.read(async reader => {
    assert.ok(reader.readKnowledgeProjectionBatch);
    const readBatch = reader.readKnowledgeProjectionBatch.bind(reader);
    const limits = { aliasesPerNode: 1, relationsPerNode: 1, mentionsPerNode: 2, assertionsPerAnchor: 1 };
    const nodeIds = [nodeId, secondNodeId];
    const compare = async (selectedNodeIds: readonly KnowledgeNodeId[]) => {
      const batch = await readBatch(project.id, selectedNodeIds, limits);
      const singles = {
        aliases: [] as KnowledgeProjectionBatch['aliases'][number][],
        relations: [] as KnowledgeProjectionBatch['relations'][number][],
        mentions: [] as KnowledgeProjectionBatch['mentions'][number][],
        anchors: [] as KnowledgeProjectionBatch['anchors'][number][],
        revisions: [] as KnowledgeProjectionBatch['revisions'][number][],
        assertionEvidence: [] as KnowledgeProjectionBatch['assertionEvidence'][number][],
        assertions: [] as KnowledgeProjectionBatch['assertions'][number][],
      };
      for (const selectedNodeId of new Set(selectedNodeIds)) {
        for (const alias of await reader.listKnowledgeAliases(project.id, selectedNodeId, limits.aliasesPerNode)) {
          singles.aliases.push({ nodeId: selectedNodeId, alias });
        }
        for (const relation of await reader.listKnowledgeRelations(project.id, selectedNodeId, limits.relationsPerNode)) {
          singles.relations.push({ nodeId: selectedNodeId, relation });
        }
        singles.mentions.push(...(await reader.listNodeMentions(project.id, selectedNodeId, limits.mentionsPerNode)));
      }
      const revisions = new Set<string>();
      const assertions = new Set<string>();
      for (const evidenceId of [...new Set(singles.mentions.map(mention => mention.evidenceId))].sort()) {
        const anchor = await reader.getEvidenceAnchor(project.id, evidenceId);
        if (!anchor) continue;
        singles.anchors.push(anchor);
        const revisionKey = JSON.stringify([anchor.documentId, anchor.revisionId]);
        if (!revisions.has(revisionKey)) {
          revisions.add(revisionKey);
          const revision = await reader.getRevision(project.id, anchor.documentId, anchor.revisionId);
          if (revision) singles.revisions.push(revision);
        }
        for (const link of await reader.listEvidenceAssertions(project.id, evidenceId, limits.assertionsPerAnchor)) {
          singles.assertionEvidence.push({ evidenceId, link });
          if (!assertions.has(link.assertionId)) {
            assertions.add(link.assertionId);
            const assertion = await reader.getAssertion(project.id, link.assertionId);
            if (assertion) singles.assertions.push(assertion);
          }
        }
      }
      const sorted = (value: KnowledgeProjectionBatch): KnowledgeProjectionBatch => {
        const byJson = <T>(rows: readonly T[]): T[] =>
          [...rows].sort((left, right) => (JSON.stringify(left) ?? '').localeCompare(JSON.stringify(right) ?? ''));
        return {
          aliases: byJson(value.aliases),
          relations: byJson(value.relations),
          mentions: byJson(value.mentions),
          anchors: byJson(value.anchors),
          revisions: byJson(value.revisions),
          assertionEvidence: byJson(value.assertionEvidence),
          assertions: byJson(value.assertions),
        };
      };
      return { batch: sorted(batch), singles: sorted(singles) };
    };
    const ordinary = await compare(nodeIds);
    assert.deepEqual(ordinary.batch, ordinary.singles);
    for (const selectedNodeIds of [
      [],
      [randomUUID() as KnowledgeNodeId],
      [foreignOnlyNodeId],
      [secondNodeId, nodeId, nodeId, secondNodeId, foreignOnlyNodeId, randomUUID() as KnowledgeNodeId],
    ]) {
      const comparison = await compare(selectedNodeIds);
      assert.deepEqual(comparison.batch, comparison.singles, 'batch agrees with scoped, deduplicated single reads');
      const hasLocalNodes = selectedNodeIds.includes(nodeId) || selectedNodeIds.includes(secondNodeId);
      if (hasLocalNodes) assert.deepEqual(comparison.batch, ordinary.batch, 'duplicate and foreign keys do not change the local result');
      else
        for (const rows of Object.values(comparison.batch))
          assert.equal(rows.length, 0, 'empty, missing or foreign-only keys return no rows');
    }
    for (const selectedEvidenceId of [evidenceId, historicalEvidenceId]) {
      assert.equal(
        (await reader.listEvidenceAssertions(project.id, selectedEvidenceId, 2)).length,
        2,
        'both anchors actually contain more assertion links than the per-anchor limit',
      );
    }
    return ordinary;
  });
  assert.deepEqual(
    batchComparison.batch,
    batchComparison.singles,
    'bounded set reads enforce each parent limit and retain exact source revision mapping',
  );
  assert.equal(batchComparison.batch.aliases.length, 2, 'a limit of one applies to both parents instead of truncating the whole batch');
  assert.equal(batchComparison.batch.relations.length, 2, 'a relation joining two selected nodes is mapped once to each parent');
  assert.deepEqual(
    batchComparison.batch.assertionEvidence.map(item => item.evidenceId).sort(),
    [evidenceId, historicalEvidenceId].sort(),
    'a limit of one returns one link for each anchor',
  );
  assert.equal(
    batchComparison.batch.assertions.length,
    1,
    'the same selected assertion is fetched once while its two evidence links remain distinct',
  );
  assert.equal(
    batchComparison.batch.anchors.find(anchor => anchor.id === historicalEvidenceId)?.revisionId,
    latestHistoricalRevision.revision.id,
    "the batch keeps the anchor's exact source revision",
  );
  assert.equal(
    batchComparison.batch.revisions.find(revision => revision.documentId === historicalDocument.document.id)?.markdown,
    latestHistoricalBody,
    'the batch maps its source revision for the correct document',
  );

  const reviewedAnchor = await persistence.transaction(transaction =>
    transaction.saveEvidenceAnchor({
      projectId: project.id,
      id: evidenceId,
      documentId: document.document.id,
      revisionId: document.revision.id,
      fromUtf16: 0,
      toUtf16: document.revision.markdown.length,
      quoteSha256: anchorHash,
      status: 'needs_review',
      expectedVersion: 1,
    }),
  );
  assert.equal(reviewedAnchor.version, 2);
  assert.equal((await persistence.read(reader => reader.listEvidenceHistory(project.id, evidenceId))).length, 2);
  await assert.rejects(
    persistence.transaction(transaction =>
      transaction.saveEvidenceAnchor({
        projectId: project.id,
        id: evidenceId,
        documentId: document.document.id,
        revisionId: document.revision.id,
        fromUtf16: 0,
        toUtf16: document.revision.markdown.length,
        quoteSha256: anchorHash,
        status: 'confirmed',
        expectedVersion: 1,
      }),
    ),
    (error: unknown) => error instanceof PersistenceError && error.code === 'conflict',
  );

  const currentNode = readBack.node!;
  const updates = ['Aoi', '青い'].map(name =>
    persistence.transaction(transaction =>
      transaction.saveKnowledgeNode({
        projectId: project.id,
        id: nodeId,
        type: 'character',
        name,
        attributes: { canon: true },
        status: 'confirmed',
        expectedVersion: currentNode.version,
      }),
    ),
  );
  const updateResults = await Promise.allSettled(updates);
  assert.equal(updateResults.filter(result => result.status === 'fulfilled').length, 1);
  const rejectedUpdate = updateResults.find(result => result.status === 'rejected');
  assert.ok(rejectedUpdate && rejectedUpdate.status === 'rejected');
  assert.ok(rejectedUpdate.reason instanceof PersistenceError);
  assert.equal(rejectedUpdate.reason.code, 'conflict');
});

test('project page preserves deterministic keyset order across more than 200 projects', async t => {
  const prefix = `pagination-${randomUUID()}-`;
  const rows = Array.from({ length: 205 }, (_, index) => ({ id: randomUUID(), title: `${prefix}${index}` }));
  t.after(async () => {
    await directPool.query('DELETE FROM project WHERE id = ANY($1::uuid[])', [rows.map(row => row.id)]);
  });
  await directPool.query(`INSERT INTO project(id,title) SELECT id,title FROM jsonb_to_recordset($1::jsonb) AS row(id uuid,title text)`, [
    JSON.stringify(rows),
  ]);
  const collected: string[] = [];
  let after: ProjectPageCursor | undefined;
  let pages = 0;
  for (;;) {
    const page = await persistence.read(reader => {
      assert.ok(reader.listProjectPage);
      return reader.listProjectPage(101, after);
    });
    assert.ok(page.length <= 101);
    collected.push(...page.filter(project => project.title.startsWith(prefix)).map(project => project.id));
    pages++;
    if (page.length < 101) break;
    const last = page.at(-1)!;
    after = { updatedAt: last.updatedAt, id: last.id };
  }
  assert.ok(pages >= 3, '205 projects must cross the default page boundary');
  assert.deepEqual(new Set(collected), new Set(rows.map(row => row.id)));
  assert.equal(collected.length, rows.length, 'pages must not repeat project identities');
});

test('portable module inventory omits arbitrarily many retained authority records without reading their bodies', async () => {
  const project = await createProject('Portable authority inventory');
  // Keep synthetic retained records strictly below the current project version.
  // Subsequent integration suites must never treat them as a current snapshot.
  await directPool.query('UPDATE project SET version=10002 WHERE id=$1', [project.id]);
  await directPool.query(
    `INSERT INTO module_record(project_id,module_id,key,value)
    SELECT $1,'core.authority.snapshots','snapshot:' || n, '{"private":"internal"}'::jsonb
    FROM generate_series(1,10001) AS n`,
    [project.id],
  );
  await persistence.transaction(tx =>
    tx.saveModuleRecord({ projectId: project.id, moduleId: 'story', key: 'author-note', value: { text: 'keep' }, expectedVersion: null }),
  );
  const result = await persistence.read(reader => reader.listPortableModuleRecords(project.id));
  assert.deepEqual(result.omittedAuthorityModules, ['core.authority.snapshots']);
  assert.deepEqual(
    result.records.map(item => [item.moduleId, item.key, item.value]),
    [['story', 'author-note', { text: 'keep' }]],
  );
});

test('proposal review queue counts unresolved records without returning the unbounded tail', async () => {
  const first = await createProject('Review first');
  const second = await createProject('Review second');
  const outside = await createProject('Review outside');
  const moduleId = 'core.authority.proposals';
  try {
    await directPool.query(
      `INSERT INTO module_record(project_id,module_id,key,value)
      SELECT $1,$2,'proposal:' || lpad(n::text,4,'0'), jsonb_build_object('state','proposed')
      FROM generate_series(1,1002) AS n`,
      [first.id, moduleId],
    );
    await directPool.query(
      `INSERT INTO module_record(project_id,module_id,key,value) VALUES
      ($1,$4,'proposal:0000','{"state":"applied"}'),
      ($2,$4,'proposal:0001','{"state":"approved"}'),
      ($3,$4,'proposal:0001','{"state":"proposed"}'),
      ($1,$4,'receipt:0000','{}'),
      ($1,'story','proposal:0000','{"state":"proposed"}')`,
      [first.id, second.id, outside.id, moduleId],
    );
    const page = await persistence.read(reader => reader.listProposalReviewQueue([second.id, first.id], moduleId, 1000));
    assert.equal(page.unresolvedCount, 1003);
    assert.equal(page.records.length, 1000);
    assert.deepEqual(
      page.records.slice(0, 2).map(({ record }) => [record.projectId, record.key]),
      [
        [second.id, 'proposal:0001'],
        [first.id, 'proposal:0001'],
      ],
    );
    assert.equal(page.records.at(-1)?.record.key, 'proposal:0999');
    assert.ok(page.records.every(({ record, projectVersion }) => record.projectId !== outside.id && projectVersion === 1));
    assert.deepEqual(await persistence.read(reader => reader.listProposalReviewQueue([], moduleId, 1000)), {
      unresolvedCount: 0,
      records: [],
    });
    const standalone = await persistence.read(reader => reader.listProposalReviewQueue(null, moduleId, 1000));
    assert.ok(standalone.unresolvedCount >= 1004);
    assert.equal(standalone.records.length, 1000);
    assert.ok(standalone.records.some(({ record }) => record.projectId === outside.id));

    await directPool.query(
      `INSERT INTO module_record(project_id,module_id,key,value)
      SELECT $1,$2,'proposal:' || item.key,
        jsonb_build_object('state', 'approved', 'proposal', jsonb_build_object('operations', jsonb_build_array(
          jsonb_build_object('writes', jsonb_build_array(
            jsonb_build_object('path', 'bible/public.yaml'),
            jsonb_build_object('path', item.path, 'content', 'synthetic review content')
          ))
        )))
      FROM (VALUES
        ('0000-episodes', 'meta/scriptorium/modules/publishing/episodes.yaml'),
        ('0000-grants', 'meta/scriptorium/modules/publishing/share-grants.jsonl'),
        ('0000-visible', 'meta/scriptorium/modules/publishing/share-grants.jsonl.example')
      ) AS item(key,path)`,
      [second.id, moduleId],
    );
    const visible = await persistence.read(reader =>
      reader.listProposalReviewQueue([second.id, first.id], moduleId, 2, {
        excludePrivateProposals: true,
      }),
    );
    assert.equal(visible.unresolvedCount, 1004);
    assert.deepEqual(
      visible.records.map(({ record }) => record.key),
      ['proposal:0000-visible', 'proposal:0001'],
    );
    const author = await persistence.read(reader => reader.listProposalReviewQueue([second.id, first.id], moduleId, 2));
    assert.equal(author.unresolvedCount, 1006);
    assert.deepEqual(
      author.records.map(({ record }) => record.key),
      ['proposal:0000-episodes', 'proposal:0000-grants'],
    );
  } finally {
    await directPool.query('DELETE FROM module_record WHERE project_id = ANY($1::uuid[])', [[first.id, second.id, outside.id]]);
  }
});
