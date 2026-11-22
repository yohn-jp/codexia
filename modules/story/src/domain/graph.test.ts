import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSceneContext,
  buildSceneLocationInfos,
  getBacklinks,
  getEntityAppearances,
  getGraphData,
  getThreadsOverview,
  getVolumeTree,
} from "./graph.js";
import { buildLocationMap } from "./locationMap.js";
import type { StoryEntity, StoryGraphInput } from "./types.js";

const snapshot = {
  projectId: "repo-1",
  projectVersion: 11,
};

function entity(
  id: string,
  type: StoryEntity["type"],
  raw: Record<string, unknown> = {},
  extra: Partial<StoryEntity> = {},
): StoryEntity {
  return { id, type, name: id, filePath: `${type}/${id}.yaml`, raw, ...extra };
}

function input(
  entities: StoryEntity[],
  links: StoryGraphInput["links"] = [],
  documentOrderByEntityId?: ReadonlyMap<string, number>,
): StoryGraphInput & { documentOrderByEntityId?: ReadonlyMap<string, number> } {
  return {
    snapshot,
    entities: new Map(entities.map((item) => [item.id, item])),
    links,
    ...(documentOrderByEntityId ? { documentOrderByEntityId } : {}),
  };
}

test("backlinks retain source relation order and omit missing source entities", () => {
  const story = input(
    [entity("char-a", "character"), entity("scene-a", "scene")],
    [
      { from: "scene-a", to: "char-a", kind: "appears" },
      { from: "missing", to: "char-a", kind: "mentions" },
      { from: "scene-a", to: "char-a", kind: "pov" },
    ],
  );
  const result = getBacklinks({ ...story, toId: "char-a" });
  assert.strictEqual(result.snapshot, snapshot);
  assert.deepEqual(
    result.data.map(({ link, entity: source }) => [link.kind, source.id]),
    [["appears", "scene-a"], ["pov", "scene-a"]],
  );
});

test("appearances aggregate relation kinds by scene and sort by scene order", () => {
  const story = input(
    [
      entity("char-a", "character"),
      entity("scene-late", "scene", { order: 8, volume: "vol-2", chapter: "ch-3" }),
      entity("scene-early", "scene", { order: 2, volume: "vol-1", chapter: "ch-1" }),
      entity("thread-a", "thread"),
    ],
    [
      { from: "scene-late", to: "char-a", kind: "appears" },
      { from: "scene-early", to: "char-a", kind: "mentions" },
      { from: "scene-late", to: "char-a", kind: "pov" },
      { from: "thread-a", to: "char-a", kind: "related" },
      { from: "scene-early", to: "char-a", kind: "mentions" },
    ],
  );
  const result = getEntityAppearances({ ...story, entityId: "char-a" });
  assert.deepEqual(
    result.data.map((appearance) => [
      appearance.scene.id,
      appearance.volumeId,
      appearance.chapterId,
      appearance.kinds,
    ]),
    [
      ["scene-early", "vol-1", "ch-1", ["mentions"]],
      ["scene-late", "vol-2", "ch-3", ["appears", "pov"]],
    ],
  );
});

test("appearances follow the same mixed-width sibling chronology as the volume tree", () => {
  const story = input([
    entity("char-a", "character"),
    entity("vol-a", "volume", { order: "0000000001" }),
    entity("ch-a", "chapter", { id: "ch-a", volume: "vol-a", order: "0000000001" }),
    entity("scene-long-key", "scene", { chapter: "ch-a", order: "0000000002" }),
    entity("scene-short-key", "scene", { chapter: "ch-a", order: "00000001" }),
  ], [
    { from: "scene-short-key", to: "char-a", kind: "appears" },
    { from: "scene-long-key", to: "char-a", kind: "appears" },
  ]);

  assert.deepEqual(getEntityAppearances({ ...story, entityId: "char-a" }).data.map(({ scene }) => scene.id), [
    "scene-long-key", "scene-short-key",
  ]);
});

test("appearance chronology follows hierarchy order across PostgreSQL parent groups", () => {
  const story = input([
    entity("char-a", "character"),
    entity("vol-first", "volume", { order: "0001" }),
    entity("vol-second", "volume", { order: "0002" }),
    entity("ch-first", "chapter", { id: "ch-first", volume: "vol-first", order: "0001" }),
    entity("ch-second", "chapter", { id: "ch-second", volume: "vol-second", order: "0001" }),
    entity("scene-first", "scene", { chapter: "ch-first", order: "0001" }),
    entity("scene-second", "scene", { chapter: "ch-second", order: "0001" }),
  ], [
    { from: "scene-second", to: "char-a", kind: "appears" },
    { from: "scene-first", to: "char-a", kind: "appears" },
  ], new Map([
    ["vol-first", 0], ["vol-second", 1],
    ["ch-second", 2], ["scene-second", 3],
    ["ch-first", 4], ["scene-first", 5],
  ]));

  assert.deepEqual(getEntityAppearances({ ...story, entityId: "char-a" }).data.map(({ scene }) => scene.id), [
    "scene-first", "scene-second",
  ]);
});

test("scene context resolves POV, raw location, relation collections and manuscript path", () => {
  const story = input(
    [
      entity("scene-a", "scene", { location: "loc-raw", manuscript: "manuscript/a.md" }),
      entity("char-a", "character"),
      entity("loc-raw", "location"),
      entity("loc-linked", "location"),
      entity("item-a", "item"),
      entity("thread-a", "thread"),
      entity("manuscript-a", "manuscript", {}, { filePath: "manuscript/a.md", body: "scene text" }),
    ],
    [
      { from: "scene-a", to: "char-a", kind: "pov" },
      { from: "scene-a", to: "char-a", kind: "appears" },
      { from: "scene-a", to: "loc-linked", kind: "appears" },
      { from: "scene-a", to: "item-a", kind: "appears" },
      { from: "scene-a", to: "thread-a", kind: "plants" },
      { from: "scene-a", to: "thread-a", kind: "advances" },
    ],
  );
  const result = buildSceneContext({ ...story, sceneId: "scene-a" });
  assert.equal(result.data?.pov?.id, "char-a");
  assert.equal(result.data?.location?.id, "loc-raw");
  assert.deepEqual(result.data?.appears.map((item) => item.id), ["char-a"]);
  assert.deepEqual(result.data?.items.map((item) => item.id), ["item-a"]);
  assert.deepEqual(result.data?.threadsPlanted.map((item) => item.id), ["thread-a"]);
  assert.deepEqual(result.data?.threadsAdvanced.map((item) => item.id), ["thread-a"]);
  assert.equal(result.data?.manuscriptBody, "scene text");
});

test("scene context infers only location entities from appears links", () => {
  const story = input(
    [
      entity("scene-person-first", "scene"),
      entity("scene-location-first", "scene"),
      entity("scene-people-only", "scene"),
      entity("scene-explicit", "scene", { location: "loc-explicit" }),
      entity("scene-wrong-type-location", "scene", { location: "char-c" }),
      entity("char-a", "character"),
      entity("char-b", "character"),
      entity("char-c", "character"),
      entity("loc-linked", "location"),
      entity("loc-explicit", "location"),
    ],
    [
      { from: "scene-person-first", to: "char-a", kind: "appears" },
      { from: "scene-person-first", to: "loc-linked", kind: "appears" },
      { from: "scene-location-first", to: "loc-linked", kind: "appears" },
      { from: "scene-location-first", to: "char-b", kind: "appears" },
      { from: "scene-people-only", to: "char-c", kind: "appears" },
    ],
  );

  const locationFor = (sceneId: string) =>
    buildSceneContext({ ...story, sceneId }).data?.location?.id;

  assert.equal(locationFor("scene-person-first"), "loc-linked");
  assert.equal(locationFor("scene-location-first"), "loc-linked");
  assert.equal(locationFor("scene-people-only"), undefined);
  assert.equal(locationFor("scene-explicit"), "loc-explicit");
  assert.equal(locationFor("scene-wrong-type-location"), undefined);
});

test("volume tree and scene-location chronology use volume/chapter/scene order", () => {
  const story = input(
    [
      entity("vol-2", "volume", { order: 2 }),
      entity("vol-1", "volume", { order: 1 }),
      entity("ch-2", "chapter", { volume: "vol-2", order: 1 }),
      entity("ch-1", "chapter", { volume: "vol-1", order: 1 }),
      entity("sc-b", "scene", { chapter: "ch-1", order: 2, location: "loc-b" }),
      entity("sc-a", "scene", { chapter: "ch-1", order: 1, location: "loc-a" }),
      entity("sc-c", "scene", { chapter: "ch-2", order: 1, location: "loc-b" }),
      entity("loc-a", "location"),
      entity("loc-b", "location"),
      entity("char-a", "character"),
    ],
    [
      { from: "sc-a", to: "char-a", kind: "appears" },
      { from: "sc-c", to: "char-a", kind: "appears" },
    ],
  );
  assert.deepEqual(getVolumeTree(story).data.map((volume) => volume.volume.id), ["vol-1", "vol-2"]);
  const chronology = buildSceneLocationInfos(story).data;
  assert.deepEqual(
    chronology.map((item) => [item.sceneId, item.order, item.locationId, item.characterIds]),
    [["sc-a", 1, "loc-a", ["char-a"]], ["sc-b", 2, "loc-b", []], ["sc-c", 3, "loc-b", ["char-a"]]],
  );
});

test("hierarchy order follows text order keys and stable IDs across root and nested documents", () => {
  const story = input([
    entity("vol-long-key", "volume", { order: "0000000002" }, { name: "Long key" }),
    entity("vol-short-key", "volume", { order: "00000001" }, { name: "Short key" }),
    entity("vol-tie-z", "volume", { order: "same" }, { name: "A title" }),
    entity("vol-tie-a", "volume", { order: "same" }, { name: "Z title" }),
    entity("ch-long-key", "chapter", { id: "ch-long-key", volume: "vol-long-key", order: "0000000002" }),
    entity("ch-short-key", "chapter", { id: "ch-short-key", volume: "vol-long-key", order: "00000001" }),
    entity("ch-tie-z", "chapter", { id: "ch-tie-z", volume: "vol-long-key", order: "same" }, { name: "A title" }),
    entity("ch-tie-a", "chapter", { id: "ch-tie-a", volume: "vol-long-key", order: "same" }, { name: "Z title" }),
    entity("sc-long-key", "scene", { chapter: "ch-long-key", order: "0000000002" }),
    entity("sc-short-key", "scene", { chapter: "ch-long-key", order: "00000001" }),
    entity("sc-tie-z", "scene", { chapter: "ch-long-key", order: "same" }, { name: "A title" }),
    entity("sc-tie-a", "scene", { chapter: "ch-long-key", order: "same" }, { name: "Z title" }),
    entity("00000000-root-scene", "scene", { order: "0000000002", chapter: null }),
  ]);

  const tree = getVolumeTree(story).data;
  assert.deepEqual(tree.map(({ volume }) => volume.id), [
    "vol-long-key", "vol-short-key", "vol-tie-a", "vol-tie-z",
  ]);
  const chapters = tree.find(({ volume }) => volume.id === "vol-long-key")!.chapters;
  assert.deepEqual(chapters.map(({ chapter }) => chapter.id), [
    "ch-long-key", "ch-short-key", "ch-tie-a", "ch-tie-z",
  ]);
  assert.deepEqual(chapters[0]!.scenes.map((scene) => scene.id), [
    "sc-long-key", "sc-short-key", "sc-tie-a", "sc-tie-z",
  ]);
  assert.deepEqual(buildSceneLocationInfos(story).data.map(({ sceneId }) => sceneId), [
    "00000000-root-scene",
    "sc-long-key", "sc-short-key", "sc-tie-a", "sc-tie-z",
  ]);
});

test("hierarchy siblings preserve PostgreSQL order from the selected snapshot", () => {
  const story = input([
    entity("vol-logical-late", "volume", { order: "same" }, { name: "Z title" }),
    entity("vol-logical-early", "volume", { order: "same" }, { name: "A title" }),
    entity("ch-logical-late", "chapter", { id: "ch-logical-late", volume: "vol-logical-late", order: "same" }, { name: "Z title" }),
    entity("ch-logical-early", "chapter", { id: "ch-logical-early", volume: "vol-logical-late", order: "same" }, { name: "A title" }),
    entity("sc-logical-late", "scene", { chapter: "ch-logical-late", order: "same" }, { name: "Z title" }),
    entity("sc-logical-early", "scene", { chapter: "ch-logical-late", order: "same" }, { name: "A title" }),
    entity("root-scene", "scene", { order: "same", chapter: null }),
  ], [], new Map([
    ["root-scene", 0],
    ["vol-logical-late", 1],
    ["vol-logical-early", 2],
    ["ch-logical-late", 3],
    ["ch-logical-early", 4],
    ["sc-logical-late", 5],
    ["sc-logical-early", 6],
  ]));

  const tree = getVolumeTree(story).data;
  assert.deepEqual(tree.map(({ volume }) => volume.id), ["vol-logical-late", "vol-logical-early"]);
  assert.deepEqual(tree[0]!.chapters.map(({ chapter }) => chapter.id), ["ch-logical-late", "ch-logical-early"]);
  assert.deepEqual(tree[0]!.chapters[0]!.scenes.map((scene) => scene.id), ["sc-logical-late", "sc-logical-early"]);
  assert.deepEqual(buildSceneLocationInfos(story).data.map(({ sceneId }) => sceneId), [
    "root-scene", "sc-logical-late", "sc-logical-early",
  ]);
});

test("thread overview combines both planted relation directions and deduplicates by scene", () => {
  const story = input(
    [entity("thread-x", "thread"), entity("scene-1", "scene"), entity("scene-2", "scene")],
    [
      { from: "thread-x", to: "scene-1", kind: "planted", note: "thread record" },
      { from: "scene-1", to: "thread-x", kind: "plants", note: "scene record" },
      { from: "scene-2", to: "thread-x", kind: "advances" },
      { from: "thread-x", to: "scene-2", kind: "payoff" },
    ],
  );
  const [overview] = getThreadsOverview(story).data;
  assert.deepEqual(overview?.planted.map((item) => [item.scene.id, item.note]), [
    ["scene-1", "thread record"],
  ]);
  assert.deepEqual(overview?.advanced.map((item) => item.scene.id), ["scene-2"]);
  assert.deepEqual(overview?.payoff.map((item) => item.scene.id), ["scene-2"]);
});

test("graph defaults omit scene nodes and location map adds deduplicated reciprocal travel edges", () => {
  const story = input(
    [
      entity("loc-a", "location", { travel: { adjacent: ["loc-b"], daysTo: { "loc-b": 3 } } }),
      entity("loc-b", "location", { travel: { adjacent: ["loc-a"], sameAs: ["loc-c"], daysTo: { "loc-c": 0 } } }),
      entity("loc-c", "location"),
      entity("char-a", "character"),
      entity("scene-a", "scene"),
    ],
    [
      { from: "loc-a", to: "loc-b", kind: "border" },
      { from: "loc-b", to: "loc-a", kind: "border" },
      { from: "scene-a", to: "char-a", kind: "appears" },
    ],
  );
  const defaultGraph = getGraphData(story).data;
  assert.ok(!defaultGraph.nodes.some((node) => node.type === "scene"));
  assert.ok(!defaultGraph.nodes.some((node) => node.type === "volume"));
  const locationMap = buildLocationMap(story).data;
  assert.deepEqual(locationMap.edges, [
    { from: "loc-a", to: "loc-b", kind: "border" },
    { from: "loc-a", to: "loc-b", kind: "adjacent", days: 3 },
    { from: "loc-b", to: "loc-c", kind: "sameAs", days: 0 },
  ]);
});
