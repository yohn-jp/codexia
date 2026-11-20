import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

  const page = await handlePersistenceRoute({ ...base, method: "GET", url: "/api/v1/persistence/projects?page=1&limit=20" });
  assert.equal(page?.status, 200);
  assert.deepEqual(page?.body, { projects: [project], nextCursor: null });
  assert.deepEqual(lookedUp, [assignedProjectId, assignedProjectId]);

  const unassigned = await handlePersistenceRoute({
    ...base,
    method: "GET",
    url: "/api/v1/persistence/projects/another-project",
  });
  assert.equal(unassigned?.status, 404);
  assert.deepEqual(lookedUp, [assignedProjectId, assignedProjectId]);

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
        async getProject(selectedProjectId: ProjectId) { assert.equal(selectedProjectId, projectId); return { id: projectId, version: 1 }; },
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

test("Knowledge browse returns a filter-bound page cursor and rejects stale project snapshots", async () => {
  const projectId = randomUUID() as ProjectId;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  let projectVersion = 7;
  const requested: Array<{ limit: number; after?: { name: string; id: string } }> = [];
  const persistence = {
    async read<T>(work: (reader: unknown) => Promise<T>) {
      return work({
        async getProject(selectedProjectId: ProjectId) { assert.equal(selectedProjectId, projectId); return { id: projectId, version: projectVersion }; },
        async searchKnowledgeNodes(_selectedProjectId: ProjectId, search: { limit: number; after?: { name: string; id: string } }) {
          requested.push(search);
          const nodes = ids.map((id, index) => ({ id, projectId, type: "person", name: `Node ${index}`, attributes: {}, status: "confirmed", version: 1, deletedAt: null, createdAt: "now", updatedAt: "now" }));
          return nodes.slice(search.after ? 1 : 0, search.after ? 2 : 2);
        },
      });
    },
  } as unknown as Persistence;
  const base = { persistence, body: null, requestHeaders: {}, async requireAuthor() { return "author"; } };
  const first = await handlePersistenceRoute({ ...base, method: "GET", url: `/api/v1/persistence/projects/${projectId}/nodes?q=deep&limit=1` });
  assert.equal(first?.status, 200);
  const firstBody = first?.body as { nodes: Array<{ id: string }>; nextCursor: string | null; projectVersion: number };
  assert.equal(firstBody.nodes.length, 1);
  assert.ok(firstBody.nextCursor);
  assert.equal(firstBody.projectVersion, 7);
  const second = await handlePersistenceRoute({ ...base, method: "GET", url: `/api/v1/persistence/projects/${projectId}/nodes?q=deep&limit=1&cursor=${firstBody.nextCursor}` });
  assert.equal(second?.status, 200);
  assert.deepEqual(requested[1]?.after, { name: "Node 0", id: ids[0] });
  assert.equal((second?.body as { nodes: Array<{ id: string }> }).nodes[0]?.id, ids[1]);
  const mismatched = await handlePersistenceRoute({ ...base, method: "GET", url: `/api/v1/persistence/projects/${projectId}/nodes?q=other&cursor=${firstBody.nextCursor}` });
  assert.equal(mismatched?.status, 400);
  const tooLong = await handlePersistenceRoute({ ...base, method: "GET", url: `/api/v1/persistence/projects/${projectId}/nodes?q=${"x".repeat(129)}` });
  assert.equal(tooLong?.status, 400);
  projectVersion += 1;
  const stale = await handlePersistenceRoute({ ...base, method: "GET", url: `/api/v1/persistence/projects/${projectId}/nodes?q=deep&cursor=${firstBody.nextCursor}` });
  assert.equal(stale?.status, 409);
});

test("persistence project page uses the bounded keyset reader and encodes continuation", async () => {
  const projects = [
    { id: "00000000-0000-4000-8000-000000000001" as ProjectId, title: "One", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "00000000-0000-4000-8000-000000000002" as ProjectId, title: "Two", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const calls: unknown[] = [];
  const persistence = {
    async read<T>(work: (reader: unknown) => Promise<T>) {
      return work({ async listProjectPage(limit: number, after?: unknown) { calls.push([limit, after]); return after ? [projects[1]] : projects; } });
    },
  } as unknown as Persistence;
  const result = await handlePersistenceRoute({
    persistence, method: "GET", url: "/api/v1/persistence/projects?page=1&limit=1", body: null, requestHeaders: {},
    async requireAuthor() { return "author"; },
  });
  assert.equal(result?.status, 200);
  const cursor = "eyJ1cGRhdGVkQXQiOiIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJ9";
  assert.deepEqual(result?.body, { projects: [projects[0]], nextCursor: cursor });
  const next = await handlePersistenceRoute({
    persistence, method: "GET", url: `/api/v1/persistence/projects?page=1&limit=1&cursor=${cursor}`, body: null, requestHeaders: {},
    async requireAuthor() { return "author"; },
  });
  assert.deepEqual(next?.body, { projects: [projects[1]], nextCursor: null });
  assert.deepEqual(calls, [
    [2, undefined],
    [2, { updatedAt: projects[0]!.updatedAt, id: projects[0]!.id }],
  ]);
});
