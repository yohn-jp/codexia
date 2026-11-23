import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModuleActionContext, ModuleContext, OwnModuleRecord, OwnModuleRecordProposal, SnapshotId } from "@codexia/contracts";
import { createModule } from "./index.js";

const snapshot: SnapshotId = { projectId: "nlp-feature-consent", projectVersion: 13 };
const featureSettingsKey = "feature-settings";

test("external consent reads the bound record and proposes a CAS without applying it", async () => {
  const moduleContext: ModuleContext = {
    cacheDirectory: "/tmp/codexia-nlp-feature-consent-test",
    signal: new AbortController().signal,
    async acquireCapability() { assert.fail("consent does not acquire a model"); },
    async createWorkerService() { assert.fail("consent does not start a worker"); },
  };
  const definition = await createModule(moduleContext);
  const featuresAction = definition.actions?.find((item) => item.id === "nlp.features");
  const consentAction = definition.actions?.find((item) => item.id === "nlp.updateExternalConsent");
  assert.ok(featuresAction);
  assert.ok(consentAction);

  let selectedRecord: OwnModuleRecord | undefined;
  const proposals: OwnModuleRecordProposal[] = [];
  const context: ModuleActionContext = {
    projectId: snapshot.projectId,
    reader: {
      snapshot,
      async read() { return { content: '{"externalEnabled":{"first-read-reaction":true}}', revision: "old-file" }; },
      async list() { assert.fail("consent does not enumerate files"); },
    },
    signal: new AbortController().signal,
    async invoke() { assert.fail("consent does not invoke other actions"); },
    async listActions() { return []; },
    async linkedReader() { assert.fail("consent does not read linked projects"); },
    async reportProgress() { assert.fail("consent does not start a job"); },
    async runJob() { assert.fail("consent does not start a job"); },
    async propose() { assert.fail("consent does not propose file writes"); },
    async readOwnModuleRecord(key) {
      assert.equal(key, featureSettingsKey);
      return selectedRecord;
    },
    async proposeOwnModuleRecord(proposal) {
      proposals.push(proposal);
      return { id: "native-consent-proposal", projectId: snapshot.projectId };
    },
  };

  type Features = { features: Array<{ id: string; label: string; locality: "local" | "external"; enabled: boolean }> };
  async function readFeatures() {
    const result = await featuresAction!.invoke({}, context);
    assert.equal(result.ok, true);
    return (result.data as Features).features;
  }

  const initial = await readFeatures();
  for (const [id, label] of [["first-read-reaction", "初読リアクション"], ["state-event-draft", "状態イベント草案"]] as const) {
    assert.deepEqual(initial.find((item) => item.id === id), { id, label, locality: "external", enabled: false });
  }
  assert.equal(initial.find((feature) => feature.id === "hybrid-search")?.enabled, true);

  const input = { externalEnabled: { "first-read-reaction": true, "state-event-draft": false } };
  assert.throws(() => consentAction.inputSchema.parse({ externalEnabled: { "unmapped-feature": true } }), /unsupported feature flag/u);
  assert.throws(() => consentAction.inputSchema.parse({ externalEnabled: { "first-read-reaction": "true" } }), /unsupported feature flag/u);

  const consent = await consentAction.invoke(consentAction.inputSchema.parse(input), context);
  assert.equal(consent.ok, true);
  assert.deepEqual((consent.data as { changeSet: unknown }).changeSet, { id: "native-consent-proposal", projectId: snapshot.projectId });
  assert.equal(proposals[0]?.expectedVersion, null);
  assert.equal((await readFeatures()).find((feature) => feature.id === "first-read-reaction")?.enabled, false);

  selectedRecord = {
    version: 7,
    value: { externalEnabled: { "setting-qa": "true", rewrite: true, "future-flag": { pending: true } }, ownerNote: { kept: "yes" } },
  };
  const committed = await readFeatures();
  assert.equal(committed.find((feature) => feature.id === "setting-qa")?.enabled, false);
  assert.equal(committed.find((feature) => feature.id === "rewrite")?.enabled, true);
  const update = await consentAction.invoke(consentAction.inputSchema.parse(input), context);
  assert.equal(update.ok, true);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[1]?.key, featureSettingsKey);
  assert.equal(proposals[1]?.expectedVersion, 7);
  assert.ok(proposals[1]?.idempotencyKey);
  assert.deepEqual(proposals[1]?.value, {
    externalEnabled: { "setting-qa": "true", rewrite: true, "future-flag": { pending: true }, "first-read-reaction": true, "state-event-draft": false },
    ownerNote: { kept: "yes" },
  });
});
