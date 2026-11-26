import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type {
  ModuleRecord,
  Persistence,
  PersistenceReader,
  PersistenceTransaction,
  Project,
  ProjectId,
} from '@codexia/persistence-contracts';
import { importWorkArchive, type WorkArchive, WorkArchiveError } from './work-archive.js';

function emptyArchive(): WorkArchive {
  return {
    format: 'codexia-work/v1',
    project: { title: 'Portable work', settings: {} },
    documents: [],
    knowledge: { nodes: [], aliases: [], relations: [] },
    evidence: {
      anchors: [],
      mentions: [],
      assertions: [],
      assertionEvidence: [],
      unresolved: { anchors: [], mentions: [], assertionEvidence: [] },
    },
    moduleRecords: [],
    omittedRecords: [],
  };
}

function memoryPersistence() {
  const projects = new Map<ProjectId, Project>();
  const records = new Map<string, ModuleRecord>();
  let transactions = 0;
  const recordKey = (projectId: ProjectId, moduleId: string, key: string) => `${projectId}/${moduleId}/${key}`;
  const reader = {
    getProject: async (projectId: ProjectId) => projects.get(projectId),
    getModuleRecord: async (projectId: ProjectId, moduleId: string, key: string) => records.get(recordKey(projectId, moduleId, key)),
  } as unknown as PersistenceReader;
  const transaction = {
    ...reader,
    createProject: async (command: { id?: ProjectId; title: string; settings?: Project['settings'] }) => {
      if (!command.id) throw new Error('A project ID is required by this test fixture');
      const now = '2026-01-01T00:00:00.000Z';
      const project: Project = {
        id: command.id,
        title: command.title,
        settings: command.settings ?? {},
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      projects.set(project.id, project);
      return project;
    },
    saveModuleRecord: async (command: { projectId: ProjectId; moduleId: string; key: string; value: ModuleRecord['value'] }) => {
      const now = '2026-01-01T00:00:00.000Z';
      const record: ModuleRecord = { ...command, version: 1, createdAt: now, updatedAt: now };
      records.set(recordKey(record.projectId, record.moduleId, record.key), record);
      return record;
    },
  } as unknown as PersistenceTransaction;
  const persistence: Persistence = {
    read: async <T>(work: (current: PersistenceReader) => Promise<T>) => work(reader),
    transaction: async <T>(work: (current: PersistenceTransaction) => Promise<T>) => {
      transactions++;
      return work(transaction);
    },
    close: async () => {},
  };
  return {
    persistence,
    projects,
    records,
    get transactions() {
      return transactions;
    },
  };
}

test('portable import replays when only nested object key order changes', async () => {
  const store = memoryPersistence();
  const original = emptyArchive();
  original.project.settings = { outer: { alpha: 1, beta: 2 }, list: [{ delta: true, gamma: false }] };
  const reordered = structuredClone(original);
  reordered.project.settings = { list: [{ gamma: false, delta: true }], outer: { beta: 2, alpha: 1 } };

  const first = await importWorkArchive(store.persistence, original, 'owner');
  const replay = await importWorkArchive(store.persistence, reordered, 'owner');

  assert.equal(replay.project.id, first.project.id);
  assert.equal(replay.replayed, true);
  assert.equal(store.projects.size, 1);
});

test('portable import replays a pre-canonical receipt only for the original parsed key order', async () => {
  const store = memoryPersistence();
  const archive = emptyArchive();
  archive.project.settings = { outer: { alpha: 1, beta: 2 }, list: [{ delta: true, gamma: false }] };
  const legacyHash = createHash('sha256')
    .update(`codexia-work/v1-import\0${JSON.stringify(archive)}`, 'utf8')
    .digest('hex');
  const legacyId = (legacyHash.slice(0, 8) +
    '-' +
    legacyHash.slice(8, 12) +
    '-5' +
    legacyHash.slice(13, 16) +
    '-a' +
    legacyHash.slice(17, 20) +
    '-' +
    legacyHash.slice(20, 32)) as ProjectId;
  const legacyProject: Project = {
    id: legacyId,
    title: archive.project.title,
    settings: archive.project.settings as Project['settings'],
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  store.projects.set(legacyId, legacyProject);
  const receipt: ModuleRecord = {
    projectId: legacyId,
    moduleId: 'core.portable.archive',
    key: 'import-receipt',
    value: { payloadSha256: legacyHash, archiveFormat: archive.format },
    version: 1,
    createdAt: legacyProject.createdAt,
    updatedAt: legacyProject.updatedAt,
  };
  store.records.set(`${legacyId}/core.portable.archive/import-receipt`, receipt);

  const replay = await importWorkArchive(store.persistence, archive, 'owner');

  assert.equal(replay.project.id, legacyId);
  assert.equal(replay.replayed, true);
  assert.equal(store.projects.size, 1);

  // A historical receipt stores only the order-dependent hash, not the original
  // payload. A different parsed key order cannot be proven to be that import.
  const reordered = structuredClone(archive);
  reordered.project.settings = { list: [{ gamma: false, delta: true }], outer: { beta: 2, alpha: 1 } };
  const canonical = await importWorkArchive(store.persistence, reordered, 'owner');
  assert.equal(canonical.replayed, false);
  assert.notEqual(canonical.project.id, legacyId);
  const canonicalReplay = await importWorkArchive(store.persistence, reordered, 'owner');
  assert.equal(canonicalReplay.project.id, canonical.project.id);
  assert.equal(canonicalReplay.replayed, true);
  assert.equal(store.projects.size, 2);
});

test('portable import rejects sensitive project settings before opening a write transaction', async () => {
  const store = memoryPersistence();
  const archive = emptyArchive();
  archive.project.settings = { nested: [{ service: { apiKey: 'synthetic-secret' } }] };

  await assert.rejects(
    importWorkArchive(store.persistence, archive, 'owner'),
    (error: unknown) => error instanceof WorkArchiveError && error.status === 400 && error.code === 'INVALID_WORK_ARCHIVE',
  );
  assert.equal(store.transactions, 0);
  assert.equal(store.projects.size, 0);
});
