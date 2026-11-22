export interface MarkdownHeading {
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
  const lines = sourceLines(markdown);
  const headings: MarkdownHeading[] = [];
  let frontmatter = lines[0]?.content === "---";
  let fence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (frontmatter) {
      if (index > 0 && (line.content === "---" || line.content === "...")) frontmatter = false;
      continue;
    }

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
    const preceding = lines[index - 1];
    if (!setext || !preceding || !preceding.content.trim() || /^(?: {4}|\t)/u.test(preceding.content) ||
        /^ {0,3}#{1,6}(?:[ \t]+|$)/u.test(preceding.content)) continue;
    headings.push({
      offset: preceding.from + (preceding.content.length - preceding.content.trimStart().length),
      line: index,
      level: setext[1]![0] === "=" ? 1 : 2,
      title: preceding.content.trim(),
    });
  }

  return headings;
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;
  while (from < markdown.length) {
    let end = from;
    while (end < markdown.length && markdown[end] !== "\n" && markdown[end] !== "\r") end += 1;
    lines.push({ from, content: markdown.slice(from, end) });
    if (end === markdown.length) break;
    from = end + (markdown[end] === "\r" && markdown[end + 1] === "\n" ? 2 : 1);
  }
  return lines;
}

function cleanAtxTitle(title: string): string {
  return title.trim().replace(/[ \t]+#+[ \t]*$/u, "").trim();
}
