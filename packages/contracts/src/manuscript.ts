import { parse } from "yaml";

interface ManuscriptMarkdown {
  metadata: Record<string, unknown>;
  prefix: string;
  body: string;
}

/** A closed YAML mapping is metadata. Other leading thematic breaks belong to the manuscript. */
export function splitManuscriptMarkdown(
  content: string,
  { allowYamlDocumentEnd = false }: { allowYamlDocumentEnd?: boolean } = {},
): ManuscriptMarkdown {
  const opening = /^---[ \t]*\r?\n/.exec(content);
  if (!opening) return { metadata: {}, prefix: "", body: content };

  const delimiter = allowYamlDocumentEnd ? /^(?:---|\.\.\.)[ \t]*\r?$/gm : /^---[ \t]*\r?$/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(content);
  if (!closing) return { metadata: {}, prefix: "", body: content };

  let metadata: unknown;
  try {
    metadata = parse(content.slice(opening[0].length, closing.index));
  } catch {
    return { metadata: {}, prefix: "", body: content };
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return { metadata: {}, prefix: "", body: content };

  let bodyStart = closing.index + closing[0].length;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  return { metadata: metadata as Record<string, unknown>, prefix: content.slice(0, bodyStart), body: content.slice(bodyStart) };
}
