import { splitManuscriptMarkdown } from "@codexia/contracts/manuscript";

export interface MarkdownHeading {
  /** UTF-16 position in CodeMirror, where each line break occupies one unit. */
  offset: number;
  line: number;
  level: number;
  title: string;
}

interface SourceLine {
  from: number;
  content: string;
}

export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const editorText = markdown.replace(/\r\n?/gu, "\n");
  const lines = sourceLines(editorText);
  const headings: MarkdownHeading[] = [];
  const frontmatterEnd = splitManuscriptMarkdown(editorText, { allowYamlDocumentEnd: true }).prefix.length;
  let paragraphLine: SourceLine | undefined;
  let fence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const preceding = paragraphLine;
    paragraphLine = undefined;
    if (line.from < frontmatterEnd) continue;

    const openingFence = /^ {0,3}(`{3,}|~{3,})/u.exec(line.content)?.[1];
    if (fence) {
      const closingFence = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`, "u");
      if (closingFence.test(line.content)) fence = null;
      continue;
    }
    if (openingFence) {
      fence = { marker: openingFence[0]!, length: openingFence.length };
      continue;
    }
    if (/^(?: {4}|\t)/u.test(line.content)) continue;

    const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line.content);
    if (atx) {
      headings.push({
        offset: line.from + (line.content.length - line.content.trimStart().length),
        line: index + 1,
        level: atx[1]!.length,
        title: cleanAtxTitle(atx[2]!),
      });
      continue;
    }

    const setext = /^ {0,3}(=+|-+)[ \t]*$/u.exec(line.content);
    if (setext && preceding) {
      headings.push({
        offset: preceding.from + (preceding.content.length - preceding.content.trimStart().length),
        line: index,
        level: setext[1]![0] === "=" ? 1 : 2,
        title: preceding.content.trim(),
      });
      continue;
    }

    const thematicBreak = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/u.test(line.content);
    const container = /^ {0,3}(?:>|(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$))/u.test(line.content);
    if (line.content.trim() && !thematicBreak && !container) paragraphLine = line;
  }

  return headings;
}

function sourceLines(markdown: string): SourceLine[] {
  let from = 0;
  return markdown.split("\n").map((content) => {
    const line = { from, content };
    from += content.length + 1;
    return line;
  });
}

function cleanAtxTitle(title: string): string {
  return title.trim().replace(/[ \t]+#+[ \t]*$/u, "").trim();
}
