import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createNodeServer } from "node:http";
import test from "node:test";

import { CoreStore } from "../../packages/core/dist/index.js";
import { MODEL_USAGE_CAPABILITY } from "../../packages/contracts/dist/index.js";
import { createPostgresPersistence, migratePostgresDatabase } from "../../packages/persistence-postgres/dist/index.js";
import { ModuleRuntime } from "../../packages/module-runtime/dist/index.js";
import { createServer } from "../../packages/api/dist/server.js";
import { HistoricalModelUsageStore } from "../../packages/api/dist/historical-store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const moduleRequire = createRequire(resolve(root, "modules/mcp/package.json"));
const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
  import(moduleRequire.resolve("@modelcontextprotocol/sdk/client/index.js")),
  import(moduleRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")),
  import(moduleRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")),
]);

const NATIVE_TOOL_NAMES = [
  "knowledge.nodes.list", "knowledge.node.get", "knowledge.aliases.list", "knowledge.relations.list",
  "evidence.anchor.get", "evidence.document.list", "evidence.node.list", "evidence.assertion.get", "evidence.assertion.list",
  "knowledge.propose", "changesets.list", "changeset.get", "knowledge.merge.preview", "knowledge.merge.propose",
];
const READY_MODULES = (process.env.CODEXIA_MCP_ACCEPTANCE_MODULES ?? "story,nlp,diagnostics,semantic,speaker,publishing,mcp")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const DATABASE_URL = process.env.CODEXIA_TEST_DATABASE_URL ?? process.env.CODEXIA_DATABASE_URL;
if (!DATABASE_URL) throw new Error("CODEXIA_TEST_DATABASE_URL must name a disposable PostgreSQL database for MCP acceptance");
const ACCESS_TOKEN = randomBytes(32).toString("base64url");

async function runtimeOptions(cacheDirectory, usageDirectory) {
  const manifests = [];
  const loaders = {};
  const moduleDirectories = {};
  const workerEntries = {};
  for (const id of READY_MODULES) {
    const directory = resolve(root, "modules", id);
    const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")).codexiaModule;
    assert.equal(metadata.id, id, `Missing real ${id} module manifest`);
    manifests.push(metadata);
    moduleDirectories[id] = directory;
    if (metadata.workerEntry) workerEntries[id] = resolve(directory, metadata.workerEntry);
    const entry = pathToFileURL(resolve(directory, metadata.serverEntry));
    loaders[id] = async (context) => {
      const module = await import(entry.href);
      assert.equal(typeof module.createModule, "function", `${id} must export createModule`);
      return module.createModule(context);
    };
  }
  return new ModuleRuntime({
    manifests,
    enabled: READY_MODULES,
    loaders,
    moduleDirectories,
    workerEntries,
    hostCapabilities: [MODEL_USAGE_CAPABILITY],
    capabilityProviders: {
      [MODEL_USAGE_CAPABILITY]: { create: () => new HistoricalModelUsageStore(usageDirectory) },
    },
    cacheDirectory,
  });
}

async function startAdmissionHost({ cacheDirectory, usageDirectory, hosted }) {
  const databaseUrl = DATABASE_URL;
  await migratePostgresDatabase(databaseUrl);
  const persistence = createPostgresPersistence(databaseUrl);
  const runtime = await runtimeOptions(cacheDirectory, usageDirectory);
  const store = new CoreStore({ persistence });
  const server = createServer({
    store, persistence, ...(hosted ? { hosted, trustProxy: true } : { authToken: ACCESS_TOKEN }),
    staticDir: resolve(root, "app/dist"), runtime, usageDirectory,
    profile: "mcp-admission-acceptance",
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolveListen(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let closePromise;
  return {
    base: `http://127.0.0.1:${address.port}`, runtime, store,
    close() {
      closePromise ??= new Promise((resolveClose, rejectClose) => {
        server.close(async (error) => {
          if (error) { rejectClose(error); return; }
          try { await runtime.shutdown(); await persistence.close(); resolveClose(); }
          catch (closeError) { rejectClose(closeError); }
        });
      });
      return closePromise;
    },
  };
}

async function apiRequest(host, path, { method = "GET", body, cookie, bearer = false } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = `Bearer ${ACCESS_TOKEN}`;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.Origin = host.base;
  }
  return fetch(`${host.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseJson(response, label) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned invalid JSON (HTTP ${response.status})`); }
}

async function ownerJson(host, cookie, path, { method = "GET", body, status = 200 } = {}) {
  const response = await apiRequest(host, path, { method, body, cookie });
  assert.equal(response.status, status, `${method} ${path} should return HTTP ${status}, got ${response.status}`);
  return response.status === 204 ? undefined : responseJson(response, `${method} ${path}`);
}

async function ownerAction(host, cookie, projectId, actionId, input) {
  const result = await ownerJson(host, cookie,
    `/api/projects/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(actionId)}`,
    { method: "POST", body: { input } });
  assert.equal(result.ok, true, `${actionId} failed: ${JSON.stringify(result.error)}`);
  return result;
}

async function login(host) {
  const response = await apiRequest(host, "/api/login", { method: "POST", body: { token: ACCESS_TOKEN } });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "Owner login did not establish a cookie session");
  return cookie.split(";", 1)[0];
}

function success(result, name) {
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  assert.ok(result.structuredContent, `${name} did not return MCP structured content`);
  return result.structuredContent;
}

function errorCode(result, name) {
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  const content = result.structuredContent;
  assert.equal(typeof content?.error?.code, "string", `${name} did not return a typed error`);
  return content.error.code;
}

async function startStdioClient(host, projectId, token = ACCESS_TOKEN) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    CODEXIA_API_URL: host.base,
    CODEXIA_AUTH_TOKEN: token,
    CODEXIA_PROJECT_ID: projectId,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "modules/mcp/dist/stdio.js")],
    env: environment,
    cwd: root,
    stderr: "inherit",
  });
  const client = new Client({ name: "codexia-mcp-acceptance-stdio", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function startHttpClient(host, projectId, token = ACCESS_TOKEN) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/modules/mcp/streamable`;
  const transport = new StreamableHTTPClientTransport(new URL(path, host.base), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
    reconnectionOptions: { maxReconnectionDelay: 100, initialReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
  });
  const client = new Client({ name: "codexia-mcp-acceptance-http", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function closeMcpClient(connection, http = false) {
  if (!connection) return;
  if (http) await connection.transport.terminateSession().catch(() => undefined);
  await connection.client.close().catch(() => undefined);
  await connection.transport.close().catch(() => undefined);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

test("native Knowledge MCP tools preserve PostgreSQL scope, proposal, replay, review and receipt over both transports", {
  timeout: 120_000,
}, async (t) => {
  const databaseUrl = DATABASE_URL;
  const rootDir = await mkdtemp(resolve(tmpdir(), "codexia-native-mcp-postgres-"));
  const usageDirectory = resolve(rootDir, "host-history");
  const previousProviderEnv = new Map(["ARCADIA_LLM_PROVIDER", "ARCADIA_LLM_MODEL", "ARCADIA_LLM_BASE_URL", "ARCADIA_LLM_API_KEY"].map(name => [name, process.env[name]]));
  const providerProbe = await startProviderProbe();
  process.env.ARCADIA_LLM_PROVIDER = "openai-compatible";
  process.env.ARCADIA_LLM_MODEL = "native-mcp-admission-probe";
  process.env.ARCADIA_LLM_BASE_URL = providerProbe.baseUrl;
  process.env.ARCADIA_LLM_API_KEY = "integration-placeholder";
  let host;
  let stdio;
  let http;
  const persistence = createPostgresPersistence(databaseUrl);
  t.after(async () => {
    await closeMcpClient(http, true);
    await closeMcpClient(stdio);
    await host?.close().catch(() => undefined);
    await persistence.close();
    await providerProbe.close();
    await rm(rootDir, { recursive: true, force: true });
    for (const [name, value] of previousProviderEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  host = await startAdmissionHost({ cacheDirectory: resolve(rootDir, "module-cache"), usageDirectory });
  const cookie = await login(host);
  const project = await ownerJson(host, cookie, "/api/v1/persistence/projects", {
    method: "POST", status: 201, body: { title: `Native MCP ${randomUUID()}` },
  });
  const projectId = project.project.id;
  const sourceId = randomUUID();
  const targetId = randomUUID();
  await persistence.transaction(async tx => {
    await tx.saveKnowledgeNode({ projectId, id: sourceId, type: "person", name: "MCP source", attributes: { sourceFact: "kept" }, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeNode({ projectId, id: targetId, type: "person", name: "MCP target", attributes: { targetFact: "kept" }, status: "confirmed", expectedVersion: null });
  });
  const projectVersion = (await persistence.read(reader => reader.getProject(projectId))).version;
  stdio = await startStdioClient(host, projectId);
  http = await startHttpClient(host, projectId);

  for (const [name, connection] of [["stdio", stdio], ["Streamable HTTP", http]]) {
    const catalog = await connection.client.listTools();
    const toolNames = catalog.tools.map(tool => tool.name);
    for (const toolName of NATIVE_TOOL_NAMES) assert.ok(toolNames.includes(toolName), `${name} missing ${toolName}`);
    assert.equal(toolNames.some(toolName => /approve|apply/u.test(toolName)), false, `${name} exposed author approval or apply`);
    const nodes = success(await connection.client.callTool({ name: "knowledge.nodes.list", arguments: { project_version: projectVersion, limit: 20 } }), `${name} native nodes list`);
    assert.equal(nodes.snapshot.projectVersion, projectVersion);
    assert.deepEqual(new Set(nodes.data.map(node => node.id)), new Set([sourceId, targetId]));
  }

  // Standalone owner credentials may select another owned project. Use the actual
  // Hosted assignment boundary for cross-project and read-only grant checks.
  const otherProject = await ownerJson(host, cookie, "/api/v1/persistence/projects", {
    method: "POST", status: 201, body: { title: `Other native MCP ${randomUUID()}` },
  });
  const otherProjectId = otherProject.project.id;
  const otherNodeId = randomUUID();
  await persistence.transaction(tx => tx.saveKnowledgeNode({
    projectId: otherProjectId, id: otherNodeId, type: "person", name: "Unassigned node",
    attributes: {}, status: "confirmed", expectedVersion: null,
  }));
  const otherVersion = (await persistence.read(reader => reader.getProject(otherProjectId))).version;
  const assignment = {
    contractVersion: "scriptorium-platform/v1", instanceId: "native-mcp-acceptance", repositoryId: 123,
    repositoryLocator: "https://github.com/owner/work", defaultBranchPolicy: "repository-default",
    runtimeEpoch: 3, imageDigest: `sha256:${"a".repeat(64)}`,
    compositionManifestDigest: `sha256:${"b".repeat(64)}`, enabledModuleIds: READY_MODULES,
    credentialBrokerLocator: "https://praetorium.example/internal/github/credential",
    controlServicePolicy: { issuer: "https://praetorium.example", jwksUrl: "https://praetorium.example/.well-known/control-jwks.json", audience: "praetorium-runtime-control" },
    grantPolicy: { issuer: "https://praetorium.example", jwksUrl: "https://praetorium.example/.well-known/grant-jwks.json", audience: "https://native-mcp-acceptance.instances.example" },
  };
  const readToken = randomBytes(32).toString("base64url");
  const writeToken = randomBytes(32).toString("base64url");
  const hosted = await startAdmissionHost({
    cacheDirectory: resolve(rootDir, "hosted-module-cache"), usageDirectory: resolve(rootDir, "hosted-history"),
    hosted: { assignment, projectId, authorization: {
      async authenticate(token, requiredPermission = "read") {
        if (token !== readToken && token !== writeToken) throw Object.assign(new Error("grant invalid"), { status: 401 });
        const permissions = token === writeToken ? ["read", "write"] : ["read"];
        if (!permissions.includes(requiredPermission)) throw Object.assign(new Error("permission denied"), { status: 403 });
        return { userId: token === writeToken ? "writer-1" : "reader-1", permissions,
          repositoryId: assignment.repositoryId, instanceId: assignment.instanceId, runtimeEpoch: assignment.runtimeEpoch,
          sessionRevision: 1, authorizationRevision: 1, expiresAt: Date.now() + 60_000 };
      },
    } },
  });
  t.after(() => hosted.close());
  const rejectedNode = randomUUID();
  const otherOperation = { type: "knowledge.node.save", command: {
    projectId: otherProjectId, id: rejectedNode, type: "person", name: "Must not be written",
    attributes: {}, status: "confirmed", expectedVersion: null,
  } };
  const rejected = async (connection, name, args, label) => {
    const result = await connection.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${label} unexpectedly succeeded: ${JSON.stringify(result.structuredContent ?? result.content)}`);
    return result;
  };
  for (const [label, connect, isHttp] of [["stdio", startStdioClient, false], ["Streamable HTTP", startHttpClient, true]]) {
    const writer = await connect(hosted, projectId, writeToken);
    let reader;
    try {
      const validPreview = success(await writer.client.callTool({
        name: "knowledge.merge.preview", arguments: { source_id: sourceId, target_id: targetId, project_version: projectVersion },
      }), `${label} Hosted writer preview`);
      assert.equal(validPreview.snapshot.projectId, projectId);
      assert.equal(validPreview.snapshot.projectVersion, projectVersion);
      for (const [tool, args] of [
        ["knowledge.nodes.list", { project_id: otherProjectId, project_version: otherVersion }],
        ["invoke_action", { project_id: otherProjectId, action_id: "core.knowledge.nodes.list", input: { projectVersion: otherVersion } }],
        ["knowledge.propose", { project_id: otherProjectId, project_version: otherVersion, idempotency_key: "other-project", operations: [otherOperation] }],
        ["invoke_action", { project_id: otherProjectId, action_id: "core.knowledge.propose", input: { projectVersion: otherVersion, idempotencyKey: "other-project-generic", operations: [otherOperation] } }],
        ["knowledge.propose", { project_version: projectVersion, idempotency_key: "foreign-command", operations: [otherOperation] }],
        ["invoke_action", { action_id: "core.knowledge.propose", input: { projectVersion, idempotencyKey: "foreign-command-generic", operations: [otherOperation] } }],
        ["knowledge.nodes.list", { limit: 501 }],
        ["invoke_action", { action_id: "core.knowledge.nodes.list", input: { limit: 501 } }],
        ["knowledge.propose", { project_version: projectVersion, idempotency_key: "wrong-operation", operations: [{ type: "knowledge.merge", command: {} }] }],
        ["invoke_action", { action_id: "core.knowledge.propose", input: { projectVersion, idempotencyKey: "wrong-operation-generic", operations: [{ type: "knowledge.merge", command: {} }] } }],
      ]) await rejected(writer, tool, args, `${label} ${tool} boundary`);

      reader = await connect(hosted, projectId, readToken);
      const read = success(await reader.client.callTool({ name: "knowledge.nodes.list", arguments: { project_version: projectVersion } }), `${label} read-only grant`);
      assert.equal(read.snapshot.projectId, projectId);
      assert.deepEqual(new Set(read.data.map(node => node.id)), new Set([sourceId, targetId]));
      const digest = validPreview.data.previewDigest;
      await rejected(reader, "knowledge.merge.propose", {
        source_id: sourceId, target_id: targetId, project_version: projectVersion, preview_digest: digest, idempotency_key: "read-only-merge",
      }, `${label} read-only merge`);
      await rejected(reader, "invoke_action", {
        action_id: "core.knowledge.merge.propose", input: { sourceId, targetId, projectVersion, previewDigest: digest, idempotencyKey: "read-only-merge-generic" },
      }, `${label} read-only generic merge`);
    } finally {
      await closeMcpClient(reader, isHttp);
      await closeMcpClient(writer, isHttp);
    }
  }
  for (const id of [projectId, otherProjectId]) {
    assert.deepEqual(await persistence.read(reader => reader.listChangeSets(id, 100)), [], "denied native operations must not create ChangeSets");
    assert.equal(await persistence.read(reader => reader.getKnowledgeNode(id, rejectedNode)), undefined);
  }
  assert.equal((await persistence.read(reader => reader.getKnowledgeNode(projectId, sourceId))).status, "confirmed");
  assert.equal((await persistence.read(reader => reader.getProject(projectId))).version, projectVersion);
  assert.equal((await persistence.read(reader => reader.getProject(otherProjectId))).version, otherVersion);

  const preview = success(await stdio.client.callTool({ name: "knowledge.merge.preview", arguments: { source_id: sourceId, target_id: targetId, project_version: projectVersion } }), "stdio native merge preview");
  assert.equal(preview.snapshot.projectVersion, projectVersion);
  assert.equal(preview.data.projectVersion, projectVersion);
  assert.match(preview.data.previewDigest, /^[0-9a-f]{64}$/u);
  const proposalArgs = { source_id: sourceId, target_id: targetId, project_version: projectVersion, preview_digest: preview.data.previewDigest, idempotency_key: "native-mcp-merge-once" };
  const proposed = success(await stdio.client.callTool({ name: "knowledge.merge.propose", arguments: proposalArgs }), "stdio native merge proposal");
  const changeSet = proposed.data.changeSet;
  assert.equal(changeSet.status, "proposed");
  assert.equal(changeSet.provenance.actorId, "owner");
  assert.equal(changeSet.provenance.details.origin, "external-agent");
  assert.equal(changeSet.operations[0].type, "knowledge.merge");
  assert.equal((await persistence.read(reader => reader.getKnowledgeNode(projectId, sourceId))).status, "confirmed", "proposal must not mutate canonical Knowledge");

  const replay = success(await http.client.callTool({ name: "knowledge.merge.propose", arguments: proposalArgs }), "HTTP idempotent merge replay");
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.changeSet.id, changeSet.id);
  const list = success(await http.client.callTool({ name: "changesets.list", arguments: { limit: 20 } }), "HTTP native ChangeSet list");
  assert.ok(list.data.changeSets.some(item => item.id === changeSet.id));
  const detail = success(await http.client.callTool({ name: "changeset.get", arguments: { change_set_id: changeSet.id } }), "HTTP native ChangeSet detail");
  assert.equal(detail.data.changeSet.id, changeSet.id);

  const forbiddenApproval = await apiRequest(host, `/api/v1/persistence/projects/${projectId}/changesets/${changeSet.id}/approve`, {
    method: "POST", bearer: true, body: { expectedVersion: changeSet.version },
  });
  assert.equal(forbiddenApproval.status, 403, "external MCP bearer cannot approve a native ChangeSet");
  const forbiddenApply = await apiRequest(host, `/api/v1/persistence/projects/${projectId}/changesets/${changeSet.id}/apply`, {
    method: "POST", bearer: true, body: { expectedVersion: changeSet.version },
  });
  assert.equal(forbiddenApply.status, 403, "external MCP bearer cannot apply a native ChangeSet");

  const approval = await fetch(`${host.base}/api/v1/persistence/projects/${projectId}/changesets/${changeSet.id}/approve`, {
    method: "POST", headers: { Cookie: cookie, Origin: host.base, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: changeSet.version }),
  });
  assert.equal(approval.status, 200, await approval.text());
  const apply = await fetch(`${host.base}/api/v1/persistence/projects/${projectId}/changesets/${changeSet.id}/apply`, {
    method: "POST", headers: { Cookie: cookie, Origin: host.base, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: changeSet.version + 1 }),
  });
  const appliedBody = await apply.text();
  assert.equal(apply.status, 200, appliedBody);
  const applied = JSON.parse(appliedBody);
  assert.equal(applied.changeSet.status, "applied");
  assert.ok(applied.results[0].auditId);
  const finalDetail = success(await http.client.callTool({ name: "changeset.get", arguments: { change_set_id: changeSet.id } }), "HTTP applied ChangeSet receipt");
  assert.equal(finalDetail.data.receipt.changeSet.id, changeSet.id);
  assert.equal((await persistence.read(reader => reader.getKnowledgeNode(projectId, sourceId))).status, "retired");
  const target = await persistence.read(reader => reader.getKnowledgeNode(projectId, targetId));
  assert.equal(target.attributes.sourceFact, "kept");
  assert.equal(target.attributes.targetFact, "kept");

  const ordinaryVersion = (await persistence.read(reader => reader.getProject(projectId))).version;
  const proposedNodeId = randomUUID();
  const ordinaryArgs = {
    project_version: ordinaryVersion, idempotency_key: "native-mcp-node-once",
    operations: [{ type: "knowledge.node.save", command: {
      projectId, id: proposedNodeId, type: "person", name: "MCP proposed person", attributes: {}, status: "proposed", expectedVersion: null,
    } }],
  };
  const ordinary = success(await stdio.client.callTool({ name: "knowledge.propose", arguments: ordinaryArgs }), "stdio ordinary native proposal");
  assert.equal(ordinary.snapshot.projectVersion, ordinaryVersion);
  assert.equal(ordinary.data.changeSet.provenance.details.projectVersion, ordinaryVersion);
  assert.equal(ordinary.data.changeSet.operations[0].command.id, proposedNodeId);
  assert.equal((await persistence.read(reader => reader.getKnowledgeNode(projectId, proposedNodeId))), undefined);
  const ordinaryReplay = success(await http.client.callTool({ name: "knowledge.propose", arguments: ordinaryArgs }), "HTTP ordinary proposal replay");
  assert.equal(ordinaryReplay.data.replayed, true);
  assert.equal(ordinaryReplay.data.changeSet.id, ordinary.data.changeSet.id);

  const anotherSource = randomUUID();
  const anotherTarget = randomUUID();
  await persistence.transaction(async tx => {
    await tx.saveKnowledgeNode({ projectId, id: anotherSource, type: "person", name: "Stale source", attributes: {}, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeNode({ projectId, id: anotherTarget, type: "person", name: "Stale target", attributes: {}, status: "confirmed", expectedVersion: null });
  });
  const staleVersion = (await persistence.read(reader => reader.getProject(projectId))).version;
  const stalePreview = success(await stdio.client.callTool({ name: "knowledge.merge.preview", arguments: { source_id: anotherSource, target_id: anotherTarget, project_version: staleVersion } }), "stdio stale merge preview");
  await persistence.transaction(tx => tx.saveKnowledgeNode({ projectId, id: anotherTarget, type: "person", name: "Changed target", attributes: {}, status: "confirmed", expectedVersion: 1 }));
  const staleProposal = await stdio.client.callTool({ name: "knowledge.merge.propose", arguments: {
    source_id: anotherSource, target_id: anotherTarget, project_version: staleVersion, preview_digest: stalePreview.data.previewDigest, idempotency_key: "native-mcp-merge-stale",
  } });
  assert.equal(errorCode(staleProposal, "stale native merge proposal"), "conflict");
  assert.equal(providerProbe.callCount(), 0, "native Knowledge Actions must not invoke a configured model provider");
});

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}

async function startProviderProbe() {
  let calls = 0;
  const server = createNodeServer((request, response) => {
    calls += 1;
    request.resume();
    request.once("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "provider-probe-response", object: "chat.completion", created: 0, model: "admission-probe",
        choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolveListen(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    callCount: () => calls,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

async function verifyCancellation(connection, host, projectId, label) {
  const controller = new AbortController();
  const inputText = "あ".repeat(300_000);
  const request = connection.client.callTool({
    name: "invoke_action",
    arguments: { project_id: projectId, action_id: "nlp.analyze", input: { text: inputText } },
  }, undefined, { signal: controller.signal });
  await waitUntil(() => host.runtime.status("nlp").activeJobs > 0, 20_000, `${label} never reached the real NLP worker`);
  controller.abort(new Error("P08 integration cancellation"));
  const completed = await Promise.race([
    request.then((result) => ({ result }), (error) => ({ error })),
    delay(15_000).then(() => ({ timeout: true })),
  ]);
  assert.equal("timeout" in completed, false, `${label} cancellation did not settle the MCP request`);
  assert.ok("error" in completed || completed.result.isError === true, `${label} cancellation returned a successful result`);
  await waitUntil(() => host.runtime.status("nlp").activeJobs === 0, 15_000, `${label} cancellation did not stop the real worker job`);
}

test("MCP cancellation stops real NLP worker jobs through stdio and Streamable HTTP", {
  skip: !READY_MODULES.includes("nlp"),
  timeout: 120_000,
}, async (t) => {
  const rootDir = await mkdtemp(resolve(tmpdir(), "codexia-mcp-cancellation-"));
  const usageDirectory = resolve(rootDir, "host-history");
  let host;
  let stdio;
  let http;
  t.after(async () => {
    await closeMcpClient(http, true);
    await closeMcpClient(stdio);
    await host?.close().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  });

  host = await startAdmissionHost({ cacheDirectory: resolve(rootDir, "module-cache"), usageDirectory });
  const cookie = await login(host);
  const project = await ownerJson(host, cookie, "/api/projects", {
    method: "POST", status: 201, body: { title: "MCP cancellation acceptance" },
  });
  const projectId = project.id;
  stdio = await startStdioClient(host, projectId);
  http = await startHttpClient(host, projectId);

  await verifyCancellation(stdio, host, projectId, "stdio");
  await verifyCancellation(http, host, projectId, "Streamable HTTP");
});

test("stdio and Streamable HTTP enforce external Assistant admission with a configured provider", {
  skip: !READY_MODULES.includes("assistant"),
  timeout: 120_000,
}, async (t) => {
  const rootDir = await mkdtemp(resolve(tmpdir(), "codexia-mcp-first-admission-"));
  const usageDirectory = resolve(rootDir, "host-history");
  const providerEnvNames = ["ARCADIA_LLM_PROVIDER", "ARCADIA_LLM_MODEL", "ARCADIA_LLM_BASE_URL", "ARCADIA_LLM_API_KEY"];
  const previousProviderEnv = new Map(providerEnvNames.map((name) => [name, process.env[name]]));
  const providerProbe = await startProviderProbe();
  process.env.ARCADIA_LLM_PROVIDER = "openai-compatible";
  process.env.ARCADIA_LLM_MODEL = "admission-probe";
  process.env.ARCADIA_LLM_BASE_URL = providerProbe.baseUrl;
  process.env.ARCADIA_LLM_API_KEY = "integration-placeholder";
  let host;
  let stdio;
  let http;
  t.after(async () => {
    await closeMcpClient(http, true);
    await closeMcpClient(stdio);
    await host?.close().catch(() => undefined);
    await providerProbe.close();
    await rm(rootDir, { recursive: true, force: true });
    for (const [name, value] of previousProviderEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  host = await startAdmissionHost({ cacheDirectory: resolve(rootDir, "module-cache"), usageDirectory });
  const cookie = await login(host);
  const project = await ownerJson(host, cookie, "/api/projects", {
    method: "POST", status: 201, body: { title: "MCP admission acceptance" },
  });
  const projectId = project.id;
  stdio = await startStdioClient(host, projectId);
  http = await startHttpClient(host, projectId);

  for (const [name, connection] of [["stdio", stdio], ["Streamable HTTP", http]]) {
    const actions = success(await connection.client.callTool({
      name: "discover_actions", arguments: { project_id: projectId },
    }), `${name} action discovery`);
    assert.ok(actions.data.actions.some((action) => action.id === "core.status"));
    assert.equal(actions.data.actions.some((action) => action.id.startsWith("assistant.")), false,
      `${name} action catalog exposed Assistant`);
    const status = success(await connection.client.callTool({
      name: "invoke_action", arguments: { project_id: projectId, action_id: "core.status", input: {} },
    }), `${name} Core status`);
    assert.ok(status.snapshot && status.data);

    const unknownAssistant = await connection.client.callTool({
      name: "invoke_action", arguments: { project_id: projectId, action_id: "assistant.future-generation", input: {} },
    });
    assert.equal(errorCode(unknownAssistant, `${name} unknown Assistant action`), "ACTION_UNAVAILABLE");
    const namedAssistant = await connection.client.callTool({
      name: "suggest_rewrite", arguments: { project_id: projectId, scene_id: "missing-scene", sentence_index: 0 },
    });
    assert.equal(errorCode(namedAssistant, `${name} Assistant named tool`), "MODULE_UNAVAILABLE");
  }

  const bearerAction = await apiRequest(host, `/api/projects/${encodeURIComponent(projectId)}/actions/assistant.future-generation`, {
    method: "POST", bearer: true, body: { input: {} },
  });
  assert.equal(bearerAction.status, 403);
  assert.equal((await responseJson(bearerAction, "direct bearer Assistant action")).code, "external_agent_assistant_denied");
  const bearerHttp = await apiRequest(host, `/api/projects/${encodeURIComponent(projectId)}/modules/assistant/rewrite/stream`, {
    method: "POST", bearer: true, body: { sceneId: "missing-scene", sentenceIndex: 0 },
  });
  assert.equal(bearerHttp.status, 403);
  assert.equal((await responseJson(bearerHttp, "direct bearer Assistant HTTP route")).code, "external_agent_assistant_denied");

  const proposal = success(await stdio.client.callTool({
    name: "invoke_action",
    arguments: { project_id: projectId, action_id: "core.hierarchy.create", input: {
      kind: "volume", id: "mcp-proposed-volume", title: "Proposed volume", proposalId: "mcp-admission-proposal",
    } },
  }), "MCP Core proposal");
  assert.equal(proposal.data.proposal.source, "mcp");
  assert.equal(providerProbe.callCount(), 0, "MCP dispatch and direct bearer paths must not call the configured model provider");
  const usage = await ownerAction(host, cookie, projectId, "assistant.usage.read", { limit: 200 });
  assert.deepEqual(usage.data.events, [], "denied Assistant requests must not create provider usage records");
});
