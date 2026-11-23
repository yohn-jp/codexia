import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpWritingContext,
  mcpWritingContextSelectionSchema,
  McpWritingContextInputError,
} from "./context-manifest.js";

test("selection character limits count Unicode code points while offsets count UTF-16 units", () => {
  const input = { projectId: "p", sceneId: "s", manuscriptId: "m", manuscriptRevision: "r", manuscriptText: "" };
  const selectedText = "𠮷".repeat(5_000);
  const selection = mcpWritingContextSelectionSchema.parse({ from: 0, to: selectedText.length, text: selectedText });
  for (const manifestOnly of [false, true]) {
    const context = createMcpWritingContext({ ...input, selection, manifestOnly });
    const selectionPart = context.manifest.parts.find((part) => part.kind === "selection");
    assert.ok(selectionPart);
    assert.equal(selectionPart.size.source_character_count, 5_000);
    assert.equal(selectionPart.size.included_character_count, manifestOnly ? 0 : 5_000);
  }
  assert.throws(() => createMcpWritingContext({ ...input, selection: { ...selection, to: 5_000 } }), McpWritingContextInputError);
  const overLimit = selectedText + "𠮷";
  assert.throws(() => createMcpWritingContext({ ...input, selection: { from: 0, to: overLimit.length, text: overLimit } }), McpWritingContextInputError);
});

test("writing context preserves source identity, bounds, and selection provenance", () => {
  const retainedText = "本文".repeat(25_000);
  const input = {
    projectId: "project-one",
    sceneId: "scene-one",
    sceneRevision: "scene-rev-1",
    sceneTitle: "一場面",
    manuscriptId: "manuscript-one",
    manuscriptRevision: "manuscript-rev-1",
    manuscriptText: retainedText + "末尾",
    selection: { from: 1, to: 3, text: "本文" },
    capturedAt: 123,
  };
  const context = createMcpWritingContext(input);
  const savedPart = context.manifest.parts.find((part) => part.kind === "saved_manuscript");
  const selectionPart = context.manifest.parts.find((part) => part.kind === "selection");
  assert.ok(savedPart);
  assert.ok(selectionPart);
  assert.equal(context.captured_at, 123);
  assert.equal(context.saved_manuscript.text, retainedText);
  assert.equal(context.saved_manuscript.revision, input.manuscriptRevision);
  assert.equal(savedPart.source, "arcadia");
  assert.equal(savedPart.revision, input.manuscriptRevision);
  assert.equal(savedPart.size.source_character_count, 50_002);
  assert.equal(savedPart.size.included_character_count, 50_000);
  assert.equal(savedPart.size.included_byte_count, 150_000);
  assert.equal(savedPart.trimmed, true);
  assert.equal(context.selection.status, "client_provided");
  assert.equal(context.selection.content_hash, "d0ab52a4");
  assert.equal(selectionPart.source, "mcp_client");
  assert.equal(selectionPart.source_identity.content_hash, context.selection.content_hash);
  assert.deepEqual(context.draft, { status: "not_shared" });
  assert.equal(context.manifest.scope, "arcadia_provided_context");
  assert.equal(context.manifest.external_host_final_prompt_observed, false);
});

test("writing context truncates Unicode by character and validates selection identity", () => {
  const context = createMcpWritingContext({
    projectId: "project-one",
    sceneId: "scene-one",
    sceneTitle: "😀".repeat(513),
    manuscriptId: "manuscript-one",
    manuscriptRevision: "manuscript-rev-1",
    manuscriptText: "😀x",
    selection: { from: 0, to: 2, text: "😀" },
  });
  const scenePart = context.manifest.parts.find((part) => part.kind === "scene");
  assert.ok(scenePart);
  assert.equal(context.scene.title, "😀".repeat(512));
  assert.equal(scenePart.size.source_character_count, 513);
  assert.equal(scenePart.size.included_character_count, 512);
  assert.equal(scenePart.trimmed, true);
  assert.equal(context.saved_manuscript.text, "😀x");
  assert.equal(context.selection.content_hash, "cb31c4b8");

  assert.throws(
    () => createMcpWritingContext({
      projectId: "project-one",
      sceneId: "scene-one",
      manuscriptId: "manuscript-one",
      manuscriptRevision: "manuscript-rev-1",
      manuscriptText: "saved",
      selection: { from: 2, to: 1, text: "invalid" },
    }),
    McpWritingContextInputError,
  );
  assert.throws(
    () => createMcpWritingContext({
      projectId: "project-one",
      sceneId: "scene-one",
      manuscriptId: "manuscript-one",
      manuscriptRevision: "manuscript-rev-1",
      manuscriptText: "saved",
      selection: { from: 0, to: 5_001, text: "x".repeat(5_001) },
    }),
    McpWritingContextInputError,
  );
});
