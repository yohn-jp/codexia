import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { CoreStore } from "../../packages/core/dist/index.js";
import { createPostgresPersistence, migratePostgresDatabase } from "../../packages/persistence-postgres/dist/index.js";
import {
  createMigrationProducerRegistry,
  inspectLegacyProject,
  proposeMigrationImport,
  registerMigrationProducer,
} from "../../packages/migration/dist/index.js";
import { createStoryMigrationProducer } from "@codexia/module-story/migration";
import { createDiagnosticsMigrationProducer } from "@codexia/module-diagnostics/migration";
import { createNlpMigrationProducer } from "@codexia/module-nlp/migration";
import { createSemanticMigrationProducer } from "@codexia/module-semantic/migration";
import { createSpeakerMigrationProducer } from "@codexia/module-speaker/migration";
import { createAssistantMigrationProducer } from "@codexia/module-assistant/migration";
import { createPublishingMigrationProducer } from "@codexia/module-publishing/migration";
import { hashDialogueText } from "@codexia/module-speaker";

const SPEAKER_OVERRIDE_SCENE_PATH = "plot/volumes/volume-1/chapters/chapter-1/scenes/sc-speaker-override-stable.yaml";
const SPEAKER_OVERRIDE_MANUSCRIPT_PATH = "manuscript/v1/sc-speaker-override-stable.md";
const SPEAKER_OVERRIDE_DIALOGUE = "『俺が行く。』";
const LEGACY_DESKTOP_CURSOR_UPDATED_AT = "2025-04-03T10:00:00.000Z";
const LEGACY_MOBILE_CURSOR_UPDATED_AT = "2025-04-03T11:00:00.000Z";
const SPEAKER_OVERRIDE_SCENE = [
  "id: sc-speaker-override-stable",
  "type: scene",
  "name: Synthetic manual speaker override",
  "volume: volume-1",
  "chapter: chapter-1",
  "appears: [char-hero]",
  "speakerCount: 1",
  `manuscript: ${SPEAKER_OVERRIDE_MANUSCRIPT_PATH}`,
  "speakerOverrides:",
  "  - sentenceIndex: 1",
  `    textHash: ${hashDialogueText(SPEAKER_OVERRIDE_DIALOGUE)}`,
  `    dialogueText: "${SPEAKER_OVERRIDE_DIALOGUE}"`,
  "    speakerEntityId: char-hero",
  "    source: direct",
  "unknown-scene-field: retain exactly",
  "",
].join("\n");
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    env: FIXTURE_GIT_ENV,
  }).trim();
}

async function writeFile(root, relativePath, value) {
  const absolute = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, value);
}

async function treeState(root) {
  const state = [];
  const rootInfo = await fs.lstat(root, { bigint: true });
  state.push({ path: ".", type: "directory", mode: rootInfo.mode.toString(), size: rootInfo.size.toString(), mtimeNs: rootInfo.mtimeNs.toString() });
  const visit = async (directory) => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const info = await fs.lstat(absolute, { bigint: true });
      const entry = {
        path: relative,
        type: child.isDirectory() ? "directory" : child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other",
        mode: info.mode.toString(),
        size: info.size.toString(),
        mtimeNs: info.mtimeNs.toString(),
      };
      if (child.isDirectory()) {
        state.push(entry);
        await visit(absolute);
      } else if (child.isSymbolicLink()) {
        state.push({ ...entry, link: await fs.readlink(absolute) });
      } else if (child.isFile()) {
        state.push({ ...entry, hash: hash(await fs.readFile(absolute)) });
      } else state.push(entry);
    }
  };
  await visit(root);
  return state;
}

async function makeLegacyRepository(root) {
  const seed = path.join(root, "seed");
  const remote = path.join(root, "legacy-remote.git");
  const sourceRoot = path.join(root, "legacy-project");
  await fs.mkdir(seed, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore", env: FIXTURE_GIT_ENV });
  git(seed, "config", "user.name", "Synthetic Author");
  git(seed, "config", "user.email", "author@example.invalid");
  await writeFile(seed, ".gitignore", ".arcadia/\n");
  await writeFile(seed, "meta/project.yaml", "id: legacy-project\ntitle: Synthetic Work\nunknown-project-field: keep\n");
  await writeFile(seed, "plot/volumes/volume-1/volume.yaml", "id: volume-1\ntitle: Volume 1\ntype: volume\norder: 1\n");
  await writeFile(seed, "plot/volumes/volume-1/chapters/chapter-1/chapter.yaml", "id: chapter-1\nvolume: volume-1\ntitle: Chapter 1\ntype: chapter\norder: 1\n");
  await writeFile(seed, "meta/scratch/idea-stable.md", "A synthetic published scratch note.\n");
  await writeFile(seed, "meta/scratch/files/idea-stable/diagram.bin", Buffer.from([7, 0, 249, 33]));
  await writeFile(seed, SPEAKER_OVERRIDE_SCENE_PATH, SPEAKER_OVERRIDE_SCENE);
  await writeFile(seed, SPEAKER_OVERRIDE_MANUSCRIPT_PATH, `星野は灯りを見た。${SPEAKER_OVERRIDE_DIALOGUE}\n`);
  await writeFile(seed, "story/scene.md", "published scene\n");
  await writeFile(seed, "notes/author-note.md", "Synthetic author note, retained exactly.\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "synthetic legacy baseline");

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore", env: FIXTURE_GIT_ENV });
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--set-upstream", "origin", "main");
  execFileSync("git", ["clone", remote, sourceRoot], { stdio: "ignore", env: FIXTURE_GIT_ENV });
  git(sourceRoot, "config", "user.name", "Synthetic Author");
  git(sourceRoot, "config", "user.email", "author@example.invalid");

  await writeFile(sourceRoot, ".npmrc", "//registry.example.invalid/:_authToken=DO_NOT_EXPORT_SYNTHETIC_NPM_SECRET\n");
  await writeFile(sourceRoot, ".ssh/id_ed25519", "DO_NOT_EXPORT_SYNTHETIC_PRIVATE_KEY\n");
  git(sourceRoot, "add", ".npmrc", ".ssh/id_ed25519");

  await writeFile(sourceRoot, "notes/from-unpublished-commit.md", "A committed local note that has not reached the remote.\n");
  git(sourceRoot, "add", "notes/from-unpublished-commit.md");
  git(sourceRoot, "commit", "-m", "unpublished author work");
  await writeFile(sourceRoot, "story/scene.md", "staged author version\n");
  git(sourceRoot, "add", "story/scene.md");
  await writeFile(sourceRoot, "notes/staged-add.md", "A staged local addition.\n");
  git(sourceRoot, "add", "notes/staged-add.md");
  await fs.unlink(path.join(sourceRoot, "notes/author-note.md"));
  git(sourceRoot, "add", "-u", "notes/author-note.md");
  await writeFile(sourceRoot, "notes/story-clue.md", "This fictional note uses the word secret as part of its plot.\n");
  return { remote, sourceRoot };
}

function insertStateProposal(database, { id, status, subject, token = null }) {
  database.prepare(`INSERT INTO state_proposals (
    id, scene_id, event_json, manuscript_hash, status, conflict_event_ids_json,
    duplicate_of_proposal_id, history_json, created_at, updated_at, api_token, vendor_extension
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, "scene-legacy", JSON.stringify({ kind: "move", subject, object: "library" }), "source-hash",
      status, "[]", null, "[{\"action\":\"created\"}]", "2025-01-01T00:00:00.000Z",
      "2025-01-02T00:00:00.000Z", token, `unknown-state:${id}`);
}

function insertSuggestion(database, { id, status, text }) {
  database.prepare(`INSERT INTO zukan_suggestions (
    id, entity_id, block_path, proposed_text, evidence_json, status, source,
    kind, source_session_id, source_turn_range_json, confidence, created_at, updated_at, plugin_payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, "character-legacy", "facts/0", text, "[{\"quote\":\"author evidence\"}]", status,
      "manuscript", "fact", null, null, "high", "2025-02-01T00:00:00.000Z", "2025-02-02T00:00:00.000Z",
      `unknown-suggestion:${id}`);
}

function createLegacyDatabase(file, state, suggestions) {
  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  database.exec(`
    CREATE TABLE state_proposals (
      id TEXT PRIMARY KEY, scene_id TEXT NOT NULL, event_json TEXT NOT NULL,
      manuscript_hash TEXT NOT NULL, status TEXT NOT NULL, conflict_event_ids_json TEXT NOT NULL,
      duplicate_of_proposal_id TEXT, history_json TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, api_token TEXT, vendor_extension TEXT
    );
    CREATE TABLE zukan_suggestions (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, block_path TEXT NOT NULL,
      proposed_text TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL, kind TEXT, source_session_id TEXT, source_turn_range_json TEXT,
      confidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, plugin_payload TEXT
    );
    CREATE TABLE entities (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE scene_state_events (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE reader_knowledge_events (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE private_tokens (id TEXT, token_value TEXT);
  `);
  for (const row of state) insertStateProposal(database, row);
  for (const row of suggestions) insertSuggestion(database, row);
  database.prepare("INSERT INTO entities VALUES (?, ?)").run("derived-entity", "DO_NOT_PUBLISH_DERIVED_ENTITY");
  database.prepare("INSERT INTO scene_state_events VALUES (?, ?)").run("derived-state", "DO_NOT_PUBLISH_SCENE_EVENT");
  database.prepare("INSERT INTO reader_knowledge_events VALUES (?, ?)").run("derived-knowledge", "DO_NOT_PUBLISH_KNOWLEDGE_EVENT");
  database.prepare("INSERT INTO private_tokens VALUES (?, ?)").run("credential-row", "DO_NOT_EXPORT_SQLITE_SECRET");
  return database;
}

async function addLegacyDatabases(sourceRoot, workspaceRoot) {
  const projectPath = path.join(sourceRoot, ".arcadia/index.sqlite");
  const workspacePath = path.join(workspaceRoot, "index", path.basename(sourceRoot), "index.sqlite");
  await fs.mkdir(path.dirname(projectPath), { recursive: true });
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  const project = createLegacyDatabase(projectPath,
    [
      { id: "state-project-approved", status: "approved", subject: "accepted project state", token: "DO_NOT_EXPORT_SQLITE_SECRET" },
      { id: "state-divergent", status: "approved", subject: "project version" },
      { id: "state-project-pending", status: "proposed", subject: "project proposal" },
    ],
    [
      { id: "zukan-project-approved", status: "approved", text: "accepted project fact" },
      { id: "zukan-project-pending", status: "pending", text: "unaccepted project suggestion" },
      { id: "zukan-divergent", status: "approved", text: "project suggestion version" },
    ]);
  const workspace = createLegacyDatabase(workspacePath,
    [
      { id: "state-workspace-rejected", status: "rejected", subject: "rejected workspace state" },
      { id: "state-divergent", status: "approved", subject: "workspace version" },
      { id: "state-workspace-stale", status: "stale", subject: "stale workspace proposal" },
    ],
    [
      { id: "zukan-workspace-rejected", status: "rejected", text: "rejected workspace fact" },
      { id: "zukan-workspace-pending", status: "pending", text: "unaccepted workspace suggestion" },
      { id: "zukan-workspace-stale", status: "stale", text: "stale workspace suggestion" },
      { id: "zukan-divergent", status: "rejected", text: "workspace suggestion version" },
    ]);
  return [project, workspace];
}

async function addLegacyFiles(sourceRoot, workspaceRoot) {
  const textFiles = new Map([
    ["meta/speaker-corrections.jsonl", "{\"id\":\"speaker-correction-stable\",\"speakerId\":\"speaker-1\",\"label\":\"Mika\",\"extension\":{\"retain\":true}}\n"],
    ["meta/speaker-model.json", "{\"version\":1,\"featureNames\":[\"manual\"],\"weights\":[0.5],\"bias\":0,\"extension\":\"retain\"}\n"],
    ["meta/synonyms.yaml", "groups:\n  - canonical: lantern\n    variants: [lamp, light]\nunknown-extension: retain\n"],
    ["meta/candidate-ignore-list.yaml", "terms:\n  - keep-out\nunknown-extension: retain\n"],
    ["meta/contradiction-dismissals.jsonl", "{\"id\":\"dismissal-stable\",\"candidateId\":\"candidate-1\",\"reason\":\"author reviewed\"}\n"],
    ["meta/publish-episodes.yaml", "episodes:\n  - id: episode-stable\n    number: 1\n    title: First\n    scope: chapter\n    scopeId: chapter-1\n    sceneIds: [scene-legacy]\nunknown-extension: retain\n"],
    ["meta/lint-rules.yaml", "rules:\n  - id: rule-stable\n    expression: 'true'\nunknown-extension: retain\n"],
    ["meta/tone-lexicon.yaml", "terms:\n  - word: lantern\n    weight: 0.5\nunknown-extension: retain\n"],
    ["meta/plot-lexicon.yaml", "terms:\n  - word: promise\n    weight: 0.5\nunknown-extension: retain\n"],
    [".arcadia/llm-model-settings.json", "{\"defaultPresetId\":\"small-local\",\"presets\":[{\"id\":\"small-local\",\"model\":\"local/tiny\"}],\"extension\":{\"retain\":true}}\n"],
    [".arcadia/nlp-feature-settings.json", "{\"enabledFeatures\":[],\"privacy\":\"local-only\",\"extension\":7}\n"],
    [".arcadia/llm-usage.jsonl", "{\"id\":\"usage-stable\",\"model\":\"local/tiny\",\"tokens\":3}\n"],
    [".arcadia/change-sets/applied.json", "{\"changeSet\":{\"id\":\"applied-changeset-stable\"},\"status\":\"applied\",\"unknownField\":{\"retain\":true}}\n"],
    [".arcadia/change-sets/pending.json", "{\"changeSet\":{\"id\":\"pending-changeset-stable\"},\"status\":\"proposed\",\"operations\":[{\"path\":\"story/scene.md\"}]}\n"],
    [".arcadia/snapshots/scene-before.md", "---\nauthor_note: preserve\n---\nSynthetic local snapshot\n"],
    [".arcadia/llm-cache/summary.json", "{\"derived\":true}\n"],
  ]);
  for (const [relative, content] of textFiles) await writeFile(sourceRoot, relative, content);
  await writeFile(sourceRoot, ".arcadia/cover.jpg", Buffer.from([0, 255, 3, 10, 13, 128, 42]));
  await writeFile(sourceRoot, ".arcadia/snapshots/attachments/diagram.bin", Buffer.from([1, 2, 0, 254, 255, 9]));
  const grant = {
    id: "share-grant-stable",
    ownerId: "synthetic-private-owner",
    projectId: "legacy-project-id",
    scope: "ch-chapter-1",
    label: "Reader access",
    tokenHash: "b".repeat(64),
    tokenPrefix: "DO_NOT_EXPORT_BEARER_PREFIX",
    bearerToken: "DO_NOT_EXPORT_BEARER_VALUE",
    createdAt: "2025-03-01T00:00:00.000Z",
    expiresAt: "2026-03-01T00:00:00.000Z",
  };
  const foreignGrant = {
    ...grant,
    id: "foreign-share-grant",
    projectId: "some-other-project",
    tokenHash: "c".repeat(64),
  };
  await writeFile(workspaceRoot, "app-state/share-tokens.json", JSON.stringify([grant, foreignGrant]) + "\n");
  await writeFile(workspaceRoot, "app-state/projects.json", JSON.stringify([{ id: "legacy-project-id", url: "https://example.invalid/owner/work.git" }]) + "\n");
  await writeFile(workspaceRoot, "app-state/users.json", "DO_NOT_EXPORT_WORKSPACE_USER_SECRET\n");
  await writeFile(workspaceRoot, "app-state/series.json", JSON.stringify({
    series: [{ id: "series-stable", name: "Synthetic series", bibleProjectId: "legacy-project-id", memberProjectIds: ["legacy-project-id"], unknownField: "retain" }],
    bindings: [{ projectId: "legacy-project-id", role: "member", unknownBinding: true }],
  }, null, 2) + "\n");

  const jobsState = {
    jobs: [
      {
        id: "job-mapped-stable", type: "aspect-review", status: "done", progress: 1,
        result: { summary: "Synthetic author review", findings: [{ id: "finding-stable", text: "A mapped result." }] },
        error: null, projectKey: "legacy-project-id", userId: "legacy-user",
        createdAt: "2025-04-01T00:00:00.000Z", updatedAt: "2025-04-01T00:01:00.000Z", finishedAt: "2025-04-01T00:01:00.000Z",
      },
      {
        id: "job-unmapped-stable", type: "speaker-eval", status: "error", progress: 0.5,
        result: null, error: "Synthetic private unmapped failure", projectKey: "legacy-project-id", userId: null,
        createdAt: "2025-04-02T00:00:00.000Z", updatedAt: "2025-04-02T00:01:00.000Z", finishedAt: "2025-04-02T00:01:00.000Z",
      },
    ],
    inbox: [
      {
        id: "inbox-mapped-stable", kind: "job-complete", jobId: "job-mapped-stable", jobType: "aspect-review",
        title: "Synthetic review", body: "Mapped result details retained.", status: "done", read: false,
        userId: "legacy-user", projectKey: "legacy-project-id", createdAt: "2025-04-01T00:01:00.000Z",
      },
      {
        id: "inbox-unmapped-stable", kind: "job-complete", jobId: "job-unmapped-stable", jobType: "speaker-eval",
        title: "Synthetic private failure", body: "Unmapped details stay private.", status: "error", read: false,
        userId: null, projectKey: "legacy-project-id", createdAt: "2025-04-02T00:01:00.000Z",
      },
    ],
  };
  const jobsStateBytes = Buffer.from(`${JSON.stringify(jobsState)}\n`, "utf8");
  await writeFile(workspaceRoot, "app-state/jobs-state.json", jobsStateBytes);
  const recentActivity = {
    byKey: {
      "legacy-user:legacy-project-id": [
        {
          sceneId: "sc-cursor-desktop",
          sentenceOffset: 29,
          pageIndex: 4,
          deviceType: "desktop",
          updatedAt: LEGACY_DESKTOP_CURSOR_UPDATED_AT,
          extensionCursorField: "DO_NOT_PUBLISH_CURSOR_EXTENSION",
        },
        {
          sceneId: "sc-cursor-mobile",
          sentenceOffset: 11,
          pageIndex: 2,
          deviceType: "mobile",
          updatedAt: LEGACY_MOBILE_CURSOR_UPDATED_AT,
        },
      ],
      "unmapped-user:legacy-project-id": [
        {
          sceneId: "sc-cursor-unmapped-user",
          sentenceOffset: 7,
          pageIndex: 1,
          deviceType: "mobile",
          updatedAt: "2025-04-03T12:00:00.000Z",
          extensionCursorField: "DO_NOT_PUBLISH_CURSOR_EXTENSION",
        },
      ],
      "legacy-user:foreign-project-id": [
        {
          sceneId: "sc-cursor-unmapped-project",
          sentenceOffset: 3,
          pageIndex: 0,
          deviceType: "desktop",
          updatedAt: "2025-04-03T13:00:00.000Z",
        },
      ],
    },
    extensionRecentActivityField: "DO_NOT_PUBLISH_RAW_CURSOR_EXTENSION",
  };
  const recentActivityBytes = Buffer.from(`${JSON.stringify(recentActivity)}\n`, "utf8");
  await writeFile(workspaceRoot, "app-state/recent-activity.json", recentActivityBytes);
  await fs.chmod(path.join(workspaceRoot, "app-state"), 0o700);
  await fs.chmod(path.join(workspaceRoot, "app-state/jobs-state.json"), 0o600);
  await fs.chmod(path.join(workspaceRoot, "app-state/recent-activity.json"), 0o600);
  await fs.chmod(workspaceRoot, 0o700);
  return { jobsStateBytes, recentActivityBytes };
}

function createComposedRegistry(observedModuleSets) {
  const registry = createMigrationProducerRegistry();
  for (const producer of [
    createStoryMigrationProducer(),
    createDiagnosticsMigrationProducer(),
    createNlpMigrationProducer(),
    createSemanticMigrationProducer(),
    createSpeakerMigrationProducer(),
    createAssistantMigrationProducer(),
    createPublishingMigrationProducer(),
  ]) registerMigrationProducer(registry, producer);
  registerMigrationProducer(registry, {
    id: "p12-module-set-probe",
    async inspect(context) {
      observedModuleSets.push([...context.enabledModules].sort());
      return { entries: [], operations: [], recovery: [] };
    },
  });
  return registry;
}

function writesOf(inspection) {
  return inspection.operations.flatMap((operation) => operation.writes);
}

const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;
if (!connectionString) throw new Error("CODEXIA_TEST_DATABASE_URL is required for PostgreSQL migration acceptance");

test("legacy inspection stays read-only and approved imports persist in PostgreSQL", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codexia-postgres-migration-"));
  const workspaceRoot = path.join(temporary, "legacy-data");
  const databases = [];
  let persistence;
  let reopenedPersistence;
  try {
    const { sourceRoot: legacyRoot } = await makeLegacyRepository(temporary);
    await fs.mkdir(workspaceRoot, { recursive: true });
    databases.push(...await addLegacyDatabases(legacyRoot, workspaceRoot));
    await addLegacyFiles(legacyRoot, workspaceRoot);

    const beforeSource = await treeState(legacyRoot);
    const beforeWorkspace = await treeState(workspaceRoot);
    await migratePostgresDatabase(connectionString);
    persistence = createPostgresPersistence(connectionString);
    const core = new CoreStore({ persistence });
    const project = await core.createProject({ title: "Synthetic PostgreSQL import target" });
    const reader = await core.reader(project.id);
    const observedModuleSets = [];
    const registry = createComposedRegistry(observedModuleSets);
    const options = {
      sourceRoot: legacyRoot,
      workspaceDataRoot: workspaceRoot,
      workspaceProjectId: "legacy-project-id",
      legacyProjectMappings: { "legacy-project-id": project.id },
      enabledModules: ["story"],
      registry,
      target: reader,
    };

    const inspection = await inspectLegacyProject(options);
    const writes = writesOf(inspection);
    const writeByPath = new Map(writes.map((write) => [write.path, write]));
    assert.deepEqual(observedModuleSets.at(-1), ["story"], "Story is the only enabled module during inspection");
    assert.ok(inspection.pendingWorkspace.repository);
    assert.equal(inspection.pendingWorkspace.pendingCommitCount, 1);
    assert.ok(inspection.pendingWorkspace.stagedPaths.includes("story/scene.md"));
    assert.equal(writeByPath.get(SPEAKER_OVERRIDE_SCENE_PATH)?.content, SPEAKER_OVERRIDE_SCENE,
      "the exact author-maintained Speaker override must remain reviewable");
    assert.equal(writeByPath.get("meta/scriptorium/modules/speaker/legacy/files/meta/speaker-corrections.jsonl")?.content,
      "{\"id\":\"speaker-correction-stable\",\"speakerId\":\"speaker-1\",\"label\":\"Mika\",\"extension\":{\"retain\":true}}\n",
      "disabled Speaker correction data must be retained as opaque bytes");
    assert.ok(writeByPath.has("meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/state_proposals.jsonl"),
      "disabled legacy workflow rows must remain opaque for later module review");
    assert.ok(!JSON.stringify(inspection).includes("DO_NOT_EXPORT_SQLITE_SECRET"), "legacy credentials must not enter the proposal");

    const disabledInspection = await inspectLegacyProject({ ...options, enabledModules: [] });
    const disabledWrites = new Map(writesOf(disabledInspection).map((write) => [write.path, write]));
    assert.deepEqual(observedModuleSets.at(-1), [], "the disabled-module pass must not activate Story or Speaker producers");
    assert.equal(disabledWrites.get(`meta/scriptorium/modules/story/legacy/files/${SPEAKER_OVERRIDE_SCENE_PATH}`)?.content, SPEAKER_OVERRIDE_SCENE,
      "a manual correction remains byte-exact opaque data while Story is disabled");
    assert.ok(disabledWrites.has("meta/scriptorium/modules/story/legacy/sqlite/project-arcadia/state_proposals.jsonl"),
      "disabled Story workflow rows remain opaque for later review");
    assert.deepEqual(await treeState(legacyRoot), beforeSource, "inspection must not modify Git, files, or SQLite sources");
    assert.deepEqual(await treeState(workspaceRoot), beforeWorkspace, "inspection must not modify workspace sources");

    const repeated = await inspectLegacyProject(options);
    assert.deepEqual(repeated.operations, inspection.operations, "repeated dry runs must produce the same import plan");
    assert.deepEqual(await treeState(legacyRoot), beforeSource);
    assert.deepEqual(await treeState(workspaceRoot), beforeWorkspace);

    const proposal = await proposeMigrationImport(core, project.id, inspection);
    assert.deepEqual(await proposeMigrationImport(core, project.id, repeated), proposal,
      "replaying the same PostgreSQL import proposal must preserve its identity");
    const proposed = await core.getProposal(project.id, proposal.id);
    assert.equal(proposed?.state, "proposed");
    assert.deepEqual(proposed?.approvedOperationIds, [], "inspection never grants author approval");

    const storyOperations = inspection.operations.filter((operation) => operation.writes.some((write) =>
      write.path === SPEAKER_OVERRIDE_SCENE_PATH || /^plot\/volumes\/volume-1(?:\/|$)/u.test(write.path)));
    const opaqueOperation = inspection.operations.find((operation) => operation.writes.some((write) => write.path === "meta/scriptorium/modules/speaker/legacy/files/meta/speaker-corrections.jsonl"));
    assert.ok(storyOperations.some((operation) => operation.writes.some((write) => write.path === SPEAKER_OVERRIDE_SCENE_PATH)), "manual Speaker override must be an explicit operation");
    assert.ok(opaqueOperation, "disabled module data must be an explicit operation");
    const approvedOperations = [...new Map([...storyOperations, opaqueOperation].map((operation) => [operation.id, operation])).values()]
      .sort((left, right) => Math.min(...left.writes.map((write) => write.path.split("/").length))
        - Math.min(...right.writes.map((write) => write.path.split("/").length)));
    const approvedIds = approvedOperations.map((operation) => operation.id);
    await core.approve(project.id, { proposalId: proposal.id, operationIds: approvedIds, authorScope: "synthetic-postgres-author" });
    const applicationReceipts = [];
    for (const operation of approvedOperations) applicationReceipts.push(await core.apply(project.id, operation));
    const partiallyApplied = await core.getProposal(project.id, proposal.id);
    assert.equal(partiallyApplied?.state, "partially_approved");
    assert.deepEqual(partiallyApplied?.appliedOperationIds, approvedIds);

    await persistence.close();
    persistence = undefined;
    reopenedPersistence = createPostgresPersistence(connectionString);
    const reopenedCore = new CoreStore({ persistence: reopenedPersistence });
    const recoveredReader = await reopenedCore.reader(project.id);
    const recoveredScene = (await recoveredReader.read(SPEAKER_OVERRIDE_SCENE_PATH))?.content ?? "";
    assert.match(recoveredScene, /textHash: f9b7b225/u, "the author-maintained Speaker correction survives canonical import");
    assert.match(recoveredScene, /speakerEntityId: char-hero/u);
    assert.match(recoveredScene, /unknown-scene-field: retain exactly/u);
    assert.equal((await recoveredReader.read("meta/scriptorium/modules/speaker/legacy/files/meta/speaker-corrections.jsonl"))?.content,
      writeByPath.get("meta/scriptorium/modules/speaker/legacy/files/meta/speaker-corrections.jsonl")?.content);
    const recoveredProposal = await reopenedCore.getProposal(project.id, proposal.id);
    assert.deepEqual(recoveredProposal?.approvedOperationIds, approvedIds);
    assert.deepEqual(recoveredProposal?.appliedOperationIds, approvedIds);
    assert.equal(recoveredProposal?.applications.length, approvedIds.length, "PostgreSQL retains one application receipt per approved import operation");
    for (const [index, operation] of approvedOperations.entries()) {
      assert.deepEqual(await reopenedCore.apply(project.id, operation), applicationReceipts[index],
        "replaying an applied import operation returns its existing receipt without duplication");
    }
    assert.deepEqual(await treeState(legacyRoot), beforeSource, "author application must not write to the legacy source");
    assert.deepEqual(await treeState(workspaceRoot), beforeWorkspace);
  } finally {
    for (const database of databases) database.close();
    await persistence?.close();
    await reopenedPersistence?.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
