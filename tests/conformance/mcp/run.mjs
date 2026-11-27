import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startLiveHost } from './live-host.mjs';
import { evaluateProductProfile } from './product-profile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const toolRoot = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(process.env.CODEXIA_CI_REPORT_DIR ?? resolve(root, 'test-results/conformance/mcp'));
const output = resolve(reportRoot, `mcp-${process.pid}-${Date.now()}`);
const databaseUrl = process.env.CODEXIA_MCP_CONFORMANCE_DATABASE_URL;
const disposableOptIn = process.env.CODEXIA_AUTH_TEST_DISPOSABLE === '1';
const conformanceBin = resolve(toolRoot, 'node_modules/.bin/conformance');
const inspectorBin = resolve(toolRoot, 'node_modules/.bin/mcp-inspector');
const conformanceRequire = createRequire(resolve(toolRoot, 'node_modules/@modelcontextprotocol/conformance/package.json'));
const { parse: parseYaml } = conformanceRequire('yaml');
const requirements = parseYaml(await readFile(resolve(toolRoot, 'node_modules/@modelcontextprotocol/conformance/requirements/2026-07-28.yaml'), 'utf8'));
// Exercise the entire pinned requirement manifest against isolated loopback targets.
const excludedScenarios = [];
const requiredServerScenarios = requirements.server;
const unscoredServerScenarios = requirements.not_scored.filter(item => item.leg === 'server');
const secretValues = databaseUrl ? [databaseUrl] : [];
const failures = [];
const evidence = {
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  conformanceTool: '@modelcontextprotocol/conformance@0.2.0-alpha.12',
  inspectorTool: '@modelcontextprotocol/inspector@2.16.0',
  officialConformance: { status: 'NOT_RUN' },
  fullRequiredSuiteAgainstProduct: { status: 'NOT_RUN' },
  stdioProtocolProbe: { status: 'NOT_RUN' },
  inspector: { status: 'NOT_RUN' },
  authorization: { status: 'NOT_RUN' },
  transportErrors: { malformedJson: 'NOT_RUN', unsupportedMethods: 'NOT_RUN' },
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
  for (const secret of secretValues) {
    for (const variant of new Set([secret, encodeURIComponent(secret)])) result = result.replaceAll(variant, '[REDACTED]');
  }
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
  const entries = await readdir(path, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const found = [];
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(child));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

async function scenarioResults(path, scenario) {
  const files = await listFiles(path);
  const reports = files.filter(file => basename(file) === 'checks.json' &&
    (!scenario || basename(dirname(file)).startsWith(`server-${scenario}-`)));
  const all = [];
  for (const report of reports) all.push(...JSON.parse(await readFile(report, 'utf8')));
  return reports.length ? all : null;
}

async function runOfficialScenario({ target, url, scenario, classification, reason, rawRoot, force = false }) {
  const label = scenario.replaceAll('/', '__');
  const directory = resolve(rawRoot, `${target}-${classification}-${label}`);
  const args = ['server', '--url', url, '--scenario', scenario, '--spec-version', '2026-07-28', '--output-dir', directory, '--verbose'];
  if (force) args.push('--force');
  const result = await execute(conformanceBin, args, { timeout: 120_000 });
  await writeFile(resolve(output, `${target}-${classification}-${label}.stdout.txt`), result.stdout);
  await writeFile(resolve(output, `${target}-${classification}-${label}.stderr.txt`), result.stderr);
  const checks = await scenarioResults(directory, scenario);
  const allChecksSkipped = Boolean(checks?.length) && checks.every(check => check.status === 'SKIPPED');
  const skipped = allChecksSkipped || (!checks?.length && /\bSKIPPED\b/u.test(`${result.stdout}\n${result.stderr}`));
  const hasFailingCheck = Boolean(checks?.some(check => check.status === 'FAILURE'));
  const hasPassingBehaviorCheck = Boolean(checks?.some(check =>
    !['wire-schema-valid', 'wire-schema-harness-error'].includes(check.id) && check.status === 'SUCCESS'));
  let status = 'NO_REPORT';
  if (result.code !== 0 || hasFailingCheck) status = 'FAILURE';
  else if (skipped) status = 'SKIPPED';
  else if (hasPassingBehaviorCheck) status = checks.some(check => check.status === 'WARNING') ? 'SUCCESS_WITH_WARNINGS' : 'SUCCESS';
  else if (checks?.length) status = 'NO_PASSING_CHECK';
  const toolCount = scenario === 'tools-list' ? checks?.find(check => check.id === 'tools-list')?.details?.toolCount : undefined;
  return {
    target, classification, scenario, ...(reason ? { reason } : {}), force,
    exitCode: result.code, status,
    ...(scenario === 'server-stateless' ? {
      discoveredCapabilities: checks?.find(check => check.id === 'sep-2575-server-implements-discover')?.details?.result?.capabilities ?? null,
      discoveredToolNames: checks?.find(check => check.id === 'sep-2575-discover-capabilities-match-handlers')?.details?.response?.result?.tools?.map(tool => tool.name) ?? null,
    } : {}),
    ...(typeof toolCount === 'number' ? { toolCount } : {}),
    checkCounts: (checks ?? []).reduce((counts, check) => ({ ...counts, [check.status]: (counts[check.status] ?? 0) + 1 }), {}),
    checks: checks?.map(({ id, status: checkStatus, errorMessage }) => ({ id, status: checkStatus, ...(errorMessage ? { error: errorMessage.slice(0, 600) } : {}) })) ?? null,
    ...(skipped ? { skipReason: result.stdout.slice(0, 400) } : {}),
  };
}

async function runOfficialMatrix(target, url, rawRoot) {
  const required = [];
  for (const scenario of requiredServerScenarios) {
    required.push(await runOfficialScenario({ target, url, scenario, classification: 'required', rawRoot, force: true }));
  }
  const unscored = [];
  for (const item of unscoredServerScenarios) {
    unscored.push(await runOfficialScenario({
      target, url, scenario: item.scenario, classification: 'unscored', reason: item.reason,
      rawRoot, force: true,
    }));
  }
  const eligibleRequiredPassed = required.every(item => item.status === 'SUCCESS' || item.status === 'SUCCESS_WITH_WARNINGS');
  const counts = items => items.reduce((summary, item) => ({ ...summary, [item.status]: (summary[item.status] ?? 0) + 1 }), {});
  return {
    requirements: '2026-07-28',
    required: { attempted: required.length, counts: counts(required), results: required },
    unscored: { attempted: unscored.length, counts: counts(unscored), results: unscored },
    excluded: excludedScenarios,
    eligibleRequiredPassed,
    productProfile: evaluateProductProfile(required),
    fullRequirementSetPassed: eligibleRequiredPassed && excludedScenarios.length === 0,
  };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveExit => {
    child.once('exit', resolveExit);
    child.kill('SIGTERM');
  });
}

async function publishOfficialEvidence(source) {
  for (const file of await listFiles(source)) {
    const target = resolve(output, relative(source, file));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, redact(await readFile(file, 'utf8')));
  }
}

async function runInspector(label, target, args, expectPass) {
  const result = await execute(inspectorBin, ['--cli', '--format', 'json', '--protocol-era', 'modern', ...target, ...args]);
  await writeFile(resolve(output, `${label}.stdout.txt`), result.stdout);
  await writeFile(resolve(output, `${label}.stderr.txt`), result.stderr);
  const passed = expectPass ? result.code === 0 : result.code !== 0;
  if (!passed) throw new Error(`${label} expected ${expectPass ? 'success' : 'contract rejection'} but exited ${result.code}: ${result.stderr.slice(-900)}`);
  return result;
}

async function verifyAdmissionError(result, endpoint, token, expectedStatus, expectedCode) {
  const { error } = JSON.parse(result.stderr);
  assert.equal(error.code, expectedStatus === 404 ? 'error' : 'auth_required');
  if (error.status !== undefined) assert.equal(error.status, expectedStatus);
  // Inspector's discovery errors do not always retain the API response body.
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(5_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
  });
  assert.equal(response.status, expectedStatus);
  const body = await response.json();
  assert.equal(body.code, expectedCode);
  return { inspectorCode: error.code, httpStatus: response.status, httpCode: body.code };
}

function assertLiveProjectStatus(result, projectId) {
  const { structuredContent } = JSON.parse(result.stdout).result;
  assert.equal(structuredContent.snapshot.projectId, projectId);
  assert.equal(structuredContent.data.state, 'durable');
}

// Connect to the fixed loopback endpoint; vary only admission headers.
async function discoverWithHeaders(endpoint, token, headers) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'server/discover',
    params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'codexia-admission-probe', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } },
  });
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', rejectRequest);
      response.once('end', () => {
        try {
          resolveRequest({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          rejectRequest(error);
        }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('MCP admission probe timed out')));
    request.once('error', rejectRequest);
    request.end(body);
  });
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
let rawReports;
try {
  execFileSync(process.execPath, ['--test', resolve(toolRoot, 'product-profile.test.mjs')], { cwd: root, stdio: 'inherit' });
  tempRoot = await mkdtemp(resolve(tmpdir(), 'codexia-mcp-conformance-'));
  rawReports = resolve(tempRoot, 'official-reports');
  protocolFixture = await startProtocolFixture();
  const syntheticConformance = await runOfficialMatrix('synthetic', protocolFixture.url, rawReports);
  evidence.officialConformance = {
    target: 'current @modelcontextprotocol/server SDK plus Codexia createMcpHttpContribution and tool registrars with synthetic action context',
    manifest: '@modelcontextprotocol/conformance requirements/2026-07-28.yaml',
    ...syntheticConformance,
  };
  if (!syntheticConformance.productProfile.passed) failures.push('2026-07-28 synthetic fixture product-profile acceptance failed; see native reports and applicability results');
  if (syntheticConformance.excluded.length) failures.push('full 2026-07-28 synthetic requirement set is not certified because required scenarios were excluded');

  mutationFixture = await startProtocolFixture(true);
  const mutationDir = resolve(rawReports, 'official-tools-list-deliberate-mutation');
  const mutated = await execute(conformanceBin, ['server', '--url', mutationFixture.url, '--scenario', 'tools-list', '--spec-version', '2026-07-28', '--output-dir', mutationDir, '--verbose'], { timeout: 120_000 });
  await writeFile(resolve(output, 'conformance-mutation.stdout.txt'), mutated.stdout);
  await writeFile(resolve(output, 'conformance-mutation.stderr.txt'), mutated.stderr);
  const mutationChecks = await scenarioResults(mutationDir);
  const toolsListCheck = mutationChecks?.find(item => item.id === 'tools-list');
  const mutationSchemaCheck = mutationChecks?.find(item => item.id === 'wire-schema-valid');
  const baselineToolsListChecks = syntheticConformance.required.results.find(item => item.scenario === 'tools-list')?.checks ?? null;
  const baselineToolsList = baselineToolsListChecks?.find(item => item.id === 'tools-list');
  const baselineSchemaCheck = baselineToolsListChecks?.find(item => item.id === 'wire-schema-valid');
  const detected = mutated.code === 1 && baselineToolsList?.status === 'SUCCESS' && baselineSchemaCheck?.status === 'SUCCESS' && mutationSchemaCheck?.status === 'FAILURE' &&
    /JSONRPCResultResponse: must have required property 'id'/u.test(mutationSchemaCheck.errorMessage ?? '');
  evidence.mutation = {
    defect: 'delete only the request id from a successful tools/list JSON-RPC response',
    exitCode: mutated.code,
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
  liveHost = await startLiveHost(databaseUrl, tempRoot);
  for (const token of Object.values(liveHost.tokens)) secretValues.push(token);
  const endpoint = `${liveHost.baseUrl}/mcp?projectId=${encodeURIComponent(liveHost.projectId)}`;

  await guarded('live MCP malformed JSON behavior', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Bearer ${liveHost.tokens.full}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
      },
      body: '{',
    });
    const body = await response.json();
    const conforms = response.status === 400 && body.jsonrpc === '2.0' && body.id === null && body.error?.code === -32700;
    evidence.transportErrors.malformedJson = {
      status: conforms ? 'PASS' : 'FAIL',
      httpStatus: response.status,
      body,
      expected: { status: 400, jsonrpc: '2.0', id: null, errorCode: -32700 },
    };
    assert.ok(conforms, 'live MCP malformed JSON response must be a JSON-RPC parse error');
  });

  await guarded('live MCP method denial occurs after project admission', async () => {
    const routes = [
      { name: 'standalone', url: endpoint, deniedUrl: `${liveHost.baseUrl}/mcp?projectId=${liveHost.unassignedProjectId}` },
      {
        name: 'project',
        url: `${liveHost.baseUrl}/api/projects/${liveHost.projectId}/modules/mcp/streamable`,
        deniedUrl: `${liveHost.baseUrl}/api/projects/${liveHost.unassignedProjectId}/modules/mcp/streamable`,
      },
    ];
    const results = [];
    for (const { name, url, deniedUrl } of routes) {
      for (const method of ['GET', 'DELETE']) {
        const headers = { Authorization: `Bearer ${liveHost.tokens.full}` };
        const anonymous = await fetch(url, { method, signal: AbortSignal.timeout(5_000) });
        assert.equal(anonymous.status, 401);
        assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Bearer\b/u);
        assert.equal((await anonymous.json()).code, 'UNAUTHORIZED');
        const denied = await fetch(deniedUrl, { method, headers, signal: AbortSignal.timeout(5_000) });
        assert.equal(denied.status, 404);
        assert.equal((await denied.json()).code, 'PROJECT_NOT_FOUND');
        const admitted = await fetch(url, { method, headers, signal: AbortSignal.timeout(5_000) });
        assert.equal(admitted.status, 405);
        assert.equal(admitted.headers.get('allow'), 'POST');
        const body = await admitted.json();
        assert.equal(body.jsonrpc, '2.0');
        assert.equal(body.id, null);
        assert.equal(body.error?.code, -32000);
        results.push({
          route: name, method, anonymousStatus: anonymous.status, unassignedStatus: denied.status, admittedStatus: admitted.status, body,
        });
      }
    }
    evidence.transportErrors.unsupportedMethods = { status: 'PASS', results };
  });

  await guarded('live product loopback and configured origin policy', async () => {
    const origin = new URL(endpoint).origin;
    const host = new URL(endpoint).host;
    const control = await discoverWithHeaders(endpoint, liveHost.tokens.full, { Host: host, Origin: origin });
    assert.equal(control.status, 200);
    assert.equal(control.body.jsonrpc, '2.0');
    const deniedOrigin = await discoverWithHeaders(endpoint, liveHost.tokens.full, { Host: host, Origin: 'https://foreign.example.test' });
    assert.equal(deniedOrigin.status, 403);
    assert.equal(deniedOrigin.body.code, 'CORS_ORIGIN_DENIED');
    const deniedHost = await discoverWithHeaders(endpoint, liveHost.tokens.full, { Host: 'unconfigured.example.test' });
    assert.equal(deniedHost.status, 403);
    assert.equal(deniedHost.body.code, 'MCP_HOST_DENIED');
    evidence.authorization.originPolicy = {
      sameOrigin: { status: control.status, jsonrpc: control.body.jsonrpc },
      unconfiguredOrigin: { status: deniedOrigin.status, code: deniedOrigin.body.code },
      forgedHost: { status: deniedHost.status, code: deniedHost.body.code },
    };
  });

  productConformanceProxy = await startAuthProxy(endpoint, liveHost.tokens.full);
  await guarded('conformance proxy preserves product Host admission', async () => {
    const proxyUrl = new URL(productConformanceProxy.url);
    const control = await discoverWithHeaders(proxyUrl, liveHost.tokens.full, { Host: proxyUrl.host, Origin: proxyUrl.origin });
    assert.equal(control.status, 200);
    assert.equal(control.body.jsonrpc, '2.0');
    const denied = await discoverWithHeaders(proxyUrl, liveHost.tokens.full, { Host: 'unconfigured.example.test' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'MCP_HOST_DENIED');
    evidence.authorization.proxyHostPolicy = { validHost: control.status, forgedHost: denied.status, code: denied.body.code };
  });
  const productConformance = await runOfficialMatrix('product', productConformanceProxy.url, rawReports);
  evidence.fullRequiredSuiteAgainstProduct = {
    target: 'loopback auth proxy to isolated live Fastify/Core/PostgreSQL MCP endpoint',
    manifest: '@modelcontextprotocol/conformance requirements/2026-07-28.yaml',
    ...productConformance,
  };
  if (!productConformance.productProfile.passed) failures.push('2026-07-28 live product-profile acceptance failed; see native reports and applicability results');
  if (productConformance.excluded.length) failures.push('full 2026-07-28 product requirement set is not certified because required scenarios were excluded');
  const productToolListCheck = productConformance.required.results.find(item => item.scenario === 'tools-list');
  evidence.productToolsListScenario = {
    exitCode: productToolListCheck?.exitCode ?? null,
    status: productToolListCheck?.status ?? 'NO_REPORT',
    toolCount: productToolListCheck?.toolCount ?? null,
    target: 'loopback auth proxy to isolated live Fastify/Core/PostgreSQL MCP endpoint',
  };
  if (!['SUCCESS', 'SUCCESS_WITH_WARNINGS'].includes(productToolListCheck?.status)) {
    failures.push(`official product tools-list scenario failed (${productToolListCheck?.status ?? 'NO_REPORT'}); see product tools-list report`);
  }

  const path = `/mcp?projectId=${encodeURIComponent(liveHost.projectId)}`;
  const httpTarget = ['--transport', 'http', '--server-url', `${liveHost.baseUrl}${path}`];
  const authHeader = token => ['--header', `Authorization: Bearer ${token}`];
  await guarded('official Inspector HTTP tools/list', async () => {
    const result = await runInspector('inspector-http-tools-list', httpTarget, ['--method', 'tools/list', ...authHeader(liveHost.tokens.full)], true);
    const { tools } = JSON.parse(result.stdout).result;
    const invoke = tools.find(tool => tool.name === 'invoke_action');
    assert.ok(invoke?.inputSchema?.required?.includes('action_id'), 'invoke_action publishes required action_id');
    evidence.inspector.http = 'PASS: official Inspector connected to live Fastify/Core/PostgreSQL MCP endpoint';
  });
  await guarded('official Inspector stdio', async () => {
    const stdioTarget = ['--transport', 'stdio', '--cwd', root,
      '-e', `CODEXIA_API_URL=${liveHost.baseUrl}`,
      '-e', `CODEXIA_MCP_ACCESS_TOKEN=${liveHost.tokens.full}`,
      '-e', `CODEXIA_PROJECT_ID=${liveHost.projectId}`,
      process.execPath, resolve(root, 'modules/mcp/dist/stdio.js')];
    const result = await runInspector('inspector-stdio-tools-list', stdioTarget, ['--method', 'tools/list'], true);
    assert.ok(JSON.parse(result.stdout).result.tools.some(tool => tool.name === 'invoke_action'), 'stdio tool list includes invoke_action');
    const actionResult = await runInspector('inspector-stdio-invoke-action', stdioTarget,
      ['--method', 'tools/call', '--tool-name', 'invoke_action', '--tool-arg', 'action_id=core.status'], true);
    assertLiveProjectStatus(actionResult, liveHost.projectId);
    evidence.inspector.stdio = 'PASS: official Inspector connected through production serveStdio entry to live API';
  });

  for (const [key, label, status, code] of [
    ['owner', 'owner client token', 403, 'OAUTH_MCP_CLIENT_NOT_ALLOWED'],
    ['wrongScope', 'wrong scope token', 403, 'OAUTH_MCP_SCOPE_INVALID'],
    ['expired', 'expired token', 401, 'OAUTH_TOKEN_INVALID'],
  ]) {
    await guarded(`authorization rejects ${label}`, async () => {
      const token = liveHost.tokens[key];
      const result = await runInspector(`inspector-deny-${key}`, httpTarget, ['--method', 'tools/list', ...authHeader(token)], false);
      evidence.authorization[key] = await verifyAdmissionError(result, endpoint, token, status, code);
    });
  }
  await guarded('authorization rejects unassigned project', async () => {
    const unassignedEndpoint = `${liveHost.baseUrl}/mcp?projectId=${encodeURIComponent(liveHost.unassignedProjectId)}`;
    const unassigned = ['--transport', 'http', '--server-url', unassignedEndpoint];
    const result = await runInspector('inspector-deny-unassigned-project', unassigned, ['--method', 'tools/list', ...authHeader(liveHost.tokens.full)], false);
    evidence.authorization.unassignedProject = await verifyAdmissionError(result, unassignedEndpoint, liveHost.tokens.full, 404, 'PROJECT_NOT_FOUND');
  });
  await guarded('authorization accepts read scope', async () => {
    await runInspector('inspector-accept-read-scope', httpTarget, ['--method', 'tools/list', ...authHeader(liveHost.tokens.read)], true);
    evidence.authorization.readScope = 'ACCEPTED';
  });

  await guarded('schema and unknown tool negatives', async () => {
    const good = await runInspector('inspector-invoke-action-success', httpTarget,
      ['--method', 'tools/call', '--tool-name', 'invoke_action', '--tool-arg', 'action_id=core.status', ...authHeader(liveHost.tokens.full)], true);
    assertLiveProjectStatus(good, liveHost.projectId);
    const invalid = await runInspector('inspector-invalid-schema-argument', httpTarget,
      ['--method', 'tools/call', '--tool-name', 'invoke_action', '--tool-arg', 'unexpected=value', ...authHeader(liveHost.tokens.full)], false);
    const { result } = JSON.parse(invalid.stdout);
    assert.equal(result.isError, true);
    assert.ok(result.content.some(item => item.type === 'text' && /Input validation error: .*action_id/u.test(item.text)));
    evidence.contract = { validInvokeAction: 'ACCEPTED', missingRequiredActionId: 'REJECTED' };
  });

  await guarded('wire-level unknown tool negative', async () => {
    const moduleRequire = (await import('node:module')).createRequire(resolve(root, 'modules/mcp/package.json'));
    const { Client, ProtocolErrorCode, StreamableHTTPClientTransport } = await import(moduleRequire.resolve('@modelcontextprotocol/client'));
    const { StdioClientTransport } = await import(moduleRequire.resolve('@modelcontextprotocol/client/stdio'));
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

    const stdioEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', CODEXIA_API_URL: liveHost.baseUrl,
      CODEXIA_MCP_ACCESS_TOKEN: liveHost.tokens.full, CODEXIA_PROJECT_ID: liveHost.projectId,
    };
    for (const era of ['legacy', 'modern']) {
      const stdioTransport = new StdioClientTransport({
        command: process.execPath, args: [resolve(root, 'modules/mcp/dist/stdio.js')], env: stdioEnv, cwd: root, stderr: 'inherit',
      });
      const stdioClient = new Client({ name: `codexia-mcp-${era}`, version: '1.0.0' }, {
        versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } },
      });
      try {
        if (era === 'legacy' && Date.now() >= Date.UTC(2027, 0, 28)) {
          await assert.rejects(stdioClient.connect(stdioTransport), { code: ProtocolErrorCode.UnsupportedProtocolVersion });
          evidence.stdioProtocolProbe.legacy = { admission: 'REJECTED_AFTER_CUTOFF' };
          continue;
        }
        await stdioClient.connect(stdioTransport);
        assert.equal(stdioClient.getProtocolEra(), era);
        const version = stdioClient.getNegotiatedProtocolVersion();
        assert.match(version, era === 'legacy' ? /^2025-/u : /^2026-07-28$/u);
        const catalog = await stdioClient.listTools();
        assert.ok(catalog.tools.some(tool => tool.name === 'invoke_action'), `stdio ${era} lists Codexia tools`);
        const status = await stdioClient.callTool({ name: 'invoke_action', arguments: { action_id: 'core.status' } });
        assert.equal(status.structuredContent?.snapshot?.projectId, liveHost.projectId);
        evidence.stdioProtocolProbe[era] = { admission: 'ACCEPTED', version };
      } finally {
        await stdioClient.close().catch(() => undefined);
        await stdioTransport.close().catch(() => undefined);
      }
    }
  });
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await mutationFixture?.close();
  await protocolFixture?.close();
  await productConformanceProxy?.close();
  await liveHost?.close().catch(error => failures.push(`host cleanup: ${String(error)}`));
  if (rawReports) await guarded('publish native reports', () => publishOfficialEvidence(rawReports));
  if (tempRoot) await guarded('remove fixture directory', () => rm(tempRoot, { recursive: true, force: true }));
  evidence.inspector.status = evidence.inspector.http && evidence.inspector.stdio ? 'PASSED' : 'INCOMPLETE';
  evidence.authorization.status = ['owner', 'wrongScope', 'expired', 'unassignedProject', 'readScope', 'originPolicy', 'proxyHostPolicy'].every(key => evidence.authorization[key]) ? 'PASSED' : 'INCOMPLETE';
  evidence.authorization.excluded = excludedScenarios;
  evidence.contract.status = evidence.contract.wire ? 'PASSED' : 'INCOMPLETE';
  evidence.stdioProtocolProbe.status = evidence.stdioProtocolProbe.legacy && evidence.stdioProtocolProbe.modern ? 'PASSED' : 'INCOMPLETE';
  evidence.mutation.status = evidence.mutation.detectedByOfficialTool ? 'DETECTED' : 'NOT_DETECTED';
  evidence.status = failures.length ? 'FAILED_OR_BLOCKED' : 'PASSED';
  evidence.failures = failures;
  await writeFile(resolve(output, 'report.json'), `${redact(JSON.stringify(evidence, null, 2))}\n`);
}

assert.equal(failures.length, 0, `MCP official verification did not pass; see ${output}/report.json`);
