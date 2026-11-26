import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { verifySemanticControls } from './semantic-controls.mjs';
import { tmpdir } from 'node:os';
import { format } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startBetterAuthFixture } from '../../../packages/api/test/fixtures/better-auth-server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const openApiPath = resolve(root, 'packages/http-contract/openapi/codexia.openapi.yaml');
const databaseUrl = process.env.CODEXIA_HTTP_CONFORMANCE_DATABASE_URL;
assert.ok(databaseUrl, 'CODEXIA_HTTP_CONFORMANCE_DATABASE_URL must point to a dedicated disposable PostgreSQL database');
assert.match(URL.parse(databaseUrl)?.pathname ?? '', /^\/codexia_perf_http_conformance(?:_[a-z0-9_]+)?$/u,
  'The database must be dedicated to HTTP conformance');

// Reuse the existing test fixture's explicit disposable database guard.
assert.equal(process.env.CODEXIA_AUTH_TEST_DISPOSABLE, '1',
  'CODEXIA_AUTH_TEST_DISPOSABLE=1 is required before the runner may migrate or write its database');
process.env.CODEXIA_AUTH_TEST_DATABASE_URL = databaseUrl;

const reportDir = resolve(process.env.CODEXIA_CI_REPORT_DIR ?? 'test-results/conformance/http');
await mkdir(reportDir, { recursive: true });
const schemathesisBin = process.env.SCHEMATHESIS_BIN;
const schemathesisCommand = schemathesisBin || 'uvx';
const schemathesisPrefix = schemathesisBin ? [] : ['--from', 'schemathesis==4.34.2', 'schemathesis'];
const report = {
  format: 'codexia-http-conformance/v1',
  result: 'RUNNING',
  sourceSha: await git(['rev-parse', 'HEAD']),
  openapi: {
    path: 'packages/http-contract/openapi/codexia.openapi.yaml',
    sha256: createHash('sha256').update(await readFile(openApiPath)).digest('hex'),
    totalOperationCount: (await readFile(openApiPath, 'utf8')).match(/^      operationId:/gmu)?.length ?? 0,
    persistenceOperationCount: (await readFile(openApiPath, 'utf8')).match(/^      operationId: persistence_[\w]+$/gmu)?.length ?? 0,
  },
  tool: { name: 'Schemathesis', version: null },
  target: {
    kind: 'loopback Fastify API + disposable PostgreSQL',
    includePathRegex: '^/api/v1/persistence(?:/|$)',
    operations: [],
    excludedOperationCount: 0,
    excludedReason: 'non-persistence paths are outside this Postgres persistence route pass; auth, MCP, streaming, module, and owner API groups require their own fixture semantics',
  },
  phases: [],
};

let fixture;
let driftProxy;
let controlProxy;
let failed = false;
const runtimeErrorLog = [];
const runtimeLogLimit = 2 * 1024 * 1024;
let runtimeLogBytes = 0;
const originalConsoleError = console.error;
const secrets = [databaseUrl];
console.error = (...args) => {
  if (runtimeLogBytes < runtimeLogLimit) {
    const entry = format(...args);
    runtimeErrorLog.push(entry);
    runtimeLogBytes += entry.length;
  }
};
try {
  const versionDir = await mkdtemp(resolve(tmpdir(), 'codexia-http-schemathesis-version-'));
  let versionRun;
  try {
    versionRun = await runProcess(schemathesisCommand, [...schemathesisPrefix, '--version'], versionDir);
  } finally {
    await rm(versionDir, { recursive: true, force: true });
  }
  report.tool.version = versionRun.stdout.trim();
  assert.match(report.tool.version, /schemathesis, version 4\.34\.2/u, 'Schemathesis must match the pinned version');

  fixture = await startBetterAuthFixture({ databaseUrl, usePostgresPersistence: true });
  assert.match(fixture.apiOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u, 'the test API must bind to loopback HTTP');
  const token = await fixture.issueOwnerAccessToken();
  secrets.push(token);
  const schema = openApiPath;
  assert.ok(report.openapi.persistenceOperationCount > 0, 'generated OpenAPI must contain persistence operations');
  report.target.operations.push(`all ${report.openapi.persistenceOperationCount} generated persistence operations`);
  report.target.excludedOperationCount = report.openapi.totalOperationCount - report.openapi.persistenceOperationCount;

  const helperTest = await runProcess(process.execPath, ['--import', 'tsx', '--test', resolve(dirname(fileURLToPath(import.meta.url)), 'semantic-preconditions.test.mjs')]);
  assert.equal(helperTest.exitCode, 0, helperTest.stdout + helperTest.stderr);
  const base = await executeSchemathesis({
    name: 'baseline',
    schema,
    url: fixture.apiOrigin,
    token,
    reportDir,
    includePathRegex: '^/api/v1/persistence(?:/|$)',
    checks: 'not_a_server_error,status_code_conformance,content_type_conformance,response_headers_conformance,response_schema_conformance,codexia_positive_data_acceptance,negative_data_rejection',
    maxExamples: 3,
    expectedFailure: false,
  });
  report.phases.push(base.phase);
  base.phase.gate = validatePhase(base.phase, { expectedExitCode: 0, selected: report.openapi.persistenceOperationCount });
  if (!base.phase.gate.passed) failed = true;
  report.semanticControls = await verifySemanticControls(fixture.apiOrigin, token);

  controlProxy = await startResponseProxy(fixture.apiOrigin, false);
  const control = await executeSchemathesis({
    name: 'unmodified-response-control',
    schema,
    url: controlProxy.origin,
    token,
    reportDir,
    includeOperationId: 'persistence_projects_get',
    checks: 'response_schema_conformance',
    maxExamples: 1,
    expectedFailure: false,
    recordHar: true,
  });
  report.phases.push(control.phase);
  const controlAssertion = await inspectHar(resolve(reportDir, 'unmodified-response-control.har.json'), 'object');
  report.phases.at(-1).controlAssertion = controlAssertion;
  report.phases.at(-1).gate = validatePhase(control.phase, { expectedExitCode: 0, selected: 1 });
  if (!report.phases.at(-1).gate.passed || !controlAssertion.passed) failed = true;
  driftProxy = await startResponseProxy(fixture.apiOrigin, true);
  const drift = await executeSchemathesis({
    name: 'deliberate-response-drift',
    schema,
    url: driftProxy.origin,
    token,
    reportDir,
    includeOperationId: 'persistence_projects_get',
    checks: 'response_schema_conformance',
    maxExamples: 1,
    expectedFailure: true,
    recordHar: true,
  });
  report.phases.push(drift.phase);
  const driftAssertion = await inspectDriftFailure(resolve(reportDir, 'deliberate-response-drift.schemathesis.json'));
  driftAssertion.har = await inspectHar(resolve(reportDir, 'deliberate-response-drift.har.json'), 'empty-array');
  driftAssertion.proxyMutationCount = driftProxy.mutationCount;
  report.phases.at(-1).driftAssertion = driftAssertion;
  report.phases.at(-1).gate = validatePhase(drift.phase, { expectedExitCode: 1, selected: 1, requiredFailureCode: 'ST108' });
  if (!report.phases.at(-1).gate.passed || !driftAssertion.passed || !driftAssertion.har.passed || driftAssertion.proxyMutationCount !== 1) failed = true;
} catch (error) {
  failed = true;
  report.error = safeError(error);
} finally {
  try {
    const cleanup = await Promise.allSettled([
      ...(controlProxy ? [closeServer(controlProxy.server)] : []),
      ...(driftProxy ? [closeServer(driftProxy.server)] : []),
      ...(fixture ? [fixture.close()] : []),
    ]);
    const rejected = cleanup.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  } catch (error) {
    failed = true;
    report.cleanupError = safeError(error);
  }
  console.error = originalConsoleError;
  if (runtimeErrorLog.length > 0) {
    const runtimeLogPath = resolve(reportDir, 'api-runtime.log');
    await writeFile(runtimeLogPath, redactSensitive(runtimeErrorLog.join('\n'), secrets));
    report.runtimeLog = 'api-runtime.log';
  }
}

report.result = failed ? 'FAILED' : 'PASSED';
await writeFile(resolve(reportDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${report.result}: HTTP Schemathesis conformance; evidence: ${resolve(reportDir, 'summary.json')}\n`);
if (failed) process.exitCode = 1;

async function executeSchemathesis({ name, schema, url, token, reportDir, includePathRegex, includeOperationId, checks, maxExamples, expectedFailure, recordHar = false }) {
  const outputJsonPath = resolve(reportDir, `${name}.schemathesis.json`);
  const outputHarPath = resolve(reportDir, `${name}.har.json`);
  const logPath = resolve(reportDir, `${name}.log`);
  const cliOutputDir = await mkdtemp(resolve(tmpdir(), 'codexia-http-schemathesis-'));
  const jsonPath = resolve(cliOutputDir, 'report.json');
  const harPath = resolve(cliOutputDir, 'report.har.json');
  const semanticEvidence = resolve(cliOutputDir, 'semantic-rejections.jsonl');
  const customPositive = name === 'baseline';
  const hookEnv = customPositive ? {
    SCHEMATHESIS_HOOKS: resolve(dirname(fileURLToPath(import.meta.url)), 'codexia_checks.py'),
    CODEXIA_HTTP_SEMANTIC_EVIDENCE: semanticEvidence,
  } : {};
  if (customPositive) await writeFile(semanticEvidence, '');
  const args = [
    ...schemathesisPrefix, 'run', schema,
    '--url', url,
    '--workers', '1',
    '--phases', 'examples,coverage,fuzzing',
    '--checks', checks,
    ...(includePathRegex ? ['--include-path-regex', includePathRegex] : []),
    ...(includeOperationId ? ['--include-operation-id', includeOperationId] : []),
    '--max-examples', String(maxExamples),
    '--seed', '654659',
    '--generation-deterministic',
    '--request-timeout', '5',
    ...(expectedFailure ? ['--max-failures', '1'] : []),
    '--report', recordHar ? 'json,har' : 'json',
    '--report-json-path', jsonPath,
    ...(recordHar ? ['--report-har-path', harPath] : []),
    '--output-sanitize', 'true',
    '--output-truncate', 'true',
    '--no-color',
    '-H', `Authorization: Bearer ${token}`,
  ];
  try {
    const result = await runProcess(schemathesisCommand, args, cliOutputDir, hookEnv);
    const safeLog = redactSensitive(`${result.stdout}\n${result.stderr}`, [token, databaseUrl]);
    await writeFile(logPath, safeLog);
    await copyRedactedFile(jsonPath, outputJsonPath, [token, databaseUrl]);
    if (recordHar) await copyRedactedFile(harPath, outputHarPath, [token, databaseUrl]);
    if (customPositive) await copyRedactedFile(semanticEvidence, resolve(reportDir, 'semantic-rejections.jsonl'), [token, databaseUrl]);
    const phase = {
      name,
      target: new URL(url).origin,
      exitCode: result.exitCode,
      expectedFailure,
      passedExpectation: expectedFailure ? result.exitCode !== 0 : result.exitCode === 0,
      report: `${name}.schemathesis.json`,
      ...(recordHar ? { har: `${name}.har.json` } : {}),
      ...(customPositive ? { semanticRejections: 'semantic-rejections.jsonl' } : {}),
      log: `${name}.log`,
      totals: await extractTotals(outputJsonPath),
    };
    return { exitCode: result.exitCode, stdout: safeLog, phase };
  } finally {
    await rm(cliOutputDir, { recursive: true, force: true });
  }
}

async function startResponseProxy(upstreamOrigin, mutateProjectsResponse) {
  const upstream = new URL(upstreamOrigin);
  let mutationCount = 0;
  const server = createHttpServer((incoming, outgoing) => {
    const isProjectsGet = incoming.method === 'GET' && new URL(incoming.url ?? '/', 'http://fixture.local').pathname === '/api/v1/persistence/projects';
    const upstreamRequest = httpRequest({
      hostname: upstream.hostname,
      port: Number(upstream.port),
      method: incoming.method,
      path: isProjectsGet ? '/api/v1/persistence/projects' : incoming.url,
      headers: { ...incoming.headers, host: upstream.host },
    }, upstreamResponse => {
      const chunks = [];
      upstreamResponse.on('data', chunk => chunks.push(chunk));
      upstreamResponse.on('end', () => {
        const body = Buffer.concat(chunks);
        if (isProjectsGet && mutateProjectsResponse && upstreamResponse.statusCode === 200) {
          // Deliberate fixture-only response contract drift, applied after the real PostgreSQL-backed handler.
          mutationCount += 1;
          outgoing.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' });
          outgoing.end('[]');
          return;
        }
        outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        outgoing.end(body);
      });
    });
    upstreamRequest.on('error', error => {
      outgoing.writeHead(502, { 'content-type': 'text/plain' });
      outgoing.end(error.message);
    });
    incoming.pipe(upstreamRequest);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, origin: `http://127.0.0.1:${address.port}`, get mutationCount() { return mutationCount; } };
}

async function extractTotals(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return {
      complete: value?.complete === true,
      exitCode: value?.exit_code ?? null,
      operations: value?.operations ?? null,
      testCases: value?.test_cases ?? null,
      failures: value?.failures ?? [],
      errors: value?.errors ?? [],
    };
  } catch {
    return null;
  }
}

function validatePhase(phase, { expectedExitCode, selected, requiredFailureCode }) {
  const totals = phase.totals;
  const selectedOperations = totals?.operations?.selected ?? null;
  const testedOperations = totals?.operations?.tested ?? null;
  const generatedCases = totals?.testCases?.generated ?? 0;
  const requiredFailurePresent = requiredFailureCode
    ? totals?.failures?.some(failure => failure.code === requiredFailureCode)
    : true;
  const passed = phase.exitCode === expectedExitCode &&
    totals?.complete === true && totals?.exitCode === expectedExitCode &&
    selectedOperations === selected && testedOperations === selected &&
    (totals?.operations?.errored ?? 1) === 0 && (totals?.operations?.skipped ?? 1) === 0 &&
    generatedCases > 0 && requiredFailurePresent;
  return {
    passed,
    expectedExitCode,
    reportComplete: totals?.complete ?? false,
    reportExitCode: totals?.exitCode ?? null,
    selectedOperations,
    testedOperations,
    skippedOperations: totals?.operations?.skipped ?? null,
    erroredOperations: totals?.operations?.errored ?? null,
    generatedCases,
    requiredFailureCode: requiredFailureCode ?? null,
    requiredFailurePresent,
  };
}

async function inspectDriftFailure(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    const failures = value?.failures ?? [];
    const schemaFailure = failures.find(failure =>
      failure?.code === 'ST108' && failure?.type === 'JsonSchemaError' &&
      failure?.operations?.includes('GET /api/v1/persistence/projects'));
    return {
      passed: Boolean(schemaFailure) && value?.complete === true && value?.exit_code === 1,
      operation: schemaFailure?.operations?.[0] ?? null,
      officialCheck: schemaFailure ? { code: schemaFailure.code, type: schemaFailure.type } : null,
    };
  } catch (error) {
    return { passed: false, error: safeError(error) };
  }
}

async function inspectHar(path, expectedBodyType) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    const entries = value?.log?.entries ?? [];
    const match = entries.find(entry =>
      entry?.request?.method === 'GET' &&
      new URL(entry?.request?.url ?? 'http://invalid').pathname === '/api/v1/persistence/projects');
    const body = match?.response?.content?.text;
    const parsedBody = typeof body === 'string' ? JSON.parse(body) : undefined;
    const bodyType = Array.isArray(parsedBody) ? (parsedBody.length === 0 ? 'empty-array' : 'array') : typeof parsedBody;
    return {
      passed: match?.response?.status === 200 && bodyType === expectedBodyType &&
        (expectedBodyType !== 'empty-array' || body === '[]') &&
        (expectedBodyType !== 'object' || Array.isArray(parsedBody?.projects)),
      operation: match ? 'GET /api/v1/persistence/projects' : null,
      responseStatus: match?.response?.status ?? null,
      responseBodyType: bodyType,
      exactResponseBody: expectedBodyType === 'empty-array' ? body === '[]' : null,
    };
  } catch (error) {
    return { passed: false, error: safeError(error) };
  }
}

async function copyRedactedFile(source, destination, values) {
  let original;
  try {
    original = await readFile(source, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Schemathesis can omit its report on schema or startup errors; the sanitized log remains evidence.
    await rm(destination, { force: true });
    return;
  }
  await writeFile(destination, redactSensitive(original, values));
}

function redactSensitive(value, values) {
  let result = value;
  for (const secret of values) {
    if (!secret) continue;
    for (const variant of new Set([secret, encodeURIComponent(secret)])) {
      result = result.replaceAll(variant, '[REDACTED]');
    }
  }
  return result;
}

async function runProcess(command, args, cwd = root, extraEnv = {}) {
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'GH_TOKEN' && name !== 'GITHUB_TOKEN'));
  const child = spawn(command, args, { cwd, env: { ...childEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const [code] = await once(child, 'close');
  return { exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

async function git(args) {
  return (await runProcess('git', args)).stdout.trim();
}

function safeError(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replaceAll(databaseUrl, '[REDACTED_DATABASE_URL]');
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}
