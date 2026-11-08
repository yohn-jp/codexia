interface SentenceOffset { start: number; end: number; }

// Port of core-shared's browser-safe splitter, kept in the shell so core UI
// stays independent from whichever optional module profile is selected.
function sentenceOffsets(text: string): SentenceOffset[] {
  const result: SentenceOffset[] = [];
  let lineStart = 0;
  let justSplit = false;
  let segmenter: Intl.Segmenter | null = null;
  for (let index = 0; index <= text.length; index++) {
    const atNewline = index < text.length && text[index] === "\n";
    const atEnd = index === text.length;
    if (!atNewline && !atEnd) continue;
    const lineEnd = index;
    if (lineEnd > lineStart) {
      const line = text.slice(lineStart, lineEnd);
      segmenter ??= new Intl.Segmenter("ja", { granularity: "sentence" });
      const raw = [...segmenter.segment(line)].map(({ segment, index: start }) => ({ start, end: start + segment.length }));
      const merged: SentenceOffset[] = [];
      const depthAt = (end: number) => {
        let depth = 0;
        for (let cursor = 0; cursor < end; cursor++) {
          if (line[cursor] === "「" || line[cursor] === "『") depth++;
          else if (line[cursor] === "」" || line[cursor] === "』") depth = Math.max(0, depth - 1);
        }
        return depth;
      };
      if (raw.length === 0) raw.push({ start: 0, end: line.length });
      let start = raw[0]?.start ?? 0;
      let end = raw[0]?.end ?? line.length;
      for (const segment of raw.slice(1)) {
        if (depthAt(end) > 0) end = segment.end;
        else { merged.push({ start, end }); start = segment.start; end = segment.end; }
      }
      merged.push({ start, end });
      for (const segment of merged) {
        let depth = depthAt(segment.start);
        let chunkStart = segment.start;
        for (let cursor = segment.start; cursor < segment.end; cursor++) {
          const char = line[cursor];
          if (char === "「" || char === "『") {
            if (depth === 0 && cursor > chunkStart) {
              result.push({ start: lineStart + chunkStart, end: lineStart + cursor });
              chunkStart = cursor;
            }
            depth++;
          } else if (char === "」" || char === "』") {
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
              result.push({ start: lineStart + chunkStart, end: lineStart + cursor + 1 });
              chunkStart = cursor + 1;
            }
          }
        }
        if (chunkStart < segment.end) result.push({ start: lineStart + chunkStart, end: lineStart + segment.end });
      }
      justSplit = true;
    } else if (atNewline && !justSplit) result.push({ start: lineEnd, end: lineEnd });
    if (atEnd) lineStart = text.length;
    else { lineStart = index + 1; justSplit = false; }
  }
  result.push({ start: lineStart, end: text.length });
  return result;
}

export function uiSentenceIndexAtOffset(text: string, offset: number): number | null {
  return createUiSentencePositionIndex(text).indexAtOffset(offset);
}

export interface UiSentencePositionIndex {
  indexAtOffset(offset: number): number | null;
  offsetAtIndex(sentenceIndex: number | null): number | null;
}

export interface UiSentencePositionIndexCache<TDoc> {
  get(doc: TDoc, text?: string): UiSentencePositionIndex;
}

/** Build one immutable sentence-position lookup for reuse while a document is unchanged. */
export function createUiSentencePositionIndex(text: string): UiSentencePositionIndex {
  const textLength = text.length;
  const offsets = sentenceOffsets(text);
  return {
    indexAtOffset(offset) {
      const cursor = Math.max(0, Math.min(offset, textLength));
      let low = 0;
      let high = offsets.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((offsets[middle]?.start ?? Number.POSITIVE_INFINITY) <= cursor) low = middle + 1;
        else high = middle;
      }
      const index = low - 1;
      const range = offsets[index];
      if (range && cursor >= range.start && (cursor < range.end || (index === offsets.length - 1 && cursor === range.end))) return index + 1;
      return null;
    },
    offsetAtIndex(sentenceIndex) {
      if (sentenceIndex === null || !Number.isSafeInteger(sentenceIndex) || sentenceIndex < 1) return null;
      return offsets[sentenceIndex - 1]?.start ?? null;
    },
  };
}

/** Retain a position lookup for the current immutable document across selection-only updates. */
export function createUiSentencePositionIndexCache<TDoc extends { toString(): string }>(
  buildIndex: (text: string) => UiSentencePositionIndex = createUiSentencePositionIndex,
): UiSentencePositionIndexCache<TDoc> {
  let cached: { doc: TDoc; index: UiSentencePositionIndex } | null = null;
  return {
    get(doc, text) {
      if (cached?.doc === doc) return cached.index;
      const index = buildIndex(text ?? doc.toString());
      cached = { doc, index };
      return index;
    },
  };
}

export function offsetAtUiSentenceIndex(text: string, sentenceIndex: number | null): number | null {
  return createUiSentencePositionIndex(text).offsetAtIndex(sentenceIndex);
}
