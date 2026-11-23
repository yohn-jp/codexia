import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseOAuthMcpProjectAssignments } from './oauth-mcp.js';

test('preserves assignments when client and project IDs contain JSON punctuation', () => {
  const assignments = { client: ['project":value'], ':next': ['shared', 'other'], ':last': ['shared'] };
  assert.deepEqual(parseOAuthMcpProjectAssignments(JSON.stringify(assignments), Object.keys(assignments)), assignments);
  assert.deepEqual(parseOAuthMcpProjectAssignments(String.raw`{"cl\u0069ent":["proj\u0065ct"]}`, ['client']), { client: ['project'] });
});

test('allows absent or empty configuration only if no clients must be assigned', () => {
  for (const raw of [undefined, '', ' \t\n']) {
    assert.deepEqual(parseOAuthMcpProjectAssignments(raw, []), {});
    assert.throws(() => parseOAuthMcpProjectAssignments(raw, ['client']), /is required/u);
  }
  assert.deepEqual(parseOAuthMcpProjectAssignments('{}', []), {});
  assert.throws(() => parseOAuthMcpProjectAssignments('{"client":["project"]}', []), /every configured/u);
});

test('rejects repeated decoded client member names', () => {
  for (const raw of [
    '{"client":["project"],"client":["other"]}',
    String.raw`{"client":["project"],"cl\u0069ent":["other"]}`,
    String.raw`{"\u0063lient":["project"],"cl\u0069ent":["other"]}`,
  ]) {
    assert.throws(() => parseOAuthMcpProjectAssignments(raw, ['client']), /duplicate/u);
  }
});

test('rejects syntax outside strict JSON', () => {
  for (const [label, raw] of [
    ['line comment', '{"client":["project"]} // comment'],
    ['block comment', '{/* comment */"client":["project"]}'],
    ['object trailing comma', '{"client":["project"],}'],
    ['array trailing comma', '{"client":["project",]}'],
    ['unclosed object', '{"client":["project"]'],
    ['additional root value', '{"client":["project"]} {}'],
    ['unsupported escape', String.raw`{"client":["project\x31"]}`],
    ['unescaped control character', '{"client":["project\u0001id"]}'],
    ['non-JSON whitespace', '\u00a0{"client":["project"]}'],
  ]) {
    assert.throws(() => parseOAuthMcpProjectAssignments(raw, ['client']), /valid JSON/u, label);
  }
});

test('requires a flat assignment object with every configured client and unique non-empty project IDs', () => {
  for (const raw of ['null', '["project"]', '"project"', '1', 'true']) {
    assert.throws(() => parseOAuthMcpProjectAssignments(raw, ['client']), /JSON object/u);
  }
  for (const [label, raw] of [
    ['non-array', '{"client":"project"}'],
    ['nested object', '{"client":{"projects":["project"]}}'],
    ['nested array', '{"client":[["project"]]}'],
    ['non-string project', '{"client":["project",1]}'],
    ['empty assignment', '{"client":[]}'],
    ['empty project ID', '{"client":[""]}'],
    ['whitespace-only project ID', '{"client":[" "]}'],
    ['padded project ID', '{"client":[" project"]}'],
    ['same project ID after decoding', String.raw`{"client":["project","proj\u0065ct"]}`],
  ]) {
    assert.throws(() => parseOAuthMcpProjectAssignments(raw, ['client']), /non-empty project IDs/u, label);
  }
  assert.throws(() => parseOAuthMcpProjectAssignments('{}', ['client']), /every configured/u);
  assert.throws(() => parseOAuthMcpProjectAssignments('{"extra":["project"]}', ['client']), /every configured/u);
  assert.throws(() => parseOAuthMcpProjectAssignments('{"client":["project"],"extra":["extra"]}', ['client']), /every configured/u);
  assert.throws(() => parseOAuthMcpProjectAssignments('{"client":["project"]}', ['client', 'other']), /every configured/u);
  for (const clients of [['client', 'client'], [''], [' client']]) {
    assert.throws(() => parseOAuthMcpProjectAssignments('{}', clients), /unique, non-empty client IDs/u);
  }
});

test('keeps prototype-related client names bound to explicit own assignments', () => {
  const names = ['__proto__', 'constructor', 'toString'];
  const raw = '{"__proto__":["first"],"constructor":["second"],"toString":["third"]}';
  const assignments = parseOAuthMcpProjectAssignments(raw, names);
  assert.deepEqual(Object.entries(assignments), [
    ['__proto__', ['first']],
    ['constructor', ['second']],
    ['toString', ['third']],
  ]);
  assert.equal(Object.getPrototypeOf(assignments), Object.prototype);
  assert.throws(() => parseOAuthMcpProjectAssignments(raw, ['constructor', 'toString']), /every configured/u);
  assert.throws(() => parseOAuthMcpProjectAssignments('{"constructor":["second"],"toString":["third"]}', names), /every configured/u);
});

test('standalone API startup rejects invalid assignments without logging inputs or secrets', () => {
  const entryPoint = fileURLToPath(new URL('./server.js', import.meta.url));
  const authSecret = 'startup-test-auth-secret';
  const introspectionSecret = 'startup-test-introspection-secret';
  const inputMarker = 'startup-test-assignment-input';
  for (const [assignments, diagnostic] of [
    [`{"client":["${inputMarker}",]}`, /CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS must be valid JSON/u],
    [`{"client":[{"${inputMarker}":true}]}`, /Each OAuth MCP client assignment must contain unique non-empty project IDs/u],
  ] as const) {
    const result = spawnSync(process.execPath, [entryPoint], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        CODEXIA_AUTH_MODE: 'better-auth',
        CODEXIA_AUTH_DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
        CODEXIA_PUBLIC_ORIGIN: 'https://api.codexia.example',
        CODEXIA_AUTH_SECRET: authSecret,
        CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID: 'introspection-client',
        CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET: introspectionSecret,
        CODEXIA_OAUTH_OWNER_SUBJECT: 'owner',
        CODEXIA_OAUTH_OWNER_CLIENT_IDS: 'owner-client',
        CODEXIA_OAUTH_MCP_CLIENT_IDS: 'client',
        CODEXIA_OAUTH_MCP_PROJECT_ASSIGNMENTS: assignments,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stdout, /listening/u);
    for (const marker of [inputMarker, authSecret, introspectionSecret]) {
      assert.equal(result.stderr.includes(marker) || result.stdout.includes(marker), false);
    }
  }
});
