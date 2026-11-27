import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createNodeServer } from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";

import { CoreStore } from "../../packages/core/dist/index.js";
import { createPostgresPersistence, migratePostgresDatabase } from "../../packages/persistence-postgres/dist/index.js";
import { ModuleRuntime } from "../../packages/module-runtime/dist/index.js";
import { createServer } from "../../packages/api/dist/server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const moduleRequire = createRequire(resolve(root, "modules/mcp/package.json"));
const apiRequire = createRequire(resolve(root, "packages/api/package.json"));
const { SignJWT, exportJWK, generateKeyPair } = await import(apiRequire.resolve("jose"));
const [{ Client, StreamableHTTPClientTransport }, { StdioClientTransport }] = await Promise.all([
  import(moduleRequire.resolve("@modelcontextprotocol/client")),
  import(moduleRequire.resolve("@modelcontextprotocol/client/stdio")),
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
const FIXTURE_ISSUER = "https://mcp-acceptance.codexia.test/api/auth";
const FIXTURE_RESOURCE = "https://mcp-acceptance.codexia.test/api";
const FIXTURE_SUBJECT = "owner";
const WEB_CLIENT = "acceptance-web";
const MCP_CLIENT = "acceptance-mcp";

async function createSignedRequests() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(publicKey), kid: "acceptance-signing-key", alg: "ES256", use: "sig" };
  const active = new Set();
  const issue = async (clientId, scope, { expired = false } = {}) => {
    const jwt = new SignJWT({ client_id: clientId, azp: clientId, scope })
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: jwk.kid })
      .setIssuer(FIXTURE_ISSUER)
      .setAudience(FIXTURE_RESOURCE)
      .setSubject(FIXTURE_SUBJECT)
      .setIssuedAt()
      .setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 30 : "5m")
      .setJti(randomUUID());
    const token = await jwt.sign(privateKey);
    active.add(token);
    return token;
  };
  return {
    publicJwks: { keys: [jwk] },
    isActive: async token => active.has(token),
    issue,
    revoke: token => active.delete(token),
  };
}

function clientAdmission(projectIds, publicJwks, isActive) {
  const verifier = {
    issuer: FIXTURE_ISSUER, audience: FIXTURE_RESOURCE, ownerSubject: FIXTURE_SUBJECT,
    jwksUrl: FIXTURE_ISSUER + "/jwks", fetch: async () => Response.json(publicJwks), verifyActiveToken: isActive,
  };
  return {
    betterAuth: { issuer: FIXTURE_ISSUER, audience: FIXTURE_RESOURCE },
    oauthOwner: { ...verifier, requiredScopes: ["codexia:api"], allowedClientIds: [WEB_CLIENT] },
    oauthMcp: { ...verifier, allowedClientIds: [MCP_CLIENT], ownerClientIds: [WEB_CLIENT], projectIdsByClient: { [MCP_CLIENT]: projectIds } },
  };
}

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
    cacheDirectory,
  });
}

async function startAdmissionHost({ cacheDirectory, usageDirectory, assignedProjects }) {
  const databaseUrl = DATABASE_URL;
  await migratePostgresDatabase(databaseUrl);
  const persistence = createPostgresPersistence(databaseUrl);
  const runtime = await runtimeOptions(cacheDirectory, usageDirectory);
  const store = new CoreStore({ persistence });
  assert.ok(assignedProjects.length > 0, "Standalone MCP requires explicitly assigned fixture projects");
  for (let offset = 0; offset < assignedProjects.length; offset += 20) {
    await Promise.all(assignedProjects.slice(offset, offset + 20).map(project => persistence.transaction(tx => tx.createProject(project))));
  }
  const signer = await createSignedRequests();
  const admission = clientAdmission(assignedProjects.map(project => project.id), signer.publicJwks, signer.isActive);
  const credentials = {
    owner: await signer.issue(WEB_CLIENT, "codexia:api"),
    mcp: await signer.issue(MCP_CLIENT, "mcp:read mcp:compute mcp:propose"),
    reader: await signer.issue(MCP_CLIENT, "mcp:read"),
    expired: await signer.issue(MCP_CLIENT, "mcp:read", { expired: true }),
    revocable: await signer.issue(MCP_CLIENT, "mcp:read"),
  };
  const server = createServer({
    store, persistence, ...admission,
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
    base: `http://127.0.0.1:${address.port}`, runtime, store, credentials,
    revokeToken: signer.revoke,
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

async function apiRequest(host, path, { method = "GET", body, accessToken } = {}) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
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

async function ownerJson(host, path, { method = "GET", body, status = 200 } = {}) {
  const response = await apiRequest(host, path, { method, body, accessToken: host.credentials.owner });
  assert.equal(response.status, status, `${method} ${path} should return HTTP ${status}, got ${response.status}`);
  return response.status === 204 ? undefined : responseJson(response, `${method} ${path}`);
}

async function ownerAction(host, projectId, actionId, input) {
  const result = await ownerJson(host,
    `/api/projects/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(actionId)}`,
    { method: "POST", body: { input } });
  assert.equal(result.ok, true, `${actionId} failed: ${JSON.stringify(result.error)}`);
  return result;
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

async function startStdioClient(host, projectId, token = host.credentials.mcp) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    CODEXIA_API_URL: host.base,
    // The fixture signs the access token locally while the API verifies its claims and assignment.
    CODEXIA_MCP_ACCESS_TOKEN: token,
    CODEXIA_PROJECT_ID: projectId,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "modules/mcp/dist/stdio.js")],
    env: environment,
    cwd: root,
    stderr: "inherit",
  });
  const client = new Client({ name: "codexia-mcp-acceptance-stdio", version: "1.0.0" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  await client.connect(transport);
  return { client, transport };
}

async function startHttpClient(host, projectId, token = host.credentials.mcp) {
  const path = `/mcp?projectId=${encodeURIComponent(projectId)}`;
  const transport = new StreamableHTTPClientTransport(new URL(path, host.base), {
    authProvider: { token: async () => token },
    reconnectionOptions: { maxReconnectionDelay: 100, initialReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
  });
  const client = new Client({ name: "codexia-mcp-acceptance-http", version: "1.0.0" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  await client.connect(transport);
  return { client, transport };
}

function runExternalMcpClient(host, projectId) {
  const executable = process.env.CODEXIA_MCP_EXTERNAL_CLIENT_TEST;
  if (!executable) return Promise.resolve();
  assert.ok(executable.startsWith("/"), "CODEXIA_MCP_EXTERNAL_CLIENT_TEST must be an absolute executable path");
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, [], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CODEXIA_MCP_EXTERNAL_URL: `${host.base}/mcp?projectId=${encodeURIComponent(projectId)}`,
        CODEXIA_MCP_EXTERNAL_TOKEN: host.credentials.mcp,
        CODEXIA_MCP_EXTERNAL_PROJECT: projectId,
      },
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`External MCP client exited with ${signal ? `signal ${signal}` : `status ${code}`}`));
    });
  });
}

async function closeMcpClient(connection) {
  if (!connection) return;
  await connection.client.close().catch(() => undefined);
  await connection.transport.close().catch(() => undefined);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

test("direct-root Story scenes keep PostgreSQL positions and context through Actions and MCP", {
  timeout: 120_000,
}, async (t) => {
  const rootDir = await mkdtemp(resolve(tmpdir(), "codexia-story-root-scene-pg-"));
  const persistence = createPostgresPersistence(DATABASE_URL);
  let host;
  let stdio;
  let http;
  t.after(async () => {
    await closeMcpClient(http);
    await closeMcpClient(stdio);
    await host?.close().catch(() => undefined);
    await persistence.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  const directProject = { id: randomUUID(), title: `Root scene only ${randomUUID()}` };
  const mixedProject = { id: randomUUID(), title: `Mixed root and volume scenes ${randomUUID()}` };
  host = await startAdmissionHost({
    cacheDirectory: resolve(rootDir, "module-cache"), usageDirectory: resolve(rootDir, "host-history"),
    assignedProjects: [directProject, mixedProject],
  });
  const makeScene = async (transaction, projectId, { parentId = null, id = randomUUID(), title, orderKey, markdown, stateEvents = [] }) => {
    await transaction.createDocument({
      projectId, documentId: id, ...(parentId ? { parentId } : {}), kind: "scene", title,
      orderKey, markdown, authorId: "story-root-scene-acceptance", idempotencyKey: randomUUID(),
    });
    if (stateEvents.length) {
      await transaction.saveModuleRecord({
        projectId, moduleId: "core.document-paths", key: id, expectedVersion: null,
        value: { metadata: { state_events: stateEvents } },
      });
    }
    return id;
  };
  const addCharacterArtifacts = async (transaction, projectId) => {
    for (const [id, name] of [["char-uma", "Uma"], ["char-other", "Other"]]) {
      await transaction.saveModuleRecord({
        projectId, moduleId: "core.artifacts", key: `bible/characters/${id}/profile.yaml`, expectedVersion: null,
        value: { content: `id: ${id}\ntype: character\nname: ${name}\n` },
      });
    }
  };
  const disclosure = (sceneId, eventId, object) => ({
    sceneId, eventId, kind: "knowledge", subject: "char-uma", object,
    payload: { layer: "reader-knowledge" }, status: "confirmed",
  });
  const belief = (sceneId, eventId, subject) => ({
    sceneId, eventId, kind: "attribute", subject, object: "secret-id",
    payload: { layer: "character-belief", predicate: "knows" }, status: "confirmed",
  });

  const direct = { projectId: directProject.id };
  await persistence.transaction(async (transaction) => {
    await addCharacterArtifacts(transaction, direct.projectId);
    direct.firstSceneId = randomUUID();
    await makeScene(transaction, direct.projectId, {
      id: direct.firstSceneId, title: "Root scene one", orderKey: "0001", markdown: "Direct-only first scene.\n",
      stateEvents: [disclosure(direct.firstSceneId, "direct-reader-disclosure", "direct-secret")],
    });
    direct.targetSceneId = await makeScene(transaction, direct.projectId, {
      title: "Root scene two", orderKey: "0002", markdown: "Direct-only saved body.\n",
    });
  });

  const mixed = { projectId: mixedProject.id };
  await persistence.transaction(async (transaction) => {
    await addCharacterArtifacts(transaction, mixed.projectId);
    mixed.firstSceneId = randomUUID();
    await makeScene(transaction, mixed.projectId, {
      id: mixed.firstSceneId, title: "Mixed root one", orderKey: "0001", markdown: "Mixed root first.\n",
      stateEvents: [disclosure(mixed.firstSceneId, "reader-root", "root-secret")],
    });
    mixed.volumeId = randomUUID();
    await transaction.createDocument({
      projectId: mixed.projectId, documentId: mixed.volumeId, kind: "volume", title: "Volume",
      orderKey: "0002", markdown: "", authorId: "story-root-scene-acceptance", idempotencyKey: randomUUID(),
    });
    mixed.chapterId = randomUUID();
    await transaction.createDocument({
      projectId: mixed.projectId, documentId: mixed.chapterId, parentId: mixed.volumeId, kind: "chapter", title: "Chapter",
      orderKey: "0001", markdown: "", authorId: "story-root-scene-acceptance", idempotencyKey: randomUUID(),
    });
    mixed.nestedSceneId = randomUUID();
    await makeScene(transaction, mixed.projectId, {
      id: mixed.nestedSceneId, parentId: mixed.chapterId, title: "Nested scene", orderKey: "0001", markdown: "Nested saved body.\n",
      stateEvents: [disclosure(mixed.nestedSceneId, "reader-nested", "nested-secret")],
    });
    mixed.targetSceneId = randomUUID();
    await makeScene(transaction, mixed.projectId, {
      id: mixed.targetSceneId, title: "Mixed root target", orderKey: "0003", markdown: "Fixed mixed-hierarchy body.\n",
      stateEvents: [belief(mixed.targetSceneId, "belief-uma", "char-uma"), belief(mixed.targetSceneId, "belief-other", "char-other")],
    });
    mixed.laterSceneId = randomUUID();
    await makeScene(transaction, mixed.projectId, {
      id: mixed.laterSceneId, title: "Mixed root later", orderKey: "0004", markdown: "Future scene.\n",
      stateEvents: [disclosure(mixed.laterSceneId, "reader-later", "future-secret")],
    });
  });

  for (const fixture of [
    { ...direct, expectedOrder: 2, expectedDisclosures: ["direct-reader-disclosure"], expectedBody: "Direct-only saved body.\n" },
    { ...mixed, expectedOrder: 3, expectedDisclosures: ["reader-root", "reader-nested"], expectedBody: "Fixed mixed-hierarchy body.\n" },
  ]) {
    const actionTemporal = await ownerAction(host, fixture.projectId, "story.world-state.temporal", { sceneId: fixture.targetSceneId });
    assert.equal(actionTemporal.data.narrativeOrder, fixture.expectedOrder);
    assert.equal(actionTemporal.data.worldTime, null);
    assert.deepEqual(actionTemporal.data.disclosed.map((fact) => fact.eventId), fixture.expectedDisclosures);

    const actionAuthor = await ownerAction(host, fixture.projectId, "story.context.package", {
      sceneId: fixture.targetSceneId, scope: "author", budget: 200_000,
    });
    const authorManuscript = actionAuthor.data.parts.find((part) => part.kind === "manuscript");
    assert.equal(authorManuscript.value.text, fixture.expectedBody);
    assert.equal(authorManuscript.value.path, `documents/${fixture.targetSceneId}.md`);
    assert.match(authorManuscript.value.revision, /^[a-f0-9]{64}$/u);
    const pinnedReader = await host.store.reader(fixture.projectId);
    const pinnedManuscript = await pinnedReader.read(`documents/${fixture.targetSceneId}.md`);
    assert.deepEqual(actionAuthor.snapshot, pinnedReader.snapshot);
    assert.equal(authorManuscript.value.revision, pinnedManuscript.revision, "author context is bound to the saved PostgreSQL body revision");

    const actionReader = await ownerAction(host, fixture.projectId, "story.context.package", {
      sceneId: fixture.targetSceneId, scope: "reader", budget: 200_000,
    });
    assert.deepEqual(actionReader.data.parts.map((part) => [part.kind, part.value.eventId]),
      fixture.expectedDisclosures.map((eventId) => ["reader-disclosure", eventId]));
    assert.doesNotMatch(JSON.stringify(actionReader.data), /future-secret|Fixed mixed-hierarchy body|Direct-only saved body/);
    const actionCharacter = await ownerAction(host, fixture.projectId, "story.context.package", {
      sceneId: fixture.targetSceneId, scope: "character", characterId: "char-uma", budget: 200_000,
    });
    assert.equal(actionCharacter.data.parts.some((part) => part.kind === "reader-disclosure" || part.kind === "manuscript"), false);
    if (fixture.projectId === mixed.projectId) {
      assert.deepEqual(actionCharacter.data.parts.map((part) => part.value.eventId), ["belief-uma"]);
      assert.doesNotMatch(JSON.stringify(actionCharacter.data), /belief-other/);
    }

    stdio = await startStdioClient(host, fixture.projectId);
    http = await startHttpClient(host, fixture.projectId);
    try {
      for (const [name, connection] of [["stdio", stdio], ["Streamable HTTP", http]]) {
        const scoped = { project_id: fixture.projectId, scene_id: fixture.targetSceneId };
        const temporal = success(await connection.client.callTool({ name: "story.world-state.temporal", arguments: scoped }), `${name} Story temporal`);
        assert.deepEqual(temporal, { snapshot: actionTemporal.snapshot, data: actionTemporal.data });
        const author = success(await connection.client.callTool({
          name: "story.context.package", arguments: { ...scoped, scope: "author", budget: 200_000 },
        }), `${name} Story author context`);
        assert.deepEqual(author, { snapshot: actionAuthor.snapshot, data: actionAuthor.data });
        const reader = success(await connection.client.callTool({
          name: "story.context.package", arguments: { ...scoped, scope: "reader", budget: 200_000 },
        }), `${name} Story reader context`);
        assert.deepEqual(reader.data.parts.map((part) => [part.kind, part.value.eventId]),
          fixture.expectedDisclosures.map((eventId) => ["reader-disclosure", eventId]));
        const character = success(await connection.client.callTool({
          name: "story.context.package", arguments: { ...scoped, scope: "character", character_id: "char-uma", budget: 200_000 },
        }), `${name} Story character context`);
        assert.deepEqual(character.data.parts, actionCharacter.data.parts);
        assert.equal(character.snapshot.projectId, fixture.projectId);
      }
    } finally {
      await closeMcpClient(http);
      await closeMcpClient(stdio);
      http = undefined;
      stdio = undefined;
    }
  }
});

test("[TEST-MCPV-004-001] native Knowledge MCP tools preserve PostgreSQL scope, proposal, replay, review and receipt over both transports", {
  timeout: process.env.CODEXIA_MCP_EXTERNAL_CLIENT_TIMEOUT_MS
    ? Number(process.env.CODEXIA_MCP_EXTERNAL_CLIENT_TIMEOUT_MS)
    : 120_000,
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
    await closeMcpClient(http);
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

  const projectId = randomUUID();
  const paginationRows = Array.from({ length: 205 }, (_, index) => ({ id: randomUUID(), title: `MCP pagination ${index}` }));
  host = await startAdmissionHost({
    cacheDirectory: resolve(rootDir, "module-cache"), usageDirectory,
    assignedProjects: [{ id: projectId, title: `Native MCP ${randomUUID()}` }, ...paginationRows],
  });
  await runExternalMcpClient(host, projectId);
  const expiredTransport = new StreamableHTTPClientTransport(new URL(`/mcp?projectId=${projectId}`, host.base), {
    authProvider: { token: async () => host.credentials.expired },
  });
  const expiredClient = new Client({ name: "codexia-expiry-acceptance", version: "1.0.0" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  try {
    await assert.rejects(expiredClient.connect(expiredTransport), undefined, "expired MCP access tokens must not establish a connection");
  } finally {
    await expiredClient.close().catch(() => undefined);
    await expiredTransport.close().catch(() => undefined);
  }

  const revoked = await startHttpClient(host, projectId, host.credentials.revocable);
  try {
    await revoked.client.listTools(undefined, { cacheMode: "bypass" });
    host.revokeToken(host.credentials.revocable);
    await assert.rejects(
      revoked.client.listTools(undefined, { cacheMode: "bypass" }),
      undefined,
      "a bearer token revoked after connection must be rejected on the next stateless request",
    );
  } finally {
    await closeMcpClient(revoked);
  }

  const sourceId = randomUUID();
  const targetId = randomUUID();
  await persistence.transaction(async tx => {
    await tx.saveKnowledgeNode({ projectId, id: sourceId, type: "person", name: "MCP source", attributes: { sourceFact: "kept" }, status: "confirmed", expectedVersion: null });
    await tx.saveKnowledgeNode({ projectId, id: targetId, type: "person", name: "MCP target", attributes: { targetFact: "kept" }, status: "confirmed", expectedVersion: null });
  });
  let projectVersion = (await persistence.read(reader => reader.getProject(projectId))).version;
  stdio = await startStdioClient(host, projectId);
  http = await startHttpClient(host, projectId);

  const hierarchy = {
    volumeId: randomUUID(),
    chapterId: randomUUID(),
    sceneId: randomUUID(),
    noteId: randomUUID(),
  };
  await persistence.transaction(async (tx) => {
    await tx.createDocument({
      projectId, documentId: hierarchy.volumeId, kind: "volume", title: "Volume",
      orderKey: "0001", markdown: "", authorId: "mcp-acceptance-owner", idempotencyKey: randomUUID(),
    });
    await tx.createDocument({
      projectId, documentId: hierarchy.chapterId, parentId: hierarchy.volumeId, kind: "chapter",
      title: "Chapter", orderKey: "0001", markdown: "", authorId: "mcp-acceptance-owner", idempotencyKey: randomUUID(),
    });
    await tx.createDocument({
      projectId, documentId: hierarchy.sceneId, parentId: hierarchy.chapterId, kind: "scene",
      title: "Native scene", orderKey: "0001", markdown: "Scene body.", authorId: "mcp-acceptance-owner", idempotencyKey: randomUUID(),
    });
    await tx.createDocument({
      projectId, documentId: hierarchy.noteId, parentId: hierarchy.chapterId, kind: "note",
      title: "Author note", orderKey: "0002", markdown: "Private author note.", authorId: "mcp-acceptance-owner", idempotencyKey: randomUUID(),
    });
  });
  projectVersion = (await persistence.read(reader => reader.getProject(projectId))).version;

  const actionSceneList = success(await http.client.callTool({
    name: "invoke_action",
    arguments: { project_id: projectId, action_id: "story.entities.list", input: { type: "scene" } },
  }), "Story scene list action through MCP");
  assert.deepEqual(new Set(actionSceneList.data.map((entity) => entity.id)), new Set([hierarchy.sceneId]));
  const legacySceneList = success(await stdio.client.callTool({
    name: "list_entities",
    arguments: { project_id: projectId, type: "scene" },
  }), "legacy list_entities scene filter through MCP");
  assert.deepEqual(new Set(legacySceneList.data.map((entity) => entity.id)), new Set([hierarchy.sceneId]));
  assert.equal(legacySceneList.snapshot.projectVersion, actionSceneList.snapshot.projectVersion);

  const scenarioAlternatives = [{ label: "A", events: [] }, { label: "B", events: [] }];
  const scenarioComparison = success(await http.client.callTool({
    name: "invoke_action",
    arguments: { project_id: projectId, action_id: "story.scenario.compare", input: { sceneId: hierarchy.sceneId, alternatives: scenarioAlternatives } },
  }), "Scenario comparison through Streamable HTTP MCP");
  const invokeScenarioSave = (operationId, label = "MCP replay scenario") => http.client.callTool({
    name: "invoke_action",
    arguments: {
      project_id: projectId,
      action_id: "story.scenario.save",
      input: {
        id: "mcp-scenario-replay",
        sceneId: hierarchy.sceneId,
        label,
        alternatives: scenarioAlternatives,
        sourceFingerprint: scenarioComparison.data.sourceFingerprint,
        operation_id: operationId,
      },
    },
  });
  const sequentialFirst = success(await invokeScenarioSave("mcp-scenario-sequential"), "first Scenario save through MCP");
  const sequentialReplay = success(await invokeScenarioSave("mcp-scenario-sequential"), "sequential Scenario replay through MCP");
  const sequentialProposalId = sequentialFirst.proposals?.[0]?.id;
  assert.ok(sequentialProposalId, "first Scenario save must return its Core proposal ID");
  assert.equal(sequentialReplay.proposals?.[0]?.id, sequentialProposalId, "sequential replay must return the same Core proposal ID");

  const changedReplay = await invokeScenarioSave("mcp-scenario-sequential", "Changed payload");
  assert.equal(errorCode(changedReplay, "changed Scenario payload under the same operation ID"), "proposal_identity_conflict");

  const independent = success(await invokeScenarioSave("mcp-scenario-independent"), "independent Scenario operation through MCP");
  const independentProposalId = independent.proposals?.[0]?.id;
  assert.ok(independentProposalId);
  assert.notEqual(independentProposalId, sequentialProposalId, "a distinct operation ID must get its own proposal");

  const concurrentResults = await Promise.all([
    invokeScenarioSave("mcp-scenario-concurrent"),
    invokeScenarioSave("mcp-scenario-concurrent"),
  ]);
  const concurrentProposals = concurrentResults.map((result, index) =>
    success(result, `concurrent Scenario save ${index + 1} through MCP`).proposals?.[0]?.id);
  assert.ok(concurrentProposals[0]);
  assert.equal(concurrentProposals[1], concurrentProposals[0], "concurrent replay must return the same Core proposal ID");

  const savedScenarioProposals = (await host.store.listProposals(projectId)).filter((status) =>
    [sequentialProposalId, independentProposalId, concurrentProposals[0]].includes(status.proposal.id));
  assert.equal(savedScenarioProposals.length, 3, "one distinct Core proposal must persist for each operation ID");
  for (const proposalId of [sequentialProposalId, independentProposalId, concurrentProposals[0]]) {
    const matching = savedScenarioProposals.filter((status) => status.proposal.id === proposalId);
    assert.equal(matching.length, 1, "replays must not duplicate persisted proposal rows");
    assert.equal(matching[0].state, "proposed", "Scenario saves remain pending author review");
    assert.deepEqual(matching[0].approvedOperationIds, [], "MCP does not approve a Scenario proposal");
    assert.deepEqual(matching[0].appliedOperationIds, [], "MCP does not apply a Scenario proposal");
  }

  // Exercise project discovery through the real PostgreSQL-backed MCP client
  // beyond the former single-page boundary.
  const projectPage1 = success(await stdio.client.callTool({ name: "list_projects", arguments: { limit: 200 } }), "native MCP project page 1").data;
  assert.equal(projectPage1.projects.length, 200);
  assert.equal(typeof projectPage1.next_cursor, "string");
  const projectPage2 = success(await stdio.client.callTool({ name: "list_projects", arguments: { limit: 200, cursor: projectPage1.next_cursor } }), "native MCP project page 2").data;
  assert.ok(projectPage2.projects.length > 0);
  const discoveredIds = [...projectPage1.projects, ...projectPage2.projects].map((item) => item.id);
  assert.equal(new Set(discoveredIds).size, discoveredIds.length, "MCP keyset pages must not repeat projects");
  assert.deepEqual(new Set(discoveredIds), new Set([projectId, ...paginationRows.map(row => row.id)]));

  for (const [name, connection] of [["stdio", stdio], ["Streamable HTTP", http]]) {
    const catalog = await connection.client.listTools();
    const toolNames = catalog.tools.map(tool => tool.name);
    for (const toolName of NATIVE_TOOL_NAMES) assert.ok(toolNames.includes(toolName), `${name} missing ${toolName}`);
    assert.equal(toolNames.some(toolName => /approve|apply/u.test(toolName)), false, `${name} exposed author approval or apply`);
    const nodes = success(await connection.client.callTool({ name: "knowledge.nodes.list", arguments: { project_version: projectVersion, limit: 20 } }), `${name} native nodes list`);
    assert.equal(nodes.snapshot.projectVersion, projectVersion);
    assert.deepEqual(new Set(nodes.data.map(node => node.id)), new Set([sourceId, targetId]));
  }

  // The author can create a project outside the external client’s configured assignment.
  const otherProject = await ownerJson(host, "/api/v1/persistence/projects", {
    method: "POST", status: 201, body: { title: `Other native MCP ${randomUUID()}` },
  });
  const otherProjectId = otherProject.project.id;
  const otherNodeId = randomUUID();
  await persistence.transaction(tx => tx.saveKnowledgeNode({
    projectId: otherProjectId, id: otherNodeId, type: "person", name: "Unassigned node",
    attributes: {}, status: "confirmed", expectedVersion: null,
  }));
  const otherVersion = (await persistence.read(reader => reader.getProject(otherProjectId))).version;
  const challenge = await apiRequest(host, "/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
  assert.equal(challenge.status, 401);
  assert.equal(challenge.headers.get("www-authenticate"),
    `Bearer resource_metadata="${new URL(FIXTURE_RESOURCE).origin}/.well-known/oauth-protected-resource/api", scope="mcp:read mcp:compute mcp:propose"`);
  assert.equal((await apiRequest(host, "/mcp", { accessToken: host.credentials.mcp })).status, 400, "multiple assignments require an explicit project");
  assert.equal((await apiRequest(host, `/mcp?projectId=${otherProjectId}`, { accessToken: host.credentials.mcp })).status, 404);

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
  const connections = [
    ["stdio", startStdioClient, false],
    ["Streamable HTTP", startHttpClient, true],
  ];
  for (const [label, connect, isHttp] of connections) {
    const writer = await connect(host, projectId);
    let reader;
    try {
      const validPreview = success(await writer.client.callTool({
        name: "knowledge.merge.preview", arguments: { source_id: sourceId, target_id: targetId, project_version: projectVersion },
      }), `${label} writer preview`);
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

      reader = await connect(host, projectId, host.credentials.reader);
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
      await closeMcpClient(reader);
      await closeMcpClient(writer);
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
    method: "POST", accessToken: host.credentials.mcp, body: { expectedVersion: changeSet.version },
  });
  assert.equal(forbiddenApproval.status, 403, "external MCP bearer cannot approve a native ChangeSet");
  const forbiddenApply = await apiRequest(host, `/api/v1/persistence/projects/${projectId}/changesets/${changeSet.id}/apply`, {
    method: "POST", accessToken: host.credentials.mcp, body: { expectedVersion: changeSet.version },
  });
  assert.equal(forbiddenApply.status, 403, "external MCP bearer cannot apply a native ChangeSet");

  const approval = await fetch(`${host.base}/api/v1/persistence/projects/${projectId}/changesets/${changeSet.id}/approve`, {
    method: "POST", headers: { Authorization: `Bearer ${host.credentials.owner}`, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: changeSet.version }),
  });
  assert.equal(approval.status, 200, await approval.text());
  const apply = await fetch(`${host.base}/api/v1/persistence/projects/${projectId}/changesets/${changeSet.id}/apply`, {
    method: "POST", headers: { Authorization: `Bearer ${host.credentials.owner}`, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: changeSet.version + 1 }),
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
  }, { signal: controller.signal });
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

async function verifyHttpDrain(connection, host, projectId) {
  const request = connection.client.callTool({
    name: "invoke_action",
    arguments: { project_id: projectId, action_id: "nlp.analyze", input: { text: "あ".repeat(300_000) } },
  });
  const requestOutcome = request.then(result => ({ result }), error => ({ error }));
  await waitUntil(() => host.runtime.status("nlp").activeJobs > 0, 20_000, "HTTP drain case never reached the real NLP worker");
  const close = host.close();
  await Promise.race([
    close,
    delay(15_000).then(() => { throw new Error("host shutdown did not drain the in-flight MCP request"); }),
  ]);
  const outcome = await Promise.race([
    requestOutcome,
    delay(15_000).then(() => { throw new Error("host shutdown did not settle the in-flight HTTP MCP request"); }),
  ]);
  assert.ok("error" in outcome || outcome.result.isError === true, "shutdown must not return a successful in-flight result");
  assert.equal(host.runtime.status("nlp").activeJobs, 0, "shutdown must leave no real worker jobs active");
}

test("[TEST-MCPV-006-001] MCP cancellation stops real NLP worker jobs through stdio and Streamable HTTP", {
  skip: !READY_MODULES.includes("nlp"),
  timeout: 120_000,
}, async (t) => {
  const rootDir = await mkdtemp(resolve(tmpdir(), "codexia-mcp-cancellation-"));
  const usageDirectory = resolve(rootDir, "host-history");
  let host;
  let stdio;
  let http;
  t.after(async () => {
    await closeMcpClient(http);
    await closeMcpClient(stdio);
    await host?.close().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  });

  const projectId = randomUUID();
  host = await startAdmissionHost({
    cacheDirectory: resolve(rootDir, "module-cache"), usageDirectory,
    assignedProjects: [{ id: projectId, title: "MCP cancellation acceptance" }],
  });
  stdio = await startStdioClient(host, projectId);
  http = await startHttpClient(host, projectId);

  await verifyCancellation(stdio, host, projectId, "stdio");
  await verifyCancellation(http, host, projectId, "Streamable HTTP");
  await verifyHttpDrain(http, host, projectId);
});

test("[TEST-MCP-CORE-001-001] stdio and Streamable HTTP enforce external Assistant admission with a configured provider", {
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
    await closeMcpClient(http);
    await closeMcpClient(stdio);
    await host?.close().catch(() => undefined);
    await providerProbe.close();
    await rm(rootDir, { recursive: true, force: true });
    for (const [name, value] of previousProviderEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const projectId = randomUUID();
  host = await startAdmissionHost({
    cacheDirectory: resolve(rootDir, "module-cache"), usageDirectory,
    assignedProjects: [{ id: projectId, title: "MCP admission acceptance" }],
  });
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
    const catalog = await connection.client.listTools();
    assert.equal(catalog.tools.some(tool => tool.name === "suggest_rewrite"), false,
      `${name} exposed the retired Assistant rewrite tool`);
  }

  const bearerAction = await apiRequest(host, `/api/projects/${encodeURIComponent(projectId)}/actions/assistant.future-generation`, {
    method: "POST", accessToken: host.credentials.mcp, body: { input: {} },
  });
  assert.equal(bearerAction.status, 403);
  assert.equal((await responseJson(bearerAction, "direct bearer Assistant action")).code, "external_agent_assistant_denied");
  const bearerHttp = await apiRequest(host, `/api/projects/${encodeURIComponent(projectId)}/modules/assistant/rewrite/stream`, {
    method: "POST", accessToken: host.credentials.mcp, body: { sceneId: "missing-scene", sentenceIndex: 0 },
  });
  assert.equal(bearerHttp.status, 403);
  assert.equal((await responseJson(bearerHttp, "direct bearer Assistant HTTP route")).code, "OAUTH_MCP_MODULE_DENIED");

  const proposal = success(await stdio.client.callTool({
    name: "invoke_action",
    arguments: { project_id: projectId, action_id: "core.hierarchy.create", input: {
      kind: "volume", id: "mcp-proposed-volume", title: "Proposed volume", idempotencyKey: "mcp-admission-proposal",
    } },
  }), "MCP Core proposal");
  assert.equal(proposal.data.changeSet.status, "proposed");
  assert.equal(proposal.data.changeSet.provenance.details.origin, "external-agent");
  assert.deepEqual(proposal.data.changeSet.operations.map(({ type }) => type), ["document.create"]);
  assert.equal(providerProbe.callCount(), 0, "MCP dispatch and direct bearer paths must not call the configured model provider");
});
