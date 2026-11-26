import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startLiveHost } from './live-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const toolRoot = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(process.env.CODEXIA_CI_REPORT_DIR ?? resolve(root, 'test-results/conformance/mcp'));
const output = resolve(reportRoot, `mcp-${process.pid}-${Date.now()}`);
const databaseUrl = process.env.CODEXIA_MCP_CONFORMANCE_DATABASE_URL;
const disposableOptIn = process.env.CODEXIA_AUTH_TEST_DISPOSABLE === '1';
const conformanceBin = resolve(toolRoot, 'node_modules/.bin/conformance');
const inspectorBin = resolve(toolRoot, 'node_modules/.bin/mcp-inspector');
const secretValues = databaseUrl ? [databaseUrl] : [];
const failures = [];
const evidence = {
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  conformanceTool: '@modelcontextprotocol/conformance@0.2.0-alpha.12',
  inspectorTool: '@modelcontextprotocol/inspector@2.16.0',
  officialConformance: { status: 'NOT_RUN' },
  fullRequiredSuiteAgainstProduct: { status: 'NOT_RUN_BY_SCOPE', note: 'Stock 2026 suite runs only against the loopback SDK-backed fixture; it includes hostile protocol scenarios.' },
  inspector: { status: 'NOT_RUN' },
  authorization: { status: 'NOT_RUN' },
  contract: { status: 'NOT_RUN' },
  mutation: { status: 'NOT_RUN' },
};

await mkdir(output, { recursive: true });

function safeEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of [
    'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'CODEXIA_MCP_CONFORMANCE_DATABASE_URL', 'CODEXIA_TEST_DATABASE_URL', 'CODEXIA_DATABASE_URL', 'CODEXIA_AUTH_DATABASE_URL',
  ]) delete env[name];
  return env;
}

function redact(value) {
  let result = String(value);
  for (const secret of secretValues) if (secret) result = result.split(secret).join('[REDACTED]');
  return result;
}

function execute(command, args, { env = safeEnv(), timeout = 180_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); rejectRun(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, signal, stdout: redact(stdout), stderr: redact(stderr) });
    });
  });
}

async function guarded(label, action) {
  try { return await action(); }
  catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function listFiles(path) {
  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(child));
    else found.push(child);
  }
  return found;
}

async function scenarioResults(path) {
  const files = await listFiles(path);
  const reports = files.filter(file => file.endsWith('/checks.json'));
  const all = [];
  for (const report of reports) all.push(...JSON.parse(await readFile(report, 'utf8')));
  return reports.length ? all : null;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveExit => {
    child.once('exit', resolveExit);
    child.kill('SIGTERM');
  });
}

async function sanitizeEvidenceFiles() {
  for (const file of await listFiles(output)) {
    const content = await readFile(file);
    if (content.includes(0)) continue;
    const safe = redact(content.toString('utf8'));
    await writeFile(file, safe);
  }
}

async function runInspector(label, target, args, expectPass) {
  const result = await execute(inspectorBin, ['--cli', '--format', 'json', ...target, ...args]);
  await writeFile(resolve(output, `${label}.stdout.txt`), result.stdout);
  await writeFile(resolve(output, `${label}.stderr.txt`), result.stderr);
  const passed = expectPass ? result.code === 0 : result.code !== 0;
  if (!passed) throw new Error(`${label} expected ${expectPass ? 'success' : 'contract rejection'} but exited ${result.code}: ${result.stderr.slice(-900)}`);
  return result;
}

async function startProtocolFixture(mutated = false) {
  const child = spawn(process.execPath, [resolve(toolRoot, 'fixture.mjs')], {
    cwd: root,
    env: safeEnv(mutated ? { CODEXIA_MCP_FIXTURE_MUTATION: 'missing-jsonrpc-id' } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let outputText = '';
  const url = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('Authorization proxy did not become ready')), 10_000);
    child.stdout.on('data', chunk => {
      outputText += chunk;
      const match = /READY (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(outputText);
      if (match) { clearTimeout(timer); resolveReady(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); rejectReady(new Error(`Authorization proxy exited before readiness (${code})`)); });
  });
  return { child, url, close: () => stopChild(child) };
}

async function startAuthProxy(target, token) {
  const child = spawn(process.execPath, [resolve(toolRoot, 'proxy.mjs')], {
    cwd: root,
    env: safeEnv({ CODEXIA_MCP_PROXY_TARGET: target, CODEXIA_MCP_PROXY_TOKEN: token }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let outputText = '';
  const url = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('Authorization proxy did not become ready')), 10_000);
    child.stdout.on('data', chunk => {
      outputText += chunk;
      const match = /READY (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(outputText);
      if (match) { clearTimeout(timer); resolveReady(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); rejectReady(new Error(`Authorization proxy exited before readiness (${code})`)); });
  });
  return { child, url, close: () => stopChild(child) };
}

let liveHost;
let protocolFixture;
let mutationFixture;
let productConformanceProxy;
let tempRoot;
try {
  protocolFixture = await startProtocolFixture();
  const conformanceDir = resolve(output, 'official-2026-07-28');
  const conformanceArgs = ['server', '--url', protocolFixture.url, '--requirements', '2026-07-28', '--output-dir', conformanceDir, '--verbose'];
  const conformance = await execute(conformanceBin, conformanceArgs, { timeout: 300_000 });
  await writeFile(resolve(output, 'conformance.stdout.txt'), conformance.stdout);
  await writeFile(resolve(output, 'conformance.stderr.txt'), conformance.stderr);
  const conformanceChecks = await scenarioResults(conformanceDir);
  const conformanceCounts = (conformanceChecks ?? []).reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] ?? 0) + 1 }), {});
  evidence.officialConformance = {
    target: 'current @modelcontextprotocol/server SDK plus Codexia createMcpHttpContribution and tool registrars with synthetic action context',
    fullRequirementsAgainstProduct: 'NOT_RUN_BY_SCOPE', exitCode: conformance.code,
    scenarioCounts: conformanceCounts,
    results: conformanceChecks?.map(({ id, status, errorMessage }) => ({ id, status, ...(errorMessage ? { error: errorMessage.slice(0, 600) } : {}) })) ?? null,
  };
  if (conformance.code !== 0 || !conformanceChecks?.length) failures.push(`official required 2026-07-28 SDK fixture scenarios failed or emitted no report (exit ${conformance.code}, checks ${conformanceChecks?.length ?? 0})`);

  mutationFixture = await startProtocolFixture(true);
  const mutationDir = resolve(output, 'official-tools-list-deliberate-mutation');
  const mutated = await execute(conformanceBin, ['server', '--url', mutationFixture.url, '--scenario', 'tools-list', '--spec-version', '2026-07-28', '--output-dir', mutationDir, '--verbose'], { timeout: 120_000 });
  await writeFile(resolve(output, 'conformance-mutation.stdout.txt'), mutated.stdout);
  await writeFile(resolve(output, 'conformance-mutation.stderr.txt'), mutated.stderr);
  const mutationChecks = await scenarioResults(mutationDir);
  const toolsListCheck = mutationChecks?.find(item => item.id === 'tools-list');
  const mutationSchemaCheck = mutationChecks?.find(item => item.id === 'wire-schema-valid');
  const baselineToolsList = conformanceChecks?.find(item => item.id === 'tools-list');
  const baselineSchemaCheck = conformanceChecks?.find(item => item.id === 'wire-schema-valid');
  const detected = baselineToolsList?.status === 'SUCCESS' && baselineSchemaCheck?.status === 'SUCCESS' && mutationSchemaCheck?.status === 'FAILURE' &&
    /JSONRPCResultResponse: must have required property 'id'/u.test(mutationSchemaCheck.errorMessage ?? '');
  evidence.mutation = {
    defect: 'delete only the request id from a successful tools/list JSON-RPC response',
    baselineToolsListStatus: baselineToolsList?.status ?? 'NO_REPORT',
    baselineWireSchemaStatus: baselineSchemaCheck?.status ?? 'NO_REPORT',
    mutatedToolsListStatus: toolsListCheck?.status ?? 'NO_REPORT',
    mutatedWireSchemaStatus: mutationSchemaCheck?.status ?? 'NO_REPORT',
    detectedByOfficialTool: detected,
    errorSignature: mutationSchemaCheck?.errorMessage?.slice(0, 300) ?? null,
  };
  if (!detected) failures.push('official conformance did not identify the deliberate malformed tools/list response');

  if (!databaseUrl) throw new Error('BLOCKED: CODEXIA_MCP_CONFORMANCE_DATABASE_URL is required; official protocol, authorization and stdio gates need isolated PostgreSQL');
  if (!disposableOptIn) throw new Error('BLOCKED: CODEXIA_AUTH_TEST_DISPOSABLE=1 is required before the runner may migrate or write its database');
  tempRoot = await mkdtemp(resolve(tmpdir(), 'codexia-mcp-conformance-'));
  liveHost = await startLiveHost(databaseUrl, tempRoot);
  for (const token of Object.values(liveHost.tokens)) secretValues.push(token);
  const endpoint = `${liveHost.baseUrl}/mcp?projectId=${encodeURIComponent(liveHost.projectId)}`;

  productConformanceProxy = await startAuthProxy(endpoint, liveHost.tokens.full);
  const productScenarioDir = resolve(output, 'product-tools-list-2026-07-28');
  const productResult = await execute(conformanceBin, ['server', '--url', productConformanceProxy.url,
    '--scenario', 'tools-list', '--spec-version', '2026-07-28', '--output-dir', productScenarioDir, '--verbose']);
  await writeFile(resolve(output, 'product-tools-list.stdout.txt'), productResult.stdout);
  await writeFile(resolve(output, 'product-tools-list.stderr.txt'), productResult.stderr);
  const productChecks = await scenarioResults(productScenarioDir);
  const productToolListCheck = productChecks?.find(item => item.id === 'tools-list');
  evidence.productToolsListScenario = { exitCode: productResult.code, status: productToolListCheck?.status ?? 'NO_REPORT', target: 'loopback auth proxy to isolated live Fastify/Core/PostgreSQL MCP endpoint', toolCount: productToolListCheck?.details?.toolCount ?? null };
  if (productResult.code !== 0 || productToolListCheck?.status !== 'SUCCESS') failures.push(`official product tools-list scenario failed (exit ${productResult.code}, status ${productToolListCheck?.status ?? 'NO_REPORT'}); see product-tools-list evidence`);

  const path = `/mcp?projectId=${encodeURIComponent(liveHost.projectId)}`;
  const httpTarget = ['--transport', 'http', '--server-url', `${liveHost.baseUrl}${path}`];
  const authHeader = token => ['--header', `Authorization: Bearer ${token}`];
  await guarded('official Inspector HTTP tools/list', async () => {
    const result = await runInspector('inspector-http-tools-list', httpTarget, ['--method', 'tools/list', ...authHeader(liveHost.tokens.full)], true);
    const envelope = JSON.parse(result.stdout);
    assert.ok(JSON.stringify(envelope).includes('invoke_action'), 'published tool list includes invoke_action');
    assert.ok(JSON.stringify(envelope).includes('action_id'), 'published input schema includes action_id');
    evidence.inspector.http = 'PASS: official Inspector connected to live Fastify/Core/PostgreSQL MCP endpoint';
  });
  await guarded('official Inspector stdio', async () => {
    const stdioTarget = ['--transport', 'stdio', '--cwd', root,
      '-e', `CODEXIA_API_URL=${liveHost.baseUrl}`,
      '-e', `CODEXIA_MCP_ACCESS_TOKEN=${liveHost.tokens.full}`,
      '-e', `CODEXIA_PROJECT_ID=${liveHost.projectId}`,
      process.execPath, resolve(root, 'modules/mcp/dist/stdio.js')];
    const result = await runInspector('inspector-stdio-tools-list', stdioTarget, ['--method', 'tools/list'], true);
    assert.ok(JSON.stringify(JSON.parse(result.stdout)).includes('invoke_action'), 'stdio tool list includes invoke_action');
    const actionResult = await runInspector('inspector-stdio-invoke-action', stdioTarget,
      ['--method', 'tools/call', '--tool-name', 'invoke_action', '--tool-arg', 'action_id=core.status'], true);
    assert.ok(JSON.stringify(JSON.parse(actionResult.stdout)).includes('durable'), 'stdio action call reaches live Core and returns durable status');
    evidence.inspector.stdio = 'PASS: official Inspector connected through production serveStdio entry to live API';
  });

  for (const [key, label] of [['owner', 'owner client token'], ['wrongScope', 'wrong scope token'], ['expired', 'expired token']]) {
    await guarded(`authorization rejects ${label}`, async () => {
      const result = await runInspector(`inspector-deny-${key}`, httpTarget, ['--method', 'tools/list', ...authHeader(liveHost.tokens[key])], false);
      if (key === 'expired') {
        assert.match(`${result.stdout}\n${result.stderr}`, /auth_required/u, 'Inspector correctly surfaces the expired-token OAuth challenge');
        const response = await fetch(`${liveHost.baseUrl}/mcp?projectId=${encodeURIComponent(liveHost.projectId)}`, {
          method: 'POST', headers: { Authorization: `Bearer ${liveHost.tokens.expired}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'expired-token-probe', version: '1.0.0' } } }),
        });
        const body = await response.json().catch(() => ({}));
        assert.equal(response.status, 401, 'expired access token is rejected by MCP HTTP admission');
        evidence.authorization[key] = { inspector: 'AUTH_REQUIRED', httpStatus: response.status, httpCode: body.code ?? body.error?.code ?? null };
      } else {
        assert.match(`${result.stdout}\n${result.stderr}`, /403/u, 'client/scope rejection reports HTTP 403');
        evidence.authorization[key] = 'DENIED_403';
      }
    });
  }
  await guarded('authorization rejects unassigned project', async () => {
    const unassigned = ['--transport', 'http', '--server-url', `${liveHost.baseUrl}/mcp?projectId=${encodeURIComponent(liveHost.unassignedProjectId)}`];
    const result = await runInspector('inspector-deny-unassigned-project', unassigned, ['--method', 'tools/list', ...authHeader(liveHost.tokens.full)], false);
    assert.match(`${result.stdout}\n${result.stderr}`, /404/u, 'unassigned project is concealed as HTTP 404');
    evidence.authorization.unassignedProject = 'DENIED';
  });
  await guarded('authorization accepts read scope', async () => {
    await runInspector('inspector-accept-read-scope', httpTarget, ['--method', 'tools/list', ...authHeader(liveHost.tokens.read)], true);
    evidence.authorization.readScope = 'ACCEPTED';
  });

  await guarded('schema and unknown tool negatives', async () => {
    const good = JSON.parse((await runInspector('inspector-invoke-action-success', httpTarget,
      ['--method', 'tools/call', '--tool-name', 'invoke_action', '--tool-arg', 'action_id=core.status', ...authHeader(liveHost.tokens.full)], true)).stdout);
    assert.ok(JSON.stringify(good).includes('durable'), 'known action success control returns live Core status');
    const invalid = await runInspector('inspector-invalid-schema-argument', httpTarget,
      ['--method', 'tools/call', '--tool-name', 'invoke_action', '--tool-arg', 'unexpected=value', ...authHeader(liveHost.tokens.full)], false);
    assert.match(`${invalid.stdout}\n${invalid.stderr}`, /invalid|action_id|schema|argument/iu, 'invalid call is rejected for the missing required action_id');
    evidence.contract = { validInvokeAction: 'ACCEPTED', missingRequiredActionId: 'REJECTED by Inspector/catalog schema validation' };
  });

  await guarded('wire-level unknown tool negative', async () => {
    const moduleRequire = (await import('node:module')).createRequire(resolve(root, 'modules/mcp/package.json'));
    const { Client, StreamableHTTPClientTransport } = await import(moduleRequire.resolve('@modelcontextprotocol/client'));
    const transport = new StreamableHTTPClientTransport(new URL(`/mcp?projectId=${encodeURIComponent(liveHost.projectId)}`, liveHost.baseUrl), {
      authProvider: { token: async () => liveHost.tokens.full },
    });
    const client = new Client({ name: 'codexia-mcp-conformance-probe', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      await client.connect(transport);
      const control = await client.callTool({ name: 'invoke_action', arguments: { action_id: 'core.status' } });
      assert.notEqual(control.isError, true, 'wire-level invoke_action control succeeds');
      await assert.rejects(client.callTool({ name: 'codexia.conformance.missing', arguments: {} }), /Tool codexia\.conformance\.missing not found/u,
        'product SDK client receives unknown-tool rejection');
      const invalid = await client.callTool({ name: 'invoke_action', arguments: { unexpected: true } });
      assert.equal(invalid.isError, true, 'product server rejects invalid input schema over JSON-RPC');
      evidence.contract.wire = { invokeActionControl: 'ACCEPTED', unknownTool: 'REJECTED by product server', invalidInvokeActionSchema: 'REJECTED by product server' };
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  });
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await mutationFixture?.close();
  await protocolFixture?.close();
  await productConformanceProxy?.close();
  await liveHost?.close().catch(error => failures.push(`host cleanup: ${String(error)}`));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  evidence.inspector.status = evidence.inspector.http && evidence.inspector.stdio ? 'PASSED' : 'INCOMPLETE';
  evidence.authorization.status = ['owner', 'wrongScope', 'expired', 'unassignedProject', 'readScope'].every(key => evidence.authorization[key]) ? 'PASSED' : 'INCOMPLETE';
  evidence.contract.status = evidence.contract.wire ? 'PASSED' : 'INCOMPLETE';
  evidence.mutation.status = evidence.mutation.detectedByOfficialTool ? 'DETECTED' : 'NOT_DETECTED';
  evidence.status = failures.length ? 'FAILED_OR_BLOCKED' : 'PASSED';
  evidence.failures = failures;
  await sanitizeEvidenceFiles();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

assert.equal(failures.length, 0, `MCP official verification did not pass; see ${output}/report.json`);
