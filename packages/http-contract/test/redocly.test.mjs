import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const redocly = createRequire(import.meta.url).resolve('@redocly/cli/bin/cli.js');
const config = fileURLToPath(new URL('../redocly.yaml', import.meta.url));

test('Redocly rejects an unresolved response schema reference with the repository configuration', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codexia-redocly-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixturePath = path.join(directory, 'response.openapi.json');
  const schema = { $ref: '#/components/schemas/Example' };
  const fixture = {
    openapi: '3.1.0',
    info: { title: 'Response fixture', version: '1.0.0' },
    servers: [{ url: 'https://example.com' }],
    security: [],
    paths: {
      '/example': {
        get: {
          operationId: 'get_example',
          responses: {
            200: { description: 'Example', content: { 'application/json': { schema } } },
          },
        },
      },
    },
    components: { schemas: { Example: { type: 'string' } } },
  };

  const lintFixture = () => {
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
    const result = spawnSync(process.execPath, [redocly, 'lint', fixturePath, '--config', config, '--format', 'json'], {
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    return result;
  };

  const valid = lintFixture();
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);

  schema.$ref = '#/components/schemas/MissingExample';
  const invalid = lintFixture();
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  const report = JSON.parse(invalid.stdout);
  assert.ok(
    report.problems.some(
      ({ ruleId, severity, location }) =>
        ruleId === 'no-unresolved-refs' &&
        severity === 'error' &&
        location.some(({ pointer }) => pointer === '#/paths/~1example/get/responses/200/content/application~1json/schema'),
    ),
    invalid.stdout,
  );
});
