import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Persistence, PersistenceReader, Project, ProjectId } from "@codexia/persistence-contracts";
import {
  metadataForRuntime,
  parseQuiesceRequest,
  parseRuntimeAssignment,
  parseRuntimeControlCredential,
  observePostgresPersistence,
  sha256Digest,
} from "./platform-runtime.js";

const ASSIGNMENT = {
  contractVersion: "scriptorium-platform/v1",
  instanceId: "instance-1",
  repositoryId: 42,
  repositoryLocator: "https://github.com/owner/book",
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
    audience: "https://praetorium.example/codexia",
  },
} as const;

function pgProject(id = "project-a", version = 7): Project {
  return {
    id: id as ProjectId,
    title: "Test project",
    settings: {},
    version,
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
}

function testPersistence(options: {
  project?: Project;
  healthError?: Error;
  withoutHealth?: boolean;
  onRead?: () => void;
} = {}): Persistence {
  const reader = { async getProject() { return options.project; } } as unknown as PersistenceReader;
  return {
    async read(work) {
      options.onRead?.();
      return work(reader);
    },
    async transaction() { throw new Error("transactions are outside this observation test"); },
    async close() {},
    ...(options.withoutHealth ? {} : { async checkHealth() { if (options.healthError) throw options.healthError; } }),
  };
}

describe("hosted runtime platform contract", () => {
  it("parses only a structured immutable assignment and quiesce request", () => {
    const assignment = parseRuntimeAssignment(ASSIGNMENT);
    assert.equal(assignment.repositoryId, 42);
    assert.deepEqual(assignment.enabledModuleIds, ["story", "mcp"]);
    assert.throws(() => parseRuntimeAssignment({ ...ASSIGNMENT, githubToken: "secret" }), /assignment is invalid/u);

    const request = parseQuiesceRequest({
      contractVersion: "scriptorium-platform/v1",
      operationId: "operation-1",
      instanceId: "instance-1",
      runtimeEpoch: 3,
      reason: "redeploy",
      deadline: "2026-10-17T00:00:30.000Z",
    });
    assert.equal(request.reason, "redeploy");
    assert.throws(() => parseQuiesceRequest({ ...request, extra: true }), /request is invalid/u);
  });

  it("binds private controls to assignment, operation, payload and lifetime", () => {
    const payloadDigest = "sha256:230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5";
    assert.equal(sha256Digest("body"), payloadDigest);
    const expected = {
      issuer: ASSIGNMENT.controlServicePolicy.issuer,
      audience: ASSIGNMENT.controlServicePolicy.audience,
      instanceId: ASSIGNMENT.instanceId,
      repositoryId: ASSIGNMENT.repositoryId,
      runtimeEpoch: ASSIGNMENT.runtimeEpoch,
      operationId: "operation-1",
      action: "quiesce" as const,
      payloadDigest,
      nowSeconds: 110,
    };
    const credential = {
      contractVersion: "praetorium-runtime-control/v1",
      iss: expected.issuer,
      sub: "control-plane",
      aud: expected.audience,
      instanceId: expected.instanceId,
      repositoryId: expected.repositoryId,
      runtimeEpoch: expected.runtimeEpoch,
      operationId: "operation-1",
      action: "quiesce",
      payloadDigest,
      iat: 100,
      nbf: 100,
      exp: 130,
      jti: "credential-1",
    };
    assert.equal(parseRuntimeControlCredential(credential, expected).jti, "credential-1");
    assert.throws(() => parseRuntimeControlCredential(credential, { ...expected, runtimeEpoch: 4 }), /binding mismatch/u);
    assert.throws(() => parseRuntimeControlCredential(credential, { ...expected, payloadDigest: `sha256:${"1".repeat(64)}` }), /binding mismatch/u);
  });

  it("reports the exact PostgreSQL project version after a healthy durable read", async () => {
    const persistence = testPersistence({ project: pgProject() });
    assert.deepEqual(await observePostgresPersistence(persistence, "project-a"), { state: "verified", provider: "postgres", projectVersion: 7 });
  });

  it("never certifies a missing project, missing health check, or unavailable PostgreSQL as durable", async () => {
    let reads = 0;
    const missingProject = testPersistence({ onRead: () => { reads += 1; } });
    const missingHealth = testPersistence({ project: pgProject(), withoutHealth: true, onRead: () => { reads += 1; } });
    const unavailable = testPersistence({ project: pgProject(), healthError: new Error("offline"), onRead: () => { reads += 1; } });
    for (const persistence of [missingProject, missingHealth, unavailable]) {
      assert.deepEqual(await observePostgresPersistence(persistence, "project-a"), { state: "unknown", provider: "postgres", projectVersion: null });
    }
    assert.equal(reads, 1, "failed or unavailable health checks do not perform project reads");
  });

  it("fails closed when the database returns another project or invalid version", async () => {
    for (const project of [pgProject("other-project"), pgProject("project-a", 0), pgProject("project-a", NaN)]) {
      const persistence = testPersistence({ project });
      assert.equal((await observePostgresPersistence(persistence, "project-a")).state, "unknown");
    }
  });

  it("declares the actual hosted listener and quiesce shutdown action", () => {
    const metadata = metadataForRuntime({ producerRevision: "1".repeat(40), port: 3000, shutdownTimeoutSeconds: 25 });
    assert.equal(metadata.listener.port, 3000);
    assert.equal(metadata.paths.shutdown, "/api/platform/v1/quiesce");
    assert.equal(metadata.paths.status, "/api/platform/v1/status");
  });
});
