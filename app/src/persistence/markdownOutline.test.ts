import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { extractMarkdownHeadings } from "./markdownOutline";

test("Markdown headings keep exact source positions and distinct duplicate titles", () => {
  const markdown = "Overview\n========\n\n# Shared\n\nBody.\n\n## Shared ##\n";
  const headings = extractMarkdownHeadings(markdown);

  assert.deepEqual(headings, [
    { offset: 0, line: 1, level: 1, title: "Overview" },
    { offset: markdown.indexOf("# Shared"), line: 4, level: 1, title: "Shared" },
    { offset: markdown.indexOf("## Shared ##"), line: 8, level: 2, title: "Shared" },
  ]);
  assert.notEqual(headings[1]?.offset, headings[2]?.offset);
});

test("Markdown heading extraction ignores frontmatter, fenced code, and indented code", () => {
  const markdown = [
    "---",
    "title: '# frontmatter'",
    "---",
    "",
    "```md",
    "# Fenced",
    "```",
    "",
    "    # Indented",
    "",
    "### Visible",
  ].join("\n");

  assert.deepEqual(extractMarkdownHeadings(markdown), [
    { offset: markdown.indexOf("### Visible"), line: 11, level: 3, title: "Visible" },
  ]);
});

test("horizontal rules and unclosed frontmatter-like prefixes do not hide actual headings", () => {
  const withoutClosing = "---\n# 見出し\n本文です。";
  assert.deepEqual(extractMarkdownHeadings(withoutClosing), [
    { offset: withoutClosing.indexOf("# 見出し"), line: 2, level: 1, title: "見出し" },
  ]);

  const delimitedProse = "---\n普通の回想\n---\n## 次の場面\n";
  const headings = extractMarkdownHeadings(delimitedProse);
  assert.ok(headings.some((heading) => heading.title === "次の場面" &&
    heading.offset === delimitedProse.indexOf("## 次の場面")));
  assert.ok(headings.some((heading) => heading.title === "普通の回想" &&
    heading.offset === delimitedProse.indexOf("普通の回想")));
});

test("heading offsets use the same positions as CodeMirror for mixed line endings", () => {
  const markdown = "序章\r\n\r# 同名\n\r\n  # 同名";
  const doc = EditorState.create({ doc: markdown }).doc;
  const headings = extractMarkdownHeadings(markdown);
  assert.deepEqual(headings.map(({ offset }) => offset), [doc.line(3).from, doc.line(5).from + 2]);
});

test("a Setext underline only promotes preceding paragraph text", () => {
  const markdown = ["---", "title: metadata", "---", "---", "```md", "code", "```", "---", "* * *", "---", "次の場面", "===", "---"].join("\n");
  assert.deepEqual(extractMarkdownHeadings(markdown), [
    { offset: markdown.indexOf("次の場面"), line: 11, level: 1, title: "次の場面" },
  ]);
});

test("only valid YAML mappings hide headings inside the metadata block", () => {
  const prose = "---\nhttps://example.test\n# 章\n---\n";
  assert.deepEqual(extractMarkdownHeadings(prose), [
    { offset: prose.indexOf("# 章"), line: 3, level: 1, title: "章" },
  ]);
  // A multiline flow mapping may put its key and colon on separate lines.
  const metadata = ["---", "{ title", ": 第一章 }", "# Metadata comment", "...", "# 本文"];
  for (const newline of ["\n", "\r\n", "\r"]) {
    assert.deepEqual(extractMarkdownHeadings(metadata.join(newline)), [
      { offset: metadata.join("\n").indexOf("# 本文"), line: 6, level: 1, title: "本文" },
    ]);
  }
});
