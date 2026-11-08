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
