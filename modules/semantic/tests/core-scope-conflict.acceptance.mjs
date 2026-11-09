import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { postgresFixture } from "../../test-support/postgres-fixture.mjs";

import { ModuleRuntime } from "../../../packages/module-runtime/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "codexia-semantic-scope-"));
const fixtureFiles = {};
let fixture;
let runtime;

async function writeProjectFile(path, content) { fixtureFiles[path] = content; }

async function modulePackage(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

try {
  await writeProjectFile("meta/project.yaml", "id: semantic-scope-fixture\ntitle: Semantic scope fixture\n");
  await writeProjectFile("bible/characters/owner/profile.yaml", "id: char-owner\ntype: character\nname: Owner\naliases: [Owner]\n");
  await writeProjectFile("bible/characters/thief/profile.yaml", "id: char-thief\ntype: character\nname: Thief\naliases: [Thief]\n");
  await writeProjectFile("plot/volumes/v/volume.yaml", "id: vol-v\ntype: volume\norder: 0\n");
  await writeProjectFile("plot/volumes/v/chapters/c/chapter.yaml", "id: ch-c\ntype: chapter\nvolume: vol-v\norder: 0\n");
  await writeProjectFile("plot/volumes/v/chapters/c/scenes/one.yaml", "id: sc-one\ntype: scene\nchapter: ch-c\norder: 0\neffects:\n  - action: acquire_item\n    itemId: sword\n    characterId: char-owner\n");
  await writeProjectFile("plot/volumes/v/chapters/c/scenes/two.yaml", "id: sc-two\ntype: scene\nchapter: ch-c\norder: 1\neffects:\n  - action: use_item\n    itemId: sword\n    characterId: char-thief\n");

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
  fixture = await postgresFixture(fixtureFiles, "Semantic scope fixture");
  const { store, project } = fixture;
  const observed = await store.observe(project.id);
  assert.equal(observed.state, "fresh");
  const reader = await store.reader(project.id, observed.snapshot);
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
  assert.equal(rebuilt.ok, true, `semantic contradiction rebuild failed: ${JSON.stringify(rebuilt.error)}`);
  const candidate = rebuilt.data.candidates.find((item) => item.id.startsWith("rule:item-owner-mismatch:"));
  assert.ok(candidate, "the synthetic source effects should yield an ownership contradiction");
  const dismissed = await runtime.invokeAction("semantic", "semantic.contradictions.dismiss", { candidateId: candidate.id }, host);
  assert.equal(dismissed.ok, true, `semantic dismissal proposal failed: ${JSON.stringify(dismissed.error)}`);
  const proposal = dismissed.data.proposal;
  const operation = proposal.operations[0];
  assert.deepEqual(operation.readScopes.map(({ prefix }) => prefix).sort(), ["bible", "plot"]);
  await store.approve(project.id, {
    proposalId: proposal.id,
    operationIds: [operation.id],
    authorScope: "p09-semantic-scope-owner",
  });

  await writeProjectFile("bible/characters/owner/profile.yaml", "id: char-owner\ntype: character\nname: Owner\naliases: [Former Owner]\n");
  await fixture.applyFiles({ "bible/characters/owner/profile.yaml": fixtureFiles["bible/characters/owner/profile.yaml"] });
  await assert.rejects(
    store.apply(project.id, operation),
    (error) => error?.code === "conflict" && error?.details?.resource === "project",
  );
  console.log("PASS: actual semantic dismissal proposal carries Bible/plot revisions and PostgreSQL Core rejects apply after the Bible alias changes.");
} finally {
  await runtime?.shutdown();
  await fixture?.close();
  await rm(root, { recursive: true, force: true });
}
