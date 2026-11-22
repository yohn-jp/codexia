import assert from "node:assert/strict";
import test from "node:test";
import { applyTextChanges } from "./evidence";
import { editorOffsetReader, sourceEdit, sourceOffsetReader, sourceSelection } from "./sourceText";

test("source offsets round trip UTF-16 editor positions without selecting half a CRLF", () => {
  const source = "甲😀\r\n乙\r丙\n丁\r\n";
  const editor = source.replace(/\r\n?/gu, "\n");
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
  assert.equal(applyTextChanges(source, projected.changes), projected.markdown);
});

test("editing at a CR and LF boundary preserves both displayed line breaks", () => {
  const source = "a\rb\nc";
  for (const changes of [
    [{ from: 0, to: 3, insert: "\n" }],
    [{ from: 2, to: 3, insert: "" }],
    [{ from: 1, to: 2, insert: "\n" }, { from: 2, to: 3, insert: "" }],
  ]) {
    const editorText = applyTextChanges(source.replace(/\r\n?/gu, "\n"), changes);
    const result = sourceEdit(source, editorText, changes);
    assert.equal(result.markdown.replace(/\r\n?/gu, "\n"), editorText);
    assert.equal(applyTextChanges(source, result.changes), result.markdown);
    assert.deepEqual(result.changes.map(({ from, to }) => [from, to]), changes.map(({ from, to }) => [from, to]));
  }
});
