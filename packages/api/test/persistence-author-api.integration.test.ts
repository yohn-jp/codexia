import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPostgresPersistence } from "@codexia/persistence-postgres";
import type { DocumentId, ProjectId } from "@codexia/persistence-contracts";
import { startBetterAuthFixture } from "./fixtures/better-auth-server.js";

test("Web append creates at the canonical end of each parent's ordered siblings", async (t) => {
  const databaseUrl = process.env.CODEXIA_AUTH_TEST_DATABASE_URL;
  assert.ok(databaseUrl, "CODEXIA_AUTH_TEST_DATABASE_URL must name an explicitly disposable PostgreSQL auth database");
  const fixture = await startBetterAuthFixture({ databaseUrl, usePostgresPersistence: true });
  t.after(() => fixture.close());
  const persistence = createPostgresPersistence(databaseUrl);
  t.after(() => persistence.close());
  const base = fixture.apiOrigin;
  const headers = { Authorization: `Bearer ${await fixture.issueOwnerAccessToken()}`, "Content-Type": "application/json" };
  const session = await fetch(`${base}/api/session`, { headers });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true, authorScope: "owner" });
  const projectResponse = await fetch(`${base}/api/v1/persistence/projects`, {
    method: "POST", headers, body: JSON.stringify({ title: `Append ${randomUUID()}` }),
  });
  assert.equal(projectResponse.status, 201);
  const projectId = (await projectResponse.json() as { project: { id: string } }).project.id as ProjectId;
  const parents: Record<string, string> = {};
  await persistence.transaction(async (transaction) => {
    const volume = (await transaction.createDocument({
      projectId, kind: "volume", title: "Volume", orderKey: "0001", markdown: "", authorId: "test-owner", idempotencyKey: randomUUID(),
    })).document;
    for (const id of ["empty", "mixed", "wide", "concurrent"] as const) {
      const chapter = (await transaction.createDocument({
        projectId, parentId: volume.id, kind: "chapter", title: id, orderKey: String(Object.keys(parents).length + 1).padStart(4, "0"),
        markdown: "", authorId: "test-owner", idempotencyKey: randomUUID(),
      })).document;
      parents[id] = chapter.id;
    }
    for (const [parent, kind, orderKey, title] of [
      ["mixed", "scene", "0000000009", "Nine A"],
      ["mixed", "scene", "0000000002", "Two"],
      ["mixed", "scene", "0000000009", "Nine B"],
      ["mixed", "note", "0000000015", "Other kind last"],
      ["wide", "scene", "00001000", "Wide order"],
      ["concurrent", "scene", "0000000008", "Before concurrency"],
    ] as const) {
      await transaction.createDocument({
        projectId, parentId: parents[parent] as DocumentId,
        kind, orderKey, title, markdown: "", authorId: "test-owner", idempotencyKey: randomUUID(),
      });
    }
  });

  const documentsPath = `${base}/api/v1/persistence/projects/${projectId}/documents`;
  const append = (parent: keyof typeof parents, title: string, key: string) => fetch(documentsPath, {
    method: "POST", headers: { ...headers, "Idempotency-Key": key },
    body: JSON.stringify({ kind: "scene", title, parentId: parents[parent], markdown: "", orderKey: "0000", appendToEnd: true }),
  });
  const empty = await append("empty", "First scene", "append-empty");
  assert.equal(empty.status, 201);
  const emptyResult = await empty.json() as { document: { id: string; orderKey: string }; replayed: boolean };
  assert.equal(emptyResult.document.orderKey, "0000000001");
  assert.equal(emptyResult.replayed, false);
  const emptyReplay = await append("empty", "First scene", "append-empty");
  assert.equal(emptyReplay.status, 201);
  assert.deepEqual(await emptyReplay.json(), { ...emptyResult, replayed: true });

  const mixed = await append("mixed", "After mixed siblings", "append-mixed");
  assert.equal(mixed.status, 201);
  const mixedResult = await mixed.json() as { document: { id: string; orderKey: string } };
  assert.equal(mixedResult.document.orderKey, "0000000016", "append considers all same-parent kinds and the actual maximum key");
  const mixedRead = await fetch(`${documentsPath}?parentId=${encodeURIComponent(parents.mixed)}`, { headers: { Authorization: headers.Authorization } });
  assert.equal(mixedRead.status, 200);
  const mixedDocuments = (await mixedRead.json() as { documents: Array<{ id: string; orderKey: string }> }).documents;
  assert.equal(mixedDocuments.at(-1)?.id, mixedResult.document.id, "the authoritative PostgreSQL ordered read places the new document last");

  const wide = await append("wide", "After wide key", "append-wide");
  assert.equal(wide.status, 201);
  assert.equal((await wide.json() as { document: { orderKey: string } }).document.orderKey, "00001001");

  const concurrent = await Promise.all([
    append("concurrent", "Concurrent A", "append-concurrent-a"),
    append("concurrent", "Concurrent B", "append-concurrent-b"),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status), [201, 201]);
  const concurrentResults = await Promise.all(concurrent.map((response) => response.json() as Promise<{ document: { id: string; orderKey: string }; replayed: boolean }>));
  assert.deepEqual(concurrentResults.map((result) => result.document.orderKey).sort(), ["0000000009", "0000000010"]);
  assert.ok(concurrentResults.every((result) => !result.replayed));
  const concurrentRead = await fetch(`${documentsPath}?parentId=${encodeURIComponent(parents.concurrent)}`, { headers: { Authorization: headers.Authorization } });
  const concurrentDocuments = (await concurrentRead.json() as { documents: Array<{ id: string; orderKey: string }> }).documents;
  assert.deepEqual(concurrentDocuments.slice(-2).map((document) => document.id).sort(), concurrentResults.map((result) => result.document.id).sort());

  const explicitKey = "explicit-order-compatible";
  const explicitBody = { kind: "scene", title: "Explicit key", parentId: parents.empty, orderKey: "0000000017", markdown: "" };
  const explicit = await fetch(documentsPath, { method: "POST", headers: { ...headers, "Idempotency-Key": explicitKey }, body: JSON.stringify(explicitBody) });
  assert.equal(explicit.status, 201);
  const explicitResult = await explicit.json() as { document: { id: string; orderKey: string }; replayed: boolean };
  assert.equal(explicitResult.document.orderKey, "0000000017");
  assert.equal(explicitResult.replayed, false);
  const explicitReplay = await fetch(documentsPath, { method: "POST", headers: { ...headers, "Idempotency-Key": explicitKey }, body: JSON.stringify(explicitBody) });
  assert.deepEqual(await explicitReplay.json(), { ...explicitResult, replayed: true }, "legacy explicit-key retries retain their original idempotency digest");
});
