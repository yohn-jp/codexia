import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { postgresFixture } from "../../../tests/helpers/postgres-fixture.mjs";

import { ModuleRuntime } from "../../../packages/module-runtime/dist/index.js";

const ownerPath = "bible/characters/owner/profile.yaml";
const plotPath = "plot/volumes/v/chapters/c/scenes/extra.yaml";
const dismissalPath = "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl";
const files = {
  [ownerPath]: "id: char-owner\ntype: character\nname: Owner\naliases: [Owner]\n",
  "bible/characters/thief/profile.yaml": "id: char-thief\ntype: character\nname: Thief\naliases: [Thief]\n",
  "plot/volumes/v/volume.yaml": "id: vol-v\ntype: volume\norder: 0\n",
  "plot/volumes/v/chapters/c/chapter.yaml": "id: ch-c\ntype: chapter\nvolume: vol-v\norder: 0\n",
  "plot/volumes/v/chapters/c/scenes/one.yaml": "id: sc-one\ntype: scene\nchapter: ch-c\norder: 0\neffects:\n  - action: acquire_item\n    itemId: sword\n    characterId: char-owner\n",
  "plot/volumes/v/chapters/c/scenes/two.yaml": "id: sc-two\ntype: scene\nchapter: ch-c\norder: 1\neffects:\n  - action: use_item\n    itemId: sword\n    characterId: char-thief\n",
};

async function modulePackage(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

test("Semantic dismissals fence Bible and plot changes through Core and PostgreSQL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexia-semantic-scope-"));
  let runtime;
  t.after(async () => {
    try {
      await runtime?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const [storyPackage, nlpPackage, semanticPackage] = await Promise.all([
    modulePackage("../../story/package.json"),
    modulePackage("../../nlp/package.json"),
    modulePackage("../package.json"),
  ]);
  const storyEntry = new URL("../../story/dist/index.js", import.meta.url).href;
  const nlpEntry = new URL("../../nlp/dist/index.js", import.meta.url).href;
  const semanticEntry = new URL("../dist/index.js", import.meta.url).href;
  const runtimeCache = join(root, "runtime-cache");
  runtime = new ModuleRuntime({
    manifests: [storyPackage.codexiaModule, nlpPackage.codexiaModule, semanticPackage.codexiaModule],
    enabled: ["semantic"],
    cacheDirectory: runtimeCache,
    workerEntries: {
      nlp: fileURLToPath(new URL("../../nlp/dist/worker.js", import.meta.url)),
      semantic: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    },
    loaders: {
      story: async (context) => (await import(storyEntry)).createModule(context),
      nlp: async (context) => (await import(nlpEntry)).createModule(context),
      semantic: async (context) => (await import(semanticEntry)).createModule(context),
    },
  });
  async function prepareDismissal(scopeTest) {
    const fixture = await postgresFixture(files, "Semantic scope fixture");
    scopeTest.after(() => fixture.close());
    const { store, project } = fixture;
    const reader = await store.reader(project.id);
    const host = {
      projectId: project.id,
      reader,
      signal: new AbortController().signal,
      access: "owner",
      async propose(operations, evidence, proposalId) {
        return store.propose(project.id, {
          id: proposalId ?? "p09-semantic-dismissal",
          snapshot: reader.snapshot,
          operations,
          source: "module",
          ...(evidence ? { evidence } : {}),
        });
      },
    };

    const rebuilt = await runtime.invokeAction("semantic", "semantic.contradictions.rebuild", {}, host);
    assert.ok(rebuilt.ok, `semantic contradiction rebuild failed: ${JSON.stringify(rebuilt.error)}`);
    assert.equal(rebuilt.data.candidates.length, 1, "the fixture supplies one contradiction between the two scenes");
    const [candidate] = rebuilt.data.candidates;
    const dismissed = await runtime.invokeAction("semantic", "semantic.contradictions.dismiss", { candidateId: candidate.id }, host);
    assert.ok(dismissed.ok, `semantic dismissal proposal failed: ${JSON.stringify(dismissed.error)}`);
    assert.equal(await (await store.reader(project.id)).read(dismissalPath), null, "proposing does not write the dismissal");
    const { proposal } = dismissed.data;
    const [operation] = proposal.operations;
    await store.approve(project.id, {
      proposalId: proposal.id,
      operationIds: [operation.id],
      authorScope: "p09-semantic-scope-owner",
    });
    return { fixture, store, project, candidate, proposal, operation };
  }

  const changedScopes = [
    ["Bible alias changes", { [ownerPath]: files[ownerPath].replace("[Owner]", "[Former Owner]") }],
    ["a new scene is added to the plot", {
      [plotPath]: "id: sc-extra\ntype: scene\nchapter: ch-c\norder: 2\n",
    }],
  ];
  for (const [label, changes] of changedScopes) {
    await t.test(`rejects apply when ${label}`, async (scopeTest) => {
      const { fixture, store, project, proposal, operation } = await prepareDismissal(scopeTest);
      await fixture.applyFiles(changes);
      await assert.rejects(store.apply(project.id, operation), { status: 409, code: "scope_conflict" });
      assert.equal(await (await store.reader(project.id)).read(dismissalPath), null);
      const status = await store.getProposal(project.id, proposal.id);
      assert.deepEqual(status?.approvedOperationIds, [operation.id]);
      assert.deepEqual(status?.appliedOperationIds, []);
      assert.deepEqual(status?.applications, []);
    });
  }

  await t.test("an unrelated change still permits application of the approved dismissal", async (scopeTest) => {
    const { fixture, store, project, candidate, proposal, operation } = await prepareDismissal(scopeTest);
    await fixture.applyFiles({ "meta/scratch/unrelated.txt": "An unrelated note." });
    await store.apply(project.id, operation);
    const dismissal = await (await store.reader(project.id)).read(dismissalPath);
    assert.ok(dismissal);
    assert.equal(JSON.parse(dismissal.content).candidateId, candidate.id);
    const status = await store.getProposal(project.id, proposal.id);
    assert.deepEqual(status?.appliedOperationIds, [operation.id]);
    assert.equal(status?.applications.length, 1);
  });
});
