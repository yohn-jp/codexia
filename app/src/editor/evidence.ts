/** UI-facing text evidence types. The persistence adapter translates these to the published API contract. */
export type TextAnchorStatus = "proposed" | "current" | "needs_review" | "orphaned" | "revision_conflict";

export interface MarkdownBlockIdentity {
  id: string;
  from: number;
  to: number;
  kind: "frontmatter" | "code" | "heading" | "list" | "quote" | "paragraph";
}

export interface KnowledgeReference {
  id: string;
  label: string;
  /** Optional path understood by the existing document navigator. */
  targetPath?: string;
}

export interface AssertionReference {
  id: string;
  label: string;
  role: "supports" | "contradicts" | "quotes" | "context";
  status: "proposed" | "confirmed" | "rejected" | "retired";
}

export interface TextAnchor {
  id: string;
  blockId: string;
  from: number;
  to: number;
  quote: string;
  /** Author-confirmed Knowledge target. A body mention may have no target. */
  target?: KnowledgeReference;
  /** Unconfirmed link candidates; these are never treated as canon references. */
  candidates?: KnowledgeReference[];
  assertions?: AssertionReference[];
  revisionId: string;
  status: TextAnchorStatus;
}

export interface TextChange {
  /** UTF-16 offset in the document before this ChangeSet. */
  from: number;
  /** Exclusive UTF-16 offset in the document before this ChangeSet. */
  to: number;
  insert: string;
}

interface TextPiece {
  kind: "source" | "inserted";
  from: number;
  to: number;
  text?: string;
}

/** Compose sequential CodeMirror changes into UTF-16 ranges against one saved revision. */
export function composeTextChanges(
  sourceText: string,
  previous: readonly TextChange[],
  next: readonly TextChange[],
): TextChange[] {
  const pieces: TextPiece[] = sourceText.length > 0 ? [{ kind: "source", from: 0, to: sourceText.length }] : [];
  applyChangesToPieces(pieces, previous, sourceText.length);
  const currentLength = pieces.reduce((total, piece) => total + pieceLength(piece), 0);
  applyChangesToPieces(pieces, next, currentLength);

  const composed: TextChange[] = [];
  let sourceOffset = 0;
  let inserted = "";
  for (const piece of pieces) {
    if (piece.kind === "inserted") {
      inserted += piece.text ?? "";
      continue;
    }
    if (piece.from < sourceOffset) throw new RangeError("Text changes reordered source text.");
    if (piece.from > sourceOffset || inserted.length > 0) {
      composed.push({ from: sourceOffset, to: piece.from, insert: inserted });
      inserted = "";
    }
    sourceOffset = piece.to;
  }
  if (sourceOffset < sourceText.length || inserted.length > 0) {
    composed.push({ from: sourceOffset, to: sourceText.length, insert: inserted });
  }
  return composed;
}

function pieceLength(piece: TextPiece): number {
  return piece.kind === "source" ? piece.to - piece.from : (piece.text ?? "").length;
}

function splitPiecesAt(pieces: TextPiece[], offset: number): number {
  let cursor = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!;
    const length = pieceLength(piece);
    if (offset === cursor) return index;
    if (offset === cursor + length) return index + 1;
    if (offset > cursor && offset < cursor + length) {
      const leftLength = offset - cursor;
      const left: TextPiece = piece.kind === "source"
        ? { kind: "source", from: piece.from, to: piece.from + leftLength }
        : { kind: "inserted", from: 0, to: 0, text: piece.text!.slice(0, leftLength) };
      const right: TextPiece = piece.kind === "source"
        ? { kind: "source", from: piece.from + leftLength, to: piece.to }
        : { kind: "inserted", from: 0, to: 0, text: piece.text!.slice(leftLength) };
      pieces.splice(index, 1, left, right);
      return index + 1;
    }
    cursor += length;
  }
  if (offset === cursor) return pieces.length;
  throw new RangeError("Text change offset is outside its source revision.");
}

function applyChangesToPieces(pieces: TextPiece[], changes: readonly TextChange[], sourceLength: number): void {
  const ordered = [...changes].sort((left, right) => left.from - right.from || left.to - right.to);
  let previousEnd = 0;
  for (const change of ordered) {
    if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < previousEnd
      || change.to < change.from || change.to > sourceLength || typeof change.insert !== "string") {
      throw new RangeError("Text changes must be ordered, non-overlapping UTF-16 ranges.");
    }
    previousEnd = change.to;
  }
  for (const change of [...ordered].reverse()) {
    const startIndex = splitPiecesAt(pieces, change.from);
    const endIndex = splitPiecesAt(pieces, change.to);
    const replacement = change.insert.length > 0
      ? [{ kind: "inserted", from: 0, to: 0, text: change.insert } satisfies TextPiece]
      : [];
    pieces.splice(startIndex, endIndex - startIndex, ...replacement);
  }
}

export interface DocumentEvidenceState {
  /** Revision the anchors were read from. Local edits do not invent a revision identifier. */
  revisionId: string;
  blocks: MarkdownBlockIdentity[];
  anchors: TextAnchor[];
  revisionConflict: boolean;
  positionsTrusted: boolean;
}

export interface EditorEvidenceIdentity {
  projectId: string;
  documentId: string;
  revisionId: string;
  /** Exact source text lets adapters reject a stale or unmapped revision before decorating. */
  markdown?: string;
}

export interface EditorEvidenceSnapshot {
  revisionId: string;
  markdown?: string;
  blocks: MarkdownBlockIdentity[];
  anchors: TextAnchor[];
}

export interface EditorPersistenceSave {
  baseMarkdown: string;
  markdown: string;
  changes: TextChange[];
  idempotencyKey: string;
  clientId: string;
}

export interface EditorPersistenceSaveResult {
  revisionId: string;
  markdown: string;
}

/** Host adapter for a revision-pinned PostgreSQL document binding used by the existing Editor. */
export interface EditorEvidenceAdapter {
  read(identity: EditorEvidenceIdentity, signal: AbortSignal): Promise<EditorEvidenceSnapshot>;
  /** Optional writer for a PG-backed Editor binding; invoked only after the browser Draft Journal stores the text. */
  save?(identity: EditorEvidenceIdentity, request: EditorPersistenceSave, signal: AbortSignal): Promise<EditorPersistenceSaveResult>;
}

/** Validates host adapter data before offsets become CodeMirror decorations. */
export function assertEditorEvidenceSnapshot(value: unknown, documentLength: number): EditorEvidenceSnapshot {
  const record = (input: unknown): input is Record<string, unknown> => typeof input === "object" && input !== null && !Array.isArray(input);
  if (!record(value) || typeof value.revisionId !== "string" || value.revisionId.length === 0
    || (value.markdown !== undefined && typeof value.markdown !== "string")
    || !Array.isArray(value.blocks) || !Array.isArray(value.anchors)) throw new TypeError("Text Anchor adapter returned an invalid snapshot.");
  const blockKinds = new Set(["frontmatter", "code", "heading", "list", "quote", "paragraph"]);
  const blocks = value.blocks.map((item) => {
    if (!record(item) || typeof item.id !== "string" || item.id.length === 0
      || !Number.isInteger(item.from) || !Number.isInteger(item.to)
      || (item.from as number) < 0 || (item.to as number) <= (item.from as number) || (item.to as number) > documentLength
      || typeof item.kind !== "string" || !blockKinds.has(item.kind)) throw new TypeError("Text Anchor adapter returned an invalid block identity.");
    return item as unknown as MarkdownBlockIdentity;
  });
  if (!validBlocksOfLength(blocks, documentLength)) throw new TypeError("Text Anchor adapter returned duplicate or unordered block identities.");
  const statuses = new Set(["proposed", "current", "needs_review", "orphaned", "revision_conflict"]);
  const anchors = value.anchors.map((item) => {
    if (!record(item) || typeof item.id !== "string" || item.id.length === 0
      || typeof item.blockId !== "string" || item.blockId.length === 0
      || !Number.isInteger(item.from) || !Number.isInteger(item.to)
      || (item.from as number) < 0 || (item.to as number) < (item.from as number)
      || typeof item.quote !== "string" || item.quote.length === 0
      || typeof item.revisionId !== "string" || item.revisionId.length === 0 || typeof item.status !== "string" || !statuses.has(item.status)
      || ((item.to as number) === (item.from as number) && item.status !== "orphaned")
      || (item.target !== undefined && !validKnowledgeReference(item.target))
      || (item.candidates !== undefined && (!Array.isArray(item.candidates) || !item.candidates.every(validKnowledgeReference)))
      || (item.assertions !== undefined && (!Array.isArray(item.assertions) || !item.assertions.every(validAssertionReference)))) {
      throw new TypeError("Text Anchor adapter returned an invalid anchor.");
    }
    if ((item.to as number) > documentLength && item.status !== "orphaned" && item.status !== "revision_conflict") {
      throw new TypeError("Text Anchor adapter returned an out-of-range current anchor.");
    }
    return item as unknown as TextAnchor;
  });
  return { revisionId: value.revisionId, ...(typeof value.markdown === "string" ? { markdown: value.markdown } : {}), blocks, anchors };
}

function validKnowledgeReference(value: unknown): value is KnowledgeReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return typeof reference.id === "string" && reference.id.length > 0
    && typeof reference.label === "string" && reference.label.length > 0
    && (reference.targetPath === undefined || typeof reference.targetPath === "string");
}

function validAssertionReference(value: unknown): value is AssertionReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return typeof reference.id === "string" && reference.id.length > 0
    && typeof reference.label === "string" && reference.label.length > 0
    && ["supports", "contradicts", "quotes", "context"].includes(String(reference.role))
    && ["proposed", "confirmed", "rejected", "retired"].includes(String(reference.status));
}

export type CreateBlockId = () => string;

let fallbackBlockSequence = 0;

export function createBlockId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  fallbackBlockSequence += 1;
  return `block-${Date.now().toString(36)}-${fallbackBlockSequence.toString(36)}`;
}

/**
 * Splits raw Markdown into display blocks without parsing, normalizing, or rewriting the source.
 * Blank-line separation is respected, with frontmatter and fenced code kept intact.
 */
export function parseMarkdownBlocks(text: string, makeId: CreateBlockId = createBlockId): MarkdownBlockIdentity[] {
  const lines = lineRanges(text);
  const blocks: MarkdownBlockIdentity[] = [];
  let start: number | null = null;
  let kind: MarkdownBlockIdentity["kind"] = "paragraph";
  let fence: { marker: string; length: number } | null = null;
  let frontmatter = lines[0]?.content === "---";

  const add = (from: number, to: number, blockKind: MarkdownBlockIdentity["kind"]) => {
    if (to > from) blocks.push({ id: makeId(), from, to, kind: blockKind });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (frontmatter) {
      if (index === 0) start = line.from;
      if (index > 0 && (line.content === "---" || line.content === "...")) {
        add(start ?? 0, line.to, "frontmatter");
        start = null;
        frontmatter = false;
      } else if (index === lines.length - 1) {
        add(start ?? 0, line.to, "frontmatter");
        start = null;
        frontmatter = false;
      }
      continue;
    }

    const fenceOpening = /^ {0,3}(`{3,}|~{3,})/u.exec(line.content)?.[1];
    if (start === null && fenceOpening) {
      start = line.from;
      kind = "code";
      fence = { marker: fenceOpening[0]!, length: fenceOpening.length };
      continue;
    }
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`, "u");
      if (close.test(line.content) || index === lines.length - 1) {
        add(start ?? line.from, line.from + line.content.length, "code");
        start = null;
        fence = null;
      }
      continue;
    }

    if (/^\s*$/u.test(line.content)) {
      if (start !== null) add(start, previousContentEnd(lines, index), kind);
      start = null;
      continue;
    }
    if (start === null) {
      start = line.from;
      kind = /^ {0,3}#{1,6}(?:\s|$)/u.test(line.content) ? "heading"
        : /^\s*(?:[-+*]|\d+[.)])\s+/u.test(line.content) ? "list"
          : /^\s*>/u.test(line.content) ? "quote" : "paragraph";
    }
    if (index === lines.length - 1) {
      add(start, line.from + line.content.length, kind);
      start = null;
    }
  }

  if (start !== null && lines.length > 0) add(start, previousContentEnd(lines, lines.length), fence ? "code" : kind);
  return blocks;
}

function lineRanges(text: string): Array<{ from: number; to: number; content: string }> {
  if (text.length === 0) return [];
  const lines: Array<{ from: number; to: number; content: string }> = [];
  let from = 0;
  while (from < text.length) {
    let end = from;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
    const newlineWidth = end === text.length ? 0 : text[end] === "\r" && text[end + 1] === "\n" ? 2 : 1;
    const to = end + newlineWidth;
    lines.push({ from, to, content: text.slice(from, end) });
    from = to;
  }
  return lines;
}

function previousContentEnd(lines: readonly { from: number; to: number; content: string }[], beforeIndex: number): number {
  const line = lines[Math.max(0, beforeIndex - 1)];
  if (!line) return 0;
  return line.from + line.content.length;
}

export function mapTextOffset(offset: number, changes: readonly TextChange[], association: -1 | 1): number {
  let delta = 0;
  for (const change of changes) {
    const insertedLength = change.insert.length;
    const removedLength = change.to - change.from;
    if (offset < change.from) break;
    if (change.from === change.to) {
      if (offset === change.from) return change.from + delta + (association > 0 ? insertedLength : 0);
      delta += insertedLength;
      continue;
    }
    if (offset > change.to) {
      delta += insertedLength - removedLength;
      continue;
    }
    if (offset === change.to) return change.from + delta + insertedLength;
    return change.from + delta + (association > 0 ? insertedLength : 0);
  }
  return offset + delta;
}

export function reconcileMarkdownBlocks(
  previous: readonly MarkdownBlockIdentity[],
  oldText: string,
  nextText: string,
  changes: readonly TextChange[],
  makeId: CreateBlockId = createBlockId,
): MarkdownBlockIdentity[] {
  const next = parseMarkdownBlocks(nextText, makeId);
  const assigned = new Map<number, string>();

  previous.forEach((block) => {
    if (block.from < 0 || block.to <= block.from || block.to > oldText.length) return;
    let bestIndex = -1;
    let bestOverlap = 0;
    const surviving = survivingBlockSegments(block.from, block.to, changes);
    const projected = surviving.map(([from, to]) => [
      mapTextOffset(from, changes, 1),
      mapTextOffset(to, changes, -1),
    ] as const);
    for (const [from, to] of projected) {
      next.forEach((candidate, newIndex) => {
        const overlap = Math.max(0, Math.min(to, candidate.to) - Math.max(from, candidate.from));
        const containsStart = from >= candidate.from && from <= candidate.to;
        const score = overlap + (containsStart ? 0.25 : 0);
        if (score > bestOverlap) {
          bestIndex = newIndex;
          bestOverlap = score;
        }
      });
    }
    if (bestIndex < 0) {
      const replacement = changes.find((change) => change.from <= block.from && change.to >= block.to && change.insert.length > 0);
      if (replacement) {
        const newFrom = changeInsertedStart(replacement, changes);
        const newTo = newFrom + replacement.insert.length;
        next.forEach((candidate, newIndex) => {
          const overlap = Math.max(0, Math.min(newTo, candidate.to) - Math.max(newFrom, candidate.from));
          if (overlap > bestOverlap) {
            bestIndex = newIndex;
            bestOverlap = overlap;
          }
        });
      }
    }
    if (bestIndex >= 0 && !assigned.has(bestIndex)) assigned.set(bestIndex, block.id);
  });

  return next.map((block, index) => ({ ...block, id: assigned.get(index) ?? block.id }));
}

function survivingBlockSegments(from: number, to: number, changes: readonly TextChange[]): Array<[number, number]> {
  let segments: Array<[number, number]> = [[from, to]];
  for (const change of changes) {
    if (change.to <= change.from) continue;
    const next: Array<[number, number]> = [];
    for (const [segmentFrom, segmentTo] of segments) {
      if (change.to <= segmentFrom || change.from >= segmentTo) {
        next.push([segmentFrom, segmentTo]);
        continue;
      }
      if (segmentFrom < change.from) next.push([segmentFrom, change.from]);
      if (change.to < segmentTo) next.push([change.to, segmentTo]);
    }
    segments = next;
  }
  return segments.filter(([segmentFrom, segmentTo]) => segmentTo > segmentFrom);
}

function changeInsertedStart(change: TextChange, changes: readonly TextChange[]): number {
  let delta = 0;
  for (const prior of changes) {
    if (prior === change) break;
    delta += prior.insert.length - (prior.to - prior.from);
  }
  return change.from + delta;
}

function blockAt(blocks: readonly MarkdownBlockIdentity[], offset: number): MarkdownBlockIdentity | undefined {
  return blocks.find((block) => offset >= block.from && offset <= block.to)
    ?? blocks.reduce<MarkdownBlockIdentity | undefined>((nearest, block) =>
      !nearest || Math.abs(block.from - offset) < Math.abs(nearest.from - offset) ? block : nearest, undefined);
}

export function initializeDocumentEvidence(
  text: string,
  revisionId: string,
  snapshot: EditorEvidenceSnapshot | null,
  makeId: CreateBlockId = createBlockId,
): DocumentEvidenceState {
  const sourceMatches = !snapshot || snapshot.revisionId === revisionId;
  const blocks = snapshot?.revisionId === revisionId && validBlocks(text, snapshot.blocks) && (snapshot.blocks.length > 0 || text.length === 0)
    ? snapshot.blocks.map((block) => ({ ...block }))
    : parseMarkdownBlocks(text, makeId);
  const anchors = (snapshot?.anchors ?? []).flatMap((anchor) => {
    if (!Number.isInteger(anchor.from) || !Number.isInteger(anchor.to) || anchor.from < 0 || anchor.to < anchor.from
      || (anchor.to === anchor.from && anchor.status !== "orphaned")) return [];
    const inRange = anchor.to <= text.length;
    const quoteMatches = inRange && text.slice(anchor.from, anchor.to) === anchor.quote;
    const revisionMatches = anchor.revisionId === revisionId && snapshot?.revisionId === revisionId;
    const persistedBlock = blocks.find((block) => block.id === anchor.blockId);
    const actualBlock = inRange ? blockAt(blocks, anchor.from) : undefined;
    return [{
      ...anchor,
      blockId: persistedBlock && inRange && anchor.from >= persistedBlock.from && anchor.from <= persistedBlock.to
        ? persistedBlock.id : actualBlock?.id ?? anchor.blockId,
      status: sourceMatches && revisionMatches && quoteMatches ? anchor.status
        : anchor.status === "orphaned" ? "orphaned" as const : "revision_conflict" as const,
    }];
  });
  return { revisionId, blocks, anchors, revisionConflict: !sourceMatches, positionsTrusted: sourceMatches };
}

export function emptyDocumentEvidence(text: string, revisionId: string, makeId: CreateBlockId = createBlockId): DocumentEvidenceState {
  return { revisionId, blocks: parseMarkdownBlocks(text, makeId), anchors: [], revisionConflict: false, positionsTrusted: true };
}

export function markEvidenceNeedsReview(state: DocumentEvidenceState): DocumentEvidenceState {
  return {
    ...state,
    positionsTrusted: false,
    anchors: state.anchors.map((anchor) => anchor.status === "current"
      ? { ...anchor, status: "needs_review" }
      : anchor),
  };
}

function validBlocks(text: string, blocks: readonly MarkdownBlockIdentity[]): boolean {
  return validBlocksOfLength(blocks, text.length);
}

function validBlocksOfLength(blocks: readonly MarkdownBlockIdentity[], length: number): boolean {
  if (!Array.isArray(blocks)) return false;
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const block of blocks) {
    if (typeof block.id !== "string" || block.id.length === 0 || ids.has(block.id)
      || !Number.isInteger(block.from) || !Number.isInteger(block.to)
      || block.from < previousEnd || block.to <= block.from || block.to > length) return false;
    ids.add(block.id);
    previousEnd = block.to;
  }
  return true;
}

export function trackTextChanges(
  state: DocumentEvidenceState,
  oldText: string,
  nextText: string,
  changes: readonly TextChange[],
  makeId: CreateBlockId = createBlockId,
): DocumentEvidenceState {
  const previousBlocks = state.positionsTrusted ? state.blocks : parseMarkdownBlocks(oldText, makeId);
  const blocks = reconcileMarkdownBlocks(previousBlocks, oldText, nextText, changes, makeId);
  if (!state.positionsTrusted) return { ...state, blocks };
  const anchors = state.anchors.map((anchor) => {
    if (anchor.status === "orphaned" || anchor.status === "revision_conflict") return anchor;
    const overlapping = changes.some((change) => change.from === change.to
      ? change.from > anchor.from && change.from < anchor.to
      : change.from < anchor.to && change.to > anchor.from);
    const deleted = overlapping && changes.some((change) => change.from < change.to
      && change.insert.length === 0 && change.from <= anchor.from && change.to >= anchor.to);
    const from = mapTextOffset(anchor.from, changes, overlapping ? -1 : 1);
    const to = mapTextOffset(anchor.to, changes, overlapping ? 1 : -1);
    if (deleted || to <= from) {
      return { ...anchor, from, to: from, status: "orphaned" as const };
    }
    const quoteMatches = nextText.slice(from, to) === anchor.quote;
    const status = overlapping || !quoteMatches ? "needs_review" as const : anchor.status;
    return { ...anchor, from, to, blockId: blockAt(blocks, from)?.id ?? anchor.blockId, status };
  });
  return { ...state, blocks, anchors };
}

/** Revision identity changes invalidate location claims while preserving anchor history in the UI. */
export function markRevisionConflict(state: DocumentEvidenceState, currentRevisionId: string): DocumentEvidenceState {
  if (state.revisionId === currentRevisionId) return state;
  return invalidateDocumentEvidence(state);
}

export function invalidateDocumentEvidence(state: DocumentEvidenceState): DocumentEvidenceState {
  return {
    ...state,
    revisionConflict: true,
    positionsTrusted: false,
    anchors: state.anchors.map((anchor) => ({
      ...anchor,
      status: anchor.status === "orphaned" ? "orphaned" : "revision_conflict",
    })),
  };
}
