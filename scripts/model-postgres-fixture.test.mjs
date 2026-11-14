import assert from "node:assert/strict";
import { test } from "node:test";
import { postgresFixture } from "../tests/helpers/postgres-fixture.mjs";
import { seedModelFixture } from "../tests/integration/model-postgres-fixture.mjs";

test("model acceptance fixture seeds more than one bounded operation into PostgreSQL", async () => {
  const fixture = await postgresFixture({}, "Model seed regression");
  try {
    const files = {
      "plot/volumes/v1/volume.yaml": JSON.stringify({id:"vol-one", title:"Volume", order:1}),
      "plot/volumes/v1/chapters/c1/chapter.yaml": JSON.stringify({id:"ch-one", title:"Chapter", order:1}),
      "meta/scriptorium/modules/semantic/settings.json": JSON.stringify({schemaVersion:1, rerankerEnabled:false}),
    };
    for (let i=0;i<130;i++) {
      const manuscript = "manuscript/v1/c1/sc-"+i+".md";
      files["plot/volumes/v1/chapters/c1/scenes/sc-"+i+".yaml"] = JSON.stringify({id:"sc-"+i,title:"Scene "+i,order:i+1,manuscript});
      files[manuscript] = "本文 "+i+"\n";
    }
    const reader = await seedModelFixture(fixture.store, fixture.project.id, files);
    const current = await fixture.store.reader(fixture.project.id);
    assert.deepEqual(current.snapshot, reader.snapshot);
    assert.equal((await current.list("manuscript")).length,130);
    assert.equal((await current.read("manuscript/v1/c1/sc-129.md")).content,"本文 129\n");
    assert.equal((await current.read("meta/scriptorium/modules/semantic/settings.json")).content,files["meta/scriptorium/modules/semantic/settings.json"]);
    const docs = await fixture.persistence.read(tx=>tx.listDocuments(fixture.project.id,undefined,1000));
    assert.equal(docs.length,132);
  } finally { await fixture.close(); }
});
