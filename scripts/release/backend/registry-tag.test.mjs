import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBackendRegistryTag } from './registry-tag.mjs';

const sourceSha = 'a'.repeat(40);
const context = { sourceSha, repository: 'yohn-jp/codexia', ref: 'refs/heads/main' };

test('accepts only Core and Full registry tags bound to the verified source SHA', () => {
  assert.doesNotThrow(() => assertBackendRegistryTag({ ...context, tag: `sha-${sourceSha}` }));
  assert.doesNotThrow(() => assertBackendRegistryTag({ ...context, tag: `sha-${sourceSha}-full` }));
});

test('does not bind publication tag checks to workflow_run execution SHA', () => {
  const executionSha = 'b'.repeat(40);
  assert.notEqual(executionSha, sourceSha);
  assert.throws(() => assertBackendRegistryTag({ ...context, tag: `sha-${executionSha}` }), /exact verified source SHA/u);
  assert.throws(() => assertBackendRegistryTag({ ...context, tag: `sha-${executionSha}-full` }), /exact verified source SHA/u);
});

test('retains exact source, repository and main ref guards', () => {
  assert.throws(() => assertBackendRegistryTag({ ...context, sourceSha: 'invalid', tag: `sha-${sourceSha}` }), /source SHA is invalid/u);
  assert.throws(() => assertBackendRegistryTag({ ...context, repository: 'attacker/repo', tag: `sha-${sourceSha}` }), /repository/u);
  assert.throws(() => assertBackendRegistryTag({ ...context, ref: 'refs/heads/feature', tag: `sha-${sourceSha}` }), /ref/u);
});
