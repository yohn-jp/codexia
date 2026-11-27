import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createPostgresPersistence, migratePostgresDatabase } from '@codexia/persistence-postgres';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { generateOpenWorkZip } from './open-work-export.js';

const databaseUrl = process.env.CODEXIA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('CODEXIA_TEST_DATABASE_URL is required for open-work export integration tests');
const database = createPostgresPersistence(databaseUrl);
before(() => migratePostgresDatabase(databaseUrl));
after(() => database.close());

test('open work ZIP preserves historical and deleted revision bytes and excludes private records', async () => {
  const first = '先頭\r\n東京 😀';
  const next = '最新\n内容';
  const beforeDelete = await database.transaction(async tx => {
    const project = await tx.createProject({ title: '日誌', settings: { language: 'ja', token: 'private' } });
    const initial = await tx.createDocument({
      projectId: project.id,
      kind: 'scene',
      title: 'CON',
      orderKey: '0001',
      markdown: first,
      authorId: 'owner',
      idempotencyKey: 'create-' + project.id,
    });
    const edited = await tx.saveDocument({
      projectId: project.id,
      documentId: initial.document.id,
      baseRevisionId: initial.revision.id,
      changes: [{ fromUtf16: 0, toUtf16: first.length, insert: next }],
      resultingSha256: createHash('sha256').update(next).digest('hex'),
      authorId: 'owner',
      clientId: 'export-test',
      idempotencyKey: 'save-' + project.id,
    });
    await tx.saveModuleRecord({
      projectId: project.id,
      moduleId: 'core.authority.internal',
      key: 'private-record',
      value: { secret: 'not-for-export' },
      expectedVersion: null,
    });
    return { project, initial, edited };
  });
  await database.transaction(tx =>
    tx.deleteDocument({
      projectId: beforeDelete.project.id,
      documentId: beforeDelete.edited.document.id,
      expectedVersion: beforeDelete.edited.document.version,
    }),
  );
  const zip = await generateOpenWorkZip(database, beforeDelete.project.id, new AbortController().signal);
  try {
    const bytes = await readFile(zip.path);
    assert.equal(bytes.byteLength, zip.bytes);
    const reader = new ZipReader(new Uint8ArrayReader(bytes));
    try {
      const files = new Map();
      for (const entry of await reader.getEntries()) {
        if (!entry.directory) files.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
      }
      const parse = (path: string) => JSON.parse(Buffer.from(files.get(path)).toString('utf8'));
      const project = parse('metadata/project.json');
      const revisions = parse('history/revisions.json');
      const manifest = parse('manifest.json');
      assert.deepEqual(project.settings, { language: 'ja' });
      assert.equal(project.documents[0].deletedAt !== null, true);
      assert.equal(revisions.length, 2);
      assert.ok(revisions.every((row: { path: string }) => row.path.startsWith('history/documents/deleted/')));
      assert.equal(
        Buffer.from(files.get(revisions.find((row: { id: string }) => row.id === beforeDelete.initial.revision.id).path)).toString(),
        first,
      );
      assert.equal(
        Buffer.from(files.get(revisions.find((row: { id: string }) => row.id === beforeDelete.edited.revision.id).path)).toString(),
        next,
      );
      assert.deepEqual(parse('metadata/module-records.json'), []);
      for (const { path, bytes: size, sha256 } of manifest.files) {
        assert.equal(files.get(path).byteLength, size);
        assert.equal(createHash('sha256').update(files.get(path)).digest('hex'), sha256);
      }
    } finally {
      await reader.close();
    }
  } finally {
    await zip.dispose();
  }
});
