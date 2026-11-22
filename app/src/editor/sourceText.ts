import { applyTextChanges, type TextChange } from "./evidence";

/** Translate increasing CodeMirror positions to UTF-16 positions in the original manuscript. */
export function sourceOffsetReader(source: string) {
  let nextPair = source.indexOf("\r\n");
  let extra = 0;
  return (editorOffset: number): number => {
    while (nextPair >= 0 && nextPair < editorOffset + extra) {
      extra++;
      nextPair = source.indexOf("\r\n", nextPair + 2);
    }
    return editorOffset + extra;
  };
}

export function sourceSelection(source: string, from: number, to: number) {
  if (from === to) return null;
  const offset = sourceOffsetReader(source);
  const start = offset(from);
  const end = offset(to);
  return { from: start, to: end, text: source.slice(start, end) };
}

/** Preserve untouched separators and express every edit against the exact saved source. */
export function sourceEdit(source: string, editorText: string, changes: TextChange[]) {
  if (!source.includes("\r")) return { markdown: editorText, changes };
  const offset = sourceOffsetReader(source);
  const separator = source.match(/\r\n?|\n/u)![0];
  const sourceChanges = changes.map(({ from, to, insert }) => ({
    from: offset(from), to: offset(to), insert: insert.replaceAll("\n", separator),
  }));
  // A standalone CR and LF meeting at a splice would otherwise collapse to a single editor break.
  let previousEnd = 0;
  let lastCharacter: string | undefined;
  for (const [index, change] of sourceChanges.entries()) {
    if (change.from > previousEnd) lastCharacter = source[change.from - 1];
    if (lastCharacter === "\r" && change.insert.startsWith("\n")) change.insert = "\n" + change.insert;
    lastCharacter = change.insert.at(-1) ?? lastCharacter;
    const next = sourceChanges[index + 1];
    if (lastCharacter === "\r" && source[change.to] === "\n" && next?.from !== change.to) {
      change.insert += "\n";
      lastCharacter = "\n";
    }
    previousEnd = change.to;
  }
  return { markdown: applyTextChanges(source, sourceChanges), changes: sourceChanges };
}

/** Resolve persisted UTF-16 offsets, rejecting positions inside the two units of a CRLF. */
export function editorOffsetReader(source: string) {
  const pairs: number[] = [];
  for (let at = source.indexOf("\r\n"); at >= 0; at = source.indexOf("\r\n", at + 2)) pairs.push(at);
  return (offset: number): number | null => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) return null;
    let low = 0;
    let high = pairs.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pairs[mid]! < offset) low = mid + 1;
      else high = mid;
    }
    if (low > 0 && pairs[low - 1] === offset - 1) return null;
    return offset - low;
  };
}
