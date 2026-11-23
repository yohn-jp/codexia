import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { assertCurrentJobHistory, JobHistoryStore } from "./job-history-store.js";

async function readStateFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Job history fixture is not a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

const timestamp = "2026-10-01T10:00:00+09:00";
const pendingJob = {
  ownerKey: "a".repeat(64), projectKey: "b".repeat(64),
  job: {
    id: "job-one", type: "nlp.tokenize", status: "running", progress: 0.5, result: { message: "原稿", items: [true, null] },
    error: null, retryable: false, createdAt: timestamp, updatedAt: timestamp, finishedAt: null,
  },
};
const inboxItem = {
  id: "inbox-one", kind: "job-complete", jobId: "previous-job", jobType: "nlp.tokenize", title: "結果",
  body: "本文", status: "done", read: true, userId: "owner", projectKey: pendingJob.projectKey, createdAt: timestamp,
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codexia-job-history-maintenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "jobs");
  const path = join(directory, "jobs-state.json");
  return { root, directory, path };
}

function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("./maintain-job-history.js", import.meta.url)), ...args], {
    encoding: "utf8", env: { ...process.env, CODEXIA_USAGE_DIR: root },
  });
}

test("live job history rejects older private state without recovering or rewriting it", async (t) => {
  const { root, directory, path } = await fixture(t);
  await mkdir(directory, { mode: 0o700 });
  const source = JSON.stringify({ version: 1, jobs: [pendingJob], inbox: [inboxItem] });
  await writeFile(path, source, { mode: 0o600 });
  await assert.rejects(assertCurrentJobHistory(root), { code: "job_history_maintenance_required" });
  await assert.rejects(new JobHistoryStore(root).listJobs(), { code: "job_history_maintenance_required" });
  assert.equal(await readStateFile(path), source);
});

for (const version of [1, 2]) {
  test(`explicit job history maintenance preserves v${version} records and writes a private v3 once`, async (t) => {
    const { root, directory, path } = await fixture(t);
    await mkdir(directory, { mode: 0o700 });
    const legacySources = version === 2 ? ["c".repeat(64)] : [];
    const source = JSON.stringify({ version, jobs: [pendingJob], inbox: [inboxItem], ...(version === 2 ? { legacySources } : {}) }) + "\n";
    await writeFile(path, source, { mode: 0o600 });
    const initial = await stat(path);
    const check = cli(root, "--check");
    assert.equal(check.status, 2, check.stderr);
    assert.deepEqual(JSON.parse(check.stdout), { status: "maintenance_required", version, migrated: false });
    assert.equal(await readStateFile(path), source);
    assert.equal((await stat(path)).ino, initial.ino);
    assert.equal((await stat(path)).mtimeMs, initial.mtimeMs);

    const apply = cli(root, "--apply");
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(JSON.parse(apply.stdout), { status: "ready", version: 3, migrated: true });
    const after = await readStateFile(path);
    assert.deepEqual(JSON.parse(after), { version: 3, jobs: [{ kind: "worker", ...pendingJob }], inbox: [inboxItem], legacySources });
    const updated = await stat(path);
    assert.equal(updated.mode & 0o777, 0o600);
    assert.notEqual(updated.ino, initial.ino);
    assert.deepEqual(await readdir(directory), ["jobs-state.json"]);
    await assertCurrentJobHistory(root);

    for (const mode of ["--check", "--apply"]) {
      const repeated = cli(root, mode);
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.deepEqual(JSON.parse(repeated.stdout), { status: "ready", version: 3, migrated: false });
    }
    assert.equal(await readStateFile(path), after);
    assert.equal((await stat(path)).ino, updated.ino);
  });
}

test("offline job history maintenance leaves missing state alone and rejects unsafe or invalid input", async (t) => {
  const { root, directory, path } = await fixture(t);
  const missing = cli(root, "--apply");
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout), { status: "ready", version: null, migrated: false });
  assert.deepEqual(await readdir(root), []);
  assert.equal(cli("", "--check").status, 1);
  assert.equal(cli(root, "--check", "--apply").status, 1);

  await mkdir(directory, { mode: 0o700 });
  const external = join(root, "outside.json");
  const source = '{"version":2,"jobs":[],"inbox":[],"legacySources":[]}';
  await writeFile(external, source, { mode: 0o600 });
  await symlink(external, path);
  assert.equal(cli(root, "--apply").status, 1);
  assert.equal(await readFile(external, "utf8"), source);
  await rm(path);

  const invalid = '{"version":2,"jobs":[{}],"inbox":[],"legacySources":[]}';
  await writeFile(path, invalid, { mode: 0o600 });
  assert.equal(cli(root, "--check").status, 1);
  assert.equal(cli(root, "--apply").status, 1);
  assert.equal(await readStateFile(path), invalid);
  await rm(path);
  await writeFile(path, source, { mode: 0o600 });
  await chmod(path, 0o644);
  assert.equal(cli(root, "--apply").status, 1);
  assert.equal(await readStateFile(path), source);
});
