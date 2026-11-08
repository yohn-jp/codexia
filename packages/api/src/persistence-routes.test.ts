import assert from "node:assert/strict";
import test from "node:test";
import type { Persistence, ProjectId } from "@codexia/persistence-contracts";
import { handlePersistenceRoute } from "./persistence-routes.js";

test("hosted PostgreSQL routes are scoped to the assigned project", async () => {
  const assignedProjectId = "assigned-project" as ProjectId;
  const project = { id: assignedProjectId, title: "Assigned", settings: {} };
  const lookedUp: ProjectId[] = [];
  const persistence = {
    async read<T>(work: (reader: unknown) => Promise<T>) {
      return work({
        async getProject(projectId: ProjectId) {
          lookedUp.push(projectId);
          return projectId === assignedProjectId ? project : undefined;
        },
        async listProjects() {
          assert.fail("hosted project listing must not enumerate the database");
        },
      });
    },
  } as unknown as Persistence;
  const base = {
    persistence,
    assignedProjectId,
    requestHeaders: {},
    body: null,
    async requireAuthor() { return "hosted-author"; },
  };

  const projects = await handlePersistenceRoute({ ...base, method: "GET", url: "/api/v1/persistence/projects" });
  assert.equal(projects?.status, 200);
  assert.deepEqual(projects?.body, [project]);
  assert.deepEqual(lookedUp, [assignedProjectId]);

  const unassigned = await handlePersistenceRoute({
    ...base,
    method: "GET",
    url: "/api/v1/persistence/projects/another-project",
  });
  assert.equal(unassigned?.status, 404);
  assert.deepEqual(lookedUp, [assignedProjectId]);

  const creation = await handlePersistenceRoute({ ...base, method: "POST", url: "/api/v1/persistence/projects" });
  assert.equal(creation?.status, 403);
});

test("persistence status reports database health and knowledge lists are bounded", async () => {
  const projectId = "knowledge-project" as ProjectId;
  let requestedLimit = 0;
  const persistence = {
    async checkHealth() { throw new Error("database unavailable"); },
    async read<T>(work: (reader: unknown) => Promise<T>) {
      return work({
        async listKnowledgeNodes(selectedProjectId: ProjectId, limit: number) {
          assert.equal(selectedProjectId, projectId);
          requestedLimit = limit;
          return [];
        },
      });
    },
  } as unknown as Persistence;
  const base = { persistence, body: null, requestHeaders: {}, async requireAuthor() { return "author"; } };

  const status = await handlePersistenceRoute({ ...base, method: "GET", url: "/api/v1/persistence/status" });
  assert.equal(status?.status, 503);

  const nodes = await handlePersistenceRoute({
    ...base,
    method: "GET",
    url: `/api/v1/persistence/projects/${projectId}/nodes?limit=500`,
  });
  assert.equal(nodes?.status, 200);
  assert.deepEqual(nodes?.body, { nodes: [] });
  assert.equal(requestedLimit, 500);
  const overLimit = await handlePersistenceRoute({
    ...base,
    method: "GET",
    url: `/api/v1/persistence/projects/${projectId}/nodes?limit=501`,
  });
  assert.equal(overLimit?.status, 400);
});
