import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign as signJwt } from "node:crypto";
import { request as httpRequest } from "node:http";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { fromNodeHeaders } from "better-auth/node";
import { MODEL_USAGE_CAPABILITY, type ActionResult, type ChangeOperation, type ChangeProposal, type JobRequest, type ModelUsageEvent, type ModelUsageStore, type ModuleAction, type ModuleContext, type ModuleDefinition, type ModuleManifest, type ProposalStatus, type SnapshotId, type ValueSchema } from "@codexia/contracts";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import type { ChangeSetApplicationResult, ChangeSetId, ChangeSetResult, JsonObject, Persistence, PersistenceReader } from "@codexia/persistence-contracts";
import { CoreStore, type CoreStore as CoreStoreShape } from "@codexia/core";
import { ModuleRuntime, type ModuleLoader, type ModuleRuntimeOptions, type WorkerJobLifecycleListener, type WorkerJobLifecycleSnapshot } from "@codexia/module-runtime";
import { createHostedAuthorizationPolicy } from "./hosted-policy.js";
import { advertisePublicClientTokenAuth } from "./better-auth.js";
import { HistoricalModelUsageError, HistoricalModelUsageStore } from "./historical-store.js";
import { JobHistoryError, JobHistoryStore, type WorkerJobLifecycle } from "./job-history-store.js";
import { createServer, importLegacyJobHistory, type ApiServerOptions, type HostedAuthorizationPolicy, type HostedPrincipal } from "./server.js";
import { RUNTIME_QUIESCE_PATH, RUNTIME_RESUME_PATH, RUNTIME_STATUS_PATH, sha256Digest, type RuntimeAssignment } from "./platform-runtime.js";
import { createOAuthMcpAuthenticator } from "./oauth-mcp.js";

const ACCESS_TOKEN = "test-access-token-which-is-longer-than-32-characters";
const SNAPSHOT: SnapshotId = { projectId: "project-1", projectVersion: 1 };
const HOSTED_ASSIGNMENT: RuntimeAssignment = {
  contractVersion: "scriptorium-platform/v1",
  instanceId: "instance-1",
  repositoryId: 123,
  repositoryLocator: "https://github.com/owner/work",
  defaultBranchPolicy: "repository-default",
  runtimeEpoch: 3,
  imageDigest: `sha256:${"a".repeat(64)}`,
  compositionManifestDigest: `sha256:${"b".repeat(64)}`,
  enabledModuleIds: ["story", "mcp"],
  credentialBrokerLocator: "https://praetorium.example/internal/github/credential",
  controlServicePolicy: {
    issuer: "https://praetorium.example",
    jwksUrl: "https://praetorium.example/.well-known/control-jwks.json",
    audience: "praetorium-runtime-control",
  },
  grantPolicy: {
    issuer: "https://praetorium.example",
    jwksUrl: "https://praetorium.example/.well-known/grant-jwks.json",
    audience: "https://instance-1.instances.example",
  },
};
const RUNTIME_CONTROL_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const RUNTIME_CONTROL_PUBLIC_JWK = {
  ...RUNTIME_CONTROL_KEY.publicKey.export({ format: "jwk" }),
  use: "sig",
  alg: "ES256",
  kid: "runtime-control-test-key",
};
const HOSTED_GRANT_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const HOSTED_GRANT_PUBLIC_JWK = {
  ...HOSTED_GRANT_KEY.publicKey.export({ format: "jwk" }),
  use: "sig",
  alg: "ES256",
  kid: "hosted-grant-test-key",
};

function hostedGrantToken(expired = false, lifetimeSeconds = 120): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const issuedAt = expired ? now - 120 : now;
  const unsigned = `${encode({ alg: "ES256", kid: "hosted-grant-test-key", typ: "JWT" })}.${encode({
    iss: HOSTED_ASSIGNMENT.grantPolicy.issuer,
    sub: "hosted-user-1",
    aud: HOSTED_ASSIGNMENT.grantPolicy.audience,
    instanceId: HOSTED_ASSIGNMENT.instanceId,
    repositoryId: HOSTED_ASSIGNMENT.repositoryId,
    runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
    permissions: ["read", "write"],
    sessionRevision: 2,
    authorizationRevision: 3,
    iat: issuedAt,
    nbf: issuedAt,
    exp: expired ? now - 1 : now + lifetimeSeconds,
    jti: expired ? "expired-browser-grant" : "valid-browser-grant",
  })}`;
  const signature = signJwt("sha256", Buffer.from(unsigned, "ascii"), {
    key: HOSTED_GRANT_KEY.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

function realHostedGrantPolicy(): HostedAuthorizationPolicy {
  return createHostedAuthorizationPolicy({
    assignment: HOSTED_ASSIGNMENT,
    fetch: async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.grantPolicy.jwksUrl);
      return Response.json({ keys: [HOSTED_GRANT_PUBLIC_JWK] });
    },
  });
}

async function nativePersistence(t: { after(callback: () => Promise<void>): void }) {
  const url = process.env.CODEXIA_TEST_DATABASE_URL;
  if (!url) throw new Error("CODEXIA_TEST_DATABASE_URL must name a disposable PostgreSQL test database for native Core API recovery tests");
  await migratePostgresDatabase(url);
  const persistence = createPostgresPersistence(url);
  t.after(() => persistence.close());
  return persistence;
}

async function nativeProject(t: { after(callback: () => Promise<void>): void }, title: string) {
  const persistence = await nativePersistence(t);
  const store = new CoreStore({ persistence });
  const project = await store.createProject({ title: `${title} ${randomUUID()}` });
  return { persistence, store, project };
}

function instrumentPersistence(
  persistence: Persistence,
  hooks: { beforeProjectRead?: () => Promise<void>; onProjectRead?: () => void } = {},
): Persistence {
  return new Proxy(persistence, {
    get(target, property, receiver) {
      if (property === "read") {
        return <T>(work: (reader: PersistenceReader) => Promise<T>): Promise<T> => target.read((reader) => work(new Proxy(reader, {
          get(readerTarget, readerProperty, readerReceiver) {
            if (readerProperty === "getProject") {
              return async (...args: Parameters<PersistenceReader["getProject"]>) => {
                await hooks.beforeProjectRead?.();
                hooks.onProjectRead?.();
                return readerTarget.getProject(...args);
              };
            }
            const value = Reflect.get(readerTarget, readerProperty, readerReceiver);
            return typeof value === "function" ? value.bind(readerTarget) : value;
          },
        })));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Admission-only fixture. Persistence integration cases below use a disposable PostgreSQL schema. */
function makeStore(onSaveScene: () => void = () => undefined): CoreStoreShape {
  const project = { id: "project-1", title: "A Work", version: 1 };
  return {
    listProjects: async () => [project],
    listProjectsPage: async () => ({ projects: [project], nextCursor: null }),
    createProject: async ({ title }: { title: string }) => ({ id: "project-2", title, version: 1 }),
    status: async () => ({ ...SNAPSHOT, state: "durable" as const }),
    observe: async () => ({ snapshot: SNAPSHOT, observedAt: "2026-10-17T00:00:00.000Z", state: "fresh" }),
    saveScene: async () => { onSaveScene(); throw Error("direct scene writes are forbidden"); },
  } as unknown as CoreStore;
}

function admissionPersistence(store: CoreStore): ApiServerOptions["persistence"] {
  return {
    async checkHealth() {},
    async read<T>(read: (reader: { getProject(id: string): Promise<unknown> }) => Promise<T>) {
      return read({ async getProject(id) {
        const project = (await store.listProjects()).find((item) => item.id === id);
        return project ? { ...project, version: 1, settings: {}, createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z" } : null;
      } });
    },
  } as unknown as ApiServerOptions["persistence"];
}

function makeSnapshotStore() {
  const proposed: ChangeProposal[] = [];
  const approvals: Array<{ proposalId: string; operationIds: string[]; authorScope: string }> = [];
  const pinnedReads: Array<number | undefined> = [];
  const snapshotReads: Array<{ kind: "tree" | "scene" | "views"; pinned?: SnapshotId }> = [];
  const document = { path: "manuscript/ms-one/scene-one.md", content: "---\nid: scene-one\n---\n\nA harbor at night.\n", revision: "body-revision" };
  const scene = (sceneId: string) => ({ scene: { id: sceneId, title: "Opening", text: "A harbor at night.", revision: "scene-revision" }, document,
    metadata: { path: "plot/volumes/v1/chapters/c1/scenes/scene-one.yaml", content: "id: scene-one\n", revision: "metadata-revision" } });
  const store = Object.assign(makeStore(), {
    async reader(_projectId: string, pinned?: SnapshotId) {
      pinnedReads.push(pinned?.projectVersion);
      return { snapshot: pinned ?? SNAPSHOT,
        async read(path: string, encoding: "utf8" | "base64" = "utf8") {
          if (path !== document.path) return null;
          return { content: encoding === "base64" ? Buffer.from(document.content).toString("base64") : document.content, revision: document.revision };
        }, async list(prefix: string) { return prefix === "manuscript/" ? [document.path] : []; } };
    },
    async resolveDocumentScene(_projectId: string, path: string, pinned?: SnapshotId) {
      return { snapshot: pinned ?? SNAPSHOT, sceneId: path === document.path ? "scene-one" : null };
    },
    async readTreeSnapshot(_projectId: string, pinned?: SnapshotId) {
      snapshotReads.push({ kind: "tree", pinned }); return { snapshot: pinned ?? SNAPSHOT, tree: { title: "A Work", volumes: [] } };
    },
    async readSceneSnapshot(_projectId: string, sceneId: string, pinned?: SnapshotId) {
      snapshotReads.push({ kind: "scene", pinned }); return { snapshot: pinned ?? SNAPSHOT, ...scene(sceneId) };
    },
    async listManuscriptSnapshots(_projectId: string, manuscriptId: string, sceneId?: string, pinned?: SnapshotId) {
      return { snapshot: pinned ?? SNAPSHOT, snapshots: [{ id: "11111111-1111-4111-8111-111111111111", manuscriptId, sceneId, createdAt: Date.now(), charCount: 18, source: "postgres" }] };
    },
    async readManuscriptSnapshot(_projectId: string, snapshotId: string, manuscriptId: string, _sceneId?: string, pinned?: SnapshotId) {
      return { snapshot: pinned ?? SNAPSHOT, manuscriptSnapshot: { id: snapshotId, manuscriptId, body: "A harbor at night.", document } };
    },
    async searchSnapshot(_projectId: string, query: string, limit = 20, pinned?: SnapshotId) {
      pinnedReads.push(pinned?.projectVersion);
      return { snapshot: pinned ?? SNAPSHOT, results: [{ id: "scene-one", type: "scene", name: "Opening", snippet: "A harbor at night.", filePath: document.path, score: 1, field: "body", offset: 2, length: query.length }].slice(0, limit) };
    },
    async writingStatsSnapshot(_projectId: string, pinned?: SnapshotId) {
      pinnedReads.push(pinned?.projectVersion); return { snapshot: pinned ?? SNAPSHOT, stats: { totalCharCount: 20, totalPages400: 1, volumes: [], sceneById: {} } };
    },
    async listProposals() { return []; }, async getProposal() { return null; },
    async propose(_projectId: string, proposal: ChangeProposal) { proposed.push(proposal); return proposal; },
    async approve(_projectId: string, approval: { proposalId: string; operationIds: string[]; authorScope: string }) { approvals.push(approval); },
    async apply(_projectId: string, operation: ChangeOperation) { return { operationId: operation.id, generation: operation.generation, projectVersion: operation.baseProjectVersion + 1, revisions: operation.writes.map(({ path, revision }) => ({ path, revision })) }; },
  }) as unknown as CoreStore;
  return { store, proposed, approvals, pinnedReads, snapshotReads };
}

interface PublishingObservations {
  paths: string[];
  forwardedHeaders?: { authorization: string | null; cookie: string | null; proxyAuthorization: string | null; mcpSessionId: string | null };
  publicCoreActions?: ActionResult;
  publicActionIds?: string[];
  linkedReaderError?: string;
}

function publishingRuntime(cacheDirectory: string, observed: PublishingObservations): ModuleRuntime {
  const manifest: ModuleManifest = {
    id: "publishing", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const schema: ValueSchema = { parse(value) { return value; } };
  const readCore: ModuleAction = {
    id: "read-core", effect: "read", inputSchema: schema, outputSchema: schema,
    async invoke(_input, context): Promise<ActionResult> { return context.invoke("core.status", {}); },
  };
  const definition: ModuleDefinition = {
    manifest,
    actions: [readCore],
    ui: [],
    http: [{
      id: "share", path: "share/:token", methods: ["GET"], access: "public", effect: "read",
      async handle(request, context) {
        observed.paths.push(new URL(request.url).pathname);
        observed.forwardedHeaders = {
          authorization: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
          proxyAuthorization: request.headers.get("proxy-authorization"),
          mcpSessionId: request.headers.get("mcp-session-id"),
        };
        observed.publicCoreActions = await context.invoke("core.proposals.list", {});
        observed.publicActionIds = (await context.listActions()).map(({ id }) => id);
        try { await context.linkedReader("123"); }
        catch (error) { observed.linkedReaderError = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unavailable"; }
        return Response.json({ path: new URL(request.url).pathname, access: context.projectId, snapshot: context.reader.snapshot.projectVersion }, {
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Robots-Tag": "noindex, nofollow",
          },
        });
      },
    }],
    async dispose() {},
  };
  return new ModuleRuntime({ manifests: [manifest], enabled: ["publishing"], loaders: { publishing: async () => definition }, cacheDirectory });
}

function actionBoundaryRuntime(cacheDirectory: string): ModuleRuntime {
  const schema: ValueSchema = { parse(value) { return value; } };
  const mcpManifest: ModuleManifest = {
    id: "mcp", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const nlpManifest: ModuleManifest = {
    id: "nlp", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const mcpDefinition: ModuleDefinition = {
    manifest: mcpManifest,
    actions: [{
      id: "propose", effect: "propose", inputSchema: schema, outputSchema: schema,
      async invoke(input, context): Promise<ActionResult> {
        const proposal = await context.propose([input as ChangeOperation]);
        return { ok: true, snapshot: context.reader.snapshot, data: { proposal } };
      },
    }],
    ui: [],
    http: [{
      id: "propose", path: "propose", methods: ["POST"], access: "owner", effect: "propose",
      async handle(request, context) {
        const proposal = await context.propose([await request.json() as ChangeOperation]);
        return Response.json({ source: proposal.source });
      },
    }, {
      id: "streamable", path: "streamable", methods: ["GET"], access: "owner", effect: "propose",
      async handle(_request, context) {
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode("data: ready\n\n")); },
        }), { headers: {
          "Content-Type": "text/event-stream",
          "X-Test-MCP-Project": context.projectId,
          ...(context.mcpSessionIdentity ? { "X-Test-MCP-Identity": context.mcpSessionIdentity } : {}),
        } });
      },
    }, {
      id: "native-propose", path: "native-propose", methods: ["POST"], access: "owner", effect: "propose",
      async handle(request, context) {
        return Response.json(await context.invoke("core.knowledge.propose", await request.json()));
      },
    }, {
      id: "compute", path: "compute", methods: ["POST"], access: "owner", effect: "compute",
      async handle(request, context) {
        const input = await request.json() as { operation?: ChangeOperation; linkedProjectId?: string };
        const document = await context.reader.read("manuscript/ms-one/scene-one.md");
        const nested = await context.invoke("nlp.analyze", {});
        let linkedProjectError: string | null = null;
        if (input.linkedProjectId) {
          try { await context.linkedReader(input.linkedProjectId); }
          catch (error) { linkedProjectError = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown"; }
        }
        let proposalCode: string | null = null;
        try {
          await context.propose([input.operation as ChangeOperation]);
        } catch (error) {
          proposalCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
        }
        return Response.json({ document: document?.content ?? null, nested, proposalCode, linkedProjectError });
      },
    }],
    async dispose() {},
  };
  const nlpDefinition: ModuleDefinition = {
    manifest: nlpManifest,
    actions: [{
      id: "analyze", effect: "compute", inputSchema: schema, outputSchema: schema,
      async invoke(_input, context): Promise<ActionResult> {
        const nested = await context.invoke("core.hierarchy.create", { kind: "volume", id: "blocked", title: "Blocked", idempotencyKey: "blocked-action" });
        return { ok: true, snapshot: context.reader.snapshot, data: { nested } };
      },
    }],
    ui: [],
    async dispose() {},
  };
  return new ModuleRuntime({
    manifests: [mcpManifest, nlpManifest], enabled: ["mcp", "nlp"], cacheDirectory,
    loaders: { mcp: async () => mcpDefinition, nlp: async () => nlpDefinition },
  });
}

const testWorkerEntry = fileURLToPath(new URL("../../module-runtime/src/fixtures/worker.mjs", import.meta.url));

function jobHistoryRuntime(cacheDirectory: string): ModuleRuntime {
  const manifest: ModuleManifest = {
    id: "speaker", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const schema: ValueSchema = { parse(value) { return value; } };
  const definition: ModuleDefinition = {
    manifest,
    actions: [{
      id: "test-worker", effect: "compute", inputSchema: schema, outputSchema: schema,
      async invoke(input, context): Promise<ActionResult> {
        const value = input as { jobId: string; task?: string };
        const request: JobRequest = {
          id: value.jobId, module: "speaker", task: value.task ?? "echo", snapshot: context.reader.snapshot,
          model: "test-model", modelVersion: "1", moduleVersion: manifest.version, deadline: Date.now() + 10_000,
          input: { privatePayload: "worker-input-must-not-enter-owner-history" },
        };
        return { ok: true, snapshot: context.reader.snapshot, data: await context.runJob(request) };
      },
    }],
    ui: [],
    async dispose() {},
  };
  return new ModuleRuntime({
    manifests: [manifest], enabled: ["speaker"], loaders: { speaker: async () => definition },
    workerEntries: { speaker: testWorkerEntry }, cacheDirectory,
  });
}

function sourceDomainJobRuntime(cacheDirectory: string): {
  runtime: ModuleRuntime;
  asyncStarted: Promise<void>;
  releaseAsync(): void;
} {
  const schema: ValueSchema = { parse(value) { return value; } };
  const speakerManifest: ModuleManifest = {
    id: "speaker", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const mcpManifest: ModuleManifest = {
    id: "mcp", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  let resolveAsyncStarted!: () => void;
  const asyncStarted = new Promise<void>((resolveStarted) => { resolveAsyncStarted = resolveStarted; });
  let releaseAsync!: () => void;
  const asyncGate = new Promise<void>((resolveGate) => { releaseAsync = resolveGate; });
  const speakerAction: ModuleAction = {
    id: "speaker.evaluation.run", effect: "compute", job: { type: "speaker-eval" },
    inputSchema: schema, outputSchema: schema,
    async invoke(rawInput, context): Promise<ActionResult> {
      const input = rawInput as { fail?: boolean; wait?: boolean; progress?: number[] };
      if (Array.isArray(input.progress)) {
        if (!context.reportProgress) throw new Error("The host did not scope domain progress to this invocation");
        for (const progress of input.progress) await context.reportProgress(progress);
      }
      if (input.wait) {
        resolveAsyncStarted();
        await asyncGate;
      }
      if (input.fail) {
        return { ok: false, snapshot: context.reader.snapshot, error: { code: "synthetic_evaluation_failed", message: "Synthetic evaluation failure", retryable: true } };
      }
      return {
        ok: true, snapshot: context.reader.snapshot,
        data: { report: { examples: 3, accuracy: 0.75 }, version: "synthetic-v1" },
      };
    },
  };
  const definition: ModuleDefinition = {
    manifest: speakerManifest, actions: [speakerAction], ui: [], async dispose() {},
  };
  const mcpDefinition: ModuleDefinition = {
    manifest: mcpManifest, actions: [], ui: [],
    http: [{
      id: "invoke", path: "invoke", methods: ["POST"], access: "owner", effect: "propose",
      async handle(request, context) {
        return Response.json(await context.invoke("speaker.evaluation.run", await request.json()));
      },
    }],
    async dispose() {},
  };
  return {
    runtime: new ModuleRuntime({
      manifests: [speakerManifest, mcpManifest], enabled: ["speaker", "mcp"], cacheDirectory,
      loaders: { speaker: async () => definition, mcp: async () => mcpDefinition },
    }),
    asyncStarted,
    releaseAsync: () => releaseAsync(),
  };
}

async function startCustomApi(
  store: CoreStore,
  staticDir: string,
  options: Partial<Pick<ApiServerOptions, "trustProxy" | "runtime" | "runtimeOptions" | "usageDirectory" | "persistence" | "oauthOwner" | "oauthMcp" | "betterAuth" | "closeBetterAuthOnShutdown" | "corsAllowedOrigins">> = {},
) {
  const defaults = testClientSettings("project-1", signedRequests.publicJwks, signedRequests.isActive);
  const explicitIdentity = options.betterAuth || options.oauthOwner || options.oauthMcp;
  const server = createServer({
    store, staticDir, persistence: admissionPersistence(store),
    ...(explicitIdentity ? { betterAuth: defaults.betterAuth } : defaults),
    ...options,
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const close = () => new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return { server, base, close };
}

const TEST_ISSUER = "https://auth.codexia.test/api/auth";
const TEST_AUDIENCE = "https://auth.codexia.test/api";
const TEST_OWNER_SUBJECT = "owner";
const TEST_WEB_CLIENT = "codexia-web";
const TEST_MCP_CLIENT = "codexia-mcp";

function createSignedRequestFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "codexia-fixture-key", alg: "ES256", use: "sig" };
  const active = new Set<string>();
  function requestHeaders(clientId: string, scope: string) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = encode({ alg: "ES256", typ: "at+jwt", kid: jwk.kid }) + "." + encode({
      iss: TEST_ISSUER, aud: TEST_AUDIENCE, sub: TEST_OWNER_SUBJECT, client_id: clientId, azp: clientId,
      iat: now, exp: now + 300, jti: randomUUID(), scope,
    });
    const signature = signJwt("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const token = unsigned + "." + signature;
    active.add(token);
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }
  return {
    publicJwks: { keys: [jwk] },
    isActive: async (token: string) => active.has(token),
    ownerHeaders: () => requestHeaders(TEST_WEB_CLIENT, "codexia:api"),
    mcpHeaders: (scope = "mcp:read mcp:compute mcp:propose") => requestHeaders(TEST_MCP_CLIENT, scope),
  };
}

function testClientSettings(projectId: string, publicJwks: object, isActive: (token: string) => Promise<boolean>) {
  const verifier = {
    issuer: TEST_ISSUER, audience: TEST_AUDIENCE, ownerSubject: TEST_OWNER_SUBJECT, jwksUrl: TEST_ISSUER + "/jwks",
    fetch: async () => Response.json(publicJwks), verifyActiveToken: isActive,
  };
  return {
    // These API contracts exercise bearer verification and do not call the OAuth provider routes.
    betterAuth: { issuer: TEST_ISSUER, audience: TEST_AUDIENCE } as NonNullable<ApiServerOptions["betterAuth"]>,
    oauthOwner: { ...verifier, requiredScopes: ["codexia:api"], allowedClientIds: [TEST_WEB_CLIENT] },
    oauthMcp: { ...verifier, allowedClientIds: [TEST_MCP_CLIENT], ownerClientIds: [TEST_WEB_CLIENT], projectIdsByClient: { [TEST_MCP_CLIENT]: [projectId] } },
  };
}

const signedRequests = createSignedRequestFixture();

function hostedTestPolicy(): HostedAuthorizationPolicy {
  const principals = new Map<string, HostedPrincipal>([
    ["read-grant", {
      userId: "reader-1", permissions: ["read"], repositoryId: HOSTED_ASSIGNMENT.repositoryId,
      instanceId: HOSTED_ASSIGNMENT.instanceId, runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      sessionRevision: 1, authorizationRevision: 1, expiresAt: Date.now() + 60_000,
    }],
    ["write-grant", {
      userId: "writer-1", permissions: ["read", "write"], repositoryId: HOSTED_ASSIGNMENT.repositoryId,
      instanceId: HOSTED_ASSIGNMENT.instanceId, runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      sessionRevision: 1, authorizationRevision: 1, expiresAt: Date.now() + 60_000,
    }],
  ]);
  return {
    async authenticate(token, requiredPermission = "read") {
      const principal = principals.get(token);
      if (!principal) throw Object.assign(new Error("grant invalid"), { status: 401 });
      if (!principal.permissions.includes(requiredPermission)) throw Object.assign(new Error("permission denied"), { status: 403 });
      return principal;
    },
  };
}

it("starts standalone API only with Better Auth and exposes no static session mutation routes", async (t) => {
  const store = makeStore();
  const persistence = admissionPersistence(store);
  assert.throws(() => createServer({ store, persistence }), /Standalone authentication requires Better Auth/u);
  const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-canonical-auth-only-"));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const instance = await startCustomApi(store, staticDir);
  const owner = signedRequests.ownerHeaders();
  t.after(instance.close);
  const oldLogin = await fetch(instance.base + "/api/login", { method: "POST", headers: owner, body: "{}" });
  assert.equal(oldLogin.status, 404);
  assert.equal(oldLogin.headers.get("set-cookie"), null);
  const session = await fetch(instance.base + "/api/session", { headers: owner });
  assert.deepEqual(await session.json(), { authenticated: true, authorScope: "owner" });
  const retiredLogout = await fetch(instance.base + "/api/logout", { method: "POST", headers: owner, body: "{}" });
  assert.equal(retiredLogout.status, 404);
  assert.equal(retiredLogout.headers.get("set-cookie"), null);
});

class InterleavingLifecycleRuntime extends ModuleRuntime {
  private lifecycleListener: WorkerJobLifecycleListener | undefined;

  override subscribeJobLifecycle(listener: WorkerJobLifecycleListener): () => void {
    this.lifecycleListener = listener;
    return () => { if (this.lifecycleListener === listener) this.lifecycleListener = undefined; };
  }

  async emitLifecycle(snapshot: WorkerJobLifecycleSnapshot): Promise<void> {
    await this.lifecycleListener?.(snapshot);
  }
}

async function startHostedApi(
  store: CoreStore,
  staticDir: string,
  authorization: HostedAuthorizationPolicy,
  controlFetch?: typeof fetch,
  runtime?: ModuleRuntime,
  usageDirectory?: string,
  persistence: ApiServerOptions["persistence"] = admissionPersistence(store),
  projectId = "project-1",
) {
  const server = createServer({
    store, staticDir, persistence,
    trustProxy: true,
    ...(runtime ? { runtime } : {}),
    ...(usageDirectory ? { usageDirectory } : {}),
    hosted: { assignment: HOSTED_ASSIGNMENT, projectId, authorization, ...(controlFetch ? { controlFetch } : {}) },
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const close = () => new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return { server, base, close };
}

function rawHostedRequest(urlValue: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string; cookies: string[] }> {
  const url = new URL(urlValue);
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolveResponse({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        cookies: response.headers["set-cookie"] ?? [],
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

it("keeps Hosted session mutations at the Instance Access boundary", async (t) => {
  const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-hosted-logout-"));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const api = await startHostedApi(makeSnapshotStore().store, staticDir, hostedTestPolicy());
  t.after(api.close);
  const headers = {
    Host: "instance-1.instances.example", "X-Forwarded-Proto": "https", Origin: HOSTED_ASSIGNMENT.grantPolicy.audience,
    Cookie: "__Host-praetorium_access=read-grant; __Host-praetorium_csrf=fixture-csrf",
    "Content-Type": "application/json",
  };
  for (const path of ["/api/login", "/api/logout"]) {
    const result = await rawHostedRequest(api.base + path, { ...headers, "X-CSRF-Token": "fixture-csrf" }, "{}");
    assert.equal(result.status, 404, result.body);
    assert.deepEqual(result.cookies, []);
  }
});

async function rawHostedRequestStatus(urlValue: string, headers: Record<string, string>, body?: string): Promise<number> {
  return (await rawHostedRequest(urlValue, headers, body)).status;
}

function runtimeControlToken(action: "status" | "quiesce" | "resume", operationId: string, payloadDigest: string, signingKey = RUNTIME_CONTROL_KEY.privateKey, kid = "runtime-control-test-key"): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid, typ: "JWT" })}.${encode({
    contractVersion: "praetorium-runtime-control/v1",
    iss: HOSTED_ASSIGNMENT.controlServicePolicy.issuer,
    sub: "test-control-plane",
    aud: HOSTED_ASSIGNMENT.controlServicePolicy.audience,
    instanceId: HOSTED_ASSIGNMENT.instanceId,
    repositoryId: HOSTED_ASSIGNMENT.repositoryId,
    runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
    operationId,
    action,
    payloadDigest,
    iat: now,
    nbf: now,
    exp: now + 30,
    jti: `${action}-${operationId}`,
  })}`;
  const signature = signJwt("sha256", Buffer.from(unsigned, "ascii"), {
    key: signingKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

async function startApi(staticDir: string, trustProxy = false) {
  return startCustomApi(makeStore(), staticDir, { trustProxy });
}

function usageEvent(projectId: string, id: string, startedAt: string, options: Partial<ModelUsageEvent> = {}): ModelUsageEvent {
  return {
    id, projectId, feature: "assistant.story-draft", provider: "openai", model: "gpt-4o-mini",
    startedAt, completedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(), state: "completed",
    inputTokens: 12, outputTokens: 8, cost: 0.00002, ...options,
  };
}

function modelUsageRuntimeOptions(cacheDirectory: string): Omit<ModuleRuntimeOptions, "cacheDirectory"> & { cacheDirectory: string } {
  const manifest: ModuleManifest = {
    id: "assistant", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], optionalRequires: [MODEL_USAGE_CAPABILITY], statePaths: [], locality: "optional-external",
  };
  const schema: ValueSchema = { parse(value) { return value; } };
  const loader: ModuleLoader = async (moduleContext: ModuleContext) => ({
    manifest,
    actions: [{
      id: "assistant.model-usage-history", effect: "compute", inputSchema: schema, outputSchema: schema,
      async invoke(rawInput, context): Promise<ActionResult> {
        const input = rawInput as { event?: ModelUsageEvent; query?: { from?: string; to?: string; limit?: number; cursor?: string } };
        const lease = await moduleContext.acquireCapability<ModelUsageStore>(MODEL_USAGE_CAPABILITY);
        try {
          if (input.event) await lease.value.append(input.event);
          const history = await lease.value.list(context.reader.snapshot.projectId, input.query);
          return { ok: true, snapshot: context.reader.snapshot, data: history };
        } catch (error) {
          const candidate = error as { code?: unknown; message?: unknown };
          return { ok: false, snapshot: context.reader.snapshot, error: {
            code: typeof candidate?.code === "string" ? candidate.code : "model_usage_test_failed",
            message: typeof candidate?.message === "string" ? candidate.message : "Model usage test action failed",
            retryable: false,
          } };
        } finally {
          await lease.release();
        }
      },
    }],
    ui: [],
    async dispose() {},
  });
  return {
    manifests: [manifest], enabled: ["assistant"], loaders: { assistant: loader }, cacheDirectory,
  };
}

async function waitForJob(base: string, ownerAuthorization: string, id: string): Promise<{ status: string; result: unknown }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/jobs/${encodeURIComponent(id)}`, { headers: { Authorization: ownerAuthorization } });
    assert.equal(response.status, 200);
    const job = await response.json() as { status: string; result: unknown };
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.fail(`Job ${id} did not reach a terminal state`);
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codexia HTTP boundary", () => {
  it("routes Better Auth discovery and token requests through the Fastify entry point", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-better-auth-routes-"));
    tempDirs.push(staticDir);
    const delegated: Array<{ method: string; path: string; body: string }> = [];
    const metadata = Response.json({
      issuer: "https://api.example.test/api/auth",
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
    const fake = {
      issuer: "https://api.example.test/api/auth",
      audience: "https://api.example.test/api",
      handler: async (request: Request) => {
        const body = request.method === "GET" ? "" : await request.text();
        delegated.push({ method: request.method, path: new URL(request.url).pathname, body });
        return Response.json({ accepted: true });
      },
      authorizationServerMetadata: async () => metadata.clone(),
      openIdConfigMetadata: async () => metadata.clone(),
      toHeaders: fromNodeHeaders,
      advertisePublicClientTokenAuth,
    } as unknown as NonNullable<ApiServerOptions["betterAuth"]>;
    const api = await startCustomApi(makeStore(), staticDir, { betterAuth: fake });
    t.after(api.close);

    for (const path of ["/.well-known/oauth-authorization-server/api/auth", "/.well-known/openid-configuration/api/auth"]) {
      const response = await fetch(`${api.base}${path}`);
      assert.equal(response.status, 200);
      const document = await response.json() as { token_endpoint_auth_methods_supported: string[] };
      assert.ok(document.token_endpoint_auth_methods_supported.includes("none"));
    }
    const mcp = await fetch(`${api.base}/mcp`, { method: "POST" });
    assert.equal(mcp.status, 401);
    assert.match(mcp.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/api\.example\.test\/\.well-known\/oauth-protected-resource\/api"/u);
    const resource = await fetch(`${api.base}/.well-known/oauth-protected-resource/api`);
    assert.equal(resource.status, 200);
    assert.deepEqual(await resource.json(), {
      resource: fake.audience, authorization_servers: [fake.issuer],
      scopes_supported: ["mcp:read", "mcp:compute", "mcp:propose"], bearer_methods_supported: ["header"],
    });
    const token = await fetch(`${api.base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=fixture-code",
    });
    assert.equal(token.status, 200);
    assert.deepEqual(delegated, [{ method: "POST", path: "/api/auth/oauth2/token", body: "grant_type=authorization_code&code=fixture-code" }]);
  });

  it("releases only API-owned Better Auth PostgreSQL pools on shutdown", async () => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-auth-pool-close-"));
    tempDirs.push(staticDir);
    for (const apiOwned of [true, false]) {
      let closedPools = 0;
      const fake = { pool: { end: async () => { closedPools += 1; } } } as unknown as NonNullable<ApiServerOptions["betterAuth"]>;
      const api = await startCustomApi(makeStore(), staticDir, { betterAuth: fake, closeBetterAuthOnShutdown: apiOwned });
      assert.equal((await fetch(`${api.base}/api/health`)).status, 200);
      await api.close();
      assert.equal(closedPools, apiOwned ? 1 : 0, "Only a pool owned by the API lifecycle is released");
    }
  });

  it("distinguishes runtime-control key outages from invalid credentials and reuses verified JWKS", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-control-jwks-"));
    tempDirs.push(staticDir);
    const native = await nativeProject(t, "Hosted control JWKS");
    let unavailable = true;
    let requests = 0;
    const rotated = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const rotatedKid = "runtime-control-rotated-key";
    const rotatedJwk = { ...RUNTIME_CONTROL_PUBLIC_JWK, ...rotated.publicKey.export({ format: "jwk" }), kid: rotatedKid };
    let keys = [RUNTIME_CONTROL_PUBLIC_JWK];
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      requests++;
      if (unavailable) throw new Error("private upstream failure");
      return Response.json({ keys });
    };
    const apiServer = await startHostedApi(native.store, staticDir, hostedTestPolicy(), controlFetch, undefined, undefined, native.persistence, native.project.id);
    t.after(apiServer.close);
    const operationId = "control-key-outage";
    const body = JSON.stringify({ operationId, instanceId: HOSTED_ASSIGNMENT.instanceId, runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      reason: "redeploy", contractVersion: "scriptorium-platform/v1", deadline: new Date(Date.now() + 60_000).toISOString() });
    const statusToken = runtimeControlToken("status", operationId, sha256Digest(""));
    const status = (token = statusToken) => fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
    for (const action of ["status", "quiesce", "resume"] as const) {
      const response = action === "status" ? await status() : await fetch(`${apiServer.base}${action === "quiesce" ? RUNTIME_QUIESCE_PATH : RUNTIME_RESUME_PATH}`, {
        method: "POST", headers: { Authorization: `Bearer ${runtimeControlToken(action, operationId, sha256Digest(body))}`, "Content-Type": "application/json" }, body,
      });
      assert.equal(response.status, 503, action);
      const failure = await response.json() as { code: string; message: string };
      assert.equal(failure.code, "AUTHORIZATION_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(failure), /private upstream failure/u);
    }
    assert.equal((await status("invalid.token.value")).status, 401);
    unavailable = false;
    assert.equal((await status()).status, 200);
    const afterFetch = requests;
    unavailable = true;
    assert.equal((await status()).status, 200, "a valid cached key survives a temporary upstream outage");
    const signature = statusToken.split(".")[2]!;
    const tampered = statusToken.slice(0, statusToken.lastIndexOf(".") + 1) + (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    assert.equal((await status(tampered)).status, 401);
    assert.equal(requests, afterFetch, "verified JWKS is reused without relaxing credential validation");

    unavailable = false;
    keys = [rotatedJwk];
    const rotatedToken = runtimeControlToken("status", operationId, sha256Digest(""), rotated.privateKey, rotatedKid);
    assert.equal((await status(rotatedToken)).status, 200, "a previously unknown signing key triggers JWKS refresh");
    assert.equal(requests, afterFetch + 1);
    unavailable = true;
    assert.equal((await status(rotatedToken)).status, 200, "the refreshed key is cached");
    assert.equal(requests, afterFetch + 1);
    assert.equal((await status(statusToken)).status, 401, "the replaced key is not accepted after refresh");
  });

  it("binds hosted API access and signed lifecycle controls to one PostgreSQL project and runtime epoch", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-hosted-api-"));
    tempDirs.push(staticDir);
    const native = await nativeProject(t, "Hosted API");
    let projectReads = 0;
    const persistence = instrumentPersistence(native.persistence, { onProjectRead: () => { projectReads++; } });
    const projectSnapshot: SnapshotId = { projectId: native.project.id, projectVersion: native.project.version };
    let delayNextProposal = false;
    let announceProposalStarted!: () => void;
    let releaseProposal!: () => void;
    const proposalStarted = new Promise<void>((resolveStarted) => { announceProposalStarted = resolveStarted; });
    const proposalGate = new Promise<void>((resolveGate) => { releaseProposal = resolveGate; });
    const store = native.store;
    const originalPropose = store.propose.bind(store);
    store.propose = async (projectId, proposal) => {
      if (delayNextProposal) {
        delayNextProposal = false;
        announceProposalStarted();
        await proposalGate;
      }
      return originalPropose(projectId, proposal);
    };
    const operation: ChangeOperation = {
      id: "hosted-api-proposal-op", generation: 0, projectId: native.project.id,
      baseProjectVersion: native.project.version, effect: "metadata", reads: [],
      writes: [{ path: "meta/hosted-api-test.md", revision: null, content: "A durable proposal.\n" }],
      message: "Propose a bounded metadata update",
    };
    const proposalBody = JSON.stringify({ id: "hosted-api-proposal", snapshot: projectSnapshot, operations: [operation] });
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(store, staticDir, hostedTestPolicy(), controlFetch, undefined, undefined, persistence, native.project.id);
    t.after(async () => { releaseProposal(); await apiServer.close(); });

    const noGrant = await fetch(`${apiServer.base}/api/projects`);
    assert.equal(noGrant.status, 401);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const discovery = await fetch(`${apiServer.base}${path}`);
      assert.equal(discovery.status, 200, `${path} must be public without a grant`);
      assert.deepEqual(await discovery.json(), {
        resource: HOSTED_ASSIGNMENT.grantPolicy.audience,
        authorization_servers: [HOSTED_ASSIGNMENT.grantPolicy.issuer],
        scopes_supported: ["read", "write"],
      });
    }
    const mcpChallenge = await fetch(`${apiServer.base}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    });
    assert.equal(mcpChallenge.status, 401);
    assert.match(mcpChallenge.headers.get("www-authenticate") ?? "", /oauth-protected-resource/u);
    const readerHeaders = { Authorization: "Bearer read-grant" };
    const mcpReader = await fetch(`${apiServer.base}/mcp`, { headers: readerHeaders });
    assert.equal(mcpReader.status, 404, "a read grant must pass auth even if MCP was not packaged");
    const projects = await fetch(`${apiServer.base}/api/projects`, { headers: readerHeaders });
    assert.equal(projects.status, 200);
    assert.deepEqual(await projects.json(), { projects: [native.project], nextCursor: null });
    const projectPage = await fetch(`${apiServer.base}/api/projects?limit=20`, { headers: readerHeaders });
    assert.equal(projectPage.status, 200);
    assert.deepEqual(await projectPage.json(), { projects: [native.project], nextCursor: null });
    const otherRepository = await fetch(`${apiServer.base}/api/projects/another-project/tree`, { headers: readerHeaders });
    assert.equal(otherRepository.status, 404);
    const ambiguous = await fetch(`${apiServer.base}/api/projects`, {
      headers: { Authorization: "Bearer read-grant", Cookie: "__Host-praetorium_access=write-grant" },
    });
    assert.equal(ambiguous.status, 400);

    const readAction = await fetch(`${apiServer.base}/api/projects/${native.project.id}/actions/core.status`, {
      method: "POST", headers: { ...readerHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ input: {} }),
    });
    assert.equal(readAction.status, 200, "read-only MCP grants may invoke POST actions whose declared effect is read");
    const deniedProposal = await fetch(`${apiServer.base}/api/projects/${native.project.id}/proposals`, {
      method: "POST", headers: { ...readerHeaders, "Content-Type": "application/json" }, body: proposalBody,
    });
    assert.equal(deniedProposal.status, 403);
    assert.equal((await deniedProposal.json() as { code: string }).code, "WRITE_PERMISSION_REQUIRED");
    const cookieHeaders = {
      Host: "instance-1.instances.example", "X-Forwarded-Proto": "https", Origin: HOSTED_ASSIGNMENT.grantPolicy.audience,
      Cookie: "__Host-praetorium_access=write-grant; __Host-praetorium_csrf=csrf-value",
    };
    const missingCsrf = await rawHostedRequestStatus(`${apiServer.base}/api/inbox/read-all`, cookieHeaders);
    assert.equal(missingCsrf, 403);
    const cookieWrite = await rawHostedRequestStatus(`${apiServer.base}/api/inbox/read-all`, {
      ...cookieHeaders, "X-CSRF-Token": "csrf-value",
    });
    assert.equal(cookieWrite, 200);

    const statusWithoutControl = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`);
    assert.equal(statusWithoutControl.status, 401);
    const statusToken = runtimeControlToken("status", "status-operation", sha256Digest(""));
    const statusResponse = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, { headers: { Authorization: `Bearer ${statusToken}` } });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as {
      instanceId: string; projectId: string; runtimeEpoch: number;
      persistence: { state: string; provider: string; projectVersion: number | null };
    };
    assert.deepEqual([status.instanceId, status.projectId, status.runtimeEpoch], ["instance-1", native.project.id, 3]);
    assert.equal(status.persistence.state, "verified");
    assert.equal(status.persistence.provider, "postgres");
    assert.equal(status.persistence.projectVersion, native.project.version);
    const readsBeforePreflight = projectReads;
    assert.ok(readsBeforePreflight > 0, "hosted persistence status must read the assigned project through Persistence.read/getProject");

    const quiesceRequest = {
      operationId: "quiesce-safe",
      instanceId: HOSTED_ASSIGNMENT.instanceId,
      runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      reason: "redeploy",
      contractVersion: "scriptorium-platform/v1",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const exactQuiesceBody = JSON.stringify(quiesceRequest);
    const quiesceToken = runtimeControlToken("quiesce", quiesceRequest.operationId, sha256Digest(exactQuiesceBody));
    const quiesceResponse = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${quiesceToken}`, "Content-Type": "application/json" }, body: exactQuiesceBody,
    });
    assert.equal(quiesceResponse.status, 200);
    const safeReceipt = await quiesceResponse.json() as { disposition: string; activeMutations: number; projectVersion: number | null };
    assert.equal(safeReceipt.disposition, "safe");
    assert.equal(safeReceipt.activeMutations, 0);
    assert.equal(safeReceipt.projectVersion, native.project.version);
    assert.ok(projectReads > readsBeforePreflight, "quiesce performs a fresh PostgreSQL census after closing admission");
    const blockedByGate = await fetch(`${apiServer.base}/api/projects/${native.project.id}/proposals`, {
      method: "POST", headers: { Authorization: "Bearer write-grant", "Content-Type": "application/json" }, body: proposalBody,
    });
    assert.equal(blockedByGate.status, 503);
    assert.equal((await blockedByGate.json() as { code: string }).code, "RUNTIME_QUIESCED");

    const resumeToken = runtimeControlToken("resume", quiesceRequest.operationId, sha256Digest(exactQuiesceBody));
    const resumed = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${resumeToken}`, "Content-Type": "application/json" }, body: exactQuiesceBody,
    });
    assert.equal(resumed.status, 204);
    const resumedAgain = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${resumeToken}`, "Content-Type": "application/json" }, body: exactQuiesceBody,
    });
    assert.equal(resumedAgain.status, 204, "the same epoch and completed operation may resume idempotently");
    const unrelatedResumeBody = JSON.stringify({ ...quiesceRequest, operationId: "unrelated-resume" });
    const unrelatedResumeToken = runtimeControlToken("resume", "unrelated-resume", sha256Digest(unrelatedResumeBody));
    const unrelatedResume = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${unrelatedResumeToken}`, "Content-Type": "application/json" }, body: unrelatedResumeBody,
    });
    assert.equal(unrelatedResume.status, 409);
    const allowedProposal = await fetch(`${apiServer.base}/api/projects/${native.project.id}/proposals`, {
      method: "POST", headers: { Authorization: "Bearer write-grant", "Content-Type": "application/json" }, body: proposalBody,
    });
    assert.equal(allowedProposal.status, 201);

    delayNextProposal = true;
    const inFlightProposal = fetch(`${apiServer.base}/api/projects/${native.project.id}/proposals`, {
      method: "POST", headers: { Authorization: "Bearer write-grant", "Content-Type": "application/json" }, body: proposalBody,
    });
    await proposalStarted;
    const blockedRequest = {
      ...quiesceRequest,
      operationId: "quiesce-blocked",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const exactBlockedBody = JSON.stringify(blockedRequest);
    const blockedToken = runtimeControlToken("quiesce", blockedRequest.operationId, sha256Digest(exactBlockedBody));
    const blockedResponse = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${blockedToken}`, "Content-Type": "application/json" }, body: exactBlockedBody,
    });
    assert.equal(blockedResponse.status, 200);
    const blockedReceipt = await blockedResponse.json() as { disposition: string; activeMutations: number; reasonCodes: string[] };
    assert.equal(blockedReceipt.disposition, "blocked");
    assert.equal(blockedReceipt.activeMutations, 1);
    assert.ok(blockedReceipt.reasonCodes.includes("ACTIVE_MUTATIONS"));
    const blockedResumeToken = runtimeControlToken("resume", blockedRequest.operationId, sha256Digest(exactBlockedBody));
    const blockedResume = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${blockedResumeToken}`, "Content-Type": "application/json" }, body: exactBlockedBody,
    });
    assert.equal(blockedResume.status, 204, "resuming the exact blocked operation is an idempotent no-op");
    releaseProposal();
    assert.equal((await inFlightProposal).status, 201, "the active mutation may finish after quiesce reports blocked and reopens admission");
  });

  it("keeps a quiesce census unverified when a worker job starts and finishes during its local scan, then permits a stable retry", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-hosted-activity-race-"));
    tempDirs.push(staticDir);
    const native = await nativeProject(t, "Hosted activity race");
    const runtime = new InterleavingLifecycleRuntime({ manifests: [], enabled: [], cacheDirectory: resolve(staticDir, "module-cache") });
    const projectSnapshot: SnapshotId = { projectId: native.project.id, projectVersion: native.project.version };
    let projectReads = 0;
    let interleaveNextProjectRead = false;
    const lifecycleCreatedAt = new Date().toISOString();
    let lifecycleUpdatedAt = lifecycleCreatedAt;
    let lifecycleStartedAt: string | null = null;
    const lifecycle = async (state: WorkerJobLifecycleSnapshot["state"]): Promise<void> => {
      lifecycleUpdatedAt = new Date(Date.parse(lifecycleUpdatedAt) + 1).toISOString();
      if (state === "running") lifecycleStartedAt = lifecycleUpdatedAt;
      await runtime.emitLifecycle({
        jobId: "job-interleaving", module: "story", task: "runtime-activity-interleaving", snapshot: projectSnapshot,
        state, createdAt: lifecycleCreatedAt, updatedAt: lifecycleUpdatedAt,
        startedAt: lifecycleStartedAt,
        finishedAt: state === "succeeded" || state === "failed" || state === "cancelled" ? lifecycleUpdatedAt : null,
      });
    };
    const persistence = instrumentPersistence(native.persistence, {
      async beforeProjectRead() {
        if (!interleaveNextProjectRead) return;
        interleaveNextProjectRead = false;
        await lifecycle("queued");
        await lifecycle("running");
        await lifecycle("succeeded");
      },
      onProjectRead: () => { projectReads++; },
    });
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(native.store, staticDir, hostedTestPolicy(), controlFetch, runtime, resolve(staticDir, "usage"), persistence, native.project.id);
    t.after(apiServer.close);

    const preflight = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, {
      headers: { Authorization: `Bearer ${runtimeControlToken("status", "race-preflight", sha256Digest(""))}` },
    });
    assert.equal(preflight.status, 200);
    const preflightStatus = await preflight.json() as { persistence: { state: string; projectVersion: number | null } };
    assert.equal(preflightStatus.persistence.state, "verified");
    assert.equal(preflightStatus.persistence.projectVersion, native.project.version);
    const projectReadsAfterPreflight = projectReads;
    assert.ok(projectReadsAfterPreflight > 0, "the signed preflight reads the assigned project from PostgreSQL");

    const request = {
      operationId: "quiesce-activity-race",
      instanceId: HOSTED_ASSIGNMENT.instanceId,
      runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      reason: "redeploy",
      contractVersion: "scriptorium-platform/v1",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const body = JSON.stringify(request);
    const quiesceHeaders = {
      Authorization: `Bearer ${runtimeControlToken("quiesce", request.operationId, sha256Digest(body))}`,
      "Content-Type": "application/json",
    };
    interleaveNextProjectRead = true;
    const first = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, { method: "POST", headers: quiesceHeaders, body });
    assert.equal(first.status, 200);
    const firstReceipt = await first.json() as { disposition: string; activeJobs: number; reasonCodes: string[] };
    assert.equal(firstReceipt.activeJobs, 0, "the worker has already finished by the time the census returns");
    assert.equal(firstReceipt.disposition, "unknown", "the monotonic activity version detects the completed job");
    assert.ok(firstReceipt.reasonCodes.includes("PERSISTENCE_UNVERIFIED"));
    assert.ok(projectReads > projectReadsAfterPreflight, "the closed-admission census re-reads its PostgreSQL project version");

    const stableStatus = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, {
      headers: { Authorization: `Bearer ${runtimeControlToken("status", "race-stable-status", sha256Digest(""))}` },
    });
    assert.equal(stableStatus.status, 200);
    assert.equal((await stableStatus.json() as { persistence: { state: string } }).persistence.state, "verified");

    const retry = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, { method: "POST", headers: quiesceHeaders, body });
    assert.equal(retry.status, 200);
    const retryReceipt = await retry.json() as { disposition: string; projectVersion: number | null };
    assert.equal(retryReceipt.disposition, "safe");
    assert.equal(retryReceipt.projectVersion, native.project.version);

    const resumed = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${runtimeControlToken("resume", request.operationId, sha256Digest(body))}`, "Content-Type": "application/json" },
      body,
    });
    assert.equal(resumed.status, 204);
  });

  it("waits for accepted private job-history writes before certifying safe quiesce", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-hosted-history-quiesce-"));
    tempDirs.push(staticDir);
    const native = await nativeProject(t, "Hosted history quiesce");
    const usageDirectory = resolve(staticDir, "usage");
    const migratedDirectory = resolve(staticDir, "migrated-usage");
    const runtime = new InterleavingLifecycleRuntime({ manifests: [], enabled: [], cacheDirectory: resolve(staticDir, "module-cache") });
    const projectSnapshot: SnapshotId = { projectId: native.project.id, projectVersion: native.project.version };
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(native.store, staticDir, hostedTestPolicy(), controlFetch, runtime, usageDirectory, native.persistence, native.project.id);
    t.after(apiServer.close);

    const createdAt = new Date().toISOString();
    const runningAt = new Date(Date.parse(createdAt) + 1).toISOString();
    const finishedAt = new Date(Date.parse(createdAt) + 2).toISOString();
    const lifecycle = (state: WorkerJobLifecycleSnapshot["state"], updatedAt: string, finishedAtValue: string | null = null): WorkerJobLifecycleSnapshot => ({
      jobId: "job-history-quiesce-race", module: "story", task: "history-quiesce-race", snapshot: projectSnapshot,
      state, createdAt, updatedAt, startedAt: runningAt, finishedAt: finishedAtValue,
    });
    await runtime.emitLifecycle(lifecycle("running", runningAt));
    const historyPath = resolve(usageDirectory, "jobs", "jobs-state.json");
    assert.equal(((JSON.parse(await readFile(historyPath, "utf8")) as { jobs: Array<{ job: { status: string } }> }).jobs[0]?.job.status), "running");

    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolveGate) => { releaseTerminal = resolveGate; });
    let terminalPersistStarted!: () => void;
    const terminalStarted = new Promise<void>((resolveStarted) => { terminalPersistStarted = resolveStarted; });
    let historyBarrierStarted!: () => void;
    const historyBarrier = new Promise<void>((resolveStarted) => { historyBarrierStarted = resolveStarted; });
    const prototype = JobHistoryStore.prototype as unknown as {
      persist: (state: unknown) => Promise<void>;
      listJobs: () => Promise<unknown[]>;
    };
    const originalPersist = prototype.persist;
    const originalListJobs = prototype.listJobs;
    prototype.persist = function (state: unknown): Promise<void> {
      const jobs = (state as { jobs?: Array<{ job?: { id?: string; status?: string } }> }).jobs ?? [];
      if (jobs.some((record) => record.job?.id === "job-history-quiesce-race" && record.job.status === "done")) {
        terminalPersistStarted();
        return terminalGate.then(() => originalPersist.call(this, state));
      }
      return originalPersist.call(this, state);
    };
    prototype.listJobs = function (): Promise<unknown[]> {
      historyBarrierStarted();
      return originalListJobs.call(this);
    };

    let terminalCallback: Promise<void> | undefined;
    try {
      terminalCallback = runtime.emitLifecycle(lifecycle("succeeded", finishedAt, finishedAt));
      await terminalStarted;
      const request = {
        operationId: "quiesce-history-write",
        instanceId: HOSTED_ASSIGNMENT.instanceId,
        runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
        reason: "migrate private history",
        contractVersion: "scriptorium-platform/v1",
        deadline: new Date(Date.now() + 60_000).toISOString(),
      };
      const body = JSON.stringify(request);
      const quiesce = fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtimeControlToken("quiesce", request.operationId, sha256Digest(body))}`,
          "Content-Type": "application/json",
        },
        body,
      });
      let barrierTimeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          historyBarrier,
          new Promise<never>((_resolve, reject) => {
            barrierTimeout = setTimeout(() => reject(new Error("quiesce did not warm private job history")), 1_000);
          }),
        ]);
      } finally { if (barrierTimeout) clearTimeout(barrierTimeout); }
      const earlyResponse = await Promise.race([
        quiesce.then(() => true),
        new Promise<boolean>((resolveDelay) => setTimeout(() => resolveDelay(false), 25)),
      ]);
      assert.equal(earlyResponse, false, "quiesce must await the accepted terminal history write");

      releaseTerminal();
      const response = await quiesce;
      assert.equal(response.status, 200);
      const receipt = await response.json() as { disposition: string; reasonCodes: string[] };
      assert.equal(receipt.disposition, "safe");
      assert.ok(!receipt.reasonCodes.includes("PERSISTENCE_UNVERIFIED"));

      await cp(usageDirectory, migratedDirectory, { recursive: true });
      const migrated = await new JobHistoryStore(migratedDirectory).listJobs();
      assert.equal(migrated[0]?.status, "done");
      assert.equal(migrated[0]?.errorCode, undefined, "first read after migration must not orphan a completed worker");
    } finally {
      releaseTerminal();
      prototype.persist = originalPersist;
      prototype.listJobs = originalListJobs;
      await terminalCallback?.catch(() => undefined);
    }
  });

  it("does not certify safe quiesce when a domain job terminal history write and fallback both fail", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-hosted-domain-history-quiesce-"));
    tempDirs.push(root);
    const staticDir = resolve(root, "static");
    await mkdir(staticDir);
    const native = await nativeProject(t, "Hosted domain history failure");
    const usageDirectory = resolve(root, "usage");
    const domain = sourceDomainJobRuntime(resolve(root, "module-cache"));
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(native.store, staticDir, hostedTestPolicy(), controlFetch, domain.runtime, usageDirectory, native.persistence, native.project.id);
    t.after(async () => { domain.releaseAsync(); await apiServer.close(); });
    const prototype = JobHistoryStore.prototype as unknown as { persist: (state: unknown) => Promise<void> };
    const originalPersist = prototype.persist;
    let failedTerminalWrites = 0;
    prototype.persist = function (state: unknown): Promise<void> {
      const jobs = (state as { jobs?: Array<{ kind?: string; job?: { status?: string } }> }).jobs ?? [];
      if (jobs.some((entry) => entry.kind === "domain" && (entry.job?.status === "done" || entry.job?.status === "error"))) {
        failedTerminalWrites += 1;
        return Promise.reject(new Error("injected private history terminal write failure"));
      }
      return originalPersist.call(this, state);
    };
    try {
      const action = await fetch(`${apiServer.base}/api/projects/${native.project.id}/actions/speaker.evaluation.run`, {
        method: "POST",
        headers: { Authorization: "Bearer write-grant", "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });
      assert.equal(action.status, 200);
      assert.ok(action.headers.get("x-codexia-job-id"));
      assert.equal(failedTerminalWrites, 2, "both the result and explicit retention-failure fallback writes must be exercised");
      const request = {
        operationId: "quiesce-domain-history-failure",
        instanceId: HOSTED_ASSIGNMENT.instanceId,
        runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
        reason: "migrate private domain history",
        contractVersion: "scriptorium-platform/v1",
        deadline: new Date(Date.now() + 60_000).toISOString(),
      };
      const body = JSON.stringify(request);
      const response = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtimeControlToken("quiesce", request.operationId, sha256Digest(body))}`,
          "Content-Type": "application/json",
        },
        body,
      });
      assert.equal(response.status, 200);
      const receipt = await response.json() as { disposition: string; reasonCodes: string[] };
      assert.equal(receipt.disposition, "unknown");
      assert.ok(receipt.reasonCodes.includes("PERSISTENCE_UNVERIFIED"));
    } finally {
      prototype.persist = originalPersist;
    }
  });

  it("reports unknown when accepted private job history cannot drain before the quiesce deadline", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-hosted-history-deadline-"));
    tempDirs.push(staticDir);
    const native = await nativeProject(t, "Hosted history deadline");
    const usageDirectory = resolve(staticDir, "usage");
    const runtime = new InterleavingLifecycleRuntime({ manifests: [], enabled: [], cacheDirectory: resolve(staticDir, "module-cache") });
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(native.store, staticDir, hostedTestPolicy(), controlFetch, runtime, usageDirectory, native.persistence, native.project.id);
    t.after(apiServer.close);
    const createdAt = new Date().toISOString();
    const runningAt = new Date(Date.parse(createdAt) + 1).toISOString();
    const finishedAt = new Date(Date.parse(createdAt) + 2).toISOString();
    const lifecycle = (state: WorkerJobLifecycleSnapshot["state"], updatedAt: string, finishedAtValue: string | null = null): WorkerJobLifecycleSnapshot => ({
      jobId: "job-history-deadline", module: "story", task: "history-deadline", snapshot: { projectId: native.project.id, projectVersion: native.project.version },
      state, createdAt, updatedAt, startedAt: runningAt, finishedAt: finishedAtValue,
    });
    await runtime.emitLifecycle(lifecycle("running", runningAt));
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolveGate) => { releaseTerminal = resolveGate; });
    let terminalPersistStarted!: () => void;
    const terminalStarted = new Promise<void>((resolveStarted) => { terminalPersistStarted = resolveStarted; });
    let barrierStarted!: () => void;
    const barrier = new Promise<void>((resolveStarted) => { barrierStarted = resolveStarted; });
    const prototype = JobHistoryStore.prototype as unknown as {
      persist: (state: unknown) => Promise<void>;
      listJobs: () => Promise<unknown[]>;
    };
    const originalPersist = prototype.persist;
    const originalListJobs = prototype.listJobs;
    prototype.persist = function (state: unknown): Promise<void> {
      const jobs = (state as { jobs?: Array<{ job?: { id?: string; status?: string } }> }).jobs ?? [];
      if (jobs.some((record) => record.job?.id === "job-history-deadline" && record.job.status === "done")) {
        terminalPersistStarted();
        return terminalGate.then(() => originalPersist.call(this, state));
      }
      return originalPersist.call(this, state);
    };
    prototype.listJobs = function (): Promise<unknown[]> {
      barrierStarted();
      return originalListJobs.call(this);
    };
    let terminalCallback: Promise<void> | undefined;
    try {
      terminalCallback = runtime.emitLifecycle(lifecycle("succeeded", finishedAt, finishedAt));
      await terminalStarted;
      const request = {
        operationId: "quiesce-history-deadline",
        instanceId: HOSTED_ASSIGNMENT.instanceId,
        runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
        reason: "migrate private history",
        contractVersion: "scriptorium-platform/v1",
        deadline: new Date(Date.now() + 100).toISOString(),
      };
      const body = JSON.stringify(request);
      const startedAt = Date.now();
      const quiesce = fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtimeControlToken("quiesce", request.operationId, sha256Digest(body))}`,
          "Content-Type": "application/json",
        },
        body,
      });
      await barrier;
      const response = await quiesce;
      assert.equal(response.status, 200);
      const receipt = await response.json() as { disposition: string; reasonCodes: string[] };
      assert.equal(receipt.disposition, "unknown");
      assert.ok(receipt.reasonCodes.includes("PERSISTENCE_UNVERIFIED"));
      assert.ok(Date.now() - startedAt < 2_000, "private-history drain must honor the signed quiesce deadline");
    } finally {
      releaseTerminal();
      prototype.persist = originalPersist;
      prototype.listJobs = originalListJobs;
      await terminalCallback?.catch(() => undefined);
    }
  });

  it("safely quiesces an untouched empty PostgreSQL project using the lifecycle request property order", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-hosted-empty-project-"));
    tempDirs.push(staticDir);
    const native = await nativeProject(t, "Empty hosted project");
    assert.deepEqual((await native.store.readTreeSnapshot(native.project.id)).tree.volumes, [], "the project has no manuscript hierarchy");
    let projectReads = 0;
    const persistence = instrumentPersistence(native.persistence, { onProjectRead: () => { projectReads++; } });
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(native.store, staticDir, hostedTestPolicy(), controlFetch, undefined, undefined, persistence, native.project.id);
    t.after(apiServer.close);

    const statusToken = runtimeControlToken("status", "empty-status", sha256Digest(""));
    const statusResponse = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, { headers: { Authorization: `Bearer ${statusToken}` } });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as { projectId: string; persistence: { state: string; provider: string; projectVersion: number | null } };
    assert.equal(status.projectId, native.project.id);
    assert.equal(status.persistence.state, "verified");
    assert.equal(status.persistence.provider, "postgres");
    assert.equal(status.persistence.projectVersion, native.project.version);
    const projectReadsAfterPreflight = projectReads;

    // This matches Praetorium ControlHttpClient's insertion order exactly.
    const request = {
      operationId: "empty-quiesce",
      instanceId: HOSTED_ASSIGNMENT.instanceId,
      runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      reason: "redeploy",
      contractVersion: "scriptorium-platform/v1",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const body = JSON.stringify(request);
    const quiesceToken = runtimeControlToken("quiesce", request.operationId, sha256Digest(body));
    const quiesced = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${quiesceToken}`, "Content-Type": "application/json" }, body,
    });
    assert.equal(quiesced.status, 200);
    const receipt = await quiesced.json() as { disposition: string; projectVersion: number | null };
    assert.equal(receipt.disposition, "safe");
    assert.equal(receipt.projectVersion, native.project.version);
    assert.ok(projectReads > projectReadsAfterPreflight, "quiesce verifies the empty project's PostgreSQL version after closing admission");

    const resumeToken = runtimeControlToken("resume", request.operationId, sha256Digest(body));
    const resumed = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${resumeToken}`, "Content-Type": "application/json" }, body,
    });
    assert.equal(resumed.status, 204);
  });

  it("keeps health public, protects project data, and serves the app shell", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-"));
    tempDirs.push(staticDir);
    await writeFile(resolve(staticDir, "index.html"), '<meta name="codexia-style-nonce" content="__CODEXIA_STYLE_NONCE__"><h1>Codexia</h1>');
    await Promise.all(["main.js", "api.js", "drafts.js", "styles.css"].map((name) => writeFile(resolve(staticDir, name), name)));
    await writeFile(resolve(staticDir, "server.test.js"), "private test file");
    await mkdir(resolve(staticDir, "assets"));
    await writeFile(resolve(staticDir, "assets", "main-a1b2.js"), "compiled lazy chunk");
    await symlink(resolve(staticDir, "server.test.js"), resolve(staticDir, "assets", "leak-a1b2.js"));
    await mkdir(resolve(staticDir, "oauth", "assets"), { recursive: true });
    await writeFile(resolve(staticDir, "oauth", "oauth-login.html"),
      '<meta name="codexia-style-nonce" content="__CODEXIA_STYLE_NONCE__"><h1>OAuth sign in</h1><link rel="stylesheet" href="/oauth/assets/styles-AbCd1234.css"><script type="module" src="/oauth/assets/login-AbCd1234.js"></script>');
    await writeFile(resolve(staticDir, "oauth", "oauth-consent.html"),
      '<meta name="codexia-style-nonce" content="__CODEXIA_STYLE_NONCE__"><h1>OAuth consent</h1><link rel="stylesheet" href="/oauth/assets/styles-AbCd1234.css"><script type="module" src="/oauth/assets/consent-example-entry.js"></script>');
    await writeFile(resolve(staticDir, "oauth", "assets", "login-AbCd1234.js"), "OAuth login bundle");
    await writeFile(resolve(staticDir, "oauth", "assets", "consent-example-entry.js"), "OAuth consent bundle");
    await writeFile(resolve(staticDir, "oauth", "assets", "styles-AbCd1234.css"), "OAuth-only styles");
    await writeFile(resolve(staticDir, "oauth", "assets", "icon-GhIj9012.svg"), "<svg></svg>");
    await symlink(resolve(staticDir, "server.test.js"), resolve(staticDir, "oauth", "assets", "leak-KlMn3456.js"));
    for (const ui of ["desktop", "mobile"]) {
      await mkdir(resolve(staticDir, ui, "assets"), { recursive: true });
      await writeFile(resolve(staticDir, ui, "index.html"), `<meta name="codexia-style-nonce" content="__CODEXIA_STYLE_NONCE__"><h1>${ui}</h1>`);
      await writeFile(resolve(staticDir, ui, "main.js"), `${ui} bundle`);
      await writeFile(resolve(staticDir, ui, "assets", "chunk.js"), `${ui} chunk`);
    }
    const apiServer = await startApi(staticDir);
    t.after(apiServer.close);

    for (const ui of ["desktop", "mobile"]) {
      for (const route of [`/${ui}`, `/${ui}/`, `/${ui}/writing?project=fixture&scene=s1`, `/${ui}/projects/project.1/scenes/scene.1?volume=volume.1&chapter=chapter.1`]) {
        const page = await fetch(`${apiServer.base}${route}`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), new RegExp(`<h1>${ui}</h1>`));
      assert.ok(page.headers.get("content-security-policy")?.includes("style-src-attr 'unsafe-inline'"));
      assert.ok(!page.headers.get("content-security-policy")?.includes("script-src 'unsafe-inline'"));
      }
      assert.equal(await (await fetch(`${apiServer.base}/${ui}/main.js`)).text(), `${ui} bundle`);
      assert.equal(await (await fetch(`${apiServer.base}/${ui}/assets/chunk.js`)).text(), `${ui} chunk`);
      assert.equal((await fetch(`${apiServer.base}/${ui}/assets/missing.js`)).status, 404);
      assert.equal((await fetch(`${apiServer.base}/${ui}/unknown-route`)).status, 404);
      assert.equal((await fetch(`${apiServer.base}/${ui}/server.test.js`)).status, 404);
    }

    const health = await fetch(`${apiServer.base}/api/health`);
    assert.equal(health.status, 200);
    const healthBody: unknown = await health.json();
    assert.deepEqual(healthBody, { status: "ok" });
    assert.equal(JSON.stringify(healthBody).includes(ACCESS_TOKEN), false);

    const projects = await fetch(`${apiServer.base}/api/projects`);
    assert.equal(projects.status, 401);
    assert.equal((await projects.json() as { code: string }).code, "UNAUTHORIZED");

    const shell = await fetch(`${apiServer.base}/`);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /Codexia/u);
    const nonce = /name="codexia-style-nonce" content="([^"]+)"/u.exec(html)?.[1];
    assert.ok(nonce && nonce !== "__CODEXIA_STYLE_NONCE__");
    assert.ok(shell.headers.get("content-security-policy")?.includes(`style-src 'self' 'nonce-${nonce}'`));
    assert.ok(shell.headers.get("content-security-policy")?.includes("style-src-attr 'unsafe-inline'"));
    assert.ok(!shell.headers.get("content-security-policy")?.includes("script-src 'unsafe-inline'"));
    for (const [path, heading, entry] of [
      ["/oauth/login?oauth_query=opaque", "OAuth sign in", "login-AbCd1234.js"],
      ["/oauth/consent?oauth_query=opaque", "OAuth consent", "consent-example-entry.js"],
    ] as const) {
      const oauthShell = await fetch(`${apiServer.base}${path}`);
      assert.equal(oauthShell.status, 200, `${path} must return its dedicated OAuth entry`);
      assert.match(oauthShell.headers.get("content-type") ?? "", /text\/html/u);
      const oauthHtml = await oauthShell.text();
      assert.ok(oauthHtml.includes(`<h1>${heading}</h1>`));
      assert.ok(oauthHtml.includes(`/oauth/assets/${entry}`));
      assert.ok(oauthHtml.includes("/oauth/assets/styles-AbCd1234.css"));
      assert.ok(!oauthHtml.includes('src="/assets/'));
      assert.ok(!oauthHtml.includes('href="/assets/'));
      const nonce = /name="codexia-style-nonce" content="([^"]+)"/u.exec(oauthHtml)?.[1];
      assert.ok(nonce && nonce !== "__CODEXIA_STYLE_NONCE__");
      assert.ok(oauthShell.headers.get("content-security-policy")?.includes(`style-src 'self' 'nonce-${nonce}'`));
    }
    assert.equal((await fetch(`${apiServer.base}/oauth/login/`)).status, 404);
    assert.equal((await fetch(`${apiServer.base}/oauth/consent/`)).status, 404);
    assert.equal((await fetch(`${apiServer.base}/oauth/oauth-login.html`)).status, 404);
    assert.equal((await fetch(`${apiServer.base}/oauth/unknown`)).status, 404);
    const oauthLoginAsset = await fetch(`${apiServer.base}/oauth/assets/login-AbCd1234.js`);
    assert.equal(await oauthLoginAsset.text(), "OAuth login bundle");
    assert.equal(oauthLoginAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal((await fetch(`${apiServer.base}/oauth/assets/main-a1b2.js`)).status, 404,
      "the dedicated prefix must not expose the generic application asset directory");
    const oauthConsentAsset = await fetch(`${apiServer.base}/oauth/assets/consent-example-entry.js`);
    assert.equal(await oauthConsentAsset.text(), "OAuth consent bundle");
    const oauthStyles = await fetch(`${apiServer.base}/oauth/assets/styles-AbCd1234.css`);
    assert.equal(await oauthStyles.text(), "OAuth-only styles");
    const oauthIcon = await fetch(`${apiServer.base}/oauth/assets/icon-GhIj9012.svg`);
    assert.equal(await oauthIcon.text(), "<svg></svg>");
    assert.equal(oauthIcon.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const oauthMissingAsset = await fetch(`${apiServer.base}/oauth/assets/missing.js`);
    assert.equal(oauthMissingAsset.status, 404);
    assert.equal((await oauthMissingAsset.json() as { code: string }).code, "NOT_FOUND");
    const oauthSymlinkAsset = await fetch(`${apiServer.base}/oauth/assets/leak-KlMn3456.js`);
    assert.equal(oauthSymlinkAsset.status, 404);
    assert.equal((await oauthSymlinkAsset.json() as { code: string }).code, "NOT_FOUND");
    const oauthAssetsDirectory = resolve(staticDir, "oauth", "assets");
    const internalOAuthAssetsDirectory = resolve(staticDir, "oauth", "internal-assets");
    await rename(oauthAssetsDirectory, internalOAuthAssetsDirectory);
    await symlink(internalOAuthAssetsDirectory, oauthAssetsDirectory, "dir");
    const oauthAssetsDirectoryAlias = await fetch(`${apiServer.base}/oauth/assets/login-AbCd1234.js`);
    assert.equal(oauthAssetsDirectoryAlias.status, 404);
    assert.equal((await oauthAssetsDirectoryAlias.json() as { code: string }).code, "NOT_FOUND");
    await rm(oauthAssetsDirectory);
    await rename(internalOAuthAssetsDirectory, oauthAssetsDirectory);
    const oauthDirectory = resolve(staticDir, "oauth");
    const internalOAuthDirectory = resolve(staticDir, "oauth-internal");
    await rename(oauthDirectory, internalOAuthDirectory);
    await symlink(internalOAuthDirectory, oauthDirectory, "dir");
    const oauthDirectoryAlias = await fetch(`${apiServer.base}/oauth/login`);
    assert.equal(oauthDirectoryAlias.status, 404);
    assert.equal((await oauthDirectoryAlias.json() as { code: string }).code, "NOT_FOUND");
    const nextShell = await fetch(`${apiServer.base}/`);
    assert.notEqual(nextShell.headers.get("content-security-policy"), shell.headers.get("content-security-policy"));
    const publicProjectId = randomUUID();
    const publicReader = await fetch(`${apiServer.base}/r/publishing/${publicProjectId}/e2e-invalid-token`);
    assert.equal(publicReader.status, 200, "a structurally valid public reader URL must load the SPA before token validation");
    assert.match(publicReader.headers.get("content-type") ?? "", /text\/html/u);
    assert.equal(publicReader.headers.get("referrer-policy"), "no-referrer");
    assert.equal(publicReader.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.match(await publicReader.text(), /Codexia/u);
    assert.equal((await fetch(`${apiServer.base}/r/unknown/${publicProjectId}/e2e-invalid-token`)).status, 404);
    assert.equal((await fetch(`${apiServer.base}/r/publishing/not-numeric/e2e-invalid-token`)).status, 404);
    assert.equal((await fetch(`${apiServer.base}/r/publishing/${publicProjectId}/e2e-invalid-token/extra`)).status, 404);
    assert.equal((await fetch(`${apiServer.base}/r/publishing/123/e2e-invalid-token`)).status, 404);
    const owner = signedRequests.ownerHeaders();
    assert.equal((await fetch(`${apiServer.base}/api/no-such-route`, { headers: { Authorization: owner.Authorization } })).status, 404,
      "the SPA fallback must not turn missing API routes into index.html");
    for (const name of ["main.js", "api.js", "drafts.js", "styles.css"]) {
      assert.equal((await fetch(`${apiServer.base}/${name}`)).status, 200);
    }
    const chunk = await fetch(`${apiServer.base}/assets/main-a1b2.js`);
    assert.equal(chunk.status, 200);
    assert.match(chunk.headers.get("content-type") ?? "", /javascript/u);
    assert.equal(await (await fetch(`${apiServer.base}/assets/leak-a1b2.js`)).json().then((body: unknown) => (body as { code: string }).code), "NOT_FOUND");
    assert.equal((await fetch(`${apiServer.base}/server.test.js`)).status, 404);
  });

  it("keeps fixed UI aliases fresh while caching only content-hashed JS and CSS", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-static-manifest-"));
    tempDirs.push(staticDir);
    await writeFile(resolve(staticDir, "server.test.js"), "private test file");
    const fixtures = new Map<string, { entry: string; stylesheet: string; scriptBody: string; styleBody: string }>();
    for (const ui of ["launcher", "desktop", "mobile"] as const) {
      const uiRoot = ui === "launcher" ? staticDir : resolve(staticDir, ui);
      const prefix = ui === "launcher" ? "" : `/${ui}`;
      const suffix = ui === "launcher" ? "a1B2c3D4" : ui === "desktop" ? "e5F6g7H8" : "i9J0k1L2";
      const entry = `main-${suffix}.js`;
      const stylesheet = `styles-${suffix}.css`;
      const scriptBody = `${ui} hashed bundle`;
      const styleBody = `${ui} hashed styles`;
      await Promise.all([
        mkdir(resolve(uiRoot, ".vite"), { recursive: true }),
        mkdir(resolve(uiRoot, "assets"), { recursive: true }),
      ]);
      await writeFile(resolve(uiRoot, "index.html"),
        `<meta name="codexia-style-nonce" content="__CODEXIA_STYLE_NONCE__"><link rel="stylesheet" href="${prefix}/assets/${stylesheet}"><script type="module" src="${prefix}/assets/${entry}"></script>`);
      await writeFile(resolve(uiRoot, "main.js"), `${ui} legacy bundle`);
      await writeFile(resolve(uiRoot, "styles.css"), `${ui} legacy styles`);
      await writeFile(resolve(uiRoot, "assets", entry), scriptBody);
      await writeFile(resolve(uiRoot, "assets", stylesheet), styleBody);
      await writeFile(resolve(uiRoot, "assets", "chunk.js"), `${ui} unhashed chunk`);
      await writeFile(resolve(uiRoot, ".vite", "manifest.json"), JSON.stringify({
        "index.html": { file: `assets/${entry}`, src: "index.html", isEntry: true },
        "style.css": { file: `assets/${stylesheet}`, src: "style.css" },
      }));
      fixtures.set(ui, { entry, stylesheet, scriptBody, styleBody });
    }
    await symlink(resolve(staticDir, "server.test.js"), resolve(staticDir, "assets", "leak-LeakHa12.js"));

    const apiServer = await startApi(staticDir);
    t.after(apiServer.close);
    for (const [ui, fixture] of fixtures) {
      const prefix = ui === "launcher" ? "" : `/${ui}`;
      const route = `${prefix}/`;
      const shell = await fetch(`${apiServer.base}${route}`);
      const shellHtml = await shell.text();
      const nonce = /name="codexia-style-nonce" content="([^"]+)"/u.exec(shellHtml)?.[1];
      assert.equal(shell.status, 200);
      assert.equal(shell.headers.get("cache-control"), "no-store");
      assert.ok(nonce && nonce !== "__CODEXIA_STYLE_NONCE__");
      assert.ok(shell.headers.get("content-security-policy")?.includes(`style-src 'self' 'nonce-${nonce}'`));
      assert.ok(shell.headers.get("content-security-policy")?.includes("style-src-attr 'unsafe-inline'"));
      assert.ok(shellHtml.includes(`src="${prefix}/assets/${fixture.entry}"`));
      assert.ok(shellHtml.includes(`href="${prefix}/assets/${fixture.stylesheet}"`));
      const nextShell = await fetch(`${apiServer.base}${route}`);
      assert.notEqual(nextShell.headers.get("content-security-policy"), shell.headers.get("content-security-policy"));
      assert.equal(nextShell.headers.get("cache-control"), "no-store");

      const jsAsset = await fetch(`${apiServer.base}${prefix}/assets/${fixture.entry}`);
      assert.equal(jsAsset.status, 200);
      assert.equal(await jsAsset.text(), fixture.scriptBody);
      assert.equal(jsAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
      const cssAsset = await fetch(`${apiServer.base}${prefix}/assets/${fixture.stylesheet}`);
      assert.equal(cssAsset.status, 200);
      assert.equal(await cssAsset.text(), fixture.styleBody);
      assert.equal(cssAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");

      const jsAlias = await fetch(`${apiServer.base}${prefix}/main.js`);
      assert.equal(await jsAlias.text(), fixture.scriptBody, `${ui} fixed script URL resolves the active manifest`);
      assert.equal(jsAlias.headers.get("cache-control"), "no-store");
      const cssAlias = await fetch(`${apiServer.base}${prefix}/styles.css`);
      assert.equal(await cssAlias.text(), fixture.styleBody, `${ui} fixed stylesheet URL resolves the active manifest`);
      assert.equal(cssAlias.headers.get("cache-control"), "no-store");
      const unhashed = await fetch(`${apiServer.base}${prefix}/assets/chunk.js`);
      assert.equal(unhashed.headers.get("cache-control"), "no-store");
      assert.equal((await fetch(`${apiServer.base}${prefix}/assets/stale-Ab1Cd2Ef.js`)).status, 404);
    }

    const symlinkResponse = await fetch(`${apiServer.base}/assets/leak-LeakHa12.js`);
    assert.equal(symlinkResponse.status, 404);
    assert.equal((await symlinkResponse.json() as { code: string }).code, "NOT_FOUND");
    assert.equal(symlinkResponse.headers.get("cache-control"), "no-store");

    const launcherAssets = resolve(staticDir, "assets");
    const internalAssets = resolve(staticDir, "internal-assets");
    await rename(launcherAssets, internalAssets);
    await symlink(internalAssets, launcherAssets, "dir");
    for (const alias of ["/main.js", "/styles.css"]) {
      const aliasResponse = await fetch(`${apiServer.base}${alias}`);
      assert.equal(aliasResponse.status, 404, `${alias} rejects a manifest target beneath a symlinked assets directory`);
      assert.equal((await aliasResponse.json() as { code: string }).code, "NOT_FOUND");
    }
    await rm(launcherAssets);
    await rename(internalAssets, launcherAssets);

    await writeFile(resolve(staticDir, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { file: "../server.test.js", src: "index.html", isEntry: true },
      "style.css": { file: "../server.test.js", src: "style.css" },
    }));
    const unsafeAlias = await fetch(`${apiServer.base}/main.js`);
    assert.equal(await unsafeAlias.text(), "launcher legacy bundle", "an unsafe manifest path cannot expose a private file");
    assert.equal(unsafeAlias.headers.get("cache-control"), "no-store");

    await writeFile(resolve(staticDir, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { file: "main.js", src: "index.html", isEntry: true },
      "style.css": { file: "styles.css", src: "style.css" },
    }));
    const rollbackAlias = await fetch(`${apiServer.base}/main.js`);
    assert.equal(await rollbackAlias.text(), "launcher legacy bundle", "a legacy manifest remains usable after rollback");
    assert.equal(rollbackAlias.headers.get("cache-control"), "no-store");
  });

  it("stores bounded immutable model usage with complete paginated history and no symlink traversal", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-api-model-history-"));
    tempDirs.push(root);
    const usageDirectory = resolve(root, "host-history");
    const unusedDirectory = resolve(root, "unused-history");
    assert.deepEqual(await new HistoricalModelUsageStore(unusedDirectory).list(SNAPSHOT.projectId), { events: [] });
    await assert.rejects(lstat(unusedDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "an empty history read must not create host storage");
    const store = new HistoricalModelUsageStore(usageDirectory);
    const first = usageEvent(SNAPSHOT.projectId, "usage-1", "2026-10-17T00:00:00.000Z", {
      cacheHit: true, promptVersion: "rewrite@1", durationMs: 217, queueWaitMs: 18,
    });
    const second = usageEvent(SNAPSHOT.projectId, "usage-2", "2026-10-17T00:00:02.000Z", { state: "aborted", errorCode: "request_cancelled" });
    const third = usageEvent(SNAPSHOT.projectId, "usage-3", "2026-10-17T00:00:04.000Z");
    await Promise.all([store.append(first), store.append(first), store.append(second), store.append(third)]);

    const pageOne = await store.list(SNAPSHOT.projectId, { limit: 2 });
    assert.deepEqual(pageOne.events.map(({ id }) => id), [first.id, second.id]);
    assert.deepEqual(pageOne.events[0], first, "source cache and prompt/timing metadata survive append and list");
    assert.ok(pageOne.nextCursor);
    const pageTwo = await store.list(SNAPSHOT.projectId, { limit: 2, cursor: pageOne.nextCursor });
    assert.deepEqual(pageTwo.events.map(({ id }) => id), [third.id]);
    assert.equal(pageTwo.nextCursor, undefined);
    const ranged = await store.list(SNAPSHOT.projectId, { from: second.startedAt, to: third.startedAt, limit: 10 });
    assert.deepEqual(ranged.events.map(({ id }) => id), [second.id, third.id]);
    await assert.rejects(store.list(SNAPSHOT.projectId, { limit: 1_001 }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_query_invalid");
    await assert.rejects(store.append({ ...first, outputTokens: 9 }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_id_conflict");
    await assert.rejects(store.append({ ...first, cacheHit: false }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_id_conflict");
    for (const invalid of [
      { cacheHit: "true" },
      { promptVersion: "v1\nprivate prompt" },
      { promptVersion: "v".repeat(129) },
      { durationMs: Number.POSITIVE_INFINITY },
      { durationMs: -1 },
      { durationMs: 86_400_001 },
      { queueWaitMs: Number.NaN },
      { queueWaitMs: -1 },
      { queueWaitMs: 86_400_001 },
    ]) {
      await assert.rejects(store.append({ ...first, id: `invalid-${Object.keys(invalid)[0]}`, ...invalid } as ModelUsageEvent),
        (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_invalid");
    }
    await assert.rejects(store.append({
      ...first, prompt: "private prompt", headers: { Authorization: "secret" }, key: "private key", body: "private body",
    } as ModelUsageEvent), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_invalid");

    const reopened = new HistoricalModelUsageStore(usageDirectory);
    assert.deepEqual((await reopened.list(SNAPSHOT.projectId, { limit: 10 })).events, [first, second, third],
      "source cache and prompt/timing metadata survive reopening the host-owned store");

    const alias = resolve(root, "history-alias");
    await symlink(usageDirectory, alias, "dir");
    await assert.rejects(new HistoricalModelUsageStore(alias).list(SNAPSHOT.projectId), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_path_invalid");
  });

  it("keeps accepted offset timestamps readable and rejects normalized dates outside the stored format", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-api-model-history-offsets-"));
    tempDirs.push(root);
    const store = new HistoricalModelUsageStore(resolve(root, "host-history"));
    const offsetEvent = usageEvent(SNAPSHOT.projectId, "offset-event", "2026-10-17T01:00:00+01:00");
    await store.append({ ...offsetEvent, completedAt: "2026-10-17T01:00:01+01:00" });
    assert.deepEqual((await store.list(SNAPSHOT.projectId)).events, [{
      ...offsetEvent,
      startedAt: "2026-10-17T00:00:00.000Z",
      completedAt: "2026-10-17T00:00:01.000Z",
    }]);

    await assert.rejects(store.append({
      ...offsetEvent, id: "year-underflow", startedAt: "0000-01-01T00:00:00+01:00", completedAt: "0000-01-01T00:00:01+01:00",
    }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_invalid");
    await assert.rejects(store.append({
      ...offsetEvent, id: "year-overflow", startedAt: "9999-12-31T23:59:59-01:00", completedAt: "9999-12-31T23:59:59-01:00",
    }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_invalid");
    await assert.rejects(store.append({
      ...offsetEvent, id: "invalid-calendar-day", startedAt: "2026-02-30T00:00:00Z", completedAt: "2026-02-30T00:00:01Z",
    }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_invalid");
  });

  it("stores only bounded worker lifecycle metadata and durable completion inbox state", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-api-job-history-"));
    tempDirs.push(root);
    const usageDirectory = resolve(root, "host-history");
    const store = new JobHistoryStore(usageDirectory);
    await assert.rejects(lstat(usageDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "construction must not touch host history");
    const base = {
      module: "assistant",
      task: "draft.story",
      snapshot: SNAPSHOT,
      createdAt: "2026-10-17T02:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    } satisfies Pick<WorkerJobLifecycle, "module" | "task" | "snapshot" | "createdAt" | "startedAt" | "finishedAt">;
    const queued: WorkerJobLifecycle = { ...base, jobId: "worker-job-1", state: "queued", updatedAt: base.createdAt };
    assert.deepEqual(await store.record(queued), {
      type: "job-status", jobId: "worker-job-1", jobType: "assistant.draft.story", status: "queued", progress: null, at: base.createdAt,
    });
    const running: WorkerJobLifecycle = { ...queued, state: "running", startedAt: "2026-10-17T02:00:01.000Z", updatedAt: "2026-10-17T02:00:01.000Z" };
    await store.record(running);
    const finished: WorkerJobLifecycle = {
      ...running, state: "failed", updatedAt: "2026-10-17T02:00:02.000Z", finishedAt: "2026-10-17T02:00:02.000Z", errorCode: "worker_failed",
    };
    const event = await store.record(finished);
    assert.deepEqual(event, {
      type: "job-status", jobId: "worker-job-1", jobType: "assistant.draft.story", status: "error", progress: null,
      error: "worker_failed", at: "2026-10-17T02:00:02.000Z",
    });
    assert.deepEqual(await store.listJobs(), [{
      id: "worker-job-1", type: "assistant.draft.story", status: "error", progress: null, result: null, error: "worker_failed",
      createdAt: "2026-10-17T02:00:00.000Z", updatedAt: "2026-10-17T02:00:02.000Z", finishedAt: "2026-10-17T02:00:02.000Z",
    }]);
    const inbox = await store.listInbox({ unreadOnly: true });
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.unreadCount, 1);
    assert.equal(inbox.items[0]?.body, "The job failed (worker_failed).");
    assert.equal(inbox.items[0]?.projectKey.includes(SNAPSHOT.projectId), false);
    const stateText = await readFile(resolve(usageDirectory, "jobs", "jobs-state.json"), "utf8");
    for (const secret of ["private-project-title", "private-owner-scope", ACCESS_TOKEN, "prompt-secret", "result-secret", "worker error text"]) {
      assert.equal(stateText.includes(secret), false, `host history must not contain ${secret}`);
    }
    assert.equal(stateText.includes('"progress":null'), true);
    assert.equal(stateText.includes('"result":null'), true);
    assert.equal(stateText.includes('"type":"assistant.draft.story"'), true);
    await assert.rejects(store.record({ ...finished, errorCode: undefined, errorMessage: "worker error text" } as unknown as WorkerJobLifecycle),
      (error: unknown) => error instanceof JobHistoryError && error.code === "job_event_invalid");
    const reloaded = new JobHistoryStore(usageDirectory);
    assert.deepEqual(await reloaded.getJob("worker-job-1"), (await store.getJob("worker-job-1")));
    assert.equal(await reloaded.markAllInboxRead(), 1);
    assert.deepEqual(await new JobHistoryStore(usageDirectory).listInbox({ unreadOnly: true }), { items: [], unreadCount: 0 });
    await assert.rejects(reloaded.record({ ...queued, snapshot: { ...SNAPSHOT, projectId: "another-project" } }),
      (error: unknown) => error instanceof JobHistoryError && error.code === "job_identity_conflict");
  });

  it("retains exact declared domain action data and machine errors across host-history reopen", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-api-domain-job-history-"));
    tempDirs.push(root);
    const usageDirectory = resolve(root, "history");
    const store = new JobHistoryStore(usageDirectory);
    const success: ActionResult = {
      ok: true, snapshot: SNAPSHOT,
      data: { report: { examples: 3, accuracy: 0.75 }, proposalId: "speaker-proposal-1" },
    };
    const queued = await store.beginDomainJob({ id: "domain-job-success", type: "speaker-eval", projectId: SNAPSHOT.projectId });
    assert.equal(queued.status, "queued");
    assert.equal(queued.progress, 0);
    const running = await store.markDomainJobRunning("domain-job-success");
    assert.equal(running.status, "running");
    assert.deepEqual(await store.reportDomainJobProgress("domain-job-success", 0.4), {
      type: "job-progress", jobId: "domain-job-success", jobType: "speaker-eval", status: "running", progress: 0.4,
      at: (await store.getJob("domain-job-success"))!.updatedAt,
    });
    const regressed = await store.reportDomainJobProgress("domain-job-success", 0.1);
    assert.equal(regressed?.type, "job-progress", "source progress may report a lower value in a later phase");
    assert.equal(regressed?.progress, 0.1);
    assert.equal(await store.reportDomainJobProgress("domain-job-success", 1.5).then((event) => event?.progress), 1,
      "finite source progress is bounded to the source 0–1 range");
    assert.equal(await store.reportDomainJobProgress("domain-job-success", 1), null, "identical progress may be coalesced");
    await assert.rejects(store.reportDomainJobProgress("domain-job-success", Number.NaN),
      (error: unknown) => error instanceof JobHistoryError && error.code === "job_progress_invalid");
    assert.equal((await store.finishDomainJob("domain-job-success", success)).status, "done");

    const failed: ActionResult = {
      ok: false, snapshot: SNAPSHOT,
      error: { code: "aspect_scope_invalid", message: "The selected chapter has no scenes", retryable: false },
    };
    await store.beginDomainJob({ id: "domain-job-error", type: "aspect-review", projectId: SNAPSHOT.projectId });
    await store.markDomainJobRunning("domain-job-error");
    assert.equal((await store.finishDomainJob("domain-job-error", failed)).status, "error");

    const reopened = new JobHistoryStore(usageDirectory);
    assert.deepEqual(await reopened.getJob("domain-job-success"), {
      id: "domain-job-success", type: "speaker-eval", status: "done", progress: 1,
      result: success.data, error: null,
      createdAt: (await store.getJob("domain-job-success"))!.createdAt,
      updatedAt: (await store.getJob("domain-job-success"))!.updatedAt,
      finishedAt: (await store.getJob("domain-job-success"))!.finishedAt,
    });
    assert.deepEqual(await reopened.getJob("domain-job-error"), await store.getJob("domain-job-error"));
    const failedJob = await reopened.getJob("domain-job-error");
    assert.equal(failedJob?.error, failed.error.message);
    assert.equal(failedJob?.errorCode, failed.error.code);
    assert.equal(failedJob?.retryable, false);
    await store.beginDomainJob({ id: "domain-job-interrupted", type: "speaker-retrain", projectId: SNAPSHOT.projectId });
    await store.markDomainJobRunning("domain-job-interrupted");
    await store.reportDomainJobProgress("domain-job-interrupted", 0.42);
    assert.equal((await reopened.listInbox()).unreadCount, 2);
    const afterRestart = new JobHistoryStore(usageDirectory);
    const interrupted = await afterRestart.getJob("domain-job-interrupted");
    assert.equal(interrupted?.status, "error", "an active target task becomes a non-replayed interruption after a store restart");
    assert.equal(interrupted?.errorCode, "worker_interrupted");
    assert.equal(interrupted?.progress, 0.42, "the latest fractional progress survives a host-history restart");
  });

  it("tracks exact source job results through direct actions and nested HTTP MCP invokes", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-api-domain-job-runtime-"));
    tempDirs.push(root);
    const staticDir = resolve(root, "static");
    await mkdir(staticDir);
    const usageDirectory = resolve(root, "history");
    const domain = sourceDomainJobRuntime(resolve(root, "module-cache"));
    const api = await startCustomApi(makeSnapshotStore().store, staticDir, {
      runtime: domain.runtime,
      usageDirectory,
    });
    const owner = signedRequests.ownerHeaders();
    const ownerHeaders = { Authorization: owner.Authorization, Origin: api.base, "Content-Type": "application/json" };
    const expectedData = { report: { examples: 3, accuracy: 0.75 }, version: "synthetic-v1" };
    let progressAbort: AbortController | undefined;
    let progressReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let progressEventsTask: Promise<Array<{ type: string; jobId: string; jobType: string; status: string; progress: number; at: string }>> | undefined;
    t.after(async () => {
      domain.releaseAsync();
      progressAbort?.abort();
      await progressReader?.cancel().catch(() => undefined);
      await progressEventsTask?.catch(() => undefined);
      await api.close();
    });
    progressAbort = new AbortController();
    const progressResponse = await fetch(`${api.base}/api/jobs/events`, {
      headers: { Authorization: owner.Authorization }, signal: progressAbort.signal,
    });
    assert.equal(progressResponse.status, 200);
    assert.ok(progressResponse.body);
    progressReader = progressResponse.body.getReader();
    progressEventsTask = (async () => {
      const decoder = new TextDecoder();
      const events: Array<{ type: string; jobId: string; jobType: string; status: string; progress: number; at: string }> = [];
      let buffer = "";
      while (events.length < 5) {
        const { value, done } = await progressReader!.read();
        if (done) throw new Error("The owner job event stream closed before all progress events arrived");
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (!data) continue;
          const event = JSON.parse(data) as { type: string; jobId: string; jobType: string; status: string; progress: number; at: string };
          if (event.type === "job-progress") events.push(event);
        }
      }
      return events;
    })();

    const directResponse = await fetch(`${api.base}/api/projects/project-1/actions/speaker.evaluation.run`, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ input: { requestSecret: "must-not-be-captured", progress: [0.7] } }),
    });
    assert.equal(directResponse.status, 200);
    const directJobId = directResponse.headers.get("x-codexia-job-id");
    assert.ok(directJobId);
    const directResult = await directResponse.json() as ActionResult;
    assert.deepEqual(directResult, { ok: true, snapshot: SNAPSHOT, data: expectedData });
    const directJobResponse = await fetch(`${api.base}/api/jobs/${directJobId}`, { headers: { Authorization: owner.Authorization } });
    assert.equal(directJobResponse.status, 200);
    const directJob = await directJobResponse.json() as { status: string; result: unknown };
    assert.equal(directJob.status, "done");
    assert.deepEqual(directJob.result, expectedData);

    const nestedResponse = await fetch(`${api.base}/api/projects/project-1/modules/mcp/invoke`, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ nested: true, progress: [0.4, 0.1] }),
    });
    assert.equal(nestedResponse.status, 200);
    const nestedJobId = nestedResponse.headers.get("x-codexia-job-id");
    assert.ok(nestedJobId);
    assert.notEqual(nestedJobId, directJobId);
    assert.deepEqual(await nestedResponse.json(), { ok: true, snapshot: SNAPSHOT, data: expectedData });
    const nestedJobResponse = await fetch(`${api.base}/api/jobs/${nestedJobId}`, { headers: { Authorization: owner.Authorization } });
    assert.deepEqual((await nestedJobResponse.json() as { result: unknown }).result, expectedData);

    const failedResponse = await fetch(`${api.base}/api/projects/project-1/actions/speaker.evaluation.run`, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ input: { fail: true } }),
    });
    assert.equal(failedResponse.status, 200);
    const failedJobId = failedResponse.headers.get("x-codexia-job-id");
    assert.ok(failedJobId);
    const failedResult = await failedResponse.json() as Extract<ActionResult, { ok: false }>;
    const failedJobResponse = await fetch(`${api.base}/api/jobs/${failedJobId}`, { headers: { Authorization: owner.Authorization } });
    const failedJob = await failedJobResponse.json() as { status: string; result: unknown; error: string; errorCode?: string; retryable?: boolean };
    assert.equal(failedJob.status, "error");
    assert.equal(failedJob.result, null);
    assert.equal(failedJob.error, failedResult.error.message);
    assert.equal(failedJob.errorCode, failedResult.error.code);
    assert.equal(failedJob.retryable, true);

    const asyncResponsePromise = fetch(`${api.base}/api/projects/project-1/actions/speaker.evaluation.run`, {
      method: "POST", headers: { ...ownerHeaders, Prefer: "respond-async" },
      body: JSON.stringify({ input: { wait: true, progress: [0.05, 1.5] } }),
    });
    const asyncResponse = await asyncResponsePromise;
    assert.equal(asyncResponse.status, 202);
    assert.equal(asyncResponse.headers.get("preference-applied"), "respond-async");
    const asyncJobId = asyncResponse.headers.get("x-codexia-job-id");
    assert.ok(asyncJobId);
    assert.equal((await asyncResponse.json() as { id: string }).id, asyncJobId);
    await domain.asyncStarted;
    const progressEvents = await progressEventsTask;
    assert.deepEqual(progressEvents.map(({ jobId, progress }) => [jobId, progress]), [
      [directJobId, 0.7], [nestedJobId, 0.4], [nestedJobId, 0.1], [asyncJobId, 0.05], [asyncJobId, 1],
    ], "SSE progress keeps source fractions, phase regressions, clamped values, and exact direct/nested job IDs");
    assert.ok(progressEvents.every(({ type, jobType, status, at }) => type === "job-progress" && jobType === "speaker-eval" && status === "running" && Date.parse(at) > 0));
    progressAbort.abort();
    await progressReader.cancel().catch(() => undefined);
    const runningJobResponse = await fetch(`${api.base}/api/jobs/${asyncJobId}`, { headers: { Authorization: owner.Authorization } });
    assert.equal(runningJobResponse.status, 200);
    assert.equal((await runningJobResponse.json() as { status: string }).status, "running");
    domain.releaseAsync();
    const completedAsync = await waitForJob(api.base, owner.Authorization, asyncJobId);
    assert.equal(completedAsync.status, "done");
    assert.deepEqual(completedAsync.result, expectedData);

    const reopenedHistory = new JobHistoryStore(usageDirectory);
    const retained = await reopenedHistory.listJobs();
    assert.equal(retained.length, 4, "direct, nested, failed, and async actions each register exactly one host job");
    assert.deepEqual((await reopenedHistory.getJob(directJobId))?.result, expectedData, "the exact action result remains owner-readable after host-history reopen");
    assert.deepEqual((await reopenedHistory.getJob(nestedJobId))?.result, expectedData, "nested MCP results remain owner-readable after host-history reopen");
    const inbox = await new JobHistoryStore(usageDirectory).listInbox();
    assert.equal(inbox.items.length, 1, "unread completion inbox items coalesce by job type and PostgreSQL project");
    assert.equal(inbox.items[0]?.jobId, asyncJobId);
    const historyBytes = await readFile(resolve(usageDirectory, "jobs", "jobs-state.json"), "utf8");
    assert.equal(historyBytes.includes("must-not-be-captured"), false, "action input is not retained as job history");
  });

  it("archives exact legacy jobs outside Core data and exposes only explicitly mapped owner history", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-api-legacy-jobs-"));
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-legacy-jobs-app-"));
    tempDirs.push(root, staticDir);
    const workspaceDataRoot = resolve(root, "core-data");
    const appState = resolve(workspaceDataRoot, "app-state");
    const usageDirectory = resolve(root, "history");
    await mkdir(appState, { recursive: true, mode: 0o700 });
    const legacyState = {
      jobs: [
        {
          id: "mapped-job", type: "speaker-eval", status: "done", progress: 1,
          result: { report: "explicitly mapped result" }, error: null,
          projectKey: "legacy-project-id", userId: "legacy-owner-id",
          createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:01:00.000Z", finishedAt: "2026-10-16T00:01:00.000Z",
        },
        {
          id: "unmapped-job", type: "zukan-proposal", status: "error", progress: null,
          result: { secretBody: "unmapped result stays private" }, error: "unmapped error stays private",
          projectKey: "unknown-project-id", userId: "unknown-user-id",
          createdAt: "2026-10-16T01:00:00.000Z", updatedAt: "2026-10-16T01:01:00.000Z", finishedAt: "2026-10-16T01:01:00.000Z",
        },
      ],
      inbox: [
        {
          id: "mapped-inbox", kind: "job-complete", jobId: "mapped-job", jobType: "speaker-eval",
          title: "Mapped report", body: "Mapped inbox result body", status: "done", read: false,
          userId: "legacy-owner-id", projectKey: "legacy-project-id", createdAt: "2026-10-16T00:01:00.000Z",
        },
        {
          id: "unmapped-inbox", kind: "job-complete", jobId: "unmapped-job", jobType: "zukan-proposal",
          title: "Unmapped title", body: "unmapped inbox body stays private", status: "error", read: false,
          userId: "unknown-user-id", projectKey: "unknown-project-id", createdAt: "2026-10-16T01:01:00.000Z",
        },
      ],
    };
    const sourcePath = resolve(appState, "jobs-state.json");
    const sourceBytes = Buffer.from(JSON.stringify(legacyState), "utf8");
    await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    const report = await importLegacyJobHistory({
      workspaceDataRoot,
      usageDirectory,
      legacyProjectMappings: { "legacy-project-id": SNAPSHOT.projectId },
      legacyUserMappings: { "legacy-owner-id": "owner" },
    });
    assert.equal(report.archived, true);
    assert.equal(report.adoptedJobs, 1);
    assert.equal(report.adoptedInbox, 1);
    assert.deepEqual(report.mappingRequired, [{
      projectKey: "unknown-project-id", userId: "unknown-user-id", jobCount: 1, inboxCount: 1,
    }]);
    assert.equal(JSON.stringify(report).includes("unmapped result stays private"), false);
    const archivePath = resolve(usageDirectory, "jobs", "legacy", `${report.sourceHash}.json`);
    assert.deepEqual(await readFile(archivePath), sourceBytes, "the hash-addressed host archive retains the exact source bytes");
    assert.deepEqual(await readFile(sourcePath), sourceBytes, "migration leaves the source jobs file untouched");
    const retry = await importLegacyJobHistory({
      workspaceDataRoot,
      usageDirectory,
      legacyProjectMappings: { "legacy-project-id": SNAPSHOT.projectId },
      legacyUserMappings: { "legacy-owner-id": "owner" },
    });
    assert.equal(retry.sourceHash, report.sourceHash);
    assert.equal(retry.adoptedJobs, 0, "a repeated import must not duplicate mapped jobs");
    assert.equal(retry.adoptedInbox, 0, "a repeated import must not duplicate inbox entries");

    await rm(workspaceDataRoot, { recursive: true, force: true });
    const apiServer = await startCustomApi(makeStore(), staticDir, { usageDirectory });
    t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const bearer = { Authorization: signedRequests.mcpHeaders().Authorization };
    assert.equal((await fetch(`${apiServer.base}/api/jobs`, { headers: bearer })).status, 403,
      "legacy private history is cookie-owner-only");
    const jobListResponse = await fetch(`${apiServer.base}/api/jobs`, { headers: { Authorization: owner.Authorization } });
    assert.equal(jobListResponse.status, 200);
    assert.deepEqual(await jobListResponse.json(), [{
      id: "mapped-job", type: "speaker-eval", status: "done", progress: 1,
      result: { report: "explicitly mapped result" }, error: null,
      createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:01:00.000Z", finishedAt: "2026-10-16T00:01:00.000Z",
    }]);
    const mappedJob = await fetch(`${apiServer.base}/api/jobs/mapped-job`, { headers: { Authorization: owner.Authorization } });
    assert.equal(mappedJob.status, 200);
    assert.deepEqual(await mappedJob.json(), {
      id: "mapped-job", type: "speaker-eval", status: "done", progress: 1,
      result: { report: "explicitly mapped result" }, error: null,
      createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:01:00.000Z", finishedAt: "2026-10-16T00:01:00.000Z",
    });
    assert.equal((await fetch(`${apiServer.base}/api/jobs/unmapped-job`, { headers: { Authorization: owner.Authorization } })).status, 404);
    const inbox = await fetch(`${apiServer.base}/api/inbox`, { headers: { Authorization: owner.Authorization } });
    const inboxBody = await inbox.json() as { items: Array<Record<string, unknown>>; unreadCount: number };
    assert.equal(inboxBody.unreadCount, 1);
    assert.equal(inboxBody.items.length, 1);
    assert.deepEqual(inboxBody.items[0], {
      id: "mapped-inbox", kind: "job-complete", jobId: "mapped-job", jobType: "speaker-eval",
      title: "Mapped report", body: "Mapped inbox result body", status: "done", read: false,
      userId: "owner",
      projectKey: createHash("sha256").update(`postgres-project\0${SNAPSHOT.projectId}`).digest("hex"),
      createdAt: "2026-10-16T00:01:00.000Z",
    });
    assert.equal(JSON.stringify(inboxBody).includes("unmapped inbox body stays private"), false);
    const markRead = await fetch(`${apiServer.base}/api/inbox/mapped-inbox/read`, {
      method: "POST", headers: { Authorization: owner.Authorization, Origin: apiServer.base },
    });
    assert.equal(markRead.status, 200);
    assert.equal(((await markRead.json() as { item: { read: boolean } }).item).read, true);
    const readAll = await fetch(`${apiServer.base}/api/inbox/read-all`, {
      method: "POST", headers: { Authorization: owner.Authorization, Origin: apiServer.base },
    });
    assert.deepEqual(await readAll.json(), { marked: 0 });
    assert.equal((await fetch(`${apiServer.base}/api/inbox/unmapped-inbox/read`, {
      method: "POST", headers: { Authorization: owner.Authorization, Origin: apiServer.base },
    })).status, 404);
    assert.deepEqual(await readFile(archivePath), sourceBytes, "removing the Core data root cannot remove or mutate the legacy archive");
  });

  it("publishes real supervised worker jobs through owner-only history routes and SSE", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-worker-history-app-"));
    const cacheDirectory = await mkdtemp(resolve(tmpdir(), "codexia-api-worker-history-cache-"));
    const usageDirectory = await mkdtemp(resolve(tmpdir(), "codexia-api-worker-history-store-"));
    tempDirs.push(staticDir, cacheDirectory, usageDirectory);
    const runtime = jobHistoryRuntime(cacheDirectory);
    const apiServer = await startCustomApi(makeSnapshotStore().store, staticDir, { runtime, usageDirectory });
    t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const streamAbort = new AbortController();
    const stream = await fetch(`${apiServer.base}/api/jobs/events`, { headers: { Authorization: owner.Authorization }, signal: streamAbort.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/u);
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    const eventRead = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      const events: Array<{ type: string; jobId: string; status: string }> = [];
      const timeout = setTimeout(() => { void reader.cancel(); }, 15_000);
      try {
        while (!events.some((event) => event.jobId === "real-worker-job" && (event.status === "done" || event.status === "error"))) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (data) events.push(JSON.parse(data) as { type: string; jobId: string; status: string });
          }
        }
      } finally { clearTimeout(timeout); }
      return events;
    })();
    const invocation = await fetch(`${apiServer.base}/api/projects/project-1/actions/speaker.test-worker`, {
      method: "POST",
      headers: { Authorization: owner.Authorization, Origin: apiServer.base, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { jobId: "real-worker-job" } }),
    });
    assert.equal(invocation.status, 200);
    const response = await invocation.json() as ActionResult;
    assert.equal(response.ok, true);
    assert.equal(response.ok && (response.data as { ok?: boolean }).ok, true,
      `the actual supervised worker request must succeed: ${JSON.stringify(response)}`);
    const events = await eventRead;
    streamAbort.abort();
    await reader.cancel().catch(() => undefined);
    assert.deepEqual(events.map(({ status }) => status), ["queued", "running", "done"]);
    const jobResponse = await fetch(`${apiServer.base}/api/jobs/real-worker-job`, { headers: { Authorization: owner.Authorization } });
    assert.equal(jobResponse.status, 200);
    const job = await jobResponse.json() as { id: string; type: string; status: string; progress: unknown; result: unknown; error: unknown; createdAt: string; updatedAt: string; finishedAt: string };
    assert.deepEqual({ ...job, createdAt: "", updatedAt: "", finishedAt: "" }, {
      id: "real-worker-job", type: "speaker.echo", status: "done", progress: null, result: null, error: null,
      createdAt: "", updatedAt: "", finishedAt: "",
    });
    for (const timestamp of [job.createdAt, job.updatedAt, job.finishedAt]) assert.ok(Date.parse(timestamp) > 0);
    const privateState = await readFile(resolve(usageDirectory, "jobs", "jobs-state.json"), "utf8");
    assert.equal(privateState.includes("worker-input-must-not-enter-owner-history"), false);
    assert.equal(privateState.includes("worker-input"), false);
    assert.equal((await fetch(`${apiServer.base}/api/jobs/real-worker-job`, { headers: { Authorization: signedRequests.mcpHeaders().Authorization } })).status, 403);
    const inboxResponse = await fetch(`${apiServer.base}/api/inbox`, { headers: { Authorization: owner.Authorization } });
    assert.equal((await inboxResponse.json() as { unreadCount: number }).unreadCount, 1);
  });

  it("propagates a disconnected owner action to a real running worker and records cancellation", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-worker-cancel-app-"));
    const cacheDirectory = await mkdtemp(resolve(tmpdir(), "codexia-api-worker-cancel-cache-"));
    const usageDirectory = await mkdtemp(resolve(tmpdir(), "codexia-api-worker-cancel-store-"));
    tempDirs.push(staticDir, cacheDirectory, usageDirectory);
    const apiServer = await startCustomApi(makeSnapshotStore().store, staticDir, {
      runtime: jobHistoryRuntime(cacheDirectory), usageDirectory,
    });
    t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const streamAbort = new AbortController();
    const stream = await fetch(`${apiServer.base}/api/jobs/events`, { headers: { Authorization: owner.Authorization }, signal: streamAbort.signal });
    assert.equal(stream.status, 200);
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const events: Array<{ jobId: string; status: string; error?: string }> = [];
    let buffer = "";
    const nextEvent = async (): Promise<{ jobId: string; status: string; error?: string }> => {
      while (events.length === 0) {
        const { done, value } = await reader.read();
        if (done) throw new Error("The job event stream closed before publishing a worker event");
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (data) events.push(JSON.parse(data) as { jobId: string; status: string; error?: string });
        }
      }
      return events.shift()!;
    };
    const readNextEvent = async (): Promise<{ jobId: string; status: string; error?: string }> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          nextEvent(),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for a worker event")), 5_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    };
    const actionAbort = new AbortController();
    const request = fetch(`${apiServer.base}/api/projects/project-1/actions/speaker.test-worker`, {
      method: "POST",
      headers: { Authorization: owner.Authorization, Origin: apiServer.base, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { jobId: "cancelled-worker-job", task: "hold" } }),
      signal: actionAbort.signal,
    }).catch((error: unknown) => error);
    let event = await readNextEvent();
    while (!(event.jobId === "cancelled-worker-job" && event.status === "running")) event = await readNextEvent();
    actionAbort.abort();
    let terminal = await readNextEvent();
    while (!(terminal.jobId === "cancelled-worker-job" && terminal.status === "error")) terminal = await readNextEvent();
    assert.equal(terminal.error, "job_cancelled");
    assert.ok(await request instanceof Error, "the client request should be cancelled while its worker is running");
    streamAbort.abort();
    await reader.cancel().catch(() => undefined);
    const statusResponse = await fetch(`${apiServer.base}/api/jobs/cancelled-worker-job`, { headers: { Authorization: owner.Authorization } });
    assert.equal(statusResponse.status, 200);
    const job = await statusResponse.json() as { status: string; error: string };
    assert.equal(job.status, "error");
    assert.equal(job.error, "job_cancelled");
  });

  it("wires model usage lazily into the host and retains it after Core reconstruction", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-native-core-api-"));
    const persistence = await nativePersistence(t);
    tempDirs.push(root);
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-model-history-app-"));
    tempDirs.push(staticDir);
    const usageDirectory = resolve(root, "history");
    const cacheDirectory = resolve(root, "module-cache");
    let coreStore = new CoreStore({ persistence });
    let apiServer: Awaited<ReturnType<typeof startCustomApi>> | undefined;
    t.after(async () => { if (apiServer) await apiServer.close(); });
    const openApi = (store: CoreStore) => startCustomApi(store, staticDir, {
      usageDirectory, persistence,
      runtimeOptions: modelUsageRuntimeOptions(cacheDirectory),
    });
    apiServer = await openApi(coreStore);
    let owner = signedRequests.ownerHeaders();
    const ownerHeaders = () => ({ Authorization: owner.Authorization, Origin: apiServer!.base, "Content-Type": "application/json" });
    const register = async () => {
      const response = await fetch(`${apiServer!.base}/api/projects`, { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ title: "Native API test project" }) });
      assert.equal(response.status, 201);
      return response.json() as Promise<{ id: string }>;
    };
    const invokeHistory = async (projectId: string, input: unknown) => fetch(
      `${apiServer!.base}/api/projects/${projectId}/actions/assistant.model-usage-history`,
      { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ input }) },
    );

    assert.equal((await fetch(`${apiServer.base}/api/health`)).status, 200);
    await assert.rejects(lstat(usageDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "server startup must not touch unused usage history");
    const project = await register();
    const identity = (await coreStore.observe(project.id)).snapshot.projectId;
    const event = usageEvent(identity, "host-usage-1", "2026-10-17T01:00:00.000Z", {
      cacheHit: true, promptVersion: "assistant-story-v2", durationMs: 1_842, queueWaitMs: 73,
    });
    const descriptors = await fetch(`${apiServer.base}/api/projects/${project.id}/actions`, { headers: { Authorization: owner.Authorization } });
    assert.equal(descriptors.status, 200);
    assert.ok((await descriptors.json() as { actions: Array<{ id: string }> }).actions.some(({ id }) => id === "assistant.model-usage-history"));
    await assert.rejects(lstat(usageDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "module activation alone must not create the history directory");
    const saved = await invokeHistory(project.id, { event });
    assert.equal(saved.status, 200);
    const savedResult = await saved.json() as ActionResult<{ events: ModelUsageEvent[] }>;
    assert.equal(savedResult.ok, true, JSON.stringify(savedResult));
    if (!savedResult.ok) return;
    assert.deepEqual(savedResult.data.events, [event]);
    assert.ok((await lstat(usageDirectory)).isDirectory());

    await apiServer.close();
    apiServer = undefined;
    coreStore = new CoreStore({ persistence });
    apiServer = await openApi(coreStore);
    owner = signedRequests.ownerHeaders();
    const reconstructed = (await coreStore.listProjects()).find((item) => item.id === project.id)!;
    const newIdentity = (await coreStore.observe(reconstructed.id)).snapshot.projectId;
    assert.equal(newIdentity, identity, "reopening Core retains the native project identity");
    const restored = await invokeHistory(reconstructed.id, { query: { limit: 10 } });
    assert.equal(restored.status, 200);
    const restoredResult = await restored.json() as ActionResult<{ events: ModelUsageEvent[] }>;
    assert.equal(restoredResult.ok, true, JSON.stringify(restoredResult));
    if (!restoredResult.ok) return;
    assert.deepEqual(restoredResult.data.events, [event]);
    assert.ok((await lstat(usageDirectory)).isDirectory(), "host history remains available in its separately configured directory");
  });

  it("keeps direct manuscript writes retired for the OAuth author", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-"));
    tempDirs.push(staticDir);
    let directSaveCalls = 0;
    const apiServer = await startCustomApi(makeStore(() => { directSaveCalls += 1; }), staticDir);
    t.after(apiServer.close);
    const author = signedRequests.ownerHeaders();
    const projectCollection = await fetch(apiServer.base + "/api/projects", { headers: author });
    assert.equal(projectCollection.status, 200);
    assert.deepEqual(await projectCollection.json(), {
      projects: [{ id: "project-1", title: "A Work", version: 1 }], nextCursor: null,
    });
    const scene = apiServer.base + "/api/projects/project-1/scenes/scene-1";
    const save = (revision: string, origin: string) => fetch(scene, {
      method: "PUT", headers: { ...author, Origin: origin }, body: JSON.stringify({ text: "new draft", revision }),
    });
    assert.equal((await save("revision-1", "https://unlisted.example")).status, 403);
    for (const revision of ["revision-1", "revision-old"]) {
      const mutation = await save(revision, apiServer.base);
      assert.equal(mutation.status, 404);
    }
    assert.equal(directSaveCalls, 0);
  });

  it("keeps PostgreSQL availability separate from an expired hosted Browser Grant", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-hosted-auth-boundary-"));
    tempDirs.push(staticDir);
    const native = await nativeProject(t, "Hosted readiness");
    let failHealthCheck = true;
    const persistence = new Proxy(native.persistence, {
      get(target, property, receiver) {
        if (property === "checkHealth") {
          return async () => {
            if (failHealthCheck) {
              failHealthCheck = false;
              throw new Error("simulated PostgreSQL availability failure");
            }
            await target.checkHealth?.();
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(native.store, staticDir, realHostedGrantPolicy(), controlFetch, undefined, undefined, persistence, native.project.id);
    t.after(apiServer.close);

    const status = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, {
      headers: { Authorization: `Bearer ${runtimeControlToken("status", "postgres-unavailable", sha256Digest(""))}` },
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { persistence: { state: string } }).persistence.state, "unknown",
      "a database health failure is reported as unavailable persistence, not as a rejected browser grant");

    const session = await fetch(`${apiServer.base}/api/session`, {
      headers: { Authorization: `Bearer ${hostedGrantToken()}` },
    });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), {
      authenticated: true,
      authorScope: "hosted:hosted-user-1",
      permissions: ["read", "write"],
    });

    const expiredGrant = await fetch(`${apiServer.base}/api/session`, {
      headers: { Authorization: `Bearer ${hostedGrantToken(true)}` },
    });
    assert.equal(expiredGrant.status, 401);
    assert.equal((await expiredGrant.json() as { code: string }).code, "UNAUTHORIZED");
  });

  it("closes Hosted project, job and MCP event streams at the admitting grant deadline", { timeout: 20000 }, async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-hosted-stream-expiry-"));
    tempDirs.push(staticDir);
    const native = await nativeProject(t, "Hosted stream expiry");
    const api = await startHostedApi(native.store, staticDir, realHostedGrantPolicy(), undefined,
      actionBoundaryRuntime(resolve(staticDir, "module-cache")), undefined, native.persistence, native.project.id);
    t.after(api.close);
    const abort = new AbortController();
    t.after(() => abort.abort());
    const endpoints = ["/api/projects/events", "/api/jobs/events", "/mcp"];
    const headersFor = (path: string, token: string): Record<string, string> => path === "/mcp"
      ? { Authorization: `Bearer ${token}` }
      : { Cookie: `__Host-praetorium_access=${token}` };
    const token = hostedGrantToken(false, 4);
    const expiresAt = (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp: number }).exp * 1000;
    const deadline = setTimeout(() => abort.abort(), 10000);
    try {
      const responses = await Promise.all(endpoints.map(path => fetch(api.base + path, {
        headers: headersFor(path, token), signal: abort.signal,
      })));
      for (const response of responses) {
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
      }
      const closedAt: number[] = [];
      const results = await Promise.allSettled(responses.map(async (response, index) => {
        try { return await response.text(); }
        finally { closedAt[index] = Date.now(); }
      }));
      assert.ok(closedAt.every(at => at >= expiresAt), "streams must not close before the admitting grant deadline");
      assert.equal(closedAt.length, endpoints.length);
      assert.equal(abort.signal.aborted, false, "the server must close the streams, not the test timeout");
      assert.equal(results[0]?.status, "fulfilled");
      assert.deepEqual(results[1], { status: "fulfilled", value: ": ok\n\n" });
      // Node pipeline abort terminates the module stream's socket at expiry.
      assert.equal(results[2]?.status, "rejected");
      for (const path of endpoints) {
        const expired = await fetch(api.base + path, { headers: headersFor(path, token) });
        assert.equal(expired.status, 401);
        await expired.arrayBuffer();
        const fresh = await fetch(api.base + path, { headers: headersFor(path, hostedGrantToken()) });
        assert.equal(fresh.status, 200);
        await fresh.body!.cancel();
      }
    } finally { clearTimeout(deadline); abort.abort(); }
  });

  it("does not admit standalone Access assertions or legacy bearer credentials", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-retired-browser-identity-"));
    tempDirs.push(staticDir);
    const api = await startApi(staticDir, true);
    t.after(api.close);
    const retired: Record<string, string>[] = [
      { "CF-Access-Jwt-Assertion": "retired-fixture-assertion", "X-Forwarded-Proto": "https" },
      { Cookie: "scriptorium_session=retired-fixture-session" },
      { Authorization: `Bearer ${ACCESS_TOKEN}` },
    ];
    for (const headers of retired) {
      const response = await fetch(api.base + "/api/session", { headers });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), null);
    }
    assert.equal((await fetch(api.base + "/api/session", { headers: signedRequests.ownerHeaders() })).status, 200);
  });

  it("authorizes standalone owner writes only with a verified API-audience OAuth access token", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-oauth-owner-"));
    tempDirs.push(staticDir);
    const issuer = "https://identity.example.test/";
    const audience = "https://api.codexia.example";
    const webOrigin = "https://web.codexia.test";
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "oauth-owner-test-key", alg: "RS256", use: "sig" };
    const now = Math.floor(Date.now() / 1000);
    const token = (overrides: Record<string, unknown> = {}, typ = "at+jwt", kid = jwk.kid) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = encode({ alg: "RS256", typ, kid }) + "." + encode({
        iss: issuer, sub: "owner-subject", aud: audience, client_id: "codexia-web", azp: "codexia-web",
        scope: "codexia:api", iat: now, exp: now + 300, jti: randomUUID(), ...overrides,
      });
      return unsigned + "." + signJwt("RSA-SHA256", Buffer.from(unsigned), key.privateKey).toString("base64url");
    };
    const persistence = await nativePersistence(t);
    const store = new CoreStore({ persistence });
    const api = await startCustomApi(store, staticDir, {
      persistence, usageDirectory: staticDir, corsAllowedOrigins: [webOrigin],
      oauthOwner: {
        issuer, audience, jwksUrl: "https://identity.example.test/.well-known/jwks.json",
        ownerSubject: "owner-subject", requiredScopes: ["codexia:api"],
        fetch: async (input) => {
          assert.equal(String(input), "https://identity.example.test/.well-known/jwks.json");
          return Response.json({ keys: [jwk] });
        },
      },
    });
    t.after(api.close);
    const headers = (credential: string) => ({ Authorization: `Bearer ${credential}` });
    const browserHeaders = (credential: string) => ({ ...headers(credential), Origin: webOrigin });
    const valid = token();
    const preflight = await fetch(api.base + "/api/projects", {
      method: "OPTIONS", headers: {
        Origin: webOrigin, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), webOrigin);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");
    assert.deepEqual(preflight.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
    assert.equal(preflight.headers.has("access-control-allow-credentials"), false);
    const blockedOriginPreflight = await fetch(api.base + "/api/projects", {
      method: "OPTIONS", headers: {
        Origin: "https://unlisted.example.test", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    assert.equal(blockedOriginPreflight.status, 403);
    const blockedCookiePreflight = await fetch(api.base + "/api/projects", {
      method: "OPTIONS", headers: {
        Origin: webOrigin, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, cookie",
      },
    });
    assert.equal(blockedCookiePreflight.status, 403);
    const session = await fetch(api.base + "/api/session", { headers: browserHeaders(valid) });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { authenticated: true, authorScope: "owner" });
    assert.equal(session.headers.get("access-control-allow-origin"), webOrigin);

    const write = await fetch(api.base + "/api/projects", {
      method: "POST", headers: { ...browserHeaders(valid), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "OAuth owner project" }),
    });
    assert.equal(write.status, 201, await write.text());
    assert.equal(write.headers.get("access-control-allow-origin"), webOrigin);
    const list = await fetch(api.base + "/api/projects", { headers: browserHeaders(valid) });
    assert.equal(list.status, 200);
    const { projects } = await list.json() as { projects: Array<{ id: string; title: string; version: number }> };
    const project = projects.find((item) => item.title === "OAuth owner project");
    assert.ok(project);

    const projectId = project.id as import("@codexia/persistence-contracts").ProjectId;
    const projectVersion = project.version as number;
    const nodeId = randomUUID() as import("@codexia/persistence-contracts").KnowledgeNodeId;
    const proposalInput = {
      projectVersion, idempotencyKey: `oauth-action-${randomUUID()}`,
      operations: [{ type: "knowledge.node.save", command: {
        projectId, id: nodeId, type: "person", name: "OAuth owner proposal", attributes: {},
        status: "confirmed", expectedVersion: null,
      } }],
    };
    const actionPath = `${api.base}/api/projects/${projectId}/actions/core.knowledge.propose`;
    const actionProposal = await fetch(actionPath, {
      method: "POST", headers: { ...browserHeaders(valid), "Content-Type": "application/json" },
      body: JSON.stringify({ input: proposalInput }),
    });
    const actionResult = await actionProposal.json() as ActionResult;
    assert.equal(actionProposal.status, 200, JSON.stringify(actionResult));
    assert.equal(actionResult.ok, true, JSON.stringify(actionResult));
    if (!actionResult.ok) throw new Error("OAuth action proposal was denied");
    const changeSet = (actionResult.data as { changeSet: import("@codexia/persistence-contracts").ChangeSet }).changeSet;
    assert.equal(changeSet.authorId, "owner");
    assert.equal(await persistence.read((reader) => reader.getKnowledgeNode(projectId, nodeId)), undefined);

    for (const invalid of [token({ sub: "other-subject" }), token({ scope: "profile" })]) {
      const denied = await fetch(actionPath, {
        method: "POST", headers: { ...browserHeaders(invalid), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { ...proposalInput, idempotencyKey: `denied-${randomUUID()}` } }),
      });
      assert.equal(denied.status, 403);
    }

    const approvePath = `${api.base}/api/v1/persistence/projects/${projectId}/changesets/${changeSet.id}/approve`;
    const approval = await fetch(approvePath, {
      method: "POST", headers: { ...browserHeaders(valid), "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: changeSet.version }),
    });
    assert.equal(approval.status, 200, await approval.text());
    const apply = await fetch(`${api.base}/api/v1/persistence/projects/${projectId}/changesets/${changeSet.id}/apply`, {
      method: "POST", headers: { ...browserHeaders(valid), "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: changeSet.version + 1 }),
    });
    assert.equal(apply.status, 200, await apply.text());
    assert.ok(await persistence.read((reader) => reader.getKnowledgeNode(projectId, nodeId)));

    const unknownRoute = await fetch(api.base + "/api/non-allowlisted", { headers: browserHeaders(valid) });
    assert.equal(unknownRoute.status, 404);
    const unlistedOrigin = await fetch(api.base + "/api/session", {
      headers: { ...headers(valid), Origin: "https://unlisted.example.test" },
    });
    assert.equal(unlistedOrigin.status, 403);

    const wrongOwner = await fetch(api.base + "/api/projects", {
      method: "POST", headers: { ...browserHeaders(token({ sub: "other-subject" })), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Denied project" }),
    });
    assert.equal(wrongOwner.status, 403);
    const noScope = await fetch(api.base + "/api/projects", {
      method: "POST", headers: { ...browserHeaders(token({ scope: "profile" })), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Denied project" }),
    });
    assert.equal(noScope.status, 403);
    const signature = valid.split(".")[2]!;
    const badSignature = valid.slice(0, valid.lastIndexOf(".") + 1) + (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    const invalidTokens = [
      badSignature,
      token({ iss: "https://wrong.example.test/" }), token({ aud: "https://other-api.example" }),
      token({ exp: now - 30 }), token({}, "JWT"),
    ];
    for (const [index, invalid] of invalidTokens.entries()) {
      assert.equal((await fetch(api.base + "/api/session", { headers: browserHeaders(invalid) })).status, 401, `invalid OAuth token case ${index}`);
    }
    assert.equal((await fetch(api.base + "/api/session", { headers: browserHeaders(token({}, "at+jwt", "unpublished-key")) })).status, 401, "unknown signing keys fail closed");
    const legacyBearerWrite = await fetch(api.base + "/api/projects", {
      method: "POST", headers: { ...headers(ACCESS_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Legacy bearer cannot author" }),
    });
    assert.equal(legacyBearerWrite.status, 401);
    const bothCredentials = await fetch(api.base + "/api/projects", {
      headers: { ...browserHeaders(valid), Cookie: "scriptorium_session=present" },
    });
    assert.equal(bothCredentials.status, 403, "cross-origin cookies are denied by bearer-only CORS");

    const unavailableApi = await startCustomApi(store, staticDir, {
      oauthOwner: {
        issuer, audience, jwksUrl: "https://identity.example.test/.well-known/unavailable.json",
        ownerSubject: "owner-subject", requiredScopes: ["codexia:api"],
        fetch: async () => new Response(null, { status: 503 }),
      },
    });
    t.after(unavailableApi.close);
    assert.equal((await fetch(unavailableApi.base + "/api/session", { headers: headers(valid) })).status, 503, "unavailable JWKS fails closed without treating it as bad credentials");
  });

  it("admits registered MCP OAuth clients by exact operation scope without owner rights", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-oauth-mcp-"));
    tempDirs.push(staticDir);
    const issuer = "https://api.codexia.example/api/auth";
    const audience = "https://api.codexia.example/api";
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "oauth-mcp-test-key", alg: "ES256", use: "sig" };
    const now = Math.floor(Date.now() / 1000);
    const makeToken = (scope: string, overrides: Record<string, unknown> = {}, typ = "at+jwt") => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
      const unsigned = encode({ alg: "ES256", typ, kid: jwk.kid }) + "." + encode({
        iss: issuer, sub: "owner-subject", aud: audience,
        client_id: "codexia-mcp-client", azp: "codexia-mcp-client",
        scope, iat: now, exp: now + 300, jti: randomUUID(), ...overrides,
      });
      const signature = signJwt("sha256", Buffer.from(unsigned, "ascii"), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
      return `${unsigned}.${signature.toString("base64url")}`;
    };
    const firstAssignedId = "00000000-0000-4000-8000-000000000001";
    const missingAssignedId = "00000000-0000-4000-8000-000000000003";
    const unassignedId = "00000000-0000-4000-8000-000000000002";
    let onlineChecks = 0;
    const oauthMcp = {
      issuer, audience, jwksUrl: `${issuer}/jwks`,
      ownerSubject: "owner-subject",
      ownerClientIds: ["codexia-web", "codexia-ios"],
      allowedClientIds: ["codexia-mcp-client", "single-project-client"],
      projectIdsByClient: {
        "codexia-mcp-client": ["project-1", missingAssignedId, firstAssignedId],
        "single-project-client": [firstAssignedId],
      },
      verifyActiveToken: async () => { onlineChecks += 1; return true; },
      fetch: async (input: string | URL | Request) => {
        assert.equal(String(input), `${issuer}/jwks`);
        return Response.json({ keys: [jwk] });
      },
    } satisfies Parameters<typeof createOAuthMcpAuthenticator>[0];
    const storeFixture = makeSnapshotStore();
    const assignedProject = { id: "project-1", title: "Assigned MCP project", version: 1 };
    const firstAssignedProject = { id: firstAssignedId, title: "Previous MCP project", version: 1, updatedAt: "2026-10-17T00:00:00.000Z" };
    const unassignedProject = { id: unassignedId, title: "Other disposable project", version: 1 };
    Object.assign(storeFixture.store, {
      listProjects: async () => [firstAssignedProject, unassignedProject, assignedProject],
    });
    const api = await startCustomApi(storeFixture.store, staticDir, {
      usageDirectory: staticDir,
      runtime: actionBoundaryRuntime(staticDir),
      corsAllowedOrigins: ["https://mcp-client.example.test"],
      oauthOwner: {
        issuer, audience, jwksUrl: oauthMcp.jwksUrl, ownerSubject: oauthMcp.ownerSubject,
        allowedClientIds: oauthMcp.ownerClientIds, requiredScopes: ["codexia:api"],
        verifyActiveToken: oauthMcp.verifyActiveToken, fetch: oauthMcp.fetch,
      },
      oauthMcp,
    });
    t.after(api.close);
    const send = (path: string, tokenValue: string, init: RequestInit = {}) => fetch(`${api.base}${path}`, {
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${tokenValue}`, ...init.headers },
    });
    const protectedMetadata = await fetch(`${api.base}/.well-known/oauth-protected-resource/api`);
    assert.equal(protectedMetadata.status, 200);
    assert.equal(protectedMetadata.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await protectedMetadata.json(), {
      resource: audience,
      authorization_servers: [issuer],
      scopes_supported: ["mcp:read", "mcp:compute", "mcp:propose"],
      bearer_methods_supported: ["header"],
    });

    const readToken = makeToken("openid mcp:read");
    const computeToken = makeToken("openid mcp:compute");
    const proposeToken = makeToken("openid mcp:propose");
    const singleProjectToken = makeToken("mcp:read", { client_id: "single-project-client", azp: "single-project-client" });
    const ownerToken = makeToken("codexia:api", { client_id: "codexia-web", azp: "codexia-web" });

    const initialize = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) };
    const standaloneChallenge = await fetch(api.base + "/mcp", initialize);
    assert.equal(standaloneChallenge.status, 401);
    assert.equal(standaloneChallenge.headers.get("www-authenticate"),
      'Bearer resource_metadata="https://api.codexia.example/.well-known/oauth-protected-resource/api", scope="mcp:read mcp:compute mcp:propose"');
    const preflight = await fetch(api.base + "/mcp", { method: "OPTIONS", headers: {
      Origin: "https://mcp-client.example.test",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, mcp-session-id, mcp-protocol-version",
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization, Mcp-Session-Id, MCP-Protocol-Version");
    const corsChallenge = await fetch(api.base + "/mcp", { ...initialize, headers: { ...initialize.headers, Origin: "https://mcp-client.example.test" } });
    assert.equal(corsChallenge.status, 401);
    assert.equal(corsChallenge.headers.get("access-control-expose-headers"), "Mcp-Session-Id, WWW-Authenticate");
    assert.equal((await send("/mcp", ACCESS_TOKEN, initialize)).status, 401);
    const cookie = "scriptorium_session=retired-fixture-value";
    assert.equal((await fetch(api.base + "/mcp", { ...initialize, headers: { ...initialize.headers, Cookie: cookie, Origin: api.base } })).status, 401);
    assert.equal((await send("/api/session", ownerToken)).status, 200);
    assert.equal((await send("/mcp", ownerToken, initialize)).status, 403);
    const selectProject = await send("/mcp", readToken);
    assert.equal(selectProject.status, 400);
    assert.equal((await selectProject.json() as { code: string }).code, "MCP_PROJECT_REQUIRED");
    assert.equal((await send("/mcp?projectId=project-1&projectId=project-1", readToken)).status, 400);
    assert.equal((await send(`/mcp?projectId=${unassignedId}`, readToken)).status, 404);
    assert.equal((await send(`/mcp?projectId=${missingAssignedId}`, readToken)).status, 404);
    const sessionIdentity = async (path: string, token: string): Promise<string> => {
      const response = await send(path, token);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-test-mcp-project"), firstAssignedId);
      const identity = response.headers.get("x-test-mcp-identity");
      assert.ok(identity);
      await response.body?.cancel();
      return identity;
    };
    const explicitProject = `/mcp?projectId=${firstAssignedId}`;
    const multiClientIdentity = await sessionIdentity(explicitProject, readToken);
    assert.equal(await sessionIdentity(explicitProject, makeToken("mcp:read")), multiClientIdentity);
    assert.notEqual(await sessionIdentity("/mcp", singleProjectToken), multiClientIdentity);

    const projects = await send("/api/projects", readToken);
    assert.equal(projects.status, 200);
    const firstPage = await projects.json() as { projects: Array<{ id: string }>; nextCursor: unknown };
    assert.deepEqual(firstPage.projects.map(({ id }) => id), [firstAssignedId, "project-1"],
      "MCP project enumeration returns only existing assigned resources in canonical order");
    assert.equal(firstPage.nextCursor, null);

    const pagedProjects = await send("/api/projects?limit=1", readToken);
    assert.equal(pagedProjects.status, 200);
    const page = await pagedProjects.json() as { projects: Array<{ id: string }>; nextCursor: unknown };
    assert.deepEqual(page.projects.map(({ id }) => id), [firstAssignedId]);
    assert.ok(typeof page.nextCursor === "string" && page.nextCursor, "scoped projects use the same opaque cursor as owner projects");
    const tail = await send(`/api/projects?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`, readToken);
    assert.equal(tail.status, 200);
    const lastPage = await tail.json() as { projects: Array<{ id: string }>; nextCursor: unknown };
    assert.deepEqual(lastPage.projects.map(({ id }) => id), ["project-1"]);
    assert.equal(lastPage.nextCursor, null, "a later unassigned project must not produce another page");

    const nestedProjectList = await send("/api/projects/project-1/actions/core.projects.list", readToken, {
      method: "POST", body: JSON.stringify({ input: {} }),
    });
    assert.equal(nestedProjectList.status, 200);
    const nestedProjectListResult = await nestedProjectList.json() as ActionResult;
    assert.equal(nestedProjectListResult.ok, true);
    if (nestedProjectListResult.ok) {
      assert.deepEqual((nestedProjectListResult.data as { projects: Array<{ id: string }> }).projects.map(({ id }) => id), [firstAssignedId, "project-1"],
        "nested core project enumeration observes the same client assignment");
    }
    const unassignedProjectRead = await send(`/api/projects/${unassignedId}/snapshot?projection=editor`, readToken);
    assert.equal(unassignedProjectRead.status, 404);
    assert.equal((await unassignedProjectRead.json() as { code: string }).code, "PROJECT_NOT_FOUND");
    for (const path of [
      "/api/v1/persistence/projects",
      "/api/v1/persistence/projects?limit=1",
      "/api/v1/persistence/projects/project-1/archive",
      "/api/v1/persistence/projects/project-2/archive",
    ]) {
      const directPersistence = await send(path, readToken);
      assert.equal(directPersistence.status, 403, `MCP direct persistence route ${path} is closed`);
      assert.equal((await directPersistence.json() as { code: string }).code, "OAUTH_MCP_PERSISTENCE_DENIED");
    }
    for (const path of [
      "/api/v1/persistence/projects",
      "/api/v1/persistence/projects?limit=1",
      "/api/v1/persistence/projects/project-1/archive",
      "/api/v1/persistence/projects/project-2/archive",
    ]) {
      const directPersistence = await send(path, readToken);
      assert.equal(directPersistence.status, 403, `MCP direct persistence route ${path} is closed`);
      assert.equal((await directPersistence.json() as { code: string }).code, "OAUTH_MCP_PERSISTENCE_DENIED");
    }

    const metadataChallenge = await fetch(`${api.base}/api/projects/project-1/modules/mcp/streamable`);
    assert.equal(metadataChallenge.status, 401);
    assert.equal(metadataChallenge.headers.get("www-authenticate"),
      'Bearer resource_metadata="https://api.codexia.example/.well-known/oauth-protected-resource/api", scope="mcp:read mcp:compute mcp:propose"');

    const limitedSession = await send("/api/session", readToken);
    assert.equal(limitedSession.status, 200);
    assert.equal((await limitedSession.json() as { authorScope: string }).authorScope, "",
      "MCP bearer authentication must not become the owner author scope");

    const actionList = await send("/api/projects/project-1/actions", readToken);
    assert.equal(actionList.status, 200);
    const actions = (await actionList.json() as { actions: Array<{ id: string; effect: string }> }).actions;
    assert.ok(actions.some((action) => action.effect === "read"));
    assert.equal(actions.some((action) => action.id === "mcp.propose" || action.id === "nlp.analyze"), false,
      "read scope must not disclose compute or proposal action capabilities");
    assert.equal(actions.some(action => action.id === "core.hierarchy.reorder"), false);
    const reorderWithoutProposalScope = await send("/api/projects/project-1/actions/core.hierarchy.reorder", readToken, {
      method: "POST", body: JSON.stringify({ input: { kind: "volume", orderedIds: ["one"], idempotencyKey: "read-only" } }),
    });
    assert.equal(reorderWithoutProposalScope.status, 403);
    assert.equal((await reorderWithoutProposalScope.json() as { code: string }).code, "OAUTH_MCP_SCOPE_REQUIRED");

    const computeTokenCannotRead = await send("/api/projects/project-1/snapshot?projection=editor", computeToken);
    assert.equal(computeTokenCannotRead.status, 403);
    assert.equal((await computeTokenCannotRead.json() as { code: string }).code, "OAUTH_MCP_SCOPE_REQUIRED");
    assert.equal(computeTokenCannotRead.headers.get("www-authenticate"),
      'Bearer error="insufficient_scope", resource_metadata="https://api.codexia.example/.well-known/oauth-protected-resource/api", scope="mcp:read"');

    const computeAction = await send("/api/projects/project-1/actions/nlp.analyze", computeToken, {
      method: "POST", body: JSON.stringify({ input: {} }),
    });
    assert.equal(computeAction.status, 200);
    const computeResult = await computeAction.json() as ActionResult;
    const operation: ChangeOperation = {
      id: "mcp-scope-proposal", generation: 0, projectId: "project-1", baseProjectVersion: 11,
      effect: "metadata", reads: [], writes: [], message: "MCP proposed a bounded change",
    };
    assert.equal(computeResult.ok, true);
    if (computeResult.ok) assert.equal((computeResult.data as { nested: ActionResult }).nested.ok, false,
      "compute scope cannot transitively invoke a proposal effect");

    const computeModuleRoute = await send("/api/projects/project-1/modules/mcp/compute", computeToken, {
      method: "POST", body: JSON.stringify({ operation, linkedProjectId: "project-2" }),
    });
    assert.equal(computeModuleRoute.status, 200, "the limited principal can reach an admitted MCP compute route");
    const computeModuleResult = await computeModuleRoute.json() as { proposalCode: string; linkedProjectError: string | null };
    assert.equal(computeModuleResult.proposalCode, "action_effect_denied",
      "compute scope cannot use a mixed module host to propose changes");
    assert.equal(computeModuleResult.linkedProjectError, "PROJECT_NOT_FOUND",
      "nested linked readers remain bound to this MCP client's parent project assignment");
    const readCannotUseComputeModuleRoute = await send("/api/projects/project-1/modules/mcp/compute", readToken, {
      method: "POST", body: JSON.stringify({ operation }),
    });
    assert.equal(readCannotUseComputeModuleRoute.status, 403);
    assert.equal((await readCannotUseComputeModuleRoute.json() as { code: string }).code, "OAUTH_MCP_SCOPE_REQUIRED");

    const readCannotCompute = await send("/api/projects/project-1/actions/nlp.analyze", readToken, {
      method: "POST", body: JSON.stringify({ input: {} }),
    });
    assert.equal(readCannotCompute.status, 403);
    assert.equal((await readCannotCompute.json() as { code: string }).code, "OAUTH_MCP_SCOPE_REQUIRED");

    const readCannotPropose = await send("/api/projects/project-1/proposals", readToken, {
      method: "POST", body: JSON.stringify({ snapshot: SNAPSHOT, operations: [operation] }),
    });
    assert.equal(readCannotPropose.status, 403);
    assert.equal((await readCannotPropose.json() as { code: string }).code, "OAUTH_MCP_SCOPE_REQUIRED");
    const proposal = await send("/api/projects/project-1/proposals", proposeToken, {
      method: "POST", body: JSON.stringify({ snapshot: SNAPSHOT, operations: [operation] }),
    });
    assert.equal(proposal.status, 201);
    assert.equal((await proposal.json() as ChangeProposal).source, "mcp");
    assert.equal(storeFixture.proposed.at(-1)?.source, "mcp");

    const mcpCannotApprove = await send("/api/projects/project-1/approvals", proposeToken, {
      method: "POST", body: JSON.stringify({ proposalId: "mcp-scope-proposal", operationIds: [operation.id] }),
    });
    assert.equal(mcpCannotApprove.status, 403);
    const mcpCannotApply = await send("/api/projects/project-1/apply", proposeToken, {
      method: "POST", body: JSON.stringify(operation),
    });
    assert.equal(mcpCannotApply.status, 403);

    const foreignProject = await send("/api/projects/not-a-project", readToken);
    assert.equal(foreignProject.status, 404, "MCP audience does not bypass existing project identity checks");
    const ownerClient = await send("/api/projects", makeToken("openid mcp:read", { client_id: "codexia-web", azp: "codexia-web" }));
    assert.equal(ownerClient.status, 403, "the owner client cannot be reclassified as MCP by scope alone");
    const audienceMismatch = await send("/api/projects", makeToken("openid mcp:read", { aud: "https://other.example/api" }));
    assert.equal(audienceMismatch.status, 401);
    const typeConfusion = await send("/api/projects", makeToken("openid mcp:read", {}, "JWT"));
    assert.equal(typeConfusion.status, 401);
    assert.ok(onlineChecks >= 6, "every admitted or scope-bearing MCP API request checks online token activity");
  });

  it("rejects invalid browser CORS origins before opening a listener", () => {
    const store = makeStore();
    const persistence = admissionPersistence(store);
    for (const origins of [
      ["http://web.example.test"],
      ["https://*.example.test"],
      ["https://web.example.test/path"],
      ["https://web.example.test", "https://web.example.test"],
    ]) {
      assert.throws(
        () => createServer({ store, persistence, corsAllowedOrigins: origins, ...testClientSettings("project-1", signedRequests.publicJwks, signedRequests.isActive) }),
        /exact normalized HTTPS origins/u,
        origins.join(", "),
      );
    }
  });

  it("fails API readiness and persistence status while PostgreSQL is unavailable", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-postgres-ready-"));
    tempDirs.push(staticDir);
    const persistence = {
      async checkHealth() { throw new Error("database unavailable"); },
    } as unknown as ApiServerOptions["persistence"];
    const apiServer = await startCustomApi(makeStore(), staticDir, { persistence });
    t.after(apiServer.close);

    const readiness = await fetch(`${apiServer.base}/health/ready`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json() as { ok: boolean }).ok, false);

    const status = await fetch(`${apiServer.base}/api/v1/persistence/status`, {
      headers: { Authorization: signedRequests.ownerHeaders().Authorization },
    });
    assert.equal(status.status, 503);
    assert.deepEqual(await status.json(), { error: "PostgreSQL persistence is not ready", code: "PERSISTENCE_UNAVAILABLE" });
  });

  it("serves immutable runtime metadata publicly in standalone mode", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-metadata-"));
    tempDirs.push(staticDir);
    const previousRevision = process.env.CODEXIA_PRODUCER_REVISION;
    process.env.CODEXIA_PRODUCER_REVISION = "a".repeat(40);
    const apiServer = await startCustomApi(makeStore(), staticDir);
    t.after(async () => {
      await apiServer.close();
      if (previousRevision === undefined) delete process.env.CODEXIA_PRODUCER_REVISION;
      else process.env.CODEXIA_PRODUCER_REVISION = previousRevision;
    });
    const response = await fetch(`${apiServer.base}/api/platform/v1/metadata`);
    assert.equal(response.status, 200);
    const metadata = await response.json() as {
      contractVersion: string; producerRevision: string; listener: { port: number };
      paths: { metadata: string; shutdown: string; status: string; quiesce: string; resume: string };
    };
    assert.equal(metadata.producerRevision, "a".repeat(40));
    assert.ok(metadata.listener.port > 0 && metadata.listener.port <= 65_535);
    assert.deepEqual(metadata.paths, {
      liveness: "/health/live", readiness: "/health/ready", metadata: "/api/platform/v1/metadata",
      shutdown: "/api/platform/v1/quiesce", status: "/api/platform/v1/status",
      quiesce: "/api/platform/v1/quiesce", resume: "/api/platform/v1/resume",
    });
  });

  it("exposes the source Core read surface through pinned routes and composed host actions", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-core-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const auth = { Authorization: signedRequests.ownerHeaders().Authorization };

    const projects = await fetch(`${apiServer.base}/api/projects`, { headers: auth });
    assert.deepEqual(await projects.json(), { projects: [{ id: "project-1", title: "A Work", version: 1 }], nextCursor: null });
    const detail = await fetch(`${apiServer.base}/api/projects/project-1`, { headers: auth });
    const detailBody = await detail.json() as { project: { id: string; title: string; version: number }; observation: { snapshot: SnapshotId; state: string } };
    assert.equal(detail.status, 200);
    assert.deepEqual(detailBody.project, { id: "project-1", title: "A Work", version: 1, settings: {}, createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z" });
    assert.equal(detailBody.observation.snapshot.projectVersion, SNAPSHOT.projectVersion);
    assert.equal(detailBody.observation.state, "fresh", "project opening observes the assigned PostgreSQL project");
    const missingProject = await fetch(`${apiServer.base}/api/projects/missing`, { headers: auth });
    assert.equal(missingProject.status, 404);
    assert.equal((await missingProject.json() as { code: string }).code, "PROJECT_NOT_FOUND");
    assert.equal((await fetch(`${apiServer.base}/api/projects/project-1/manuscripts`, { headers: auth })).status, 404);
    const defaultTree = await fetch(`${apiServer.base}/api/projects/project-1/tree`, { headers: auth });
    assert.equal((await defaultTree.json() as { snapshot: SnapshotId }).snapshot.projectVersion, SNAPSHOT.projectVersion);
    assert.deepEqual(fixture.snapshotReads.at(-1), { kind: "tree", pinned: undefined });
    const defaultScene = await fetch(`${apiServer.base}/api/projects/project-1/scenes/scene-one`, { headers: auth });
    assert.equal((await defaultScene.json() as { snapshot: SnapshotId }).snapshot.projectVersion, SNAPSHOT.projectVersion);
    assert.deepEqual(fixture.snapshotReads.at(-1), { kind: "scene", pinned: undefined });
    const pinnedTree = await fetch(`${apiServer.base}/api/projects/project-1/tree?projectVersion=${SNAPSHOT.projectVersion}`, { headers: auth });
    assert.equal((await pinnedTree.json() as { snapshot: SnapshotId }).snapshot.projectVersion, SNAPSHOT.projectVersion);
    assert.deepEqual(fixture.snapshotReads.at(-1), { kind: "tree", pinned: SNAPSHOT });
    const legacyGitView = await fetch(`${apiServer.base}/api/projects/project-1/tree?view=checkpoint&snapshot=${"c".repeat(40)}`, { headers: auth });
    assert.equal(legacyGitView.status, 400, "Git view and commit selectors are rejected instead of falling back to the current PostgreSQL snapshot");
    assert.equal((await legacyGitView.json() as { code: string }).code, "INVALID_SNAPSHOT");
    const retiredSceneViews = await fetch(`${apiServer.base}/api/projects/project-1/scenes/scene-one/views?projectVersion=1`, { headers: auth });
    assert.equal(retiredSceneViews.status, 404, "the two-view Git reader route has been retired");
    const modules = await fetch(`${apiServer.base}/api/projects/project-1/modules`, { headers: auth });
    assert.equal(modules.status, 200);
    assert.ok((await modules.json() as Array<{ id: string; availability: string }>).some(({ id, availability }) => id === "mcp" && availability === "not-included"));
    const contributions = await fetch(`${apiServer.base}/api/projects/project-1/contributions`, { headers: auth });
    assert.deepEqual(await contributions.json(), []);

    const descriptorsResponse = await fetch(`${apiServer.base}/api/projects/project-1/actions`, { headers: auth });
    const descriptors = await descriptorsResponse.json() as Array<{ id: string; module: string; effect: string }> | { actions: Array<{ id: string; module: string; effect: string }> };
    const actions = Array.isArray(descriptors) ? descriptors : descriptors.actions;
    assert.ok(actions.some((action) => action.id === "core.status" && action.module === "core" && action.effect === "read"));
    assert.ok(actions.some((action) => action.id === "core.search"));
    assert.ok(actions.some((action) => action.id === "core.writing-stats"));
    assert.ok(actions.some((action) => action.id === "core.manuscript-snapshots"));
    for (const id of [
      "core.knowledge.nodes.list", "core.knowledge.node.get", "core.knowledge.aliases.list", "core.knowledge.relations.list",
      "core.evidence.anchor.get", "core.evidence.document.list", "core.evidence.node.list", "core.evidence.assertion.get",
      "core.evidence.assertion.list", "core.knowledge.propose", "core.changesets.list", "core.changeset.get",
    ]) assert.ok(actions.some((action) => action.id === id && action.module === "core"), `${id} is registered by the host Core catalog`);
    assert.equal(actions.some((action) => action.module === "mcp"), false);

    const actionResponse = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.search`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { query: "harbor", limit: 5 } }),
    });
    assert.deepEqual(await actionResponse.json(), {
      ok: true, snapshot: SNAPSHOT,
      data: { query: "harbor", results: [{ id: "scene-one", type: "scene", name: "Opening", snippet: "A harbor at night.", filePath: "manuscript/ms-one/scene-one.md", score: 1, field: "body", offset: 2, length: 6 }] },
    });
    assert.ok(fixture.pinnedReads.includes(SNAPSHOT.projectVersion));
    const mismatchedNativeRead = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.knowledge.nodes.list`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ input: { projectVersion: 2 } }),
    });
    assert.equal((await mismatchedNativeRead.json() as { error: { code: string } }).error.code, "snapshot_unavailable");
    const forgedNativeActor = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.knowledge.propose`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { projectVersion: 1, idempotencyKey: "k", operations: [], actorId: "forged" } }),
    });
    assert.equal((await forgedNativeActor.json() as { error: { code: string } }).error.code, "invalid_action_input");
    const invalidAction = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.search`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { query: "" } }),
    });
    assert.equal((await invalidAction.json() as { error: { code: string } }).error.code, "invalid_action_input");

    const overlay = SNAPSHOT;
    const resolveResponse = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.document.resolve`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { path: "manuscript/ms-one/scene-one.md" }, snapshot: overlay }),
    });
    assert.deepEqual(await resolveResponse.json(), { ok: true, snapshot: overlay, data: { sceneId: "scene-one" } });
    const unsafeResolve = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.document.resolve`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ input: { path: "../secret" }, snapshot: overlay }),
    });
    assert.equal((await unsafeResolve.json() as { error: { code: string } }).error.code, "invalid_action_input");
    const invalidSnapshot = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.document.resolve`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ input: { path: "manuscript/x.md" }, snapshot: { projectId: "project-1", projectVersion: "invalid" } }),
    });
    assert.equal(invalidSnapshot.status, 400);
    const pinned = SNAPSHOT.projectVersion;
    const snapshots = await fetch(`${apiServer.base}/api/projects/project-1/manuscripts/ms-one/snapshots?sceneId=scene-one&projectVersion=${pinned}`, { headers: auth });
    const listed = await snapshots.json() as { snapshot: SnapshotId; snapshots: Array<{ id: string }> };
    assert.equal(listed.snapshot.projectVersion, pinned);
    assert.equal(listed.snapshots[0]?.id, "11111111-1111-4111-8111-111111111111");
    const historical = await fetch(`${apiServer.base}/api/projects/project-1/manuscripts/ms-one/snapshots/11111111-1111-4111-8111-111111111111?projectVersion=${pinned}`, { headers: auth });
    assert.equal(historical.status, 200);
    assert.equal((await historical.json() as { manuscriptSnapshot: { document: { path: string } } }).manuscriptSnapshot.document.path, "manuscript/ms-one/scene-one.md");
    const malformedRevision = await fetch(`${apiServer.base}/api/projects/project-1/manuscripts/ms-one/snapshots/not-a-revision?projectVersion=${pinned}`, { headers: auth });
    assert.equal(malformedRevision.status, 400);

    const stats = await fetch(`${apiServer.base}/api/projects/project-1/writing-stats?projectVersion=${pinned}`, { headers: auth });
    const statsBody = await stats.json() as { snapshot: SnapshotId; stats: { totalPages400: number } };
    assert.equal(statsBody.snapshot.projectVersion, pinned);
    assert.equal(statsBody.stats.totalPages400, 1);
  });

  it("assigns proposal source at the host and keeps approval exclusive to the verified OAuth owner", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-proposals-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const operation: ChangeOperation = {
      id: "operation-1", generation: 0, projectId: SNAPSHOT.projectId, baseProjectVersion: SNAPSHOT.projectVersion,
      effect: "metadata", reads: [], writes: [], message: "propose a bounded metadata update",
    };
    const proposal = await fetch(`${apiServer.base}/api/projects/project-1/proposals`, {
      method: "POST", headers: { Authorization: signedRequests.mcpHeaders().Authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "mcp-batch-1", source: "author", snapshot: SNAPSHOT, operations: [operation] }),
    });
    assert.equal(proposal.status, 201);
    assert.equal((await proposal.json() as ChangeProposal).source, "mcp");
    assert.equal(fixture.proposed[0]?.id, "mcp-batch-1");
    assert.equal(fixture.proposed[0]?.source, "mcp");

    const mcpApproval = await fetch(`${apiServer.base}/api/projects/project-1/approvals`, {
      method: "POST", headers: { Authorization: signedRequests.mcpHeaders().Authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: "mcp-batch-1", operationIds: [operation.id], authorScope: "forged" }),
    });
    assert.equal(mcpApproval.status, 403);
    assert.deepEqual(fixture.approvals, []);

    const owner = signedRequests.ownerHeaders();
    const authorApproval = await fetch(`${apiServer.base}/api/projects/project-1/approvals`, {
      method: "POST", headers: { Authorization: owner.Authorization, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ proposalId: "mcp-batch-1", operationIds: [operation.id], authorScope: "forged" }),
    });
    assert.equal(authorApproval.status, 204);
    assert.deepEqual(fixture.approvals, [{ proposalId: "mcp-batch-1", operationIds: [operation.id], authorScope: "owner" }]);
  });


  it("keeps a strict Core proposal after an owner request is aborted following its durable write", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-native-core-api-"));
    const persistence = await nativePersistence(t);
    tempDirs.push(root);
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-aborted-proposal-"));
    tempDirs.push(staticDir);
    const store = new CoreStore({ persistence });
    const apiServer = await startCustomApi(store, staticDir, { persistence });
    t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const headers = { Authorization: owner.Authorization, Origin: apiServer.base, "Content-Type": "application/json" };
    const registration = await fetch(`${apiServer.base}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ title: "Native API test project" }),
    });
    assert.equal(registration.status, 201);
    const project = await registration.json() as { id: string };
    const snapshot = (await store.observe(project.id)).snapshot;
    const operation: ChangeOperation = {
      id: "aborted_response_operation", generation: 1, projectId: snapshot.projectId,
      baseProjectVersion: snapshot.projectVersion, effect: "metadata", reads: [],
      writes: [{ path: "meta/scriptorium/modules/publishing/aborted-response.md", revision: null, content: "Pending author decision.\n" }],
      message: "proposal retained across lost response",
    };
    const proposal: ChangeProposal = {
      id: "aborted_response_proposal", snapshot, operations: [operation], source: "author",
    };

    let acknowledgeStored!: () => void;
    const stored = new Promise<void>((resolve) => { acknowledgeStored = resolve; });
    let releaseResponse!: () => void;
    const resume = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const originalPropose = store.propose.bind(store);
    store.propose = async (projectId, input) => {
      const durableProposal = await originalPropose(projectId, input);
      acknowledgeStored();
      await resume; // Simulate a lost response after the disk write, not an unprocessed request.
      return durableProposal;
    };
    const abort = new AbortController();
    const pending = fetch(`${apiServer.base}/api/projects/${project.id}/proposals`, {
      method: "POST", headers, body: JSON.stringify(proposal), signal: abort.signal,
    });
    try {
      await stored;
      abort.abort();
      await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
    } finally {
      releaseResponse();
    }

    const recovered = await store.getProposal(project.id, proposal.id);
    assert.deepEqual(recovered?.proposal, proposal);
    const reopened = new CoreStore({ persistence });
    assert.deepEqual((await reopened.getProposal(project.id, proposal.id))?.proposal, proposal,
      "PostgreSQL retains an unacknowledged proposal across Core reconstruction");
  });

  it("retains a partially applied MCP proposal through exact owner retry after Core reconstruction", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-native-core-api-"));
    const persistence = await nativePersistence(t);
    tempDirs.push(root);
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-proposal-recovery-"));
    tempDirs.push(staticDir);
    let store = new CoreStore({ persistence });
    let apiServer: Awaited<ReturnType<typeof startCustomApi>> | undefined;
    t.after(async () => { if (apiServer) await apiServer.close(); });

    const project = await store.createProject({ title: "Native API test project" });
    const settings = testClientSettings(project.id, signedRequests.publicJwks, signedRequests.isActive);
    apiServer = await startCustomApi(store, staticDir, { persistence, ...settings });
    let owner = signedRequests.ownerHeaders();
    const ownerHeaders = () => ({ ...owner, Origin: apiServer!.base });
    const snapshot = (await store.observe(project.id)).snapshot;
    const operation = (id: string, path: string, content: string): ChangeOperation => ({
      id, generation: 1, projectId: snapshot.projectId, baseProjectVersion: snapshot.projectVersion,
      effect: "metadata", reads: [{ path, revision: null }], writes: [{ path, revision: null, content }],
      message: `Write ${path}`,
    });
    const selected = operation("recovery_selected_op", "meta/recovery/selected.md", "Selected and published.\n");
    const unselected = operation("recovery_unselected_op", "meta/recovery/unselected.md", "Still pending after recovery.\n");
    const proposal: ChangeProposal = {
      id: "recovery_mcp_batch",
      snapshot,
      operations: [selected, unselected],
      source: "mcp",
      evidence: [{
        id: "recovery_mcp_evidence", snapshot, module: "mcp", kind: "source_change_set_mapping", paths: [],
        details: { sourceChangeSetId: "source-change-set-recovery" },
      }],
    };

    const initial = await fetch(`${apiServer.base}/api/projects/${project.id}/proposals`, {
      method: "POST", headers: { Authorization: signedRequests.mcpHeaders().Authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ ...proposal, source: "author" }),
    });
    assert.equal(initial.status, 201);
    assert.deepEqual(await initial.json(), proposal, "new bearer submissions are attributed to MCP regardless of request source");

    const authorOperation = operation("oauth_author_source_op", "meta/recovery/oauth-author.md", "Created by the owner session.\n");
    const authorCreated = await fetch(`${apiServer.base}/api/projects/${project.id}/proposals`, {
      method: "POST", headers: ownerHeaders(),
      body: JSON.stringify({ id: "oauth_author_source", snapshot, operations: [authorOperation], source: "mcp" }),
    });
    assert.equal(authorCreated.status, 201);
    assert.equal((await authorCreated.json() as ChangeProposal).source, "author", "new OAuth author submissions cannot claim MCP provenance");

    const approval = await fetch(`${apiServer.base}/api/projects/${project.id}/approvals`, {
      method: "POST", headers: ownerHeaders(),
      body: JSON.stringify({ proposalId: proposal.id, operationIds: [selected.id] }),
    });
    assert.equal(approval.status, 204);
    const applyResponse = await fetch(`${apiServer.base}/api/projects/${project.id}/apply`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify(selected),
    });
    assert.equal(applyResponse.status, 201);
    const receipt = await applyResponse.json() as { projectVersion: number; operationId: string };
    assert.equal(receipt.operationId, selected.id);
    assert.ok(receipt.projectVersion > snapshot.projectVersion);
    await apiServer.close();
    apiServer = undefined;
    store = new CoreStore({ persistence });
    apiServer = await startCustomApi(store, staticDir, { persistence, ...settings });
    owner = signedRequests.ownerHeaders();
    const recoveredProject = (await store.listProjects()).find((item) => item.id === project.id)!;
    assert.equal(recoveredProject.id, project.id, "PostgreSQL project identity survives host replacement");

    const statusPath = `${apiServer.base}/api/projects/${recoveredProject.id}/proposals/${proposal.id}`;
    const partialResponse = await fetch(statusPath, { headers: { Authorization: owner.Authorization } });
    assert.equal(partialResponse.status, 200);
    const partial = await partialResponse.json() as ProposalStatus;
    assert.equal(partial.proposal.source, "mcp");
    assert.deepEqual(partial.proposal.operations.map(({ id }) => id), [selected.id, unselected.id]);
    assert.deepEqual(partial.proposal, proposal, "PostgreSQL retains the complete private proposal and evidence");
    assert.deepEqual(partial.approvedOperationIds, [selected.id]);
    assert.deepEqual(partial.appliedOperationIds, [selected.id]);

    const retry = await fetch(`${apiServer.base}/api/projects/${recoveredProject.id}/proposals`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify(proposal),
    });
    assert.equal(retry.status, 201);
    assert.deepEqual(await retry.json(), proposal, "the owner retry restores the exact original MCP payload and source");
    const restoredResponse = await fetch(statusPath, { headers: { Authorization: owner.Authorization } });
    const restored = await restoredResponse.json() as ProposalStatus;
    assert.deepEqual(restored.proposal, proposal);
    assert.deepEqual(restored.proposal.operations.map(({ id }) => id), [selected.id, unselected.id]);
    assert.deepEqual(restored.approvedOperationIds, [selected.id], "restoring payload must not approve the remaining operation");
    assert.deepEqual(restored.appliedOperationIds, [selected.id]);

    const changed = {
      ...proposal,
      operations: proposal.operations.map((item) => item.id === unselected.id
        ? { ...item, writes: [{ ...item.writes[0]!, content: "Changed recovered payload.\n" }] }
        : item),
    };
    const changedRetry = await fetch(`${apiServer.base}/api/projects/${recoveredProject.id}/proposals`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify(changed),
    });
    assert.equal(changedRetry.status, 409);
    assert.equal((await changedRetry.json() as { code: string }).code, "proposal_identity_conflict", "Core must keep enforcing the original full-payload digest");

    const unapprovedApply = await fetch(`${apiServer.base}/api/projects/${recoveredProject.id}/apply`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify(unselected),
    });
    assert.equal(unapprovedApply.status, 403);
    assert.equal((await unapprovedApply.json() as { code: string }).code, "operation_not_approved");

    const currentSnapshot = (await store.observe(recoveredProject.id)).snapshot;
    const newAuthorOperation = {
      ...authorOperation,
      projectId: currentSnapshot.projectId,
      baseProjectVersion: currentSnapshot.projectVersion,
    };
    const newAuthorProposal = await fetch(`${apiServer.base}/api/projects/${recoveredProject.id}/proposals`, {
      method: "POST", headers: ownerHeaders(),
      body: JSON.stringify({ id: "new_oauth_after_recovery", snapshot: currentSnapshot, operations: [newAuthorOperation], source: "mcp" }),
    });
    assert.equal(newAuthorProposal.status, 201);
    assert.equal((await newAuthorProposal.json() as ChangeProposal).source, "author", "transport attribution still applies to new OAuth author proposals after recovery");
  });

  it("opens an existing PostgreSQL project outside the bounded project listing", async (t) => {
    const native = await nativeProject(t, "Outside project page");
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-project-page-"));
    tempDirs.push(staticDir);
    native.store.listProjectsPage = async () => ({ projects: [], nextCursor: null });
    const apiServer = await startCustomApi(native.store, staticDir, { persistence: native.persistence });
    t.after(apiServer.close);
    const auth = { Authorization: signedRequests.ownerHeaders().Authorization };
    assert.deepEqual(await (await fetch(`${apiServer.base}/api/projects`, { headers: auth })).json(), { projects: [], nextCursor: null });
    const detail = await fetch(`${apiServer.base}/api/projects/${native.project.id}`, { headers: auth });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json() as { project: { id: string } }).project.id, native.project.id);
    assert.equal((await fetch(`${apiServer.base}/api/projects/missing`, { headers: auth })).status, 404);
  });

  it("serves only the selected editor document revision from the current or pinned snapshot", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-editor-snapshot-"));
    tempDirs.push(staticDir);
    const { persistence, store, project } = await nativeProject(t, "Editor snapshot");
    const created = await persistence.transaction((tx) => tx.createDocument({
      projectId: project.id, kind: "scene", title: "Opening", orderKey: "0001",
      markdown: "First revision", authorId: "owner", idempotencyKey: randomUUID(),
    }));
    const openSnapshot = store.reader.bind(store);
    store.reader = async (...args) => {
      const reader = await openSnapshot(...args);
      return { ...reader, list: async () => assert.fail("Editor snapshots must avoid project-wide file enumeration") };
    };
    const apiServer = await startCustomApi(store, staticDir, { persistence });
    t.after(apiServer.close);
    const endpoint = `${apiServer.base}/api/projects/${project.id}/snapshot`;
    const selector = `projection=editor&documentId=${created.document.id}`;
    const auth = { headers: { Authorization: signedRequests.ownerHeaders().Authorization } };
    assert.equal((await fetch(`${endpoint}?${selector}`)).status, 401);
    for (const query of ["", "?projection=bulk", "?projection=editor&projection=bulk"]) {
      const invalid = await fetch(endpoint + query, auth);
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).code, "INVALID_PROJECTION");
    }
    const malformed = await fetch(`${endpoint}?projection=editor&documentId=../meta/project.yaml`, auth);
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "INVALID_ID");

    const snapshot = (await store.observe(project.id)).snapshot;
    const path = `documents/${created.document.id}.md`;
    const first = await fetch(`${endpoint}?${selector}`, auth);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { snapshot, document: { path, revision: created.revision.sha256 } });
    const noDocument = await fetch(`${endpoint}?projection=editor`, auth);
    assert.equal(noDocument.status, 200);
    assert.deepEqual(await noDocument.json(), { snapshot, document: null });
    const missing = await fetch(`${endpoint}?projection=editor&documentId=${randomUUID()}`, auth);
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), { snapshot, document: null });

    const resultingSha256 = createHash("sha256").update("Second revision").digest("hex");
    await persistence.transaction((tx) => tx.saveDocument({
      projectId: project.id, documentId: created.document.id, baseRevisionId: created.revision.id,
      changes: [{ fromUtf16: 0, toUtf16: 5, insert: "Second" }], resultingSha256,
      authorId: "owner", clientId: "test", idempotencyKey: randomUUID(),
    }));
    const latest = await fetch(`${endpoint}?${selector}`, auth);
    assert.equal(latest.status, 200);
    assert.deepEqual(await latest.json(), {
      snapshot: { projectId: project.id, projectVersion: snapshot.projectVersion + 1 },
      document: { path, revision: resultingSha256 },
    });
    const pinned = await fetch(`${endpoint}?${selector}&projectVersion=${snapshot.projectVersion}`, auth);
    assert.equal(pinned.status, 200);
    assert.deepEqual(await pinned.json(), { snapshot, document: { path, revision: created.revision.sha256 } });
  });

  it("keeps review-queue projectVersion and stale status on one PostgreSQL snapshot", async (t) => {
    const native = await nativeProject(t, "Review queue snapshot");
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-review-snapshot-"));
    tempDirs.push(staticDir);
    const apiServer = await startCustomApi(native.store, staticDir, { persistence: native.persistence });
    t.after(apiServer.close);

    const snapshot = (await native.store.observe(native.project.id)).snapshot;
    const operation: ChangeOperation = {
      id: randomUUID(), generation: 0, projectId: native.project.id,
      baseProjectVersion: snapshot.projectVersion, effect: "metadata", reads: [],
      writes: [{ path: "meta/pending-review.md", revision: null, content: "Pending review\n" }],
      message: "Pending review fixture",
    };
    const proposal: ChangeProposal = {
      id: randomUUID(), snapshot, operations: [operation], source: "author",
    };
    await native.store.propose(native.project.id, proposal);

    let readCompleted!: () => void;
    const completedRead = new Promise<void>((resolveRead) => { readCompleted = resolveRead; });
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolveRead) => { releaseRead = resolveRead; });
    const listProposalsSnapshot = native.store.listProposalsSnapshot.bind(native.store);
    native.store.listProposalsSnapshot = async (projectId) => {
      const result = await listProposalsSnapshot(projectId);
      readCompleted();
      await heldRead;
      return result;
    };

    const responsePromise = fetch(`${apiServer.base}/api/projects/${native.project.id}/review-queue`, {
      headers: { Authorization: signedRequests.ownerHeaders().Authorization },
    });
    try {
      const responseBeforeRead = await Promise.race([
        completedRead.then(() => false),
        responsePromise.then(() => true),
      ]);
      assert.equal(responseBeforeRead, false, "HTTP response completed before the review-list read hook");
      await completedRead;
      await native.persistence.transaction((tx) => tx.createDocument({
        projectId: native.project.id, kind: "volume", title: "Concurrent edit", orderKey: "0001",
        markdown: "", authorId: "owner", idempotencyKey: randomUUID(),
      }));
    } finally {
      releaseRead();
    }

    const response = await responsePromise;
    assert.equal(response.status, 200);
    const body = await response.json() as { snapshot: SnapshotId; proposals: ProposalStatus[] };
    assert.deepEqual(body.snapshot, snapshot);
    assert.equal(body.proposals.find((item) => item.proposal.id === proposal.id)?.stale, false);
    assert.equal((await native.store.observe(native.project.id)).snapshot.projectVersion, snapshot.projectVersion + 1);
  });

  it("review queue delegates once with the admitted project inventory and preserves the exact count", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-review-queue-"));
    tempDirs.push(staticDir);
    const calls: Array<readonly string[] | null> = [];
    const store = Object.assign(makeStore(), {
      async reviewQueue(projectIds: readonly string[] | null) {
        calls.push(projectIds);
        return { unresolvedCount: 1234, items: [] };
      },
      async listProposals() { throw Error("global queue must not expand per-project proposals"); },
    });
    const apiServer = await startCustomApi(store, staticDir);
    t.after(() => apiServer.close());
    assert.equal((await fetch(`${apiServer.base}/api/review-queue`)).status, 401);
    const owner = signedRequests.ownerHeaders();
    const response = await fetch(`${apiServer.base}/api/review-queue`, { headers: { Authorization: owner.Authorization } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { unresolvedCount: 1234, items: [] });
    assert.deepEqual(calls, [null]);
  });

  it("keeps owner event streams scoped, rejects retired synchronization, and closes streams on shutdown", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-project-events-"));
    tempDirs.push(staticDir);
    let forbiddenCalls = 0;
    const store = Object.assign(makeSnapshotStore().store, {
      async sync() { forbiddenCalls++; throw Error("Git sync must never be reached"); },
    });
    const apiServer = await startCustomApi(store, staticDir);
    let closed = false;
    t.after(async () => { if (!closed) await apiServer.close(); });
    const owner = signedRequests.ownerHeaders();
    const stream = await fetch(`${apiServer.base}/api/projects/events`, { headers: { Authorization: owner.Authorization } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/u);
    assert.equal((await fetch(`${apiServer.base}/api/projects/events`)).status, 401);
    for (const suffix of ["sync", "reconcile", "publish", "checkpoints"]) {
      const response = await fetch(`${apiServer.base}/api/projects/project-1/${suffix}`, {
        method: "POST", headers: { Authorization: owner.Authorization, Origin: apiServer.base, "Content-Type": "application/json" }, body: "{}",
      });
      assert.equal(response.status, 404, `${suffix} must not retain a Git fallback`);
    }
    assert.equal(forbiddenCalls, 0);
    const reader = stream.body!.getReader();
    const shutdownAt = Date.now();
    await apiServer.close(); closed = true;
    assert.equal((await reader.read()).done, true, "shutdown closes the admitted event stream");
    assert.ok(Date.now() - shutdownAt < 5_000, "shutdown closes owner streams without an indefinite wait");
  });


  it("rejects repository reconstruction and detachment without calling retired Core ports", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-project-management-"));
    tempDirs.push(staticDir);
    let retiredCalls = 0;
    const store = Object.assign(makeSnapshotStore().store, {
      async reconstructProject() { retiredCalls++; }, async detachProject() { retiredCalls++; },
    });
    const apiServer = await startCustomApi(store, staticDir); t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const routeAuthHeaders: Record<string, string>[] = [
      { Authorization: signedRequests.mcpHeaders().Authorization },
      { Authorization: owner.Authorization, Origin: apiServer.base },
    ];
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      for (const auth of routeAuthHeaders) {
        const response = await fetch(`${apiServer.base}/api/projects/project-1`, {
          method, headers: { ...auth, ...(method === "DELETE" ? {} : { "Content-Type": "application/json" }) },
          ...(method !== "DELETE" ? { body: JSON.stringify({ url: "https://github.com/other/repo.git", token: "must-not-echo", autoMerge: true }) } : {}),
        });
        const responseText = await response.text();
        assert.equal(response.status, 404, `${method} /api/projects/project-1 returned ${response.status}: ${responseText}`);
        assert.equal(responseText.includes("must-not-echo"), false);
      }
    }
    const legacyRegistration = await fetch(`${apiServer.base}/api/projects`, {
      method: "POST", headers: { Authorization: owner.Authorization, Origin: apiServer.base, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/other/repo.git", token: "must-not-echo" }),
    });
    assert.equal(legacyRegistration.status, 400);
    assert.equal((await legacyRegistration.text()).includes("must-not-echo"), false);
    assert.equal(retiredCalls, 0);
  });


  it("keeps native PostgreSQL revisions intact when retired Git management requests are attempted", async (t) => {
    const persistence = await nativePersistence(t);
    const store = new CoreStore({ persistence });
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-native-project-")); tempDirs.push(staticDir);
    const apiServer = await startCustomApi(store, staticDir, { persistence }); t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const headers = { Authorization: owner.Authorization, Origin: apiServer.base };
    const registration = await fetch(`${apiServer.base}/api/projects`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Native project" }),
    });
    assert.equal(registration.status, 201);
    const project = await registration.json() as { id: string };
    const snapshot = (await store.observe(project.id)).snapshot;
    const operation: ChangeOperation = { id: "retained-native-file", generation: 1, projectId: project.id,
      baseProjectVersion: snapshot.projectVersion, effect: "metadata", reads: [],
      writes: [{ path: "meta/retained.md", revision: null, content: "Durable native content\n" }], message: "Native durability" };
    const proposal = { id: "native-durability-proposal", snapshot, operations: [operation], source: "author" as const };
    await store.propose(project.id, proposal);
    await store.approve(project.id, { proposalId: proposal.id, operationIds: [operation.id], authorScope: "owner" });
    const applied = await store.apply(project.id, operation);
    for (const [method, suffix] of [["PUT", ""], ["DELETE", ""], ["POST", "/sync"], ["POST", "/publish"]]) {
      const response = await fetch(`${apiServer.base}/api/projects/${project.id}${suffix}`, {
        method, headers: { ...headers, ...(method === "DELETE" ? {} : { "Content-Type": "application/json" }) },
        ...(method !== "DELETE" ? { body: JSON.stringify({ url: "/tmp/forbidden.git" }) } : {}),
      });
      assert.equal(response.status, 404, `${method} /api/projects/${project.id}${suffix} returned ${response.status}: ${await response.clone().text()}`);
    }
    const reopened = new CoreStore({ persistence });
    assert.equal((await reopened.observe(project.id)).snapshot.projectVersion, applied.projectVersion);
    assert.equal((await (await reopened.reader(project.id)).read("meta/retained.md"))?.content, "Durable native content\n");
    assert.deepEqual(await reopened.apply(project.id, operation), applied, "retry retains operation identity and does not apply twice");
  });


  it("allows bearer compute under runtime effect limits and host-assigns MCP proposal source", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-effects-"));
    const cacheDir = await mkdtemp(resolve(tmpdir(), "codexia-api-effects-cache-"));
    tempDirs.push(staticDir, cacheDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir, { runtime: actionBoundaryRuntime(cacheDir) });
    t.after(apiServer.close);
    const bearer = { Authorization: signedRequests.mcpHeaders().Authorization, "Content-Type": "application/json" };

    const version = await fetch(`${apiServer.base}/api/version`);
    assert.deepEqual((await version.json() as { auth: string[] }).auth, ["oauth-owner", "oauth-mcp"]);
    const computed = await fetch(`${apiServer.base}/api/projects/project-1/actions/nlp.analyze`, {
      method: "POST", headers: bearer, body: JSON.stringify({ input: {} }),
    });
    const computeResult = await computed.json() as ActionResult<{ nested: ActionResult }>;
    assert.equal(computeResult.ok, true);
    assert.equal(computeResult.ok && computeResult.data.nested.ok, false);
    assert.equal(computeResult.ok && !computeResult.data.nested.ok && computeResult.data.nested.error.code, "action_effect_denied");
    assert.equal(fixture.proposed.length, 0, "compute must not reach a host proposal port");

    const httpCompute = await fetch(`${apiServer.base}/api/projects/project-1/modules/mcp/compute`, {
      method: "POST", headers: bearer, body: JSON.stringify({ operation: { id: "must-not-propose" } }),
    });
    assert.equal(httpCompute.status, 200);
    const httpComputeResult = await httpCompute.json() as {
      document: string | null;
      nested: ActionResult<{ nested: ActionResult }>;
      proposalCode: string | null;
    };
    assert.equal(httpComputeResult.document, "---\nid: scene-one\n---\n\nA harbor at night.\n", "bearer compute contributions receive the selected snapshot reader");
    assert.equal(httpComputeResult.nested.ok, true);
    assert.equal(httpComputeResult.nested.ok && httpComputeResult.nested.data.nested.ok, false);
    assert.equal(httpComputeResult.nested.ok && !httpComputeResult.nested.data.nested.ok && httpComputeResult.nested.data.nested.error.code, "action_effect_denied");
    assert.equal(httpComputeResult.proposalCode, "action_effect_denied", "HTTP compute may not use the host proposal capability");
    assert.equal(fixture.proposed.length, 0, "bearer HTTP compute must not reach the proposal coordinator");

    const operation: ChangeOperation = {
      id: "mcp-owner-operation", generation: 0, projectId: SNAPSHOT.projectId, baseProjectVersion: SNAPSHOT.projectVersion,
      effect: "metadata", reads: [], writes: [], message: "MCP contribution proposal",
    };
    const owner = signedRequests.ownerHeaders();
    const actionProposal = await fetch(`${apiServer.base}/api/projects/project-1/actions/mcp.propose`, {
      method: "POST",
      headers: { Authorization: owner.Authorization, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ input: operation }),
    });
    assert.equal(actionProposal.status, 200);
    assert.equal((await actionProposal.json() as ActionResult<{ proposal: ChangeProposal }>).ok, true);
    assert.equal(fixture.proposed[0]?.source, "mcp");

    const httpProposal = await fetch(`${apiServer.base}/api/projects/project-1/modules/mcp/propose`, {
      method: "POST",
      headers: { Authorization: owner.Authorization, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify(operation),
    });
    assert.equal(httpProposal.status, 200);
    assert.deepEqual(await httpProposal.json(), { source: "mcp" });
    assert.equal(fixture.proposed[1]?.source, "mcp");
  });

  it("denies hosted read grants native proposals through direct and nested MCP calls", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-native-admission-"));
    const cacheDir = await mkdtemp(resolve(tmpdir(), "codexia-api-native-admission-cache-"));
    tempDirs.push(staticDir, cacheDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startHostedApi(fixture.store, staticDir, hostedTestPolicy(), undefined, actionBoundaryRuntime(cacheDir));
    t.after(apiServer.close);
    const input = { projectVersion: 1, idempotencyKey: "native-denied", operations: [] };
    const direct = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.knowledge.propose`, {
      method: "POST", headers: { Authorization: "Bearer read-grant", "Content-Type": "application/json" }, body: JSON.stringify({ input }),
    });
    assert.equal(direct.status, 403, "direct action admission requires a current Hosted write grant");

    const nested = await fetch(`${apiServer.base}/api/projects/project-1/modules/mcp/native-propose`, {
      method: "POST", headers: { Authorization: "Bearer read-grant", "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal(nested.status, 200);
    const nestedResult = await nested.json() as ActionResult;
    assert.equal(nestedResult.ok, false);
    if (!nestedResult.ok) assert.equal(nestedResult.error.code, "WRITE_PERMISSION_REQUIRED");

    const cookieMcp = await rawHostedRequest(`${apiServer.base}/api/projects/project-1/modules/mcp/native-propose`, {
      Host: "instance-1.instances.example", "X-Forwarded-Proto": "https", Origin: HOSTED_ASSIGNMENT.grantPolicy.audience,
      Cookie: "__Host-praetorium_access=read-grant; __Host-praetorium_csrf=csrf-value", "X-CSRF-Token": "csrf-value", "Content-Type": "application/json",
    }, JSON.stringify(input));
    assert.equal(cookieMcp.status, 200);
    const cookieResult = JSON.parse(cookieMcp.body) as ActionResult;
    assert.equal(cookieResult.ok, false, "cookie-authenticated MCP still uses the host write authorization callback");
    if (!cookieResult.ok) assert.equal(cookieResult.error.code, "WRITE_PERMISSION_REQUIRED");
    assert.equal(fixture.proposed.length, 0, "native ChangeSet proposals never use the path-based proposal store");
  });

  it("passes public module requests through the registered relative route with a fresh remote reader", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-module-"));
    const cacheDir = await mkdtemp(resolve(tmpdir(), "codexia-api-module-cache-"));
    tempDirs.push(staticDir, cacheDir);
    const observed: PublishingObservations = { paths: [] };
    const runtime = publishingRuntime(cacheDir, observed);
    const apiServer = await startCustomApi(makeSnapshotStore().store, staticDir, { runtime });
    t.after(apiServer.close);

    const descriptors = await fetch(`${apiServer.base}/api/projects/project-1/actions`, { headers: { Authorization: signedRequests.mcpHeaders().Authorization } });
    const actions = (await descriptors.json() as { actions: Array<{ id: string }> }).actions;
    assert.ok(actions.some(({ id }) => id === "publishing.read-core"));
    const invoked = await fetch(`${apiServer.base}/api/projects/project-1/actions/publishing.read-core`, {
      method: "POST", headers: { Authorization: signedRequests.mcpHeaders().Authorization, "Content-Type": "application/json" }, body: JSON.stringify({ input: {} }),
    });
    const invokedBody = await invoked.json() as { ok: boolean; data: unknown };
    assert.equal(invokedBody.ok, true, JSON.stringify(invokedBody));

    const ownerRoute = await fetch(`${apiServer.base}/api/projects/project-1/modules/publishing/share/secret`);
    assert.equal(ownerRoute.status, 401);
    const publicResponse = await fetch(`${apiServer.base}/api/public/projects/project-1/modules/publishing/share/secret?lang=en`, {
      headers: {
        Authorization: signedRequests.mcpHeaders().Authorization,
        Cookie: "ambient-browser-cookie=fixture-value",
        "Proxy-Authorization": "Basic ambient-proxy-secret",
        "Mcp-Session-Id": "mcp-session-123",
      },
    });
    assert.equal(publicResponse.status, 200);
    const publicBody = await publicResponse.json() as { path: string; access: string; snapshot: string };
    assert.equal(publicBody.path, "/share/secret");
    assert.equal(publicBody.access, "project-1");
    assert.equal(publicBody.snapshot, SNAPSHOT.projectVersion);
    assert.deepEqual(observed.paths, ["/share/secret"]);
    assert.equal(publicResponse.headers.get("cache-control"), "no-store");
    assert.equal(publicResponse.headers.get("referrer-policy"), "no-referrer");
    assert.equal(publicResponse.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.deepEqual(observed.forwardedHeaders, {
      authorization: null,
      cookie: null,
      proxyAuthorization: null,
      mcpSessionId: "mcp-session-123",
    });
    assert.equal(observed.publicCoreActions?.ok, false);
    assert.equal(observed.publicCoreActions?.ok === false && observed.publicCoreActions.error.code, "public_action_unavailable");
    assert.equal(observed.publicActionIds?.some((id) => id.startsWith("core.")), false);
    assert.equal(observed.linkedReaderError, "public_access_restricted");
  });

  it("bounds shutdown when an in-flight module handler ignores cancellation", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-drain-"));
    const cacheDir = await mkdtemp(resolve(tmpdir(), "codexia-api-drain-cache-"));
    tempDirs.push(staticDir, cacheDir);
    const manifest: ModuleManifest = {
      id: "mcp", version: "0.1.0", contractVersion: 1,
      dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
    };
    let markEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered; });
    const definition: ModuleDefinition = {
      manifest, actions: [], ui: [],
      http: [{
        id: "hang", path: "hang", methods: ["GET"], access: "owner", effect: "read",
        async handle() { markEntered(); return await new Promise<Response>(() => undefined); },
      }],
      async dispose() {},
    };
    const runtime = new ModuleRuntime({
      manifests: [manifest], enabled: ["mcp"], cacheDirectory: cacheDir, moduleDrainTimeoutMs: 50,
      loaders: { mcp: async () => definition },
    });
    const apiServer = await startCustomApi(makeSnapshotStore().store, staticDir, { runtime });
    let closeCalled = false;
    t.after(async () => { if (!closeCalled) await apiServer.close().catch(() => undefined); });
    const request = fetch(`${apiServer.base}/api/projects/project-1/modules/mcp/hang`, {
      headers: { Authorization: signedRequests.mcpHeaders().Authorization },
    }).catch((error: unknown) => error);
    await entered;
    const startedAt = Date.now();
    closeCalled = true;
    const closeError = await apiServer.close().then(() => undefined, (error: unknown) => error);
    assert.ok(Date.now() - startedAt < 7_000, "server.close must finish after the bounded drain deadline");
    assert.equal((closeError as { code?: string } | undefined)?.code, "module_drain_timeout");
    assert.ok(await request instanceof Error, "the forcibly closed in-flight request must terminate");
  });

  it("stores scratch text and bounded attachments only through Core proposal/checkpoint operations", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-scratch-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const raw = Buffer.from([0, 1, 2, 250]);
    const response = await fetch(`${apiServer.base}/api/projects/project-1/scratch`, {
      method: "POST", headers: { Authorization: owner.Authorization, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ text: "", source: "camera", sceneId: "scene-one", attachments: [{ filename: "../../note.png", mimeType: "image/png", dataBase64: raw.toString("base64") }] }),
    });
    assert.equal(response.status, 201);
    const result = await response.json() as { attachments: Array<{ path: string; filename: string }>; proposal: ChangeProposal };
    assert.equal(result.attachments[0]?.filename.includes("/"), false);
    assert.equal(result.proposal.source, "author");
    const writes = fixture.proposed[0]?.operations[0]?.writes ?? [];
    const attachment = writes.find((write) => write.encoding === "base64");
    assert.ok(attachment);
    assert.equal(Buffer.from(attachment.content ?? "", "base64").toString("hex"), raw.toString("hex"));
    assert.ok(writes.some((write) => write.path.endsWith(".md") && write.content?.includes("![")));
    assert.equal(fixture.approvals[0]?.authorScope, "owner");
  });

  it("passes a large canonical base64 attachment through the bounded validator unchanged", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-large-scratch-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const raw = Buffer.alloc(6 * 1024 * 1024 + 2, 0x5a);
    const dataBase64 = raw.toString("base64");
    assert.ok(dataBase64.endsWith("=") && !dataBase64.endsWith("=="), "large one-byte-padding input exercises canonical final-group validation");
    const response = await fetch(`${apiServer.base}/api/projects/project-1/scratch`, {
      method: "POST", headers: { Authorization: owner.Authorization, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ text: "Large canonical attachment", attachments: [{ filename: "large.bin", mimeType: "application/octet-stream", dataBase64 }] }),
    });
    assert.equal(response.status, 201);
    await response.arrayBuffer();
    const attachment = fixture.proposed[0]?.operations[0]?.writes.find((write) => write.encoding === "base64");
    assert.ok(attachment);
    assert.equal(attachment.content, dataBase64);
    assert.equal(createHash("sha256").update(Buffer.from(attachment.content ?? "", "base64")).digest("hex"),
      createHash("sha256").update(raw).digest("hex"));
    assert.equal(fixture.approvals.length, 1);
  });

  it("rejects malformed large base64 attachments before calling Core", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-invalid-large-scratch-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const dataBase64 = Buffer.alloc(6 * 1024 * 1024, 0x5a).toString("base64");
    const malformedEncodings = [
      `${dataBase64.slice(0, -1)}!`,
      "AB==", // nonzero unused pad bits
      "AA=A", // padding before the end
      "AAA", // missing canonical padding
    ];
    for (const malformedBase64 of malformedEncodings) {
      const response = await fetch(`${apiServer.base}/api/projects/project-1/scratch`, {
        method: "POST", headers: { Authorization: owner.Authorization, "Content-Type": "application/json", Origin: apiServer.base },
        body: JSON.stringify({ text: "Malformed attachment", attachments: [{ filename: "large.bin", mimeType: "application/octet-stream", dataBase64: malformedBase64 }] }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code?: string }).code, "INVALID_SCRATCH_ATTACHMENT");
    }
    assert.equal(fixture.proposed.length, 0);
    assert.equal(fixture.approvals.length, 0);
  });

  it("rejects an attachment one byte over the raw cap before calling Core", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-api-oversize-scratch-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const owner = signedRequests.ownerHeaders();
    const dataBase64 = Buffer.alloc(8 * 1024 * 1024 + 1, 0x5a).toString("base64");
    const requestBody = JSON.stringify({ text: "Over the raw attachment cap", attachments: [{ filename: "large.bin", mimeType: "application/octet-stream", dataBase64 }] });
    assert.ok(Buffer.byteLength(requestBody) < 12 * 1024 * 1024, "the request remains within the existing JSON parser cap");
    const response = await fetch(`${apiServer.base}/api/projects/project-1/scratch`, {
      method: "POST", headers: { Authorization: owner.Authorization, "Content-Type": "application/json", Origin: apiServer.base }, body: requestBody,
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json() as { code?: string }).code, "SCRATCH_ATTACHMENT_TOO_LARGE");
    assert.equal(fixture.proposed.length, 0);
    assert.equal(fixture.approvals.length, 0);
  });

  it("stores project recent activity for OAuth authors across API restarts and rejects MCP or cross-origin access", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "codexia-api-recent-activity-"));
    const staticDir = resolve(root, "static");
    const usageDirectory = resolve(root, "host-history");
    await mkdir(staticDir);
    tempDirs.push(root);
    const native = await nativeProject(t, "Recent activity primary project");
    const secondProject = await native.store.createProject({ title: `Recent activity second project ${randomUUID()}` });
    let observeCalls = 0;
    native.store.observe = async () => {
      observeCalls += 1;
      throw new Error("simulated unavailable project observation");
    };
    const settings = testClientSettings(native.project.id, signedRequests.publicJwks, signedRequests.isActive);
    let apiServer = await startCustomApi(native.store, staticDir, { usageDirectory, persistence: native.persistence, ...settings });
    t.after(() => apiServer.close().catch(() => undefined));
    let owner = signedRequests.ownerHeaders();
    const ownerJson = { Authorization: owner.Authorization, Origin: apiServer.base, "Content-Type": "application/json" };

    const empty = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, { headers: { Authorization: owner.Authorization } });
    assert.deepEqual(await empty.json(), { items: [] });
    assert.deepEqual(await (await fetch(`${apiServer.base}/api/projects/${secondProject.id}/recent-activity`, { headers: { Authorization: owner.Authorization } })).json(), { items: [] });
    assert.equal(observeCalls, 0, "project activity reads do not require a Core observation");
    const desktopFirst = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, {
      method: "PUT", headers: ownerJson,
      body: JSON.stringify({ sceneId: "scene-one", sentenceOffset: 3, pageIndex: 7, deviceType: "desktop" }),
    });
    assert.equal(desktopFirst.status, 200);
    const desktopFirstBody = await desktopFirst.json() as { items: Array<{ pageIndex: number | null; deviceType: string }> };
    assert.equal(desktopFirstBody.items[0]?.pageIndex, 7);

    const desktopUpdate = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, {
      method: "PUT", headers: ownerJson,
      body: JSON.stringify({ sceneId: "scene-two", sentenceOffset: null, deviceType: "desktop" }),
    });
    const desktopUpdateBody = await desktopUpdate.json() as { items: Array<{ pageIndex: number | null; deviceType: string }> };
    assert.equal(desktopUpdateBody.items.find((item) => item.deviceType === "desktop")?.pageIndex, 7);
    const writer = randomUUID();
    const ordered = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, {
      method: "PUT", headers: { ...ownerJson, "X-Codexia-Recent-Activity-Order": `${writer}:2` },
      body: JSON.stringify({ sceneId: "scene-two", sentenceOffset: null, deviceType: "desktop" }),
    });
    assert.equal(ordered.status, 200);
    const invalidOrder = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, {
      method: "PUT", headers: { ...ownerJson, "X-Codexia-Recent-Activity-Order": "invalid" },
      body: JSON.stringify({ sceneId: "wrong", sentenceOffset: 1, deviceType: "desktop" }),
    });
    assert.equal(invalidOrder.status, 400);
    const mobileUpdate = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, {
      method: "PUT", headers: ownerJson,
      body: JSON.stringify({ sceneId: "scene-mobile", sentenceOffset: 1, pageIndex: null, deviceType: "mobile" }),
    });
    assert.equal((await mobileUpdate.json() as { items: unknown[] }).items.length, 2);
    const secondProjectActivity = await fetch(`${apiServer.base}/api/projects/${secondProject.id}/recent-activity`, {
      method: "PUT", headers: ownerJson,
      body: JSON.stringify({ sceneId: "second-project-scene", sentenceOffset: 2, deviceType: "desktop" }),
    });
    assert.equal((await secondProjectActivity.json() as { items: unknown[] }).items.length, 1);

    const bearerRead = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, { headers: { Authorization: signedRequests.mcpHeaders().Authorization } });
    assert.equal(bearerRead.status, 403, "MCP credentials cannot read author activity for their assigned project");
    const crossOriginWrite = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, {
      method: "PUT", headers: { ...ownerJson, Origin: "https://foreign.example" },
      body: JSON.stringify({ sceneId: "foreign", sentenceOffset: 0, deviceType: "mobile" }),
    });
    assert.equal(crossOriginWrite.status, 403);
    const malformed = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, {
      method: "PUT", headers: ownerJson,
      body: JSON.stringify({ sceneId: "scene-one", sentenceOffset: 0.5, deviceType: "desktop" }),
    });
    assert.equal(malformed.status, 400);
    assert.equal(observeCalls, 0, "cursor writes do not depend on project observation availability");

    await apiServer.close();
    apiServer = await startCustomApi(native.store, staticDir, { usageDirectory, persistence: native.persistence, ...settings });
    owner = signedRequests.ownerHeaders();
    observeCalls = 0;
    const afterRestart = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, { headers: { Authorization: owner.Authorization } });
    const restored = await afterRestart.json() as { items: Array<{ sceneId: string; pageIndex: number | null; deviceType: string }> };
    assert.equal(restored.items.length, 2);
    assert.equal(restored.items.find((item) => item.deviceType === "desktop")?.sceneId, "scene-two");
    assert.equal(restored.items.find((item) => item.deviceType === "desktop")?.pageIndex, 7);
    assert.equal(restored.items.find((item) => item.deviceType === "mobile")?.sceneId, "scene-mobile");
    const stale = await fetch(`${apiServer.base}/api/projects/${native.project.id}/recent-activity`, {
      method: "PUT", headers: { Authorization: owner.Authorization, Origin: apiServer.base, "Content-Type": "application/json",
        "X-Codexia-Recent-Activity-Order": `${writer}:1` },
      body: JSON.stringify({ sceneId: "older", sentenceOffset: 1, deviceType: "desktop" }),
    });
    assert.equal(stale.status, 200);
    const staleItems = await stale.json() as typeof restored;
    assert.deepEqual(staleItems, restored, "a delayed request after restart cannot rewind the accepted cursor");
    assert.equal(observeCalls, 0, "persisted cursors remain available while Core observation is unavailable after restart");
    const secondAfterRestart = await fetch(`${apiServer.base}/api/projects/${secondProject.id}/recent-activity`, { headers: { Authorization: owner.Authorization } });
    const secondRestored = await secondAfterRestart.json() as { items: Array<{ sceneId: string }> };
    assert.deepEqual(secondRestored.items.map((item) => item.sceneId), ["second-project-scene"], "recent activity stays scoped to its PostgreSQL project identity");
  });
});


for (const phase of ["read", "write"] as const) {
  it(`Hosted ${phase} reports credential denial, permission denial, and provider outages distinctly`, async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), "codexia-auth-outage-"));
    const normal = hostedTestPolicy();
    const privateDetail = "private upstream detail";
    let upstreamFailure: Error;
    const policy: HostedAuthorizationPolicy = {
      ...normal,
      async authenticate(token, permission = "read") {
        if (permission === phase) throw upstreamFailure;
        return normal.authenticate(token, permission);
      },
    };
    const apiServer = await startHostedApi(makeStore(), directory, policy, undefined, undefined, resolve(directory, "history"));
    t.after(async () => {
      await apiServer.close();
      await rm(directory, { recursive: true, force: true });
    });
    const permissionDenial = phase === "read" ? "FORBIDDEN" : "WRITE_PERMISSION_REQUIRED";
    const cases = [
      { upstreamStatus: 401, status: 401, code: "UNAUTHORIZED" },
      { upstreamStatus: 403, status: 403, code: permissionDenial },
      { upstreamStatus: 502, status: 502, code: "AUTHORIZATION_UNAVAILABLE" },
      { upstreamStatus: 503, status: 503, code: "AUTHORIZATION_UNAVAILABLE" },
      { upstreamStatus: undefined, status: 503, code: "AUTHORIZATION_UNAVAILABLE" },
    ];
    for (const { upstreamStatus, status, code } of cases) {
      upstreamFailure = new Error(privateDetail);
      if (upstreamStatus !== undefined) Object.assign(upstreamFailure, { status: upstreamStatus });
      const path = phase === "read" ? "/api/session" : "/api/inbox/read-all";
      const response = await fetch(`${apiServer.base}${path}`, {
        method: phase === "read" ? "GET" : "POST", headers: { Authorization: "Bearer write-grant" },
      });
      assert.equal(response.status, status, `upstream status ${upstreamStatus}`);
      assert.equal(response.headers.has("www-authenticate"), false);
      const body = await response.json() as { code: string; error: string };
      assert.equal(body.code, code);
      assert.doesNotMatch(body.error, /private upstream detail/u);
    }
  });
}


it("Hosted Bearer write grants can propose but cannot perform author-only persistence, approval, or apply", async (t) => {
  const fixture = makeSnapshotStore();
  let documentWrites = 0;
  const persistence = {
    ...admissionPersistence(fixture.store),
    async transaction<T>(work: (transaction: { createDocument(input: unknown): Promise<unknown> }) => Promise<T>): Promise<T> {
      documentWrites += 1;
      return work({ async createDocument(input) { return { id: "author-document", input }; } });
    },
  } as unknown as Persistence;
  const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-hosted-author-session-"));
  const apiServer = await startHostedApi(fixture.store, staticDir, hostedTestPolicy(), undefined, undefined, undefined, persistence);
  t.after(async () => { await apiServer.close(); await rm(staticDir, { recursive: true, force: true }); });

  const bearerHeaders = { Authorization: "Bearer write-grant", "Content-Type": "application/json" };
  const documentPath = `${apiServer.base}/api/v1/persistence/projects/project-1/documents`;
  const bearerDocument = await fetch(documentPath, {
    method: "POST", headers: bearerHeaders,
    body: JSON.stringify({ kind: "scene", title: "Bearer document", markdown: "Denied." }),
  });
  assert.equal(bearerDocument.status, 403);
  assert.equal((await bearerDocument.json() as { code: string }).code, "AUTHOR_SESSION_REQUIRED");
  assert.equal(documentWrites, 0, "a bearer grant must be rejected before native Persistence.transaction");

  const operation: ChangeOperation = {
    id: "hosted-review-operation", generation: 0, projectId: "project-1", baseProjectVersion: 1,
    effect: "metadata", reads: [], writes: [], message: "Reviewable hosted proposal",
  };
  const proposalResponse = await fetch(`${apiServer.base}/api/projects/project-1/proposals`, {
    method: "POST", headers: bearerHeaders,
    body: JSON.stringify({ id: "hosted-review-proposal", snapshot: SNAPSHOT, operations: [operation] }),
  });
  assert.equal(proposalResponse.status, 201, "a Hosted write grant may submit an MCP proposal");

  const bearerApproval = await fetch(`${apiServer.base}/api/projects/project-1/approvals`, {
    method: "POST", headers: bearerHeaders,
    body: JSON.stringify({ proposalId: "hosted-review-proposal", operationIds: [operation.id] }),
  });
  assert.equal(bearerApproval.status, 403);
  assert.equal((await bearerApproval.json() as { code: string }).code, "AUTHOR_SESSION_REQUIRED");
  const bearerApply = await fetch(`${apiServer.base}/api/projects/project-1/apply`, {
    method: "POST", headers: bearerHeaders, body: JSON.stringify(operation),
  });
  assert.equal(bearerApply.status, 403);
  assert.equal((await bearerApply.json() as { code: string }).code, "AUTHOR_SESSION_REQUIRED");
  const deniedScratch = await fetch(`${apiServer.base}/api/projects/project-1/scratch`, {
    method: "POST", headers: bearerHeaders, body: JSON.stringify({ text: "Bearer scratch" }),
  });
  assert.equal(deniedScratch.status, 403);
  assert.equal((await deniedScratch.json() as { code: string }).code, "AUTHOR_SESSION_REQUIRED");
  assert.equal(fixture.approvals.length, 0);
  assert.equal(fixture.proposed.length, 1);

  const cookieHeaders = {
    Host: "instance-1.instances.example", "X-Forwarded-Proto": "https", Origin: HOSTED_ASSIGNMENT.grantPolicy.audience,
    Cookie: "__Host-praetorium_access=write-grant; __Host-praetorium_csrf=csrf-value",
    "X-CSRF-Token": "csrf-value", "Content-Type": "application/json", "Idempotency-Key": "hosted-author-document-1",
  };
  const authorDocument = await rawHostedRequest(documentPath, cookieHeaders,
    JSON.stringify({ kind: "scene", title: "Author document", markdown: "Saved by author." }));
  assert.equal(authorDocument.status, 201, authorDocument.body);
  assert.equal(documentWrites, 1);
  const authorApproval = await rawHostedRequestStatus(`${apiServer.base}/api/projects/project-1/approvals`, cookieHeaders,
    JSON.stringify({ proposalId: "hosted-review-proposal", operationIds: [operation.id] }));
  assert.equal(authorApproval, 204);
  assert.equal(fixture.approvals[0]?.authorScope, "hosted:writer-1");
  const authorApply = await rawHostedRequestStatus(`${apiServer.base}/api/projects/project-1/apply`, cookieHeaders, JSON.stringify(operation));
  assert.equal(authorApply, 201);
});

it("portable work API enforces authentication, author writes, origin, hosted assignment and replay", async (t) => {
  const native = await nativeProject(t, "Portable HTTP");
  const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-archive-http-"));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const apiServer = await startCustomApi(native.store, staticDir, { persistence: native.persistence });
  t.after(apiServer.close);
  const url = apiServer.base + "/api/v1/persistence/projects/" + native.project.id + "/archive";
  assert.equal((await fetch(url)).status, 401);
  const owner = signedRequests.ownerHeaders();
  const exported = await fetch(url, { headers: { Authorization: owner.Authorization } });
  assert.equal(exported.status, 200);
  const archive = await exported.json() as { format: string; documents: unknown[] };
  assert.equal(archive.format, "codexia-work/v1");
  assert.deepEqual(archive.documents, []);
  const endpoint = apiServer.base + "/api/v1/persistence/import";
  const requestBody = JSON.stringify(archive);
  const bearer = await fetch(endpoint, { method: "POST", headers: {
    Authorization: signedRequests.mcpHeaders().Authorization, "Content-Type": "application/json"
  }, body: requestBody });
  assert.equal(bearer.status, 403, "Bearer read access must not create works");
  const forbiddenOrigin = await fetch(endpoint, { method: "POST", headers: {
    Authorization: owner.Authorization, Origin: "https://other.example", "Content-Type": "application/json"
  }, body: requestBody });
  assert.equal(forbiddenOrigin.status, 403, "Cookie writes require same origin");
  const headers = { Authorization: owner.Authorization, Origin: apiServer.base, "Content-Type": "application/json" };
  const importResponse = await fetch(endpoint, { method: "POST", headers, body: requestBody });
  assert.equal(importResponse.status, 201);
  const imported = await importResponse.json() as { project: { id: string }; replayed: boolean };
  assert.equal(imported.replayed, false);
  assert.notEqual(imported.project.id, native.project.id);
  const repeated = await fetch(endpoint, { method: "POST", headers, body: requestBody });
  assert.equal(repeated.status, 201);
  const replay = await repeated.json() as { project: { id: string }; replayed: boolean };
  assert.equal(replay.replayed, true);
  assert.equal(replay.project.id, imported.project.id);
  const importedExport = await fetch(apiServer.base + "/api/v1/persistence/projects/" + imported.project.id + "/archive", { headers: { Authorization: owner.Authorization } });
  assert.equal(importedExport.status, 200);
  assert.equal((await importedExport.json() as { project: { title: string } }).project.title, native.project.title);

  const hosted = await startHostedApi(native.store, staticDir, hostedTestPolicy(), undefined, undefined, undefined, native.persistence, native.project.id);
  t.after(hosted.close);
  const hostedImport = await fetch(hosted.base + "/api/v1/persistence/import", { method: "POST", headers: {
    Authorization: "Bearer write-grant", "Content-Type": "application/json"
  }, body: requestBody });
  assert.equal(hostedImport.status, 403);
  const hostedOtherWork = await fetch(hosted.base + "/api/v1/persistence/projects/" + imported.project.id + "/archive", {
    headers: { Authorization: "Bearer read-grant" }
  });
  assert.equal(hostedOtherWork.status, 404);
});

it("native actions use real PostgreSQL through standalone and Hosted composed admission", async (t) => {
  const native = await nativeProject(t, "Native action review");
  const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-native-action-real-"));
  const cacheDir = await mkdtemp(resolve(tmpdir(), "codexia-native-action-cache-"));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const client = createSignedRequestFixture();
  const settings = testClientSettings(native.project.id, client.publicJwks, client.isActive);
  const standalone = await startCustomApi(native.store, staticDir, { persistence: native.persistence, ...settings });
  t.after(standalone.close);
  const hosted = await startHostedApi(native.store, staticDir, hostedTestPolicy(), undefined, actionBoundaryRuntime(cacheDir), undefined, native.persistence, native.project.id);
  t.after(hosted.close);
  const projectId = native.project.id as import("@codexia/persistence-contracts").ProjectId;
  const nodeId = randomUUID() as import("@codexia/persistence-contracts").KnowledgeNodeId;
  const projectVersion = (await native.persistence.read(reader => reader.getProject(projectId)))!.version;
  const payload = { projectVersion, idempotencyKey: "action-real", operations: [{ type: "knowledge.node.save", command: { projectId, id: nodeId, type: "person", name: "Native action", attributes: {}, status: "confirmed", expectedVersion: null } }] };
  const headers = client.mcpHeaders();
  const actionPath = "/api/projects/" + projectId + "/actions/";
  const response = await fetch(standalone.base + actionPath + "core.knowledge.propose", { method: "POST", headers, body: JSON.stringify({ input: payload }) });
  const result = await response.json() as ActionResult;
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Native proposal failed");
  const proposed = (result.data as { changeSet: import("@codexia/persistence-contracts").ChangeSet }).changeSet;
  assert.equal(proposed.authorId, "owner");
  assert.equal(proposed.provenance.details.origin, "external-agent");
  assert.equal(await native.persistence.read(reader => reader.getKnowledgeNode(projectId, nodeId)), undefined);
  const approvalPath = "/api/v1/persistence/projects/" + projectId + "/changesets/" + proposed.id;
  const deniedApproval = await fetch(standalone.base + approvalPath + "/approve", { method: "POST", headers, body: JSON.stringify({ expectedVersion: proposed.version }) });
  assert.equal(deniedApproval.status, 403);
  assert.equal((await deniedApproval.json() as { code: string }).code, "OAUTH_MCP_PERSISTENCE_DENIED");
  const ownerHeaders = client.ownerHeaders();
  const approval = await fetch(standalone.base + approvalPath + "/approve", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ expectedVersion: proposed.version }) });
  assert.equal(approval.status, 200, await approval.text());
  const applied = await fetch(standalone.base + approvalPath + "/apply", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ expectedVersion: proposed.version + 1 }) });
  assert.equal(applied.status, 200, await applied.text());
  const retry = await fetch(standalone.base + actionPath + "core.knowledge.propose", { method: "POST", headers, body: JSON.stringify({ input: payload }) });
  const replay = await retry.json() as ActionResult;
  assert.ok(replay.ok && (replay.data as { replayed: boolean }).replayed);
  const listed = await fetch(standalone.base + actionPath + "core.knowledge.nodes.list", { method: "POST", headers, body: JSON.stringify({ input: {} }) });
  const list = await listed.json() as ActionResult;
  assert.ok(list.ok && (list.data as Array<{ id: string }>).some(node => node.id === nodeId));
  const current = (await native.persistence.read(reader => reader.getProject(projectId)))!.version;
  const nestedId = randomUUID();
  const nested = await fetch(hosted.base + "/api/projects/" + projectId + "/modules/mcp/native-propose", { method: "POST", headers: { Authorization: "Bearer write-grant", "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, projectVersion: current, idempotencyKey: "nested-real", operations: [{ ...payload.operations[0], command: { ...payload.operations[0]!.command, id: nestedId } }] }) });
  const nestedResult = await nested.json() as ActionResult;
  assert.ok(nestedResult.ok, JSON.stringify(nestedResult));
  if (!nestedResult.ok) throw new Error("Nested proposal failed");
  const nestedChange = (nestedResult.data as { changeSet: import("@codexia/persistence-contracts").ChangeSet }).changeSet;
  assert.equal(nestedChange.authorId, "writer-1");
  assert.equal(nestedChange.provenance.details.origin, "external-agent");
  assert.equal(nestedChange.status, "proposed");
});

it("restricts Publishing review payloads and legacy files to authenticated authors", async (t) => {
  const { project, store, persistence } = await nativeProject(t, "Private Publishing review");
  const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-publishing-review-"));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const projectId = project.id;
  const grantsPath = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  const episodesPath = "meta/scriptorium/modules/publishing/episodes.yaml";
  const grantBody = '{"tokenHash":"fixture-private-digest","label":"Proofreader"}';
  const legacyProject = await persistence.read(reader => reader.getProject(projectId));
  assert.ok(legacyProject);
  const legacySnapshot = { projectId, projectVersion: legacyProject.version };
  await persistence.transaction(async tx => {
    await tx.saveModuleRecord({
      projectId, moduleId: "core.authority.snapshots", key: "snapshot:" + legacyProject.version, expectedVersion: null,
      value: { snapshot: legacySnapshot, project: legacyProject, documents: [], files: {
        [grantsPath]: { content: grantBody, encoding: "utf8", revision: createHash("sha256").update(grantBody).digest("hex") },
      } } as unknown as JsonObject,
    });
    await tx.updateProject({ projectId, expectedVersion: legacyProject.version });
  });
  const snapshot = (await store.observe(projectId)).snapshot;
  const ordinaryId = randomUUID();
  const privateIds = [randomUUID(), randomUUID()] as const;
  for (const [id, privatePath] of [[ordinaryId], [privateIds[0], grantsPath], [privateIds[1], episodesPath]] as const) {
    const operation: ChangeOperation = {
      id: randomUUID(), projectId, baseProjectVersion: snapshot.projectVersion, generation: 0,
      effect: "metadata", reads: [], message: "Update fixture metadata",
      writes: [
        { path: "meta/review-notes.md", revision: null, content: "Public review notes" },
        ...(privatePath ? [{ path: privatePath, revision: null, content: "Author draft" }] : []),
      ],
    };
    const proposal: ChangeProposal = { id, snapshot, operations: [operation], source: "author" };
    if (privatePath) {
      const status: ProposalStatus = {
        proposal, state: "proposed", approvedOperationIds: [], appliedOperationIds: [], applications: [], stale: false,
      };
      await persistence.transaction(tx => tx.saveModuleRecord({
        projectId, moduleId: "core.authority.proposals", key: "proposal:" + id, expectedVersion: null,
        value: status as unknown as JsonObject,
      }));
    } else {
      await store.propose(projectId, proposal);
    }
  }
  const native = await persistence.transaction(tx => tx.createChangeSet({
    projectId, authorId: "owner", idempotencyKey: "private-publishing",
    operations: [{
      type: "module.record.save",
      command: { projectId, moduleId: "publishing", key: "share-grants", expectedVersion: null, value: { version: 1, grants: [] } },
    }],
    readSet: [{ resource: "module_record", id: '["publishing","share-grants"]', expectedVersion: null }],
    writeSet: [{ resource: "module_record", id: '["publishing","share-grants"]' }],
    provenance: { source: "publishing.native", actorId: "owner", details: { projectVersion: snapshot.projectVersion } },
  }));
  const client = createSignedRequestFixture();
  const standalone = await startCustomApi(store, staticDir, {
    persistence, ...testClientSettings(projectId, client.publicJwks, client.isActive),
  });
  t.after(standalone.close);
  const hosted = await startHostedApi(store, staticDir, hostedTestPolicy(), undefined, undefined, undefined, persistence, projectId);
  t.after(hosted.close);
  const projectPath = "/api/projects/" + projectId;
  const nativePath = "/api/v1/persistence/projects/" + projectId + "/changesets";
  const hostedBrowser = (grant: string) => ({
    Host: "instance-1.instances.example", "X-Forwarded-Proto": "https", Origin: HOSTED_ASSIGNMENT.grantPolicy.audience,
    Cookie: `__Host-praetorium_access=${grant}; __Host-praetorium_csrf=fixture-csrf`,
    "X-CSRF-Token": "fixture-csrf", "Content-Type": "application/json",
  });
  const readers: Array<{ name: string; base: string; headers: Record<string, string>; author: boolean; directPersistence: boolean }> = [
    { name: "OAuth author", base: standalone.base, headers: client.ownerHeaders(), author: true, directPersistence: true },
    { name: "OAuth MCP reader", base: standalone.base, headers: client.mcpHeaders(), author: false, directPersistence: false },
    { name: "Hosted write browser", base: hosted.base, headers: hostedBrowser("write-grant"), author: true, directPersistence: true },
    { name: "Hosted read browser", base: hosted.base, headers: hostedBrowser("read-grant"), author: false, directPersistence: true },
    { name: "Hosted write bearer", base: hosted.base, headers: { Authorization: "Bearer write-grant", "Content-Type": "application/json" }, author: false, directPersistence: true },
  ];
  for (const { name, base, headers, author, directPersistence } of readers) {
    await t.test(name, async () => {
      const invoke = async <Data>(action: string, input: unknown, selected?: SnapshotId): Promise<ActionResult<Data>> => {
        const url = base + projectPath + "/actions/" + action;
        const body = JSON.stringify({ input, snapshot: selected });
        if (headers.Cookie) {
          const response = await rawHostedRequest(url, headers, body);
          assert.equal(response.status, 200, response.body);
          return JSON.parse(response.body) as ActionResult<Data>;
        }
        const response = await fetch(url, { method: "POST", headers, body });
        assert.equal(response.status, 200);
        return await response.json() as ActionResult<Data>;
      };
      // A browser does not attach Origin to these same-origin GET requests.
      const getHeaders = new Headers(headers);
      getHeaders.delete("origin");
      const expectedIds = (author ? [ordinaryId, ...privateIds] : [ordinaryId]).sort();
      for (const path of ["/proposals", "/review-queue"]) {
        const response = await fetch(base + projectPath + path, { headers: getHeaders });
        assert.equal(response.status, 200);
        const { proposals } = await response.json() as { proposals: ProposalStatus[] };
        assert.deepEqual(proposals.map(status => status.proposal.id).sort(), expectedIds);
      }
      if (base === hosted.base) {
        const globalQueue = await fetch(base + "/api/review-queue", { headers: getHeaders });
        assert.equal(globalQueue.status, 200);
        const queue = await globalQueue.json() as { unresolvedCount: number; items: Array<{ projectId: string; proposal: ProposalStatus }> };
        assert.ok(queue.items.every(item => item.projectId === projectId));
        assert.deepEqual(queue.items.map(item => item.proposal.proposal.id).sort(), expectedIds);
        assert.equal(queue.unresolvedCount, expectedIds.length);
      }
      for (const id of [ordinaryId, ...privateIds]) {
        const response = await fetch(base + projectPath + "/proposals/" + id, { headers: getHeaders });
        assert.equal(response.status, author || id === ordinaryId ? 200 : 404);
        if (!author && id !== ordinaryId) assert.equal((await response.json()).code, "PROPOSAL_NOT_FOUND");
      }
      const list = await invoke<{ proposals: ProposalStatus[] }>("core.proposals.list", {});
      assert.ok(list.ok, JSON.stringify(list));
      assert.deepEqual(list.data.proposals.map(({ proposal }) => proposal.id).sort(), expectedIds);
      const detail = await invoke<{ proposal: ProposalStatus }>("core.proposals.get", { proposalId: privateIds[0] });
      if (author) assert.ok(detail.ok && detail.data.proposal.proposal.id === privateIds[0], JSON.stringify(detail));
      else assert.ok(!detail.ok && detail.error.code === "PROPOSAL_NOT_FOUND", JSON.stringify(detail));

      const resolved = await invoke<{ sceneId: null; document: { path: string; content: string } | null }>(
        "core.document.resolve", { path: grantsPath }, legacySnapshot,
      );
      assert.ok(resolved.ok, JSON.stringify(resolved));
      assert.equal(resolved.data.sceneId, null);
      if (author) assert.equal(resolved.data.document?.content, grantBody);
      else assert.equal(resolved.data.document, null);

      const nativeDetail = await invoke<{ changeSet: { id: string } } | null>("core.changeset.get", { changeSetId: native.changeSet.id });
      assert.ok(nativeDetail.ok, JSON.stringify(nativeDetail));
      assert.equal(nativeDetail.data?.changeSet.id, author ? native.changeSet.id : undefined);
      if (directPersistence) {
        const response = await fetch(base + nativePath + "/" + native.changeSet.id, { headers: getHeaders });
        assert.equal(response.status, author ? 200 : 404);
      }
    });
  }
});

it("binds Publishing record ports to the requested snapshot and authenticated author", async (t) => {
  const { project, store, persistence } = await nativeProject(t, "Publishing port");
  const directory = await mkdtemp(resolve(tmpdir(), "codexia-publishing-port-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = "share-grants";
  await persistence.transaction(tx => tx.saveModuleRecord({
    projectId: project.id, moduleId: "publishing", key, value: { version: 1, grants: [] }, expectedVersion: null,
  }));
  const pinned = (await store.reader(project.id)).snapshot;
  await persistence.transaction(tx => tx.saveModuleRecord({
    projectId: project.id, moduleId: "publishing", key, value: { version: 1, grants: [] }, expectedVersion: 1,
  }));

  const fixtureRuntime = () => {
    const manifest: ModuleManifest = {
      id: "publishing", version: "0.1.0", contractVersion: 1,
      dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
    };
    const schema: ValueSchema = { parse: value => value };
    const definition: ModuleDefinition = {
      manifest, ui: [],
      actions: [{
        id: "publishing.fixture-read", effect: "read", inputSchema: schema, outputSchema: schema,
        async invoke(input, context) {
          const record = await context.readOwnModuleRecord?.((input as { key: string }).key);
          return { ok: true, snapshot: context.reader.snapshot, data: { version: record?.version ?? null } };
        },
      }, {
        id: "publishing.fixture-propose", effect: "propose", inputSchema: schema, outputSchema: schema,
        async invoke(_input, context) {
          const changeSet = await context.proposeOwnModuleRecord?.({
            key, value: { version: 1, grants: [] }, expectedVersion: 2, idempotencyKey: randomUUID(),
          });
          return { ok: true, snapshot: context.reader.snapshot, data: { changeSet: changeSet ?? null } };
        },
      }],
      http: [{
        id: "fixture-public", path: "fixture-public", methods: ["GET"], access: "public", effect: "read",
        async handle(_request, context) {
          const record = await context.readOwnModuleRecord?.(key);
          return Response.json({ version: record?.version ?? null, write: Boolean(context.proposeOwnModuleRecord) });
        },
      }],
      async dispose() {},
    };
    return new ModuleRuntime({
      manifests: [manifest], enabled: ["publishing"], loaders: { publishing: async () => definition }, cacheDirectory: directory,
    });
  };
  const client = createSignedRequestFixture();
  const standalone = await startCustomApi(store, directory, {
    persistence, runtime: fixtureRuntime(), ...testClientSettings(project.id, client.publicJwks, client.isActive),
  });
  t.after(standalone.close);
  const hosted = await startHostedApi(store, directory, hostedTestPolicy(), undefined, fixtureRuntime(), undefined, persistence, project.id);
  t.after(hosted.close);
  const base = "/api/projects/" + project.id;
  const actionUrl = (origin: string, action: string) => origin + base + "/actions/publishing.fixture-" + action;
  const body = (input: unknown = {}, snapshot?: SnapshotId) => JSON.stringify({ input, snapshot });
  const invoke = async (origin: string, action: string, headers: Record<string, string>, input?: unknown, snapshot?: SnapshotId) => {
    const response = await fetch(actionUrl(origin, action), { method: "POST", headers, body: body(input, snapshot) });
    assert.equal(response.status, 200);
    return await response.json() as ActionResult;
  };
  const owner = client.ownerHeaders();
  const admitted = await invoke(standalone.base, "read", owner, { key }, pinned);
  assert.ok(admitted.ok, JSON.stringify(admitted));
  assert.deepEqual(admitted.data, { version: 1 });
  const current = await invoke(standalone.base, "read", owner, { key });
  assert.ok(current.ok, JSON.stringify(current));
  assert.deepEqual(current.data, { version: 2 });
  const unknown = await invoke(standalone.base, "read", owner, { key: "not-a-publishing-record" });
  assert.equal(unknown.ok, false);
  const external = await invoke(standalone.base, "read", client.mcpHeaders(), { key });
  assert.equal(external.ok, false);

  const anon = await fetch(standalone.base + "/api/public/projects/" + project.id + "/modules/publishing/fixture-public");
  assert.equal(anon.status, 200);
  assert.deepEqual(await anon.json(), { version: 2, write: false });
  const hostingAuthor = {
    Host: "instance-1.instances.example", "X-Forwarded-Proto": "https", Origin: HOSTED_ASSIGNMENT.grantPolicy.audience,
    Cookie: "__Host-praetorium_access=write-grant; __Host-praetorium_csrf=fixture-csrf",
    "X-CSRF-Token": "fixture-csrf", "Content-Type": "application/json",
  };
  const hostingResponse = await rawHostedRequest(actionUrl(hosted.base, "propose"), hostingAuthor, body());
  assert.equal(hostingResponse.status, 200, hostingResponse.body);
  const proposed = JSON.parse(hostingResponse.body) as ActionResult<{ changeSet: { id: string; projectId: string } }>;
  assert.ok(proposed.ok, hostingResponse.body);
  assert.equal(proposed.data.changeSet?.projectId, project.id);
  const changeSet = await persistence.read(reader => reader.getChangeSet(project.id, proposed.data.changeSet.id as ChangeSetId));
  assert.equal(changeSet?.authorId, "writer-1");
  assert.equal(changeSet?.status, "proposed");
  assert.equal((await persistence.read(reader => reader.getModuleRecord(project.id, "publishing", key)))?.version, 2);
  const mcpWrite = await invoke(standalone.base, "propose", client.mcpHeaders());
  const hostedBearerWrite = await invoke(hosted.base, "propose", { Authorization: "Bearer write-grant", "Content-Type": "application/json" });
  assert.ok(!mcpWrite.ok || (mcpWrite.data as { changeSet: unknown }).changeSet === null);
  assert.ok(!hostedBearerWrite.ok || (hostedBearerWrite.data as { changeSet: unknown }).changeSet === null);
  assert.equal((await persistence.read(reader => reader.listChangeSets(project.id, 20))).length, 1);
});

it("reorders hierarchy only by approving a version-bound native ChangeSet", async (t) => {
  const native = await nativeProject(t, "Native hierarchy reorder");
  const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-native-reorder-"));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const client = createSignedRequestFixture();
  const settings = testClientSettings(native.project.id, client.publicJwks, client.isActive);
  const instance = await startCustomApi(native.store, staticDir, { persistence: native.persistence, ...settings });
  t.after(instance.close);
  const hosted = await startHostedApi(native.store, staticDir, hostedTestPolicy(), undefined, undefined, undefined, native.persistence, native.project.id);
  t.after(hosted.close);
  const projectId = native.project.id;
  const [first, second] = await native.persistence.transaction(async tx => {
    const seed = (title: string, orderKey: string) => tx.createDocument({
      projectId, kind: "volume", title, orderKey, markdown: "", authorId: "owner", idempotencyKey: randomUUID(),
    });
    return [await seed("First", "1"), await seed("Second", "2")];
  });
  const snapshot = (await native.store.observe(projectId)).snapshot;
  const authorHeaders = client.ownerHeaders();
  const bearerHeaders = { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" };
  const actionPath = `/api/projects/${projectId}/actions/core.hierarchy.reorder`;
  const nativePath = `/api/v1/persistence/projects/${projectId}`;
  const readOrder = () => native.persistence.read(async reader => (await reader.listDocuments(projectId, null)).map(document => document.id));
  const input = { kind: "volume", orderedIds: [second.document.id, first.document.id], idempotencyKey: randomUUID() };
  const post = (path: string, body: unknown, headers: Record<string, string> = authorHeaders) =>
    fetch(instance.base + path, { method: "POST", headers, body: JSON.stringify(body) });

  const response = await post(actionPath, { input, snapshot });
  assert.equal(response.status, 200);
  const result = await response.json() as ActionResult<ChangeSetResult>;
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.snapshot, snapshot);
  const { changeSet, replayed } = result.data;
  assert.equal(replayed, false);
  assert.equal(changeSet.status, "proposed");
  assert.equal(changeSet.authorId, "owner");
  assert.deepEqual(changeSet.operations.map(({ type }) => type), ["document.update", "document.update"]);
  assert.deepEqual(await readOrder(), [first.document.id, second.document.id]);

  const replayResponse = await post(actionPath, { input, snapshot });
  const replay = await replayResponse.json() as ActionResult<ChangeSetResult>;
  assert.ok(replay.ok && replay.data.replayed);
  assert.equal(replay.data.changeSet.id, changeSet.id);

  const review = await fetch(instance.base + nativePath + "/review-feed", { headers: authorHeaders });
  assert.equal(review.status, 200);
  const { items } = await review.json() as { items: Awaited<ReturnType<CoreStore["listAuthorReviews"]>> };
  assert.ok(items.some(item => item.kind === "native-change-set" && item.changeSet.id === changeSet.id));

  const changeSetPath = `${nativePath}/changesets/${changeSet.id}`;
  const unauthorized = await post(actionPath, { input: { ...input, idempotencyKey: randomUUID() }, snapshot }, bearerHeaders);
  assert.equal(unauthorized.status, 401);
  const postHosted = (path: string, body: unknown, grant: string) => fetch(hosted.base + path, {
    method: "POST", headers: { Authorization: `Bearer ${grant}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const hostedInput = { ...input, idempotencyKey: randomUUID() };
  assert.equal((await postHosted(actionPath, { input: hostedInput, snapshot }, "read-grant")).status, 403);
  const hostedResponse = await postHosted(actionPath, { input: hostedInput, snapshot }, "write-grant");
  assert.equal(hostedResponse.status, 200);
  const hostedResult = await hostedResponse.json() as ActionResult<ChangeSetResult>;
  assert.ok(hostedResult.ok, JSON.stringify(hostedResult));
  const hostedChangeSet = hostedResult.data.changeSet;
  assert.equal(hostedChangeSet.authorId, "writer-1");
  assert.equal(hostedChangeSet.provenance.details.origin, "external-agent");
  assert.equal(hostedChangeSet.status, "proposed");
  const hostedChangeSetPath = `${nativePath}/changesets/${hostedChangeSet.id}`;
  for (const action of ["approve", "apply"]) {
    const denied = await postHosted(`${hostedChangeSetPath}/${action}`, { expectedVersion: hostedChangeSet.version }, "write-grant");
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { code: string }).code, "AUTHOR_SESSION_REQUIRED");
  }
  const unapproved = await post(changeSetPath + "/apply", { expectedVersion: changeSet.version });
  assert.equal(unapproved.status, 409);
  assert.deepEqual(await readOrder(), [first.document.id, second.document.id]);
  const approval = await post(changeSetPath + "/approve", { expectedVersion: changeSet.version });
  assert.equal(approval.status, 200, await approval.text());
  const applied = await post(changeSetPath + "/apply", { expectedVersion: changeSet.version + 1 });
  assert.equal(applied.status, 200, await applied.text());
  assert.deepEqual(await readOrder(), [second.document.id, first.document.id]);
  const appliedReplay = await post(actionPath, { input, snapshot });
  const appliedResult = await appliedReplay.json() as ActionResult<ChangeSetResult>;
  assert.ok(appliedResult.ok && appliedResult.data.replayed);
  assert.equal(appliedResult.data.changeSet.id, changeSet.id);
  assert.equal(appliedResult.data.changeSet.status, "applied");
});

it("replays native hierarchy creation and deletion through authenticated PostgreSQL HTTP", async (t) => {
  const native = await nativeProject(t, "Core proposal action replay");
  const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-core-action-replay-"));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const client = createSignedRequestFixture();
  const settings = testClientSettings(native.project.id, client.publicJwks, client.isActive);
  const apiServer = await startCustomApi(native.store, staticDir, { persistence: native.persistence, ...settings });
  t.after(apiServer.close);
  const projectId = native.project.id;
  const staleSnapshot = (await native.store.reader(projectId)).snapshot;

  await native.persistence.transaction(tx => tx.createDocument({
    projectId, kind: "volume", title: "Existing volume", orderKey: "1", markdown: "", authorId: "owner", idempotencyKey: randomUUID(),
  }));

  const headers = client.ownerHeaders();
  const invoke = async <Data = unknown>(actionId: string, input: unknown, snapshot?: SnapshotId, credentials = headers): Promise<ActionResult<Data>> => {
    const response = await fetch(`${apiServer.base}/api/projects/${projectId}/actions/${actionId}`, {
      method: "POST", headers: credentials, body: JSON.stringify({ input, snapshot }),
    });
    assert.equal(response.status, 200);
    return await response.json() as ActionResult<Data>;
  };
  const nativePath = `/api/v1/persistence/projects/${projectId}`;
  const postDecision = (id: string, decision: "approve" | "apply", expectedVersion: number, credentials = headers) =>
    fetch(`${apiServer.base}${nativePath}/changesets/${id}/${decision}`, {
      method: "POST", headers: credentials, body: JSON.stringify({ expectedVersion }),
    });
  const apply = async (id: string, version: number) => {
    const response = await postDecision(id, "apply", version);
    assert.equal(response.status, 200);
    return await response.json() as ChangeSetApplicationResult;
  };

  const readDocuments = () => native.persistence.read(reader => reader.listDocuments(projectId));
  const createAction = "core.hierarchy.create";
  const createSnapshot = (await native.store.observe(projectId)).snapshot;
  const createInput = { kind: "volume", id: "retry-volume", title: "Retry volume", idempotencyKey: randomUUID() };
  const proposeCreation = (input = createInput, snapshot?: SnapshotId) => invoke<ChangeSetResult>(createAction, input, snapshot);
  const legacyCreate = await invoke(createAction, { ...createInput, proposalId: randomUUID() }, createSnapshot);
  assert.ok(!legacyCreate.ok && legacyCreate.error.code === "invalid_action_input", JSON.stringify(legacyCreate));
  const staleCreate = await proposeCreation(createInput, staleSnapshot);
  assert.ok(!staleCreate.ok && staleCreate.error.code === "conflict", JSON.stringify(staleCreate));
  const [creation, concurrent] = await Promise.all([
    proposeCreation(createInput, createSnapshot),
    proposeCreation(createInput, createSnapshot),
  ]);
  assert.ok(creation.ok && concurrent.ok, JSON.stringify({ creation, concurrent }));
  assert.deepEqual(creation.snapshot, createSnapshot);
  assert.deepEqual(concurrent.data.changeSet, creation.data.changeSet);
  assert.deepEqual([creation.data.replayed, concurrent.data.replayed].sort(), [false, true]);
  const createSet = creation.data.changeSet;
  assert.equal(createSet.status, "proposed");
  assert.deepEqual(createSet.operations.map(operation => operation.type), ["document.create"]);

  const changedCreate = await proposeCreation({ ...createInput, title: "Different title" }, createSnapshot);
  assert.ok(!changedCreate.ok && changedCreate.error.code === "idempotency_conflict", JSON.stringify(changedCreate));
  assert.equal((await postDecision(createSet.id, "apply", createSet.version)).status, 409);
  assert.equal((await postDecision(createSet.id, "approve", createSet.version)).status, 200);
  assert.ok(!(await readDocuments()).some(document => document.title === createInput.title));
  const createdReceipt = await apply(createSet.id, createSet.version + 1);
  assert.equal(createdReceipt.changeSet.status, "applied");
  assert.deepEqual(await apply(createSet.id, createSet.version + 1), { ...createdReceipt, replayed: true });
  const repinnedCreate = await proposeCreation();
  assert.ok(repinnedCreate.ok && repinnedCreate.data.replayed, JSON.stringify(repinnedCreate));
  assert.notDeepEqual(repinnedCreate.snapshot, createSnapshot);
  assert.deepEqual(repinnedCreate.data.changeSet, createdReceipt.changeSet);
  const committed = (await readDocuments()).find(document => document.title === createInput.title);
  assert.ok(committed, "the newly created volume must exist before testing deletion");
  const deleteSnapshot = (await native.store.observe(projectId)).snapshot;
  const deleteInput = { target: { kind: "volume", id: committed.id }, idempotencyKey: randomUUID() };
  const external = client.mcpHeaders();
  const deleteAction = "core.hierarchy.delete";
  const proposeDeletion = (input = deleteInput) => invoke<ChangeSetResult>(deleteAction, input, deleteSnapshot, external);

  const rejectedAlias = await invoke(deleteAction, { ...deleteInput, proposalId: randomUUID() }, deleteSnapshot, external);
  assert.ok(!rejectedAlias.ok && rejectedAlias.error.code === "invalid_action_input", JSON.stringify(rejectedAlias));
  const denied = await fetch(`${apiServer.base}/api/projects/${projectId}/actions/${deleteAction}`, {
    method: "POST", headers: client.mcpHeaders("mcp:read"), body: JSON.stringify({ input: deleteInput, snapshot: deleteSnapshot }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { code: string }).code, "OAUTH_MCP_SCOPE_REQUIRED");

  const proposed = await proposeDeletion();
  assert.ok(proposed.ok, JSON.stringify(proposed));
  assert.deepEqual(proposed.snapshot, deleteSnapshot);
  const { changeSet, replayed } = proposed.data;
  assert.equal(replayed, false);
  assert.equal(changeSet.status, "proposed");
  assert.equal(changeSet.provenance.details.origin, "external-agent");
  const retry = await proposeDeletion();
  assert.ok(retry.ok && retry.data.replayed);
  assert.deepEqual(retry.data.changeSet, changeSet);

  const review = await fetch(apiServer.base + nativePath + "/review-feed", { headers });
  assert.equal(review.status, 200);
  const { items } = await review.json() as { items: Awaited<ReturnType<CoreStore["listAuthorReviews"]>> };
  assert.ok(items.some(item => item.kind === "native-change-set" && item.changeSet.id === changeSet.id));
  assert.equal((await postDecision(changeSet.id, "approve", changeSet.version, external)).status, 403);
  assert.equal((await postDecision(changeSet.id, "apply", changeSet.version)).status, 409);
  const approval = await postDecision(changeSet.id, "approve", changeSet.version);
  assert.equal(approval.status, 200, await approval.text());
  assert.ok((await readDocuments()).some(document => document.id === committed.id));
  const receipt = await apply(changeSet.id, changeSet.version + 1);
  assert.equal(receipt.changeSet.status, "applied");
  assert.ok(!(await readDocuments()).some(document => document.id === committed.id));
  assert.deepEqual(await apply(changeSet.id, changeSet.version + 1), { ...receipt, replayed: true });
  const afterApply = await proposeDeletion();
  assert.ok(afterApply.ok && afterApply.data.replayed);
  assert.deepEqual(afterApply.data.changeSet, receipt.changeSet);
});

it("restores a manuscript revision only through an approved native ChangeSet and replays its receipt", async (t) => {
  const native = await nativeProject(t, "Native manuscript restoration");
  const staticDir = await mkdtemp(resolve(tmpdir(), "codexia-native-restore-"));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const projectId = native.project.id;
  const client = createSignedRequestFixture();
  const settings = testClientSettings(projectId, client.publicJwks, client.isActive);
  const instance = await startCustomApi(native.store, staticDir, { persistence: native.persistence, ...settings });
  t.after(instance.close);

  const originalText = "The original manuscript.";
  const currentText = "The current manuscript.";
  const { document, revision: original } = await native.persistence.transaction(tx => tx.createDocument({
    projectId, kind: "scene", title: "The manuscript", orderKey: "1", markdown: originalText, authorId: "owner", idempotencyKey: randomUUID(),
  }));
  const replace = async (base: typeof original, markdown: string) => (await native.persistence.transaction(tx => tx.saveDocument({
    projectId, documentId: document.id, baseRevisionId: base.id,
    changes: [{ fromUtf16: 0, toUtf16: base.markdown.length, insert: markdown }],
    resultingSha256: createHash("sha256").update(markdown).digest("hex"),
    authorId: "owner", clientId: "restore-test", idempotencyKey: randomUUID(),
  }))).revision;
  const intermediate = await replace(original, "An intermediate revision.");
  const repeated = await replace(intermediate, originalText);
  const earlierSnapshot = (await native.store.reader(projectId)).snapshot;
  const current = await replace(repeated, currentText);
  const snapshot = (await native.store.observe(projectId)).snapshot;
  const author = client.ownerHeaders();
  const external = client.mcpHeaders();
  const actionPath = `/api/projects/${projectId}/actions/core.operation.restore`;
  const nativePath = `/api/v1/persistence/projects/${projectId}`;
  const post = (path: string, body: unknown, headers = author) =>
    fetch(instance.base + path, { method: "POST", headers, body: JSON.stringify(body) });
  const input = { documentId: document.id, baseRevisionId: current.id, sourceRevisionId: original.id, idempotencyKey: randomUUID() };
  const propose = async (payload: unknown, selected: SnapshotId | null = snapshot) => {
    const response = await post(actionPath, { input: payload, ...(selected ? { snapshot: selected } : {}) }, external);
    assert.equal(response.status, 200);
    return await response.json() as ActionResult<ChangeSetResult>;
  };
  const readHead = () => native.persistence.read(async reader => {
    const head = (await reader.getDocument(projectId, document.id))?.headRevisionId;
    return head && await reader.getRevision(projectId, document.id, head);
  });

  const readOnly = await post(actionPath, { input, snapshot }, client.mcpHeaders("mcp:read"));
  assert.equal(readOnly.status, 403);
  const stale = await propose({ ...input, baseRevisionId: repeated.id, idempotencyKey: randomUUID() });
  assert.ok(!stale.ok && stale.error.code === "revision_conflict", JSON.stringify(stale));

  const future = await propose(input, earlierSnapshot);
  assert.ok(!future.ok && future.error.code === "revision_conflict", JSON.stringify(future));

  const result = await propose(input, null);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.snapshot, snapshot);
  const { changeSet, replayed } = result.data;
  assert.equal(replayed, false);
  assert.equal(changeSet.status, "proposed");
  assert.equal(changeSet.authorId, "owner");
  assert.equal(changeSet.provenance.details.origin, "external-agent");
  const [operation] = changeSet.operations;
  assert.equal(changeSet.operations.length, 1);
  assert.ok(operation?.type === "document.restore");
  assert.equal(operation.command.baseRevisionId, current.id);
  assert.equal(operation.command.sourceRevisionId, original.id);
  assert.equal((await readHead())?.markdown, currentText);

  const retry = await propose(input);
  assert.ok(retry.ok && retry.data.replayed);
  assert.deepEqual(retry.data.changeSet, changeSet);
  const equivalent = await propose({ ...input, sourceRevisionId: repeated.id });
  assert.ok(!equivalent.ok && equivalent.error.code === "idempotency_conflict", JSON.stringify(equivalent));
  const invalid = await propose({ sceneId: document.id, snapshotId: original.id, proposalId: randomUUID() });
  assert.ok(!invalid.ok && invalid.error.code === "invalid_action_input", JSON.stringify(invalid));

  const changeSetPath = `${nativePath}/changesets/${changeSet.id}`;
  const review = await fetch(instance.base + nativePath + "/review-feed", { headers: author });
  assert.equal(review.status, 200);
  const { items } = await review.json() as { items: Awaited<ReturnType<CoreStore["listAuthorReviews"]>> };
  assert.ok(items.some(item => item.kind === "native-change-set" && item.changeSet.id === changeSet.id));
  const approvalBody = { expectedVersion: changeSet.version };
  assert.equal((await post(changeSetPath + "/approve", approvalBody, external)).status, 403);
  assert.equal((await post(changeSetPath + "/apply", approvalBody)).status, 409);
  assert.equal((await readHead())?.id, current.id);

  const approval = await post(changeSetPath + "/approve", approvalBody);
  assert.equal(approval.status, 200, await approval.text());
  assert.equal((await readHead())?.id, current.id);
  const apply = async () => {
    const response = await post(changeSetPath + "/apply", { expectedVersion: changeSet.version + 1 });
    assert.equal(response.status, 200);
    return await response.json() as ChangeSetApplicationResult;
  };
  const receipt = await apply();
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.changeSet.status, "applied");
  const restored = await readHead();
  assert.ok(restored);
  assert.equal(restored.markdown, originalText);
  assert.notEqual(restored.id, original.id);
  assert.equal(restored.parentRevisionId, current.id);
  const [restoredResult] = receipt.results;
  assert.ok(restoredResult && "revision" in restoredResult);
  assert.equal(restoredResult.revision.id, restored.id);
  assert.deepEqual(await apply(), { ...receipt, replayed: true });
  assert.equal((await readHead())?.id, restored.id);
  const afterApply = await propose(input);
  assert.ok(afterApply.ok && afterApply.data.replayed);
  assert.deepEqual(afterApply.data.changeSet, receipt.changeSet);
  assert.deepEqual(await propose(input, null), {
    ok: true, snapshot: (await native.store.observe(projectId)).snapshot, data: { changeSet: receipt.changeSet, replayed: true },
  });
});
