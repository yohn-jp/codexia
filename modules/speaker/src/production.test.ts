import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { assertChangeOperation, type ChangeOperation, type ChangeProposal, type ModuleContext, type ModuleManifest, type SnapshotId } from "@codexia/contracts";
import { ModuleRuntime } from "@codexia/module-runtime";
import { createModule as createStoryModule } from "@codexia/module-story";
import { createModule as createNlpModule } from "@codexia/module-nlp";
import { createModule as createDiagnosticsModule } from "@codexia/module-diagnostics";
import { createModule as createSpeakerModule } from "./index.js";

const repository = "p10-synthetic-speaker";

function fileRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function snapshotFor(files: Map<string, { content: string; revision: string }>): SnapshotId {
  const tree = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, file]) => [filePath, file.revision]);
  return { projectId: repository, projectVersion: Number.parseInt(createHash("sha256").update(JSON.stringify(tree)).digest("hex").slice(0, 10), 16) };
}

function sceneText(): string { return "星野は灯りを見た。『俺が行く。』"; }

function addModelProbeScene(files: Map<string, { content: string; revision: string }>): void {
  const sceneId = "sc-synthetic-model-probe";
  const scenePath = `plot/volumes/volume-1/chapters/chapter-1/scenes/${sceneId}.yaml`;
  const manuscriptPath = `manuscript/v1/${sceneId}.md`;
  const scene = [
    `id: ${sceneId}`,
    "type: scene",
    "name: 合成モデル確認シーン",
    "volume: volume-1",
    "chapter: chapter-1",
    "appears: [char-hero]",
    "speakerCount: 1",
    `manuscript: ${manuscriptPath}`,
    "",
  ].join("\n");
  files.set(scenePath, { content: scene, revision: fileRevision(scene) });
  files.set(manuscriptPath, { content: sceneText(), revision: fileRevision(sceneText()) });
}

function initialFiles(sceneCount = 14): Map<string, { content: string; revision: string }> {
  const files = new Map<string, { content: string; revision: string }>();
  const add = (filePath: string, content: string) => files.set(filePath, { content, revision: fileRevision(content) });
  add("plot/volumes/volume-1/volume.yaml", ["id: volume-1", "type: volume", "name: 第一巻", "order: 1", ""].join("\n"));
  add("plot/volumes/volume-1/chapters/chapter-1/chapter.yaml", ["id: chapter-1", "type: chapter", "name: はじまり", "volume: volume-1", "order: 1", ""].join("\n"));
  add("bible/characters/hero/profile.yaml", [
    "id: char-hero",
    "type: character",
    "name: 星野",
    "aliases: [星野]",
    "voicePatterns:",
    "  firstPerson: [僕]",
    "",
  ].join("\n"));
  for (let index = 0; index < sceneCount; index += 1) {
    const id = `sc-synthetic-${String(index + 1).padStart(2, "0")}`;
    const slug = String(index + 1).padStart(2, "0");
    const scenePath = `plot/volumes/volume-1/chapters/chapter-1/scenes/${id}.yaml`;
    const manuscriptPath = `manuscript/v1/${id}.md`;
    add(scenePath, [
      `id: ${id}`,
      "type: scene",
      `name: 合成シーン ${slug}`,
      "volume: volume-1",
      "chapter: chapter-1",
      "appears: [char-hero]",
      "speakerCount: 1",
      `manuscript: ${manuscriptPath}`,
      "",
    ].join("\n"));
    add(manuscriptPath, index === 0 ? `---\n普通の回想\n---\n${sceneText()}` : sceneText());
  }
  const voiceProbeText = "星野は灯りを見た。『俺がゆっくり行きます。』";
  add("plot/volumes/volume-1/chapters/chapter-1/scenes/sc-synthetic-voice-probe.yaml", [
    "id: sc-synthetic-voice-probe",
    "type: scene",
    "name: 口調診断プローブ",
    "volume: volume-1",
    "chapter: chapter-1",
    "appears: [char-hero]",
    "speakerCount: 1",
    "manuscript: manuscript/v1/sc-synthetic-voice-probe.md",
    "",
  ].join("\n"));
  add("manuscript/v1/sc-synthetic-voice-probe.md", voiceProbeText);
  return files;
}

function moduleContext(): ModuleContext {
  return {
    cacheDirectory: "/tmp/codexia-p10-test-cache",
    signal: new AbortController().signal,
    async acquireCapability() { throw new Error("Capability leases are supplied by ModuleRuntime"); },
    async createWorkerService() { throw new Error("Worker services are supplied by ModuleRuntime"); },
  };
}

function readManifest(url: URL): ModuleManifest {
  return JSON.parse(readFileSync(url, "utf8")).codexiaModule as ModuleManifest;
}

async function createRuntime(
  files: Map<string, { content: string; revision: string }>,
  getSnapshot: () => SnapshotId,
  cacheDirectory: string,
): Promise<{ runtime: ModuleRuntime; host: Parameters<ModuleRuntime["invokeAction"]>[3]; jobProgress: Map<string, number[][]> }> {
  const manifests = [
    readManifest(new URL("../../story/package.json", import.meta.url)),
    readManifest(new URL("../../nlp/package.json", import.meta.url)),
    readManifest(new URL("../../diagnostics/package.json", import.meta.url)),
    readManifest(new URL("../package.json", import.meta.url)),
  ];
  const runtime = new ModuleRuntime({
    manifests,
    enabled: ["speaker"],
    cacheDirectory,
    loaders: {
      story: async (context) => createStoryModule(context),
      nlp: (context) => createNlpModule(context),
      diagnostics: (context) => createDiagnosticsModule(context),
      speaker: (context) => createSpeakerModule(context),
    },
    workerEntries: {
      nlp: fileURLToPath(new URL("../../nlp/dist/worker.js", import.meta.url)),
      diagnostics: fileURLToPath(new URL("../../diagnostics/dist/worker.js", import.meta.url)),
      speaker: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    },
  });
  const jobProgress = new Map<string, number[][]>();
  const host: Parameters<ModuleRuntime["invokeAction"]>[3] = {
    projectId: repository,
    signal: new AbortController().signal,
    reader: {
      get snapshot() { return getSnapshot(); },
      async read(filePath: string) { return files.get(filePath) ?? null; },
      async list(prefix: string) {
        return [...files.keys()].filter((filePath) => filePath === prefix || filePath.startsWith(`${prefix}/`)).sort();
      },
    },
    async propose(operations: ChangeOperation[], evidence?: ChangeProposal["evidence"], proposalId?: string) {
      const snapshot = getSnapshot();
      for (const operation of operations) assertChangeOperation(operation);
      const proposal: ChangeProposal = { id: proposalId ?? `p10-proposal-${Date.now()}`, snapshot, operations, source: "module", ...(evidence ? { evidence } : {}) };
      return proposal;
    },
    async trackDomainJob(descriptor, _snapshot, _signal, execute) {
      const invocations = jobProgress.get(descriptor.job.type) ?? [];
      const progress: number[] = [];
      invocations.push(progress);
      jobProgress.set(descriptor.job.type, invocations);
      return execute(async (value) => { progress.push(value); });
    },
  };
  return { runtime, host, jobProgress };
}

function applyReviewedProposal(
  proposal: ChangeProposal,
  files: Map<string, { content: string; revision: string }>,
  getSnapshot: () => SnapshotId,
  setSnapshot: (snapshot: SnapshotId) => void,
): void {
  assert.deepEqual(proposal.snapshot, getSnapshot(), "Core proposal must be bound to the pinned snapshot being reviewed");
  for (const operation of proposal.operations) {
    assertChangeOperation(operation);
    assert.equal(operation.baseProjectVersion, proposal.snapshot.projectVersion);
    for (const read of operation.reads) assert.equal(files.get(read.path)?.revision ?? null, read.revision, `${read.path} read revision`);
    for (const write of operation.writes) {
      if (write.content === null) files.delete(write.path);
      else files.set(write.path, { content: write.content, revision: fileRevision(write.content) });
    }
  }
  setSnapshot(snapshotFor(files));
}

function dataOf(result: Awaited<ReturnType<ModuleRuntime["invokeAction"]>>): Record<string, unknown> {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected successful result");
  assert.ok(result.data && typeof result.data === "object" && !Array.isArray(result.data));
  return result.data as Record<string, unknown>;
}

function assertSpeakerIdentity(data: Record<string, unknown>, adoptedModelRevision: string | null): void {
  assert.equal(data.speakerEngine, "codexia-speaker-cpu");
  assert.equal(data.speakerEngineVersion, "1.0.0");
  assert.equal(data.speakerModuleVersion, "0.1.0");
  assert.equal(data.tokenizerModel, "lindera-wasm-nodejs-ipadic");
  assert.equal(data.tokenizerModelVersion, "2.0.0");
  assert.deepEqual(data.adoptedModelIdentity, adoptedModelRevision === null ? null : { revision: adoptedModelRevision });
}

test("loading the server entry does not install worker IPC listeners in the host", () => {
  const entry = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url))).href;
  const script = `const before = process.listenerCount("message"); await import(${JSON.stringify(entry)}); const after = process.listenerCount("message"); if (after !== before) { console.error(JSON.stringify({ before, after })); process.exitCode = 1; }`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("evaluation and retraining actions advertise their source job types", async () => {
  const definition = await createSpeakerModule(moduleContext());
  const actions = new Map(definition.actions.map((action) => [action.id, action]));
  assert.deepEqual(actions.get("speaker.evaluation.run")?.job, { type: "speaker-eval" });
  assert.deepEqual(actions.get("speaker.retraining.run")?.job, { type: "speaker-retrain" });
});

test("speaker actions retain dialogue from Markdown beginning with a horizontal rule and run real CPU attribution", { timeout: 180_000 }, async () => {
  const files = initialFiles();
  let snapshot = snapshotFor(files);
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "codexia-p10-cache-"));
  let runtime: ModuleRuntime | undefined;
  try {
    const first = await createRuntime(files, () => snapshot, cacheDirectory);
    runtime = first.runtime;
    const { host, jobProgress } = first;

    assert.equal(runtime.status("speaker").availability, "enabled-idle");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "enabled-idle speaker allocates neither tokenizer nor speaker worker");

    const sceneId = "sc-synthetic-01";
    const attributed = await runtime.invokeAction("speaker", "speaker.attribute", { sceneId }, host);
    const attributionData = dataOf(attributed);
    assertSpeakerIdentity(attributionData, null);
    assert.deepEqual(attributed.snapshot, snapshot);
    const attributions = attributionData.attributions as Array<{ sentenceIndex: number; text: string; speakerEntityId: string | null; confidence: string; reason: string }>;
    assert.equal(attributions.length, 1, JSON.stringify(attributions));
    const predicted = attributions[0]!;
    assert.equal(predicted.text, "『俺が行く。』");
    assert.equal(predicted.speakerEntityId, "char-hero", JSON.stringify(predicted));
    assert.equal(predicted.confidence, "high", JSON.stringify(predicted));

    const voice = await runtime.invokeAction("speaker", "speaker.voice.check", { sceneId: "sc-synthetic-voice-probe" }, host);
    const voiceData = dataOf(voice);
    assertSpeakerIdentity(voiceData, null);
    const voiceWarnings = voiceData.warnings as Array<{ issue: string; basis: string }>;
    assert.ok(voiceWarnings.some((warning) => warning.issue === "unexpected-first-person" && warning.basis === "profile"), JSON.stringify(voiceData));
    const learnedVoiceWarnings = voiceData.styleDeviations as Array<{ issue: string; basis: string; sentenceIndex: number }>;
    assert.ok(learnedVoiceWarnings.some((warning) => warning.issue === "unusual-ending" && warning.basis === "statistical"), JSON.stringify(voiceData));
    const stylometricWarnings = voiceData.stylometricDeviations as Array<{ sentenceIndex: number }>;
    assert.ok(stylometricWarnings.some((warning) => warning.sentenceIndex === 2), JSON.stringify(voiceData));
    const mergedIssues = voiceData.issues as Array<{ source: string; issueLabel: string }>;
    assert.ok(mergedIssues.some((warning) => warning.source === "registered" && warning.issueLabel === "想定外の一人称"), JSON.stringify(voiceData));
    assert.ok(mergedIssues.some((warning) => warning.source === "learned" && warning.issueLabel === "学習語尾から逸脱"), JSON.stringify(voiceData));
    assert.ok(mergedIssues.some((warning) => warning.source === "stylometric"), JSON.stringify(voiceData));
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "voice-check worker and its shared Lindera lease are released after the action");

    const draftText = "星野は灯りを見た。『僕が行く。』";
    const voiceDraft = await runtime.invokeAction("speaker", "speaker.voice.check", { sceneId: "sc-synthetic-voice-probe", text: draftText }, host);
    const voiceDraftData = dataOf(voiceDraft);
    assertSpeakerIdentity(voiceDraftData, null);
    assert.equal((voiceDraftData.attributions as Array<{ text: string }>)[0]?.text, "『僕が行く。』");
    assert.equal(voiceDraftData.estimatedN, 1);
    assert.equal(voiceDraftData.fromManual, true);
    assert.ok(voiceDraftData.evidence && typeof voiceDraftData.evidence === "object");
    assert.ok(Array.isArray(voiceDraftData.clusterTrails));
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "draft voice-check releases worker and shared tokenizer lease");

    const dialogue = await runtime.invokeAction("speaker", "speaker.dialogue.list", { characterId: "char-hero", limit: 80, minConfidence: "low" }, host);
    const dialogueData = dataOf(dialogue);
    assertSpeakerIdentity(dialogueData, null);
    assert.equal(dialogueData.count, 15);
    const recordedLines = dialogueData.lines as Array<{ sceneId: string; sentenceIndex: number; text: string; confidence: string }>;
    const linesByScene = new Map(recordedLines.map((line) => [line.sceneId, line]));
    assert.equal(linesByScene.get("sc-synthetic-01")?.text, "『俺が行く。』");
    assert.equal(recordedLines[0]?.confidence, "high");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, []);

    const voiceProfiles = await runtime.invokeAction("speaker", "speaker.voice.profiles", {}, host);
    const voiceProfileData = dataOf(voiceProfiles);
    assertSpeakerIdentity(voiceProfileData, null);
    const heroFingerprint = (voiceProfileData.fingerprints as Array<{ entityId: string; dialogueCount: number }>).find((row) => row.entityId === "char-hero");
    const heroStylometric = (voiceProfileData.stylometricProfiles as Array<{ entityId: string; dialogueCount: number }>).find((row) => row.entityId === "char-hero");
    assert.equal(heroFingerprint?.dialogueCount, 15);
    assert.equal(heroStylometric?.dialogueCount, 15);
    assert.equal(voiceProfileData.diagnosticsEngine, "codexia-diagnostics-cpu");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, []);

    const review = await runtime.invokeAction("speaker", "speaker.review.queue", {}, host);
    const reviewData = dataOf(review);
    assertSpeakerIdentity(reviewData, null);
    assert.ok(Array.isArray(reviewData.rows));
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, []);

    const holdoutIds = ["sc-synthetic-11", "sc-synthetic-12", "sc-synthetic-13", "sc-synthetic-14"];
    const holdoutGoldByScene = new Map<string, string | null>(holdoutIds.map((id) => [id, null]));
    holdoutGoldByScene.set("sc-synthetic-11", "char-hero");
    const holdoutPredictionsBeforeTraining = new Map<string, string | null>();
    for (let index = 0; index < 14; index += 1) {
      const currentSceneId = `sc-synthetic-${String(index + 1).padStart(2, "0")}`;
      if (holdoutIds.includes(currentSceneId)) {
        const sceneResult = await runtime.invokeAction("speaker", "speaker.attribute", { sceneId: currentSceneId }, host);
        const row = (dataOf(sceneResult).attributions as typeof attributions)[0]!;
        assert.equal(row.speakerEntityId, "char-hero", `synthetic rule attribution ${currentSceneId}`);
        holdoutPredictionsBeforeTraining.set(currentSceneId, row.speakerEntityId);
      }
      const line = linesByScene.get(currentSceneId);
      assert.ok(line, `the observed source dialogue exists for correction in ${currentSceneId}`);
      const proposed = await runtime.invokeAction("speaker", "speaker.override", {
        sceneId: currentSceneId,
        sentenceIndex: line.sentenceIndex,
        dialogueText: line.text,
        speakerEntityId: holdoutGoldByScene.get(currentSceneId) ?? null,
      }, host);
      const proposalData = dataOf(proposed);
      if (index === 0) assertSpeakerIdentity(proposalData, null);
      assert.equal(proposed.ok && proposed.proposals?.length, 1, JSON.stringify(proposed));
      const proposal: ChangeProposal | undefined = proposed.ok ? proposed.proposals?.[0] : undefined;
      assert.ok(proposal, JSON.stringify(proposalData));
      assert.deepEqual(proposal.operations[0]?.writes.map((write) => write.path).sort(), [
        `meta/scriptorium/modules/speaker/corrections.jsonl`,
        `plot/volumes/volume-1/chapters/chapter-1/scenes/${currentSceneId}.yaml`,
      ].sort());
      applyReviewedProposal(proposal, files, () => snapshot, (next) => { snapshot = next; });
      assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "each action releases both supervised CPU processes");
    }

    const correctionPath = "meta/scriptorium/modules/speaker/corrections.jsonl";
    const corrections = files.get(correctionPath)?.content ?? "";
    assert.equal(corrections.trim().split("\n").length, 14);
    assert.ok(corrections.includes('"speakerEntityId":null'));

    const assertCompletedProgress = (jobType: string, expectedRuns: number) => {
      const runs = jobProgress.get(jobType);
      assert.equal(runs?.length, expectedRuns);
      for (const updates of runs ?? []) {
        assert.ok(updates.length >= 2, "a domain job reports progress before completion");
        assert.ok(updates[0]! >= 0 && updates[0]! < 1);
        assert.deepEqual(updates, updates.toSorted((a, b) => a - b));
        assert.equal(updates.at(-1), 1);
      }
    };

    const trained = await runtime.invokeAction("speaker", "speaker.retraining.run", { holdoutSceneIds: holdoutIds }, host);
    assertCompletedProgress("speaker-retrain", 1);
    const trainingData = dataOf(trained);
    assertSpeakerIdentity(trainingData, null);
    assert.equal(trainingData.adopted, true, JSON.stringify({ accuracyWithoutModel: trainingData.accuracyWithoutModel, accuracyWithModel: trainingData.accuracyWithModel, deltaPt: trainingData.deltaPt }));
    const accuracyFromPredictions = (predictions: Map<string, string | null>) => {
      assert.equal(predictions.size, holdoutIds.length, "accuracy uses one observed prediction for every fixed holdout scene");
      const correct = [...predictions].filter(([sceneId, predicted]) => holdoutGoldByScene.get(sceneId) === predicted).length;
      return correct / holdoutIds.length;
    };
    assert.equal(trainingData.accuracyWithoutModel, accuracyFromPredictions(holdoutPredictionsBeforeTraining));
    assert.equal(trainingData.accuracyWithoutModel, 0.25);
    assert.equal(trainingData.accuracyWithModel, 0.75);
    assert.ok(Number(trainingData.deltaPt) >= 5, JSON.stringify(trainingData));
    assert.ok(Number(trainingData.trainExampleCount) >= 10);
    const trainingProvenance = trainingData.provenance as Record<string, unknown>;
    assert.equal(trainingProvenance.engineId, "codexia-speaker-cpu");
    assert.equal(trainingProvenance.engineVersion, "1.0.0");
    assert.equal(trainingProvenance.moduleVersion, "0.1.0");
    assert.ok(Array.isArray(trainingData.model && (trainingData.model as Record<string, unknown>).weights));
    const modelProposal = trained.ok ? trained.proposals?.find((proposal) => proposal.operations.some((operation) => operation.writes.some((write) => write.path === "meta/scriptorium/modules/speaker/adopted-model.json"))) : undefined;
    assert.ok(modelProposal, "only the host proposal boundary receives the adopted CPU model");
    const modelOperation = modelProposal.operations[0]!;
    assert.equal(modelOperation.effect, "settings");
    assert.deepEqual(modelOperation.writes.map((write) => write.path), ["meta/scriptorium/modules/speaker/adopted-model.json"]);
    applyReviewedProposal(modelProposal, files, () => snapshot, (next) => { snapshot = next; });

    addModelProbeScene(files);
    snapshot = snapshotFor(files);
    const applied = await runtime.invokeAction("speaker", "speaker.attribute", { sceneId: "sc-synthetic-model-probe" }, host);
    const appliedData = dataOf(applied);
    const adoptedModelRevision = files.get("meta/scriptorium/modules/speaker/adopted-model.json")!.revision;
    assertSpeakerIdentity(appliedData, adoptedModelRevision);
    const appliedRow = (appliedData.attributions as typeof attributions)[0]!;
    assert.equal(appliedRow.speakerEntityId, null, JSON.stringify(appliedRow));
    assert.equal(appliedRow.reason, "rerank", JSON.stringify(appliedRow));
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, []);

    const evaluation = await runtime.invokeAction("speaker", "speaker.evaluation.run", { writeGates: true }, host);
    assertCompletedProgress("speaker-eval", 1);
    const evaluationData = dataOf(evaluation);
    assertSpeakerIdentity(evaluationData, adoptedModelRevision);
    assert.equal(evaluationData.gatesUpdated, true);
    const evaluationProvenance = evaluationData.provenance as Record<string, unknown>;
    assert.equal(evaluationProvenance.speakerEngine, "codexia-speaker-cpu");
    assert.deepEqual(evaluationProvenance.adoptedModelIdentity, { revision: adoptedModelRevision });
    assert.equal(evaluationProvenance.engineId, "codexia-speaker-cpu");
    assert.equal(evaluationProvenance.engineVersion, "1.0.0");
    assert.equal(evaluationProvenance.tokenizerModel, "lindera-wasm-nodejs-ipadic");
    assert.equal(typeof evaluationProvenance.adoptedModelRevision, "string");
    const report = evaluationData.report as { scenes: Array<{ sceneId: string }>; metrics: { attributionAccuracy: number } };
    assert.equal(report.scenes.length, 14);
    assert.equal(report.metrics.attributionAccuracy, 13 / 14, JSON.stringify(report.metrics));
    const latest = await runtime.invokeAction("speaker", "speaker.evaluation.latest", {}, host);
    const latestData = dataOf(latest);
    assertSpeakerIdentity(latestData, adoptedModelRevision);
    assert.equal(latestData.exists, true);
    const gates = await runtime.invokeAction("speaker", "speaker.ruleGates", {}, host);
    const gatesData = dataOf(gates);
    assertSpeakerIdentity(gatesData, adoptedModelRevision);
    assert.equal(gatesData.exists, true);

    const cacheDirectoryForSpeaker = path.join(cacheDirectory, "speaker", "speaker");
    const cacheFiles = await readdir(cacheDirectoryForSpeaker);
    for (const kind of ["evaluation", "rules"] as const) {
      const fileName = cacheFiles.find((name) => name.startsWith(`${kind}-`) && name.endsWith(".json"));
      assert.ok(fileName, `${kind} cache was persisted`);
      const filePath = path.join(cacheDirectoryForSpeaker, fileName);
      const stored = JSON.parse(await readFile(filePath, "utf8")) as { identity: Record<string, unknown> };
      stored.identity.engineVersion = "0.0.0";
      await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    }
    assert.equal(dataOf(await runtime.invokeAction("speaker", "speaker.evaluation.latest", {}, host)).exists, false, "stored evaluation from an old engine is rejected despite matching snapshot and cache path");
    assert.equal(dataOf(await runtime.invokeAction("speaker", "speaker.ruleGates", {}, host)).exists, false, "stored rule gates from an old engine are rejected despite matching snapshot and cache path");
    const rebuilt = await runtime.invokeAction("speaker", "speaker.evaluation.run", { writeGates: true }, host);
    assertCompletedProgress("speaker-eval", 2);
    assert.equal(dataOf(rebuilt).gatesUpdated, true);
    assert.equal(dataOf(await runtime.invokeAction("speaker", "speaker.evaluation.latest", {}, host)).exists, true);
    assert.equal(dataOf(await runtime.invokeAction("speaker", "speaker.ruleGates", {}, host)).exists, true);

    await runtime.shutdown();
    runtime = undefined;
    assert.deepEqual(files.get("meta/scriptorium/modules/speaker/adopted-model.json") && JSON.parse(files.get("meta/scriptorium/modules/speaker/adopted-model.json")!.content).weights, (trainingData.model as Record<string, unknown>).weights);

    const restarted = await createRuntime(files, () => snapshot, cacheDirectory);
    runtime = restarted.runtime;
    assert.equal(runtime.status("speaker").availability, "enabled-idle");
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "recreated runtime starts idle and reloads only on demand");
    const reloaded = await runtime.invokeAction("speaker", "speaker.attribute", { sceneId: "sc-synthetic-model-probe" }, restarted.host);
    const reloadedRow = (dataOf(reloaded).attributions as typeof attributions)[0]!;
    assert.equal(reloadedRow.speakerEntityId, null, JSON.stringify(reloadedRow));
    assert.equal(reloadedRow.reason, "rerank", JSON.stringify(reloadedRow));
    assert.equal((dataOf(await runtime.invokeAction("speaker", "speaker.evaluation.latest", {}, restarted.host))).exists, true);
    assert.equal((dataOf(await runtime.invokeAction("speaker", "speaker.ruleGates", {}, restarted.host))).exists, true);

    for (const id of holdoutIds) {
      const scenePath = `plot/volumes/volume-1/chapters/chapter-1/scenes/${id}.yaml`;
      const sceneFile = files.get(scenePath);
      assert.ok(sceneFile, `holdout scene ${id} exists`);
      const scene = parse(sceneFile.content) as Record<string, unknown>;
      delete scene.speakerOverrides;
      const content = stringify(scene);
      files.set(scenePath, { content, revision: fileRevision(content) });
    }
    snapshot = snapshotFor(files);

    const holdoutPredictionsAfterTraining = new Map<string, string | null>();
    for (const id of holdoutIds) {
      const prediction = await runtime.invokeAction("speaker", "speaker.attribute", { sceneId: id }, restarted.host);
      const predictionData = dataOf(prediction);
      const row = (predictionData.attributions as typeof attributions).find((item) => item.text === "『俺が行く。』");
      assert.ok(row, `holdout prediction exists for ${id}`);
      assert.equal(row.reason, "rerank", JSON.stringify(row));
      holdoutPredictionsAfterTraining.set(id, row.speakerEntityId);
      assert.notEqual(row.speakerEntityId, holdoutPredictionsBeforeTraining.get(id), `the new model changes the prediction for ${id}`);
    }
    assert.equal(accuracyFromPredictions(holdoutPredictionsAfterTraining), 0.75);
    assert.equal(trainingData.pipelineHoldoutAccuracy, accuracyFromPredictions(holdoutPredictionsAfterTraining));
    assert.deepEqual(runtime.workerSupervisor.activeWorkerPids, [], "all worker and shared tokenizer processes exit after reload checks");
  } finally {
    await runtime?.shutdown();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
