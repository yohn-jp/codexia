import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { CoreStore } from "../../packages/core/dist/index.js";
import { ModuleRuntime } from "../../packages/module-runtime/dist/index.js";
import { createPostgresPersistence, migratePostgresDatabase } from "../../packages/persistence-postgres/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databaseUrl = process.env.CODEXIA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("CODEXIA_TEST_DATABASE_URL is required for Speaker scene acceptance");

async function makeRuntime(cacheDirectory) {
  const manifests = [];
  const loaders = {};
  const moduleDirectories = {};
  const workerEntries = {};
  for (const id of ["story", "nlp", "diagnostics", "speaker"]) {
    const directory = resolve(root, "modules", id);
    const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")).codexiaModule;
    manifests.push(metadata);
    moduleDirectories[id] = directory;
    if (metadata.workerEntry) workerEntries[id] = resolve(directory, metadata.workerEntry);
    const entry = pathToFileURL(resolve(directory, metadata.serverEntry));
    loaders[id] = async (context) => (await import(entry.href)).createModule(context);
  }
  return new ModuleRuntime({
    manifests,
    enabled: ["speaker"],
    loaders,
    moduleDirectories,
    workerEntries,
    cacheDirectory,
  });
}

function successfulData(result, actionId) {
  assert.equal(result.ok, true, `${actionId} failed: ${JSON.stringify(result)}`);
  return result.data;
}

test("Speaker scene picker and corpus use Story's canonical scene set in PostgreSQL", { timeout: 120_000 }, async (t) => {
  await migratePostgresDatabase(databaseUrl);
  const rootDirectory = await mkdtemp(resolve(tmpdir(), "codexia-speaker-scenes-pg-"));
  const persistence = createPostgresPersistence(databaseUrl);
  const store = new CoreStore({ persistence });
  let runtime;
  t.after(async () => {
    await runtime?.shutdown().catch(() => undefined);
    await persistence.close();
    await rm(rootDirectory, { recursive: true, force: true });
  });
  const project = await store.createProject({ title: `Speaker scene classification ${randomUUID()}` });

  const ids = { volume: randomUUID(), chapter: randomUUID(), sceneOne: randomUUID(), sceneTwo: randomUUID(), note: randomUUID() };
  await persistence.transaction(async (tx) => {
    await tx.createDocument({ projectId: project.id, documentId: ids.volume, kind: "volume", title: "Volume", orderKey: "0001", markdown: "", authorId: "speaker-scene-acceptance", idempotencyKey: randomUUID() });
    await tx.createDocument({ projectId: project.id, documentId: ids.chapter, parentId: ids.volume, kind: "chapter", title: "Chapter", orderKey: "0001", markdown: "", authorId: "speaker-scene-acceptance", idempotencyKey: randomUUID() });
    for (const [id, kind, title, orderKey] of [
      [ids.sceneOne, "scene", "Scene one", "0001"],
      [ids.sceneTwo, "scene", "Scene two", "0002"],
      [ids.note, "note", "Author note", "0003"],
    ]) {
      await tx.createDocument({
        projectId: project.id,
        documentId: id,
        parentId: ids.chapter,
        kind,
        title,
        orderKey,
        markdown: "『Uma、どうする？』\n",
        authorId: "speaker-scene-acceptance",
        idempotencyKey: randomUUID(),
      });
    }
    await tx.saveModuleRecord({
      projectId: project.id,
      moduleId: "core.artifacts",
      key: "bible/characters/char-uma/profile.yaml",
      expectedVersion: null,
      value: { content: "id: char-uma\ntype: character\nname: Uma\naliases: [Uma]\n" },
    });
  });

  runtime = await makeRuntime(resolve(rootDirectory, "module-cache"));
  const reader = await store.reader(project.id);
  const host = { projectId: project.id, reader, signal: new AbortController().signal };
  const canonical = successfulData(await runtime.invokeAction("story", "story.entities.list", { type: "scene" }, host), "story.entities.list");
  const canonicalIds = new Set(canonical.map((entity) => entity.id));
  assert.deepEqual(canonicalIds, new Set([ids.sceneOne, ids.sceneTwo]));
  assert.ok((successfulData(await runtime.invokeAction("story", "story.entities.list", { type: "character" }, host), "story.entities.list characters")).some((entity) => entity.id === "char-uma"));

  const speakerScenes = successfulData(await runtime.invokeAction("speaker", "speaker.scenes.list", {}, host), "speaker.scenes.list");
  const reviewQueue = successfulData(await runtime.invokeAction("speaker", "speaker.review.queue", {}, host), "speaker.review.queue");
  assert.ok(reviewQueue.rows.length > 0, "the PostgreSQL fixture contains unresolved dialogue in its canonical scenes");
  assert.deepEqual(new Set(reviewQueue.rows.map((row) => row.sceneId)), canonicalIds);
  assert.ok(reviewQueue.rows.every((row) => row.candidates.some((candidate) => candidate.id === "char-uma")), "corpus inference retains character candidates");
  assert.deepEqual(new Set(speakerScenes.scenes.map((scene) => scene.id)), canonicalIds);
});
