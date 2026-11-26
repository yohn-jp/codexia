import assert from "node:assert/strict";
import test from "node:test";
import { confirmAssertion, validateKnowledgeGraph, type Assertion, type KnowledgeEdge, type KnowledgeGraph, type KnowledgeNode } from "./knowledge/index.js";
import {
  advanceProjectSourceRevision,
  advanceSourceRevision,
  buildMentionDictionary,
  buildReferenceIndex,
  confirmMention,
  createEvidenceGraph,
  createMentionFromCandidate,
  createTextAnchor,
  findIncomingReferences,
  findMentionCandidates,
  findReferencesToNode,
  validateEvidenceGraph,
  type Mention,
  type SourceRevision,
} from "./evidence/index.js";

function authorNode(id: string, name: string, aliases: string[] = []): KnowledgeNode {
  return {
    id,
    type: "character",
    name,
    aliases,
    attributes: {},
    status: "canonical",
    provenance: { kind: "author", authorId: "author-1" },
  };
}

function emptyKnowledge(nodes: KnowledgeNode[] = [], edges: KnowledgeEdge[] = []): KnowledgeGraph {
  return { projectId: "project-1", nodes, edges };
}

function revision(id: string, parentRevisionId: string | null, lengthUtf16: number): SourceRevision {
  return { id, documentId: "doc-1", parentRevisionId, contentHash: `hash-${id}`, lengthUtf16 };
}

test("mention candidates preserve same-name ambiguity, longest match, normalization and UTF-16 spans", () => {
  const sameName = authorNode("person-1", "Alex Chen", ["A. Chen"]);
  const otherPerson = authorNode("person-2", "Alex Chen", ["Alexander Chen"]);
  const shortPlace = { ...authorNode("place-short", "東京"), type: "location" };
  const longPlace = { ...authorNode("place-long", "東京駅"), type: "location" };
  const proposed = {
    ...authorNode("person-proposed", "Ghost"),
    status: "proposed" as const,
    provenance: { kind: "analysis" as const, extractor: "ner", extractorVersion: "2", sourceRevisionId: "r1", confidence: 0.9 },
  };
  const dictionary = buildMentionDictionary([sameName, otherPerson, shortPlace, longPlace, proposed]);

  const matches = findMentionCandidates(dictionary, "Alex Chenは東京駅と東京を見た。Ghostもいた。");
  assert.equal(matches[0]?.status, "ambiguous");
  assert.deepEqual(matches[0]?.nodeIds, ["person-1", "person-2"]);
  assert.deepEqual(matches.slice(1).map((match) => match.surface), ["東京駅", "東京"]);
  assert.equal(matches.some((match) => match.nodeIds.includes("person-proposed")), false);

  const ambiguous = createMentionFromCandidate({
    id: "mention-alex",
    anchorId: "anchor-alex",
    sourceRevisionId: "r1",
    candidate: matches[0]!,
  });
  assert.equal(ambiguous.status, "ambiguous");
  const resolved = confirmMention(ambiguous, "person-2", "author-1");
  assert.equal(resolved.status, "confirmed");
  assert.equal(resolved.resolvedNodeId, "person-2");

  const maryDictionary = buildMentionDictionary([authorNode("person-mary", "Mary")]);
  const unicode = findMentionCandidates(maryDictionary, "😀 Ｍａｒｙさん")[0]!;
  assert.equal(unicode.fromUtf16, 3);
  assert.equal(unicode.toUtf16, 7);
  assert.equal(unicode.surface, "Ｍａｒｙ");
});

test("author confirmation does not erase negation or uncertainty in an assertion", () => {
  const analysisAssertion: Assertion = {
    id: "assertion-1",
    proposition: {
      subjectEntityId: "person-1",
      predicate: "owns",
      object: { kind: "value", value: "the key" },
    },
    modality: "negated",
    perspective: { kind: "character", entityId: "person-1" },
    status: "proposed",
    provenance: { kind: "analysis", extractor: "assertion-parser", extractorVersion: "1", sourceRevisionId: "r1", confidence: 0.72 },
  };
  const confirmed = confirmAssertion(analysisAssertion, "author-1");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.modality, "negated");
  assert.equal(confirmed.provenance.kind, "analysis");
  if (confirmed.provenance.kind === "analysis") assert.equal(confirmed.provenance.confidence, 0.72);

  const speculative = { ...analysisAssertion, id: "assertion-2", modality: "possible" as const };
  const confirmedSpeculation = confirmAssertion(speculative, "author-1");
  assert.equal(confirmedSpeculation.status, "confirmed");
  assert.equal(confirmedSpeculation.modality, "possible");
  assert.equal(speculative.status, "proposed", "confirmation returns a new assertion");
});

test("source revision changes rebase safe anchors and stale changed evidence until orphaned", () => {
  const proposedNode: KnowledgeNode = {
    ...authorNode("person-proposed", "Aki's shadow"),
    status: "proposed",
    provenance: { kind: "analysis", extractor: "ner", extractorVersion: "1", sourceRevisionId: "r1", confidence: 0.8 },
  };
  const proposedEdge: KnowledgeEdge = {
    id: "edge-proposed",
    sourceNodeId: "person-1",
    targetNodeId: proposedNode.id,
    type: "related-to",
    attributes: {},
    status: "proposed",
    provenance: { kind: "analysis", extractor: "relation-parser", extractorVersion: "1", sourceRevisionId: "r1", confidence: 0.7 },
  };
  let knowledge = emptyKnowledge([authorNode("person-1", "Aki"), proposedNode], [proposedEdge]);
  let graph = advanceSourceRevision({ graph: createEvidenceGraph("project-1"), revision: revision("r1", null, 12), changes: [] });
  const anchor = createTextAnchor({
    graph,
    id: "anchor-1",
    documentId: "doc-1",
    revisionId: "r1",
    fromUtf16: 5,
    toUtf16: 7,
    quoteHash: "quote-hash",
  });
  const assertion: Assertion = {
    id: "assertion-1",
    proposition: { subjectEntityId: "person-1", predicate: "knows", object: { kind: "value", value: "the name" } },
    modality: "asserted",
    perspective: { kind: "narrator" },
    status: "confirmed",
    provenance: { kind: "author", authorId: "author-1" },
    confirmedBy: "author-1",
  };
  const mention: Mention = {
    id: "mention-1",
    anchorId: anchor.id,
    sourceRevisionId: "r1",
    surface: "Aki",
    candidateNodeIds: ["person-1"],
    status: "confirmed",
    source: "author",
    resolvedNodeId: "person-1",
    confirmedBy: "author-1",
  };
  graph = {
    ...graph,
    anchors: [anchor],
    mentions: [mention],
    assertions: [assertion],
    evidence: [{
      id: "evidence-1",
      assertionId: assertion.id,
      anchorId: anchor.id,
      sourceRevisionId: "r1",
      role: "supports",
      status: "current",
      history: [{ revisionId: "r1", role: "supports" }],
    }],
  };
  validateEvidenceGraph(graph, knowledge);

  const advanced = advanceProjectSourceRevision({
    knowledge,
    graph,
    revision: revision("r2", "r1", 13),
    changes: [{ fromUtf16: 0, toUtf16: 0, insertedLengthUtf16: 1 }],
  });
  knowledge = advanced.knowledge;
  graph = advanced.evidence;
  assert.deepEqual([graph.anchors[0]?.fromUtf16, graph.anchors[0]?.toUtf16], [6, 8]);
  assert.equal(graph.anchors[0]?.status, "current");
  assert.equal(graph.mentions[0]?.sourceRevisionId, "r2");
  assert.equal(graph.evidence[0]?.sourceRevisionId, "r2");
  assert.equal(graph.assertions[0]?.status, "confirmed");
  assert.equal(knowledge.nodes.find((node) => node.id === proposedNode.id)?.status, "stale");
  assert.equal(knowledge.edges[0]?.status, "stale");

  graph = advanceSourceRevision({
    graph,
    revision: revision("r3", "r2", 13),
    changes: [{ fromUtf16: 6, toUtf16: 7, insertedLengthUtf16: 1 }],
  });
  assert.equal(graph.anchors[0]?.status, "needs_review");
  assert.equal(graph.mentions[0]?.status, "stale");
  assert.equal(graph.evidence[0]?.status, "stale");
  assert.equal(graph.assertions[0]?.status, "stale");

  graph = advanceSourceRevision({
    graph,
    revision: revision("r4", "r3", 11),
    changes: [{ fromUtf16: 6, toUtf16: 8, insertedLengthUtf16: 0 }],
  });
  assert.equal(graph.anchors[0]?.status, "orphaned");
  assert.equal(graph.mentions[0]?.status, "orphaned");
  assert.equal(graph.evidence[0]?.status, "orphaned");
  assert.throws(() => advanceSourceRevision({
    graph,
    revision: revision("stale-worker", "r1", 12),
    changes: [],
  }), /current head/);
  assert.equal(findIncomingReferences(buildReferenceIndex(knowledge, graph), "document", "doc-1").length, 5);
});

test("reverse index does not infer assertions from mentions and confirms only selected candidates", () => {
  const nodeA = authorNode("person-a", "Mika");
  const nodeB = authorNode("person-b", "Mika");
  const knowledge = emptyKnowledge([nodeA, nodeB]);
  let graph = advanceSourceRevision({ graph: createEvidenceGraph("project-1"), revision: revision("r1", null, 4), changes: [] });
  const anchor = createTextAnchor({ graph, id: "anchor-1", documentId: "doc-1", revisionId: "r1", fromUtf16: 0, toUtf16: 4, quoteHash: "hash" });
  const candidate = findMentionCandidates(buildMentionDictionary([nodeA, nodeB]), "Mika")[0]!;
  const mention = createMentionFromCandidate({ id: "mention-1", anchorId: anchor.id, sourceRevisionId: "r1", candidate });
  graph = { ...graph, anchors: [anchor], mentions: [mention] };
  const index = buildReferenceIndex(knowledge, graph);
  assert.deepEqual(findReferencesToNode(index, nodeA.id).map(reference => reference.source.kind), ["mention"]);
  assert.throws(() => confirmMention(mention, "person-c", "author-1"), /not a candidate/);
});

test("graph validation and confirmation reject invalid provenance, status, and scope", () => {
  const analysisNode: KnowledgeNode = {
    ...authorNode("person-proposed", "Ari"),
    status: "canonical",
    provenance: { kind: "analysis", extractor: "ner", extractorVersion: "1", sourceRevisionId: "r1", confidence: 0.8 },
  };
  assert.throws(() => validateKnowledgeGraph(emptyKnowledge([analysisNode])), /author confirmation/);
  const knowledge = emptyKnowledge([authorNode("one", "One"), authorNode("two", "Two")]);
  assert.throws(() => confirmAssertion({
    id: "assertion-1",
    proposition: { subjectEntityId: "one", predicate: "is", object: { kind: "value", value: true } },
    modality: "hypothetical",
    perspective: { kind: "unknown" },
    status: "confirmed",
    provenance: { kind: "author", authorId: "author-1" },
  }, "author-1"), /not a proposal/);
  assert.throws(() => buildReferenceIndex(knowledge, createEvidenceGraph("other-project")), /same project/);
  assert.throws(() => confirmMention({
    id: "mention-1", anchorId: "anchor", sourceRevisionId: "r1", surface: "One", candidateNodeIds: ["one"], status: "candidate", source: "lexical",
  }, "one", ""), /Author id/);
});
