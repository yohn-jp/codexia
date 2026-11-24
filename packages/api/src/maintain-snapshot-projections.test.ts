import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  NLP_FEATURE_SETTINGS_KEY,
  NLP_LEGACY_FEATURE_SETTINGS_PATH,
  PRIVATE_PUBLISHING_PATHS,
  PUBLISHING_EPISODES_KEY,
} from '@codexia/contracts';
import { createPostgresPersistence, migratePostgresDatabase } from '@codexia/persistence-postgres';

const execute = promisify(execFile);
const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error('CODEXIA_TEST_DATABASE_URL is required for snapshot maintenance integration tests');

test('snapshot maintenance checks the format and PostgreSQL text representation of NLP sources before applying Publishing', async () => {
  await migratePostgresDatabase(connectionString);
  const persistence = createPostgresPersistence(connectionString);
  try {
    const project = await persistence.transaction(tx => tx.createProject({ title: 'Snapshot maintenance source validation' }));
    const episodesPath = PRIVATE_PUBLISHING_PATHS[0];
    await persistence.transaction(async tx => {
      await tx.saveModuleRecord({
        projectId: project.id,
        moduleId: 'core.artifacts',
        key: episodesPath,
        value: { content: 'episodes: []\n' },
        expectedVersion: null,
      });
    });
    const run = (mode: '--check' | '--apply', databaseUrl = connectionString) =>
      execute(
        process.execPath,
        [fileURLToPath(new URL('./maintain-snapshot-projections.js', import.meta.url)), mode, '--project', project.id],
        { env: { ...process.env, CODEXIA_DATABASE_URL: databaseUrl } },
      );

    let sourceVersion: number | null = null;
    const invalidSettings = [
      { externalEnabled: [] },
      { externalEnabled: {}, notes: [{ label: 'before' + String.fromCharCode(0) + 'after' }] },
      { externalEnabled: { [String.fromCharCode(0xd800)]: true } },
    ];
    for (const settings of invalidSettings) {
      const source = await persistence.transaction(tx =>
        tx.saveModuleRecord({
          projectId: project.id,
          moduleId: 'core.artifacts',
          key: NLP_LEGACY_FEATURE_SETTINGS_PATH,
          value: { content: JSON.stringify(settings) },
          expectedVersion: sourceVersion,
        }),
      );
      sourceVersion = source.version;
      const before = await persistence.read(reader => reader.getProject(project.id));
      for (const mode of ['--check', '--apply'] as const) {
        await assert.rejects(run(mode), {
          code: 1,
          stderr: `Project ${project.id} cannot convert its NLP feature settings source record for feature-settings\n`,
        });
      }
      await persistence.read(async reader => {
        assert.equal((await reader.getProject(project.id))?.version, before?.version);
        assert.equal(await reader.getModuleRecord(project.id, 'publishing', PUBLISHING_EPISODES_KEY), undefined);
        assert.equal(await reader.getModuleRecord(project.id, 'nlp', NLP_FEATURE_SETTINGS_KEY), undefined);
        assert.deepEqual((await reader.getModuleRecord(project.id, 'core.artifacts', episodesPath))?.value, { content: 'episodes: []\n' });
        assert.deepEqual(
          (await reader.getModuleRecord(project.id, 'core.artifacts', NLP_LEGACY_FEATURE_SETTINGS_PATH))?.value,
          source.value,
        );
      });
    }

    const validSettings = { externalEnabled: { diagnostics: true }, label: 'Notes 🪶' };
    await persistence.transaction(tx =>
      tx.saveModuleRecord({
        projectId: project.id,
        moduleId: 'core.artifacts',
        key: NLP_LEGACY_FEATURE_SETTINGS_PATH,
        value: { content: JSON.stringify(validSettings) },
        expectedVersion: sourceVersion,
      }),
    );
    const readOnlyConnection = new URL(connectionString);
    readOnlyConnection.searchParams.set('options', '-c default_transaction_read_only=on');
    await assert.rejects(run('--check', readOnlyConnection.href), { code: 2 });
    await assert.rejects(run('--apply', readOnlyConnection.href), { code: 1 });
    assert.equal(JSON.parse((await run('--apply')).stdout).status, 'ready');
    await persistence.read(async reader => {
      assert.deepEqual((await reader.getModuleRecord(project.id, 'publishing', PUBLISHING_EPISODES_KEY))?.value, {
        version: 1,
        document: { episodes: [] },
      });
      assert.deepEqual((await reader.getModuleRecord(project.id, 'nlp', NLP_FEATURE_SETTINGS_KEY))?.value, validSettings);
    });
    assert.equal(JSON.parse((await run('--check', readOnlyConnection.href)).stdout).status, 'ready');
  } finally {
    await persistence.close();
  }
});
