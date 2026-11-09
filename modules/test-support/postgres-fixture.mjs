import { randomUUID } from "node:crypto";
import { CoreStore } from "../../packages/core/dist/index.js";
import { createPostgresPersistence, migratePostgresDatabase } from "../../packages/persistence-postgres/dist/index.js";

/** Real PostgreSQL target; fixtures never create a Git persistence authority. */
export async function postgresFixture(files = {}, title = "Module acceptance") {
  const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CODEXIA_TEST_DATABASE_URL is required for module PostgreSQL acceptance");
  await migratePostgresDatabase(connectionString);
  const persistence = createPostgresPersistence(connectionString);
  const store = new CoreStore({ persistence });
  const project = await store.createProject({ title });
  async function applyFiles(changes, message = "Seed module PostgreSQL fixture") {
    const reader = await store.reader(project.id);
    const writes = await Promise.all(Object.entries(changes).map(async ([path, content]) => ({ path, content, revision: (await reader.read(path))?.revision ?? null })));
    const operation = { id: randomUUID(), generation: 0, projectId: project.id, baseProjectVersion: reader.snapshot.projectVersion, effect: "metadata", reads: writes.map(({path, revision}) => ({path, revision})), writes, message };
    await accept(operation, reader.snapshot);
    return operation;
  }
  async function accept(operation, snapshot = {projectId: project.id, projectVersion: operation.baseProjectVersion}) {
    const proposal = await store.propose(project.id, { id: randomUUID(), snapshot, operations: [operation], source: "author" });
    await store.approve(project.id, { proposalId: proposal.id, operationIds: [operation.id], authorScope: "module-acceptance-owner" });
    return store.apply(project.id, operation);
  }
  if (Object.keys(files).length) await applyFiles(files);
  return { store, persistence, project, applyFiles, accept, close: () => persistence.close() };
}
