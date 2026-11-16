// A disposable database and distinct ports/output paths for each browser spec.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function browserFixtureSettings(task, index, serviceURL, database, stateDir) {
  assert.match(task, /^browser-(core|full)-[a-z0-9-]+$/u);
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 100);
  assert.match(database, /^codexia_ci_[a-f0-9]{32}$/u);
  const service = new URL(serviceURL);
  assert.ok(['postgres:', 'postgresql:'].includes(service.protocol)
    && service.hostname === 'postgres' && service.pathname === '/codexia_test'
    && (!service.port || service.port === '5432') && !service.search && !service.hash,
    'Browser fixtures require the canonical disposable CI service');
  const target = new URL(service);
  target.pathname = '/' + database;
  return {
    CODEXIA_E2E_ADMIN_DATABASE_URL: service.toString(),
    CODEXIA_E2E_DATABASE_URL: target.toString(),
    CODEXIA_E2E_PORT: String(4173 + index * 2),
    CODEXIA_E2E_STATE_DIR: stateDir,
    CODEXIA_E2E_OUTPUT_DIR: path.resolve('tests/e2e/test-results', task),
    CODEXIA_E2E_PROJECT_TITLE: 'Acceptance manuscript ' + database,
  };
}

export async function withBrowserFixture(task, index, execute) {
  assert.equal(process.env.CI, 'true', 'Browser fixture creation is CI-only');
  assert.ok(!process.env.CODEXIA_E2E_BASE_URL && !process.env.CODEXIA_BASE_URL
    && process.env.CODEXIA_E2E_EXTERNAL_DATABASE !== '1', 'External browser fixtures are forbidden in CI');
  const database = 'codexia_ci_' + randomUUID().replaceAll('-', '');
  const stateDir = await mkdtemp(path.join(tmpdir(), 'codexia-ci-browser-'));
  let control, created = false;
  try {
    const settings = browserFixtureSettings(task, index, process.env.CODEXIA_E2E_DATABASE_URL, database, stateDir);
    const require = createRequire(new URL('../packages/persistence-postgres/package.json', import.meta.url));
    const { Client } = require('pg');
    control = new Client({ connectionString: settings.CODEXIA_E2E_ADMIN_DATABASE_URL });
    await control.connect();
    await control.query(`CREATE DATABASE "${database}"`);
    created = true;
    console.log(JSON.stringify({ phase: 'browser-fixture', task, database, port: settings.CODEXIA_E2E_PORT }));
    return await execute(settings);
  } finally {
    try {
      if (created) await control.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      try { if (control) await control.end(); }
      finally { await rm(stateDir, { recursive: true, force: true }); }
    }
  }
}
