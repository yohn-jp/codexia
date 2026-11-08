import { normalizeKnowledgeName, normalizeKnowledgeSurface } from "../knowledge/identity.js";
import type { KnowledgeNodeStatus } from "../knowledge/types.js";

const MIN_TOKEN_LENGTH = 2;

interface TrieNode {
  children: Map<string, TrieNode>;
  nodeIds: string[] | null;
}

export interface MentionDictionary {
  root: TrieNode;
}

export interface MentionDictionaryEntry {
  id: string;
  name?: string;
  aliases?: readonly string[];
  status: KnowledgeNodeStatus;
}

export interface MentionCandidate {
  fromUtf16: number;
  toUtf16: number;
  surface: string;
  nodeIds: readonly string[];
  status: "candidate" | "ambiguous";
}

interface NormalizedText {
  characters: string[];
  sourceStarts: number[];
  sourceEnds: number[];
}

function createTrieNode(): TrieNode {
  return { children: new Map(), nodeIds: null };
}

function insertToken(root: TrieNode, token: string, nodeId: string): void {
  let node = root;
  for (const character of token) {
    let next = node.children.get(character);
    if (!next) {
      next = createTrieNode();
      node.children.set(character, next);
    }
    node = next;
  }
  if (node.nodeIds) {
    if (!node.nodeIds.includes(nodeId)) node.nodeIds.push(nodeId);
  } else {
    node.nodeIds = [nodeId];
  }
}

function normalizeText(text: string): NormalizedText {
  const characters: string[] = [];
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  const segments = new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text);
  for (const { segment, index } of segments) {
    const normalized = normalizeKnowledgeSurface(segment);
    for (const character of normalized) {
      characters.push(character);
      sourceStarts.push(index);
      sourceEnds.push(index + segment.length);
    }
  }
  return { characters, sourceStarts, sourceEnds };
}

/** Builds a longest-match trie from confirmed names and aliases; proposed nodes are excluded. */
export function buildMentionDictionary(nodes: Iterable<MentionDictionaryEntry>): MentionDictionary {
  const root = createTrieNode();
  for (const node of nodes) {
    if (node.status !== "canonical") continue;
    const tokens = [...(node.name ? [node.name] : []), ...(node.aliases ?? [])];
    for (const surface of tokens) {
      const normalized = normalizeKnowledgeName(surface);
      if (Array.from(normalized).length < MIN_TOKEN_LENGTH) continue;
      insertToken(root, normalized, node.id);
    }
  }
  return { root };
}

/** Returns text spans in UTF-16 units. Duplicate names remain ambiguous candidates. */
export function findMentionCandidates(dictionary: MentionDictionary, text: string): MentionCandidate[] {
  const normalized = normalizeText(text);
  const found: MentionCandidate[] = [];
  for (let start = 0; start < normalized.characters.length; start++) {
    let node = dictionary.root;
    let lastMatchIds: string[] | null = null;
    let lastMatchEnd = -1;
    for (let index = start; index < normalized.characters.length; index++) {
      const next = node.children.get(normalized.characters[index]!);
      if (!next) break;
      node = next;
      if (node.nodeIds) {
        lastMatchIds = node.nodeIds;
        lastMatchEnd = index;
      }
    }
    if (!lastMatchIds) continue;

    const fromUtf16 = normalized.sourceStarts[start]!;
    const toUtf16 = normalized.sourceEnds[lastMatchEnd]!;
    const nodeIds = [...lastMatchIds].sort((a, b) => a.localeCompare(b));
    found.push({
      fromUtf16,
      toUtf16,
      surface: text.slice(fromUtf16, toUtf16),
      nodeIds,
      status: nodeIds.length > 1 ? "ambiguous" : "candidate",
    });
    start = lastMatchEnd;
  }
  return found;
}
