import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HistoricalModelUsageStore } from "./historical-store.js";
import { JobHistoryStore } from "./job-history-store.js";

test("model history partitions PostgreSQL projects and binds cursors to the project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexia-model-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new HistoricalModelUsageStore(join(root, "usage"));
  const event = { id: "event-one", projectId: "project-one", feature: "assistant", provider: "test", model: "test", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", state: "completed" as const };
  await store.append(event);
  await store.append({ ...event, id: "event-two" });
  await store.append({ ...event, projectId: "project-two" });
  const first = await store.list("project-one", { limit: 1 });
  assert.equal(first.events.length, 1);
  assert.ok(first.nextCursor);
  await assert.rejects(store.list("project-two", { limit: 1, cursor: first.nextCursor }), { code: "model_usage_cursor_invalid" });
  assert.equal((await new HistoricalModelUsageStore(join(root, "usage")).list("project-two")).events.length, 1);
  await assert.rejects(store.append({ ...event, model: "different" }), { code: "model_usage_event_id_conflict" });
});

test("job IDs cannot be reused across PostgreSQL projects and results survive restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexia-job-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobHistoryStore(root);
  await store.beginDomainJob({ id: "job-one", type: "assistant", projectId: "project-one" });
  await assert.rejects(store.beginDomainJob({ id: "job-one", type: "assistant", projectId: "project-two" }), { code: "job_identity_conflict" });
  await store.finishDomainJob("job-one", { ok: true, snapshot: { projectId: "project-one", projectVersion: 1 }, data: { answer: "retained" } });
  assert.deepEqual((await new JobHistoryStore(root).getJob("job-one"))?.result, { answer: "retained" });
  assert.equal((await new JobHistoryStore(root).listInbox()).items.length, 1);
});

test("worker lifecycle validates PostgreSQL snapshots and prevents cross-project job reuse", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexia-worker-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobHistoryStore(root);
  const lifecycle = { jobId: "worker-one", module: "assistant" as const, task: "generate", snapshot: { projectId: "project-one", projectVersion: 1 }, state: "queued" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", startedAt: null, finishedAt: null };
  await store.record(lifecycle);
  await assert.rejects(store.record({ ...lifecycle, snapshot: { projectId: "project-two", projectVersion: 1 } }), { code: "job_identity_conflict" });
  await assert.rejects(store.record({ ...lifecycle, snapshot: { projectId: "project-one", projectVersion: -1 } }), { code: "job_event_invalid" });
  assert.equal((await new JobHistoryStore(root).listJobs()).length, 1);
});

test("hosted job and inbox reads and acknowledgements stay within the assigned project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexia-hosted-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobHistoryStore(root);
  for (const projectId of ["project-one", "project-two"]) {
    await store.beginDomainJob({ id: projectId, type: "assistant", projectId });
    await store.finishDomainJob(projectId, { ok: true, snapshot: { projectId, projectVersion: 1 }, data: projectId });
  }
  assert.equal((await store.listJobs("project-one")).length, 1);
  assert.equal(await store.getJob("project-two", "project-one"), undefined);
  const other = (await store.listInbox({ projectId: "project-two" })).items[0]!;
  assert.equal(await store.markInboxRead(other.id, "project-one"), undefined);
  assert.equal(await store.markAllInboxRead("project-one"), 1);
  assert.equal((await store.listInbox({ projectId: "project-two", unreadOnly: true })).unreadCount, 1);
  assert.equal((await store.listInbox({ projectId: "project-one", unreadOnly: true })).unreadCount, 0);
});
