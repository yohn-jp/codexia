import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresEditorEvidenceAdapter } from "./postgresEvidenceAdapter";

const projectId = "00000000-0000-4000-8000-000000000001";
const documentId = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const confirmedNodeId = "00000000-0000-4000-8000-000000000004";
const proposedNodeId = "00000000-0000-4000-8000-000000000005";
const manuscript = "🙂東京へ行く。";

function node(id: string, status: "confirmed" | "proposed", name: string) {
  return {
    id, projectId, type: "place", name, attributes: {}, status, version: 1,
    deletedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function anchor(id: string, fromUtf16: number, toUtf16: number, status: "confirmed" | "proposed") {
  return {
    id, projectId, documentId, revisionId, fromUtf16, toUtf16,
    quoteSha256: "a".repeat(64), status, version: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("PostgreSQL editor reads keep raw mentions, candidates, and confirmed Knowledge separate", async (t) => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/anchors?")) {
      return Response.json({
        revisionId,
        anchors: [
          { anchor: anchor("raw", 0, 2, "proposed"), quote: "🙂", mentions: [], assertions: [{
            link: { projectId, assertionId: "assertion-1", evidenceId: "raw", role: "supports", createdAt: "2026-01-01T00:00:00.000Z" },
            assertion: { id: "assertion-1", projectId, proposition: { statement: "未承認の主張" }, modality: "fact", perspective: "narrator", narrativeTime: {}, confidence: null, status: "proposed", version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          }] },
          { anchor: anchor("candidate", 2, 4, "confirmed"), quote: "東京", mentions: [{
            link: { projectId, evidenceId: "candidate", nodeId: proposedNodeId, status: "proposed", source: "author", confidence: null, extractorVersion: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
            node: node(proposedNodeId, "proposed", "東京（候補）"),
          }], assertions: [] },
          { anchor: anchor("confirmed", 2, 4, "confirmed"), quote: "東京", mentions: [{
            link: { projectId, evidenceId: "confirmed", nodeId: confirmedNodeId, status: "confirmed", source: "author", confidence: 1, extractorVersion: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
            node: node(confirmedNodeId, "confirmed", "東京"),
          }], assertions: [] },
        ],
      });
    }
    return Response.json({
      document: { id: documentId, projectId, parentId: null, kind: "scene", title: "Scene", orderKey: "0001", headRevisionId: revisionId, version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      revision: { id: revisionId, projectId, documentId, parentRevisionId: null, markdown: manuscript, sha256: "b".repeat(64), authorId: "author", createdAt: "2026-01-01T00:00:00.000Z" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const adapter = createPostgresEditorEvidenceAdapter(() => ({ projectId, documentId, revisionId }));
  const snapshot = await adapter.read({ projectId: "legacy-project", documentId: "legacy-scene", revisionId: "git-sha", markdown: manuscript }, new AbortController().signal);
  assert.equal(snapshot.revisionId, revisionId);
  assert.equal(snapshot.markdown, manuscript);
  assert.equal(snapshot.anchors.find((item) => item.id === "raw")?.target, undefined);
  assert.equal(snapshot.anchors.find((item) => item.id === "raw")?.candidates, undefined);
  assert.equal(snapshot.anchors.find((item) => item.id === "candidate")?.target, undefined);
  assert.deepEqual(snapshot.anchors.find((item) => item.id === "candidate")?.candidates, [{ id: proposedNodeId, label: "東京（候補）" }]);
  assert.deepEqual(snapshot.anchors.find((item) => item.id === "confirmed")?.target, { id: confirmedNodeId, label: "東京" });
  assert.equal(snapshot.anchors.find((item) => item.id === "raw")?.assertions?.[0]?.status, "proposed");
  assert.match(snapshot.anchors.find((item) => item.id === "raw")?.assertions?.[0]?.label ?? "", /^fact:/u);
  assert.match(requests[0]!.url, new RegExp(`revision=${revisionId}`));
});

test("PostgreSQL editor sends the exact composed ChangeSet with an idempotency key", async (t) => {
  let savedRequest: { url: string; init?: RequestInit } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    savedRequest = { url: String(input), init };
    const body = JSON.parse(String(init?.body)) as { changes: Array<{ fromUtf16: number; toUtf16: number; insert: string }>; resultingSha256: string };
    assert.deepEqual(body.changes, [{ fromUtf16: 2, toUtf16: 2, insert: "追" }, { fromUtf16: 4, toUtf16: 6, insert: "大阪" }]);
    assert.match(body.resultingSha256, /^[0-9a-f]{64}$/u);
    return Response.json({
      document: { id: documentId, projectId, parentId: null, kind: "scene", title: "Scene", orderKey: "0001", headRevisionId: revisionId, version: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      revision: { id: revisionId, projectId, documentId, parentRevisionId: null, markdown: "🙂追猫は大阪。", sha256: "c".repeat(64), authorId: "author", createdAt: "2026-01-01T00:00:00.000Z" },
      replayed: false,
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const adapter = createPostgresEditorEvidenceAdapter(() => ({ projectId, documentId }));
  const result = await adapter.save!({ projectId, documentId, revisionId }, {
    baseMarkdown: "🙂猫は東京。",
    markdown: "🙂追猫は大阪。",
    changes: [{ from: 2, to: 2, insert: "追" }, { from: 4, to: 6, insert: "大阪" }],
    idempotencyKey: "edit-once",
    clientId: "browser-one",
  }, new AbortController().signal);
  assert.equal(result.markdown, "🙂追猫は大阪。");
  assert.ok(savedRequest);
  assert.equal(savedRequest?.init?.method, "PATCH");
  assert.equal(new Headers(savedRequest?.init?.headers).get("Idempotency-Key"), "edit-once");
  assert.equal(new Headers(savedRequest?.init?.headers).get("X-Client-Id"), "browser-one");
});
