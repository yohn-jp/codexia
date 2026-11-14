import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Seed model acceptance fixtures through the same approved operations as author edits.
 * Keep hierarchy parents before children and each scene's manuscript in its own batch.
 * Core permits at most 256 writes in one operation; never turn this test into a Git import.
 */
export async function seedModelFixture(store, projectId, files) {
  const sceneEntries = Object.entries(files).filter(([path]) => /\/scenes\/[^/]+\.yaml$/u.test(path));
  const grouped = sceneEntries.map(([path, content]) => {
    const manuscript = JSON.parse(content).manuscript;
    assert.equal(typeof files[manuscript], "string", "fixture scene requires its manuscript");
    return [[path, content], [manuscript, files[manuscript]]];
  });
  const scenePaths = new Set(grouped.flat().map(([path]) => path));
  const initial = Object.entries(files).filter(([path]) => !scenePaths.has(path));
  async function apply(entries) {
    if (!entries.length) return;
    const reader = await store.reader(projectId);
    const writes = await Promise.all(entries.map(async ([path, content]) => ({
      path, content, revision: (await reader.read(path))?.revision ?? null,
    })));
    const operation = { id: randomUUID(), generation: 0, projectId, baseProjectVersion: reader.snapshot.projectVersion,
      effect: "metadata", reads: writes.map(({path, revision}) => ({path, revision})), writes, message: "Seed model lifecycle fixture" };
    const proposal = await store.propose(projectId, {id: randomUUID(), snapshot: reader.snapshot, operations: [operation], source: "author"});
    await store.approve(projectId, {proposalId: proposal.id, operationIds: [operation.id], authorScope: "model-acceptance-owner"});
    await store.apply(projectId, operation);
  }
  await apply(initial);
  for (let offset = 0; offset < grouped.length; offset += 100) await apply(grouped.slice(offset, offset + 100).flat());
  const reader = await store.reader(projectId);
  for (const [path, content] of grouped.flat().filter(([path]) => path.endsWith(".md"))) {
    assert.equal((await reader.read(path))?.content, content, "seeded canonical manuscript must match " + path);
  }
  return reader;
}
