import assert from "node:assert/strict";
import test from "node:test";
import { EditorState, Text } from "@codemirror/state";
import { editorOffsetReader, sourceEdit, sourceOffsetReader, sourceSelection } from "./sourceText";

test("source offsets round trip UTF-16 editor positions without selecting half a CRLF", () => {
  const source = "甲😀\r\n乙\r丙\n丁\r\n";
  const editor = EditorState.create({ doc: source }).doc.toString();
  const toSource = sourceOffsetReader(source);
  const toEditor = editorOffsetReader(source);
  for (let offset = 0; offset <= editor.length; offset++) {
    const raw = toSource(offset);
    assert.equal(toEditor(raw), offset);
    assert.equal(source.slice(0, raw).replace(/\r\n?/gu, "\n"), editor.slice(0, offset));
  }
  assert.equal(toEditor(source.indexOf("\r\n") + 1), null);
  assert.equal(toEditor(-1), null);
  assert.equal(toEditor(source.length + 1), null);
  const from = editor.indexOf("乙");
  assert.equal(sourceSelection(source, from, from + 3)?.text, "乙\r丙");
});

test("multiple edits replay verbatim against a manuscript with mixed line endings", () => {
  const source = "A\r\nB\rC\nD";
  const changes = [{ from: 1, to: 3, insert: "\n乙" }, { from: 6, to: 7, insert: "丁" }];
  const projected = sourceEdit(source, "A\n乙\nC\n丁", changes);
  assert.equal(projected.markdown, "A\r\n乙\rC\n丁");
  assert.deepEqual(projected.changes, [{ from: 1, to: 4, insert: "\r\n乙" }, { from: 7, to: 8, insert: "丁" }]);
});

test("editing at a CR and LF boundary preserves both displayed line breaks", () => {
  const source = "a\rb\nc";
  for (const [changes, raw] of [
    [[{ from: 0, to: 3, insert: "\n" }], "\r\n\nc"],
    [[{ from: 2, to: 3, insert: "" }], "a\r\n\nc"],
    [[{ from: 1, to: 2, insert: "\n" }, { from: 2, to: 3, insert: "" }], "a\r\n\nc"],
  ] satisfies [Parameters<typeof sourceEdit>[2], string][]) {
    const editor = EditorState.create({ doc: source });
    const editorText = editor.update({ changes }).state.doc.toString();
    const result = sourceEdit(source, editorText, changes);
    assert.equal(result.markdown, raw);
    assert.equal(EditorState.create({ doc: result.markdown }).doc.toString(), editorText);
    // Treat the source as one CodeMirror line so its raw CR/LF bytes survive replay.
    const rawEditor = EditorState.create({ doc: Text.of([source]) });
    assert.equal(rawEditor.update({ changes: result.changes.map(change => ({
      ...change,
      insert: Text.of([change.insert]),
    })) }).state.doc.toString(), raw);
    assert.deepEqual(result.changes.map(({ from, to }) => [from, to]), changes.map(({ from, to }) => [from, to]));
  }
});
