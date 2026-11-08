import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { CoreStore } from "@codexia/core";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import { createServer } from "./server.js";

const ACCESS_TOKEN = "postgres-api-test-token-longer-than-32-characters";
const connectionString = process.env.CODEXIA_TEST_DATABASE_URL;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("authenticated PostgreSQL API saves, replays, follows Evidence, conflicts and restores", { skip: !connectionString }, async (t) => {
  await migratePostgresDatabase(connectionString!);
  const persistence = createPostgresPersistence(connectionString!);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "codexia-postgres-api-"));
  const store = { async listProjects() { return []; } } as unknown as CoreStore;
  const server = createServer({
    store,
    authToken: ACCESS_TOKEN,
    staticDir: temporaryRoot,
    usageDirectory: temporaryRoot,
    persistence,
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await persistence.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${base}/api/v1/persistence/projects`);
  assert.equal(unauthorized.status, 401);
  const bearerWrite = await fetch(`${base}/api/v1/persistence/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "must-not-write" }),
  });
  assert.equal(bearerWrite.status, 403);

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ token: ACCESS_TOKEN }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const ownerHeaders = { Cookie: cookie!, Origin: base, "Content-Type": "application/json" };
  const projectResponse = await fetch(`${base}/api/v1/persistence/projects`, {
    method: "POST", headers: ownerHeaders, body: JSON.stringify({ title: `api-${randomUUID()}`, settings: { language: "ja" } }),
  });
  assert.equal(projectResponse.status, 201);
  const { project } = await projectResponse.json() as { project: { id: string } };
  const documentResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents`, {
    method: "POST",
    headers: { ...ownerHeaders, "Idempotency-Key": `create-${randomUUID()}` },
    body: JSON.stringify({ kind: "scene", title: "Scene", orderKey: "0001", markdown: "前😀 東京\n" }),
  });
  assert.equal(documentResponse.status, 201);
  const created = await documentResponse.json() as {
    document: { id: string; headRevisionId: string };
    revision: { id: string; markdown: string };
  };
  const documentId = created.document.id;
  const initialRevision = created.revision.id;
  const initialMarkdown = created.revision.markdown;
  const pinnedRevision = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}?revision=${initialRevision}`, { headers: { Cookie: cookie! } });
  assert.equal(pinnedRevision.status, 200);
  assert.equal((await pinnedRevision.json() as { revision: { id: string; markdown: string } }).revision.markdown, initialMarkdown);

  const prefix = "😀追記 ";
  const afterPrefix = prefix + initialMarkdown;
  const firstSaveCommand = {
    baseRevisionId: initialRevision,
    changes: [{ fromUtf16: 0, toUtf16: 0, insert: prefix }],
    resultingSha256: sha256(afterPrefix),
    clientId: "browser-test",
  };
  const idempotencyKey = `edit-${randomUUID()}`;
  const firstSave = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: "PATCH",
    headers: { ...ownerHeaders, "Idempotency-Key": idempotencyKey, "X-Client-Id": "browser-test" },
    body: JSON.stringify(firstSaveCommand),
  });
  assert.equal(firstSave.status, 200);
  const saved = await firstSave.json() as { document: { headRevisionId: string }; revision: { id: string; markdown: string }; replayed: boolean };
  assert.equal(saved.revision.markdown, afterPrefix);
  assert.equal(saved.replayed, false);
  const replay = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: "PATCH",
    headers: { ...ownerHeaders, "Idempotency-Key": idempotencyKey, "X-Client-Id": "browser-test" },
    body: JSON.stringify(firstSaveCommand),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { replayed: boolean }).replayed, true);

  const nodeId = randomUUID();
  const nodeResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/nodes/${nodeId}`, {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ type: "place", name: "東京", attributes: {}, status: "confirmed", expectedVersion: null }),
  });
  assert.equal(nodeResponse.status, 200);
  const anchorId = randomUUID();
  const quoteStart = afterPrefix.indexOf("東京");
  const anchorResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors`, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ id: anchorId, revisionId: saved.revision.id, fromUtf16: quoteStart, toUtf16: quoteStart + 2, status: "confirmed", nodeId }),
  });
  assert.equal(anchorResponse.status, 201);
  const anchorsBefore = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors?revision=${saved.revision.id}`, { headers: { Cookie: cookie! } });
  assert.equal(anchorsBefore.status, 200);
  const anchorListBefore = await anchorsBefore.json() as { anchors: Array<{ anchor: { status: string }; quote: string; mentions: Array<{ link: { status: string }; node: { status: string } | null }> }> };
  assert.equal(anchorListBefore.anchors[0]?.quote, "東京");
  assert.equal(anchorListBefore.anchors[0]?.anchor.status, "confirmed");
  assert.equal(anchorListBefore.anchors[0]?.mentions[0]?.link.status, "confirmed");
  assert.equal(anchorListBefore.anchors[0]?.mentions[0]?.node?.status, "confirmed");

  const rawMentionResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors`, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ id: randomUUID(), revisionId: saved.revision.id, fromUtf16: 0, toUtf16: 2, status: "proposed" }),
  });
  assert.equal(rawMentionResponse.status, 201);
  const rawMention = await rawMentionResponse.json() as { nodeId: string | null };
  assert.equal(rawMention.nodeId, null);
  const anchorsWithUnlinked = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors?revision=${saved.revision.id}`, { headers: { Cookie: cookie! } });
  const unlinkedView = (await anchorsWithUnlinked.json() as { anchors: Array<{ quote: string; mentions: unknown[] }> }).anchors.find((entry) => entry.quote === "😀");
  assert.ok(unlinkedView);
  assert.deepEqual(unlinkedView.mentions, []);

  const assertionId = randomUUID();
  const assertionResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/assertions/${assertionId}`, {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ proposition: { statement: "東京にある" }, modality: "fact", perspective: "narrator", narrativeTime: {}, confidence: null, status: "proposed", expectedVersion: null }),
  });
  assert.equal(assertionResponse.status, 200);
  const assertionEvidenceResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/assertions/${assertionId}/evidence`, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ evidenceId: anchorId, role: "supports" }),
  });
  assert.equal(assertionEvidenceResponse.status, 201);
  const anchorsWithAssertion = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors?revision=${saved.revision.id}`, { headers: { Cookie: cookie! } });
  const assertionAnchor = (await anchorsWithAssertion.json() as { anchors: Array<{ anchor: { id: string }; assertions: Array<{ assertion: { status: string } | null; link: { role: string } }> }> }).anchors.find((entry) => entry.anchor.id === anchorId)!;
  assert.equal(assertionAnchor.assertions[0]?.assertion?.status, "proposed");
  assert.equal(assertionAnchor.assertions[0]?.link.role, "supports");

  const afterShift = `💠${afterPrefix}`;
  const shiftResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: "PATCH", headers: { ...ownerHeaders, "Idempotency-Key": `shift-${randomUUID()}`, "X-Client-Id": "browser-test" },
    body: JSON.stringify({
      baseRevisionId: saved.revision.id,
      changes: [{ fromUtf16: 0, toUtf16: 0, insert: "💠" }],
      resultingSha256: sha256(afterShift),
      clientId: "browser-test",
    }),
  });
  assert.equal(shiftResponse.status, 200);
  const shifted = await shiftResponse.json() as { revision: { id: string; markdown: string } };
  const shiftedEvidence = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/anchors?revision=${shifted.revision.id}`, { headers: { Cookie: cookie! } });
  const shiftedAnchors = (await shiftedEvidence.json() as { anchors: Array<{ anchor: { id: string; fromUtf16: number; status: string } }> }).anchors;
  const shiftedAnchor = shiftedAnchors.find((item) => item.anchor.id === anchorId)!.anchor;
  assert.equal(shiftedAnchor.fromUtf16, quoteStart + "💠".length);
  assert.equal(shiftedAnchor.status, "confirmed");

  const editStart = shiftedAnchor.fromUtf16;
  const afterTouch = `${afterShift.slice(0, editStart)}大阪${afterShift.slice(editStart + 2)}`;
  const touchResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: "PATCH", headers: { ...ownerHeaders, "Idempotency-Key": `touch-${randomUUID()}`, "X-Client-Id": "browser-test" },
    body: JSON.stringify({
      baseRevisionId: shifted.revision.id,
      changes: [{ fromUtf16: editStart, toUtf16: editStart + 2, insert: "大阪" }],
      resultingSha256: sha256(afterTouch),
      clientId: "browser-test",
    }),
  });
  assert.equal(touchResponse.status, 200);
  const touched = await touchResponse.json() as { revision: { id: string; markdown: string } };
  const evidenceResponse = await fetch(`${base}/api/v1/persistence/projects/${project.id}/nodes/${nodeId}/evidence`, { headers: { Cookie: cookie! } });
  const evidence = await evidenceResponse.json() as { evidence: Array<{ anchor: { status: string }; quote: string; mentions: Array<{ link: { status: string }; node: { status: string } | null }> }> };
  assert.equal(evidence.evidence[0]?.quote, "大阪");
  assert.equal(evidence.evidence[0]?.anchor.status, "needs_review");
  assert.equal(evidence.evidence[0]?.mentions[0]?.link.status, "proposed");
  assert.equal(evidence.evidence[0]?.mentions[0]?.node?.status, "confirmed");

  const conflict = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}`, {
    method: "PATCH", headers: { ...ownerHeaders, "Idempotency-Key": `stale-${randomUUID()}`, "X-Client-Id": "browser-test" },
    body: JSON.stringify({
      baseRevisionId: saved.revision.id,
      changes: [{ fromUtf16: 0, toUtf16: 0, insert: "stale" }],
      resultingSha256: sha256(`stale${afterPrefix}`),
      clientId: "browser-test",
    }),
  });
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json() as { current: { document: { headRevisionId: string }; revision: { markdown: string } } };
  assert.equal(conflictBody.current.document.headRevisionId, touched.revision.id);
  assert.equal(conflictBody.current.revision.markdown, afterTouch);

  const restore = await fetch(`${base}/api/v1/persistence/projects/${project.id}/documents/${documentId}/restore`, {
    method: "POST", headers: { ...ownerHeaders, "Idempotency-Key": `restore-${randomUUID()}` },
    body: JSON.stringify({ baseRevisionId: touched.revision.id, sourceRevisionId: initialRevision }),
  });
  assert.equal(restore.status, 200);
  const restored = await restore.json() as { document: { headRevisionId: string }; revision: { id: string; markdown: string } };
  assert.equal(restored.revision.markdown, initialMarkdown);
  assert.equal(restored.document.headRevisionId, restored.revision.id);
});
