import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAlerts, makeExport, toCsv, REPOSITORY, SOURCE_REF } from './site/api.mjs';

const alert = (number, overrides = {}) => ({
  number, state: 'open', rule: { id: 'js/example', security_severity_level: 'high' },
  tool: { name: 'CodeQL' }, most_recent_instance: {
    commit_sha: 'a'.repeat(40), message: { text: 'Finding' }, location: { path: 'app/index.ts', start_line: 5 },
  }, ...overrides,
});
const response = (items, status = 200) => ({
  ok: status === 200, status, json: async () => items,
});

test('paginates all alert states on the exact main ref without forwarding tokens elsewhere', async () => {
  const calls = [];
  const alerts = await fetchAlerts('test-token', async (url, options) => {
    calls.push({ url, options });
    return response(calls.length === 1 ? Array.from({ length: 100 }, (_, index) => alert(index + 1)) : [alert(101)]);
  });
  assert.equal(alerts.length, 101);
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    const url = new URL(call.url);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/repos/yohn-jp/codexia/code-scanning/alerts');
    assert.equal(url.searchParams.get('ref'), SOURCE_REF);
    assert.equal(url.searchParams.get('page'), String(index + 1));
    assert.equal(call.options.headers.Authorization, 'Bearer test-token');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.method, 'GET');
  }
  const report = makeExport(alerts, '2026-11-23T10:00:00.000Z');
  assert.equal(report.repository, REPOSITORY);
  assert.equal(report.coverage, 'complete');
  assert.equal(report.alertCount, 101);
  assert.equal(report.alerts[100].number, 101);
});

test('does not return partial alerts when authentication fails or a later page is unavailable', async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    await assert.rejects(fetchAlerts('token', async () => response({}, status)), new RegExp('HTTP ' + status));
  }
  let requests = 0;
  await assert.rejects(fetchAlerts('token', async () => {
    requests++;
    return requests === 1 ? response(Array.from({ length: 100 }, (_, index) => alert(index + 1))) : response({}, 503);
  }), /HTTP 503/);
  await assert.rejects(fetchAlerts('token', async () => response({})), /形式が不正/);
  await assert.rejects(fetchAlerts(' ', async () => response([])), /トークン/);
});

test('CSV escapes spreadsheet formula injection and preserves unicode, quotes, CRLF', () => {
  const csv = toCsv([alert(6, {
    state: 'dismissed',
    rule: { id: 'rule,"quoted"', security_severity_level: 'medium' },
    most_recent_instance: {
      message: { text: '=HYPERLINK("https://evil.invalid","危険")' },
      location: { path: '-injection.ts', start_line: 1, end_line: 2 },
    },
  })]);
  assert.ok(csv.startsWith('\uFEFFnumber,state,severity'));
  assert.ok(csv.includes('"' + String.fromCharCode(39) + '=HYPERLINK'));
  assert.ok(csv.includes('"' + String.fromCharCode(39) + '-injection.ts'));
  assert.ok(csv.endsWith('\r\n'));
});

test('accepts exactly 5000 results, rejects overflow without a partial export', async () => {
  const batch = Array.from({ length: 100 }, (_, index) => alert(index + 1));
  let page = 0;
  const complete = await fetchAlerts('token', async () => {
    page++;
    return response(page <= 50 ? batch : []);
  });
  assert.equal(complete.length, 5000);
  assert.equal(page, 51);
  page = 0;
  await assert.rejects(fetchAlerts('token', async () => {
    page++;
    return response(page <= 50 ? batch : [alert(5001)]);
  }), /5000件を超えた/);
  assert.equal(page, 51);
});
