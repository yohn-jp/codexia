import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPostgresPersistence, migratePostgresDatabase } from '../../packages/persistence-postgres/dist/index.js';
import { CoreStore } from '../../packages/core/dist/index.js';

/** Materialize an explicitly generated benchmark dataset in a disposable database. */
export async function postgresFixture(datasetPath) {
  const url = process.env.CODEXIA_TEST_DATABASE_URL;
  if (!url) throw new Error('CODEXIA_TEST_DATABASE_URL must select a disposable benchmark database');
  await migratePostgresDatabase(url);
  const persistence = createPostgresPersistence(url);
  try {
    const store = new CoreStore({ persistence });
    const project = await store.createProject({ title: `Synthetic benchmark ${randomUUID()}` });
    const root = join(datasetPath, 'seed', 'manuscript');
    const scenes = [];
    await persistence.transaction(async (transaction) => {
      for (const volume of await readdir(root)) {
        const v = await transaction.createDocument({ projectId: project.id, kind: 'volume', title: volume, orderKey: volume, markdown: '', authorId: 'synthetic-benchmark', idempotencyKey: randomUUID() });
        for (const chapter of await readdir(join(root, volume))) {
          const c = await transaction.createDocument({ projectId: project.id, parentId: v.document.id, kind: 'chapter', title: chapter, orderKey: chapter, markdown: '', authorId: 'synthetic-benchmark', idempotencyKey: randomUUID() });
          for (const file of await readdir(join(root, volume, chapter))) {
            const markdown = await readFile(join(root, volume, chapter, file), 'utf8');
            const scene = await transaction.createDocument({ projectId: project.id, parentId: c.document.id, kind: 'scene', title: file.replace(/\.md$/u, ''), orderKey: file, markdown, authorId: 'synthetic-benchmark', idempotencyKey: randomUUID() });
            scenes.push(scene.document.id);
          }
        }
      }
    });
    return { store, project, scenes, persistence };
  } catch (error) { await persistence.close(); throw error; }
}
