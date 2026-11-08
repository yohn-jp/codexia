import assert from "node:assert/strict";
import test from "node:test";
import { assertEditorEvidenceSnapshot, emptyDocumentEvidence, initializeDocumentEvidence, markRevisionConflict, parseMarkdownBlocks, trackTextChanges, type TextAnchor } from "./evidence";

function makeIds() {
  let sequence = 0;
  return () => `block-${++sequence}`;
}

function anchorFor(text: string, quote: string, blockId: string, status: TextAnchor["status"] = "current"): TextAnchor {
  const from = text.indexOf(quote);
  assert.notEqual(from, -1);
  return {
    id: "anchor-1",
    blockId,
    from,
    to: from + quote.length,
    quote,
    target: { id: "knowledge-1", label: "人物設定", targetPath: "bible/character.md" },
    revisionId: "revision-1",
    status,
  };
}

test("insertion before an anchor shifts UTF-16 offsets and keeps its block identity", () => {
  const oldText = "前段落。\n\n東京へ行く。";
  const ids = makeIds();
  const state = emptyDocumentEvidence(oldText, "revision-1", ids);
  const originalBlockId = state.blocks[1]!.id;
  state.anchors = [anchorFor(oldText, "東京", originalBlockId)];
  const change = { from: 0, to: 0, insert: "追加。\n\n" };
  const nextText = change.insert + oldText;

  const next = trackTextChanges(state, oldText, nextText, [change], ids);
  assert.equal(next.anchors[0]!.from, oldText.indexOf("東京") + change.insert.length);
  assert.equal(next.anchors[0]!.status, "current");
  assert.equal(next.anchors[0]!.blockId, originalBlockId);
  assert.equal(next.blocks[2]!.id, originalBlockId);
});

test("deleting an anchor quote or its whole paragraph marks the anchor orphaned", () => {
  const oldText = "猫は東京にいる。\n\n次の段落。";
  const ids = makeIds();
  const state = emptyDocumentEvidence(oldText, "revision-1", ids);
  state.anchors = [anchorFor(oldText, "東京", state.blocks[0]!.id)];
  const from = oldText.indexOf("東京");
  const change = { from, to: from + 2, insert: "" };
  const nextText = oldText.slice(0, from) + oldText.slice(from + 2);

  const next = trackTextChanges(state, oldText, nextText, [change], ids);
  assert.equal(next.anchors[0]!.status, "orphaned");
  assert.equal(next.anchors[0]!.quote, "東京");

  const paragraphText = "前段落。\n\n対象段落。";
  const paragraphState = emptyDocumentEvidence(paragraphText, "revision-1", ids);
  paragraphState.anchors = [anchorFor(paragraphText, "対象段落", paragraphState.blocks[1]!.id)];
  const paragraphStart = paragraphText.indexOf("対象段落");
  const paragraphChange = { from: paragraphStart, to: paragraphText.length, insert: "" };
  const paragraphNext = paragraphText.slice(0, paragraphStart);
  const deletedParagraph = trackTextChanges(paragraphState, paragraphText, paragraphNext, [paragraphChange], ids);
  assert.equal(deletedParagraph.anchors[0]!.status, "orphaned");
  assert.equal(deletedParagraph.blocks.some((block) => block.id === paragraphState.blocks[1]!.id), false);
});

test("insertions inside an anchor and partial deletions need review while deletions before it track", () => {
  const text = "前。東京へ行く。";
  const ids = makeIds();
  const state = emptyDocumentEvidence(text, "revision-1", ids);
  state.anchors = [anchorFor(text, "東京", state.blocks[0]!.id)];
  const anchorStart = text.indexOf("東京");
  const insert = { from: anchorStart + 1, to: anchorStart + 1, insert: "な" };
  const inserted = trackTextChanges(state, text, `${text.slice(0, insert.from)}${insert.insert}${text.slice(insert.to)}`, [insert], ids);
  assert.equal(inserted.anchors[0]!.status, "needs_review");
  assert.equal(inserted.anchors[0]!.to, state.anchors[0]!.to + 1);

  const deletionBefore = { from: 0, to: 2, insert: "" };
  const afterBeforeDelete = trackTextChanges(state, text, text.slice(2), [deletionBefore], ids);
  assert.equal(afterBeforeDelete.anchors[0]!.from, anchorStart - 2);
  assert.equal(afterBeforeDelete.anchors[0]!.status, "current");

  const partialDelete = { from: anchorStart, to: anchorStart + 1, insert: "" };
  const afterPartialDelete = trackTextChanges(state, text, `${text.slice(0, partialDelete.from)}${text.slice(partialDelete.to)}`, [partialDelete], ids);
  assert.equal(afterPartialDelete.anchors[0]!.status, "needs_review");
});

test("range replacement requires review and preserves the anchor id", () => {
  const oldText = "猫は東京にいる。";
  const ids = makeIds();
  const state = emptyDocumentEvidence(oldText, "revision-1", ids);
  state.anchors = [anchorFor(oldText, "東京", state.blocks[0]!.id)];
  const from = oldText.indexOf("東京");
  const change = { from, to: from + 2, insert: "京都" };
  const nextText = oldText.slice(0, from) + change.insert + oldText.slice(from + 2);

  const next = trackTextChanges(state, oldText, nextText, [change], ids);
  assert.equal(next.anchors[0]!.id, "anchor-1");
  assert.equal(next.anchors[0]!.status, "needs_review");
  assert.equal(next.anchors[0]!.from, from);
  assert.equal(next.anchors[0]!.to, from + 2);
});

test("paragraph split gives the first block the stable id and creates an id for the new block", () => {
  const oldText = "前半 後半";
  const ids = makeIds();
  const state = emptyDocumentEvidence(oldText, "revision-1", ids);
  const originalId = state.blocks[0]!.id;
  state.anchors = [anchorFor(oldText, "後半", originalId)];
  const change = { from: 3, to: 3, insert: "\n\n" };
  const nextText = `${oldText.slice(0, 3)}\n\n${oldText.slice(3)}`;

  const next = trackTextChanges(state, oldText, nextText, [change], ids);
  assert.equal(next.blocks.length, 2);
  assert.equal(next.blocks[0]!.id, originalId);
  assert.notEqual(next.blocks[1]!.id, originalId);
  assert.equal(next.anchors[0]!.blockId, next.blocks[1]!.id);
  assert.equal(next.anchors[0]!.status, "current");
});

test("paragraph join retains the first id and reassigns the joined anchor block", () => {
  const oldText = "前段落。\n\n後段落。";
  const ids = makeIds();
  const state = emptyDocumentEvidence(oldText, "revision-1", ids);
  const firstId = state.blocks[0]!.id;
  state.anchors = [anchorFor(oldText, "後段落", state.blocks[1]!.id)];
  const from = "前段落。".length;
  const change = { from, to: from + 2, insert: "" };
  const nextText = oldText.slice(0, from) + oldText.slice(from + 2);

  const next = trackTextChanges(state, oldText, nextText, [change], ids);
  assert.equal(next.blocks.length, 1);
  assert.equal(next.blocks[0]!.id, firstId);
  assert.equal(next.anchors[0]!.blockId, firstId);
  assert.equal(next.anchors[0]!.status, "current");
});

test("revision changes invalidate references and never auto-merge conflicting text", () => {
  const text = "猫は東京にいる。";
  const ids = makeIds();
  const state = emptyDocumentEvidence(text, "revision-1", ids);
  state.anchors = [anchorFor(text, "東京", state.blocks[0]!.id)];
  const conflict = markRevisionConflict(state, "revision-2");

  assert.equal(conflict.revisionConflict, true);
  assert.equal(conflict.revisionId, "revision-1");
  assert.equal(conflict.anchors[0]!.status, "revision_conflict");
  const localDraft = `未保存。${text}`;
  const afterLocalEdit = trackTextChanges(conflict, text, localDraft, [{ from: 0, to: 0, insert: "未保存。" }], ids);
  assert.equal(localDraft, "未保存。猫は東京にいる。");
  assert.equal(afterLocalEdit.anchors[0]!.status, "revision_conflict");
  assert.equal(afterLocalEdit.anchors[0]!.from, state.anchors[0]!.from);
});

test("revision-pinned snapshot failures stay visible as stale entries without being highlighted", () => {
  const baseText = "猫は東京にいる。";
  const ids = makeIds();
  const base = emptyDocumentEvidence(baseText, "revision-1", ids);
  const anchor = anchorFor(baseText, "東京", base.blocks[0]!.id);
  const snapshot = { revisionId: "revision-0", blocks: base.blocks, anchors: [{ ...anchor, revisionId: "revision-0" }] };
  const state = initializeDocumentEvidence(baseText, "revision-1", snapshot, ids);

  assert.equal(state.revisionConflict, true);
  assert.equal(state.positionsTrusted, false);
  assert.equal(state.anchors[0]!.status, "revision_conflict");
  const orphan = { ...anchor, from: 20, to: 22, status: "orphaned" as const };
  const orphanState = initializeDocumentEvidence(baseText, "revision-1", {
    revisionId: "revision-1", blocks: base.blocks, anchors: [orphan],
  }, ids);
  assert.equal(orphanState.anchors[0]!.status, "orphaned");
  assert.equal(orphanState.anchors[0]!.quote, "東京");
  const collapsedOrphan = { ...anchor, from: 2, to: 2, status: "orphaned" as const };
  const validated = assertEditorEvidenceSnapshot({
    revisionId: "revision-1", blocks: base.blocks, anchors: [collapsedOrphan],
  }, baseText.length);
  assert.equal(validated.anchors[0]!.from, validated.anchors[0]!.to);
});

test("Markdown source remains byte-for-byte text and offsets use UTF-16 around surrogate pairs", () => {
  const original = "🙂猫\r\n\r\n```md\r\n1\r\n\r\n2\r\n```\r\n";
  const before = parseMarkdownBlocks(original, makeIds());
  assert.equal(original, "🙂猫\r\n\r\n```md\r\n1\r\n\r\n2\r\n```\r\n");
  assert.equal(before.length, 2);
  assert.equal(before[0]!.kind, "paragraph");
  assert.equal(before[1]!.kind, "code");
  assert.equal(parseMarkdownBlocks("一段。\r\r二段。", makeIds()).length, 2);

  const text = "🙂猫";
  const ids = makeIds();
  const state = emptyDocumentEvidence(text, "revision-1", ids);
  state.anchors = [anchorFor(text, "猫", state.blocks[0]!.id)];
  const change = { from: 0, to: 0, insert: "章" };
  const next = trackTextChanges(state, text, `${change.insert}${text}`, [change], ids);
  assert.equal(next.anchors[0]!.from, 3);
  assert.equal(next.anchors[0]!.status, "current");
});
