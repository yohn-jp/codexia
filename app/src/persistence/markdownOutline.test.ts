import assert from "node:assert/strict";
import test from "node:test";
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
