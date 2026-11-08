import assert from "node:assert/strict";
import test from "node:test";
import { confirmAssertion, mergeKnowledgeEntities, validateKnowledgeGraph, type Assertion, type KnowledgeEdge, type KnowledgeGraph, type KnowledgeNode } from "./knowledge/index.js";
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
  assert.equal(speculative.status, "proposed");
  assert.equal(speculative.modality, "possible");
});

test("explicit entity merge keeps history, relations and references without confirming mentions", () => {
  const personA = authorNode("person-a", "佐藤", ["さとう"]);
  const personB = authorNode("person-b", "佐藤", ["サトウ"]);
  const place = { ...authorNode("place-1", "図書館"), type: "location" };
  const edge: KnowledgeEdge = {
    id: "edge-1",
    sourceNodeId: personA.id,
    targetNodeId: place.id,
    type: "visits",
    attributes: { frequency: "often" },
    status: "canonical",
    provenance: { kind: "author", authorId: "author-1" },
  };
  const knowledge = emptyKnowledge([personA, personB, place], [edge]);
  validateKnowledgeGraph(knowledge);

  let evidence = advanceSourceRevision({
    graph: createEvidenceGraph("project-1"),
    revision: revision("r1", null, 10),
    changes: [],
  });
  const sourceAnchor = createTextAnchor({
    graph: evidence,
    id: "anchor-sato",
    documentId: "doc-1",
    revisionId: "r1",
    fromUtf16: 0,
    toUtf16: 2,
    quoteHash: "sato-hash",
  });
  evidence = {
    ...evidence,
    anchors: [sourceAnchor],
    assertions: [{
      id: "assertion-place",
      proposition: { subjectEntityId: personA.id, predicate: "visits", object: { kind: "entity", entityId: place.id } },
      modality: "possible",
      perspective: { kind: "character", entityId: personA.id },
      status: "proposed",
      provenance: { kind: "analysis", extractor: "parser", extractorVersion: "1", sourceRevisionId: "r1", confidence: 0.6 },
    }],
  };
  const dictionary = buildMentionDictionary([personA, personB]);
  const candidate = findMentionCandidates(dictionary, "佐藤が来た。")[0]!;
  const mention: Mention = createMentionFromCandidate({
    id: "mention-sato",
    anchorId: "anchor-sato",
    sourceRevisionId: "r1",
    candidate,
  });
  evidence = { ...evidence, mentions: [mention] };
  assert.equal(mention.status, "ambiguous");

  const result = mergeKnowledgeEntities({
    knowledge,
    evidence,
    fromNodeId: personA.id,
    intoNodeId: personB.id,
    authorId: "author-1",
  });
  const merged = result.knowledge.nodes.find((node) => node.id === personA.id)!;
  const survivor = result.knowledge.nodes.find((node) => node.id === personB.id)!;
  assert.equal(merged.status, "merged");
  assert.equal(merged.mergedIntoId, personB.id);
  assert.equal(merged.mergedBy, "author-1");
  assert.ok(survivor.aliases.includes("さとう"));
  assert.ok(survivor.aliases.includes("サトウ"));
  assert.equal(result.knowledge.edges[0]?.sourceNodeId, personB.id);
  assert.deepEqual(result.evidence.mentions[0]?.candidateNodeIds, [personB.id]);
  assert.equal(result.evidence.mentions[0]?.status, "candidate");
  assert.equal(result.evidence.mentions[0]?.resolvedNodeId, undefined);
  assert.equal(result.evidence.assertions[0]?.proposition.subjectEntityId, personB.id);
  assert.equal(result.evidence.assertions[0]?.modality, "possible");

  const index = buildReferenceIndex(result.knowledge, result.evidence);
  const references = findReferencesToNode(index, personB.id);
  assert.ok(references.some((reference) => reference.relation === "edge-source"));
  assert.ok(references.some((reference) => reference.relation === "mention"));
  assert.ok(references.some((reference) => reference.relation === "assertion-subject"));
  assert.equal(findReferencesToNode(index, personA.id).length, references.length);
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
  assert.equal(graph.assertions.length, 0);
  assert.equal(findReferencesToNode(index, nodeA.id)[0]?.source.kind, "mention");
  assert.throws(() => confirmMention(mention, "person-c", "author-1"), /not a candidate/);
});

test("analysis cannot directly mark a node canonical and entity merges require an author", () => {
  const analysisNode: KnowledgeNode = {
    ...authorNode("person-proposed", "Ari"),
    status: "canonical",
    provenance: { kind: "analysis", extractor: "ner", extractorVersion: "1", sourceRevisionId: "r1", confidence: 0.8 },
  };
  assert.throws(() => validateKnowledgeGraph(emptyKnowledge([analysisNode])), /author confirmation/);
  const knowledge = emptyKnowledge([authorNode("one", "One"), authorNode("two", "Two")]);
  const evidence = createEvidenceGraph("project-1");
  assert.throws(() => mergeKnowledgeEntities({ knowledge, evidence, fromNodeId: "one", intoNodeId: "two", authorId: "" }), /author/);
  assert.throws(() => mergeKnowledgeEntities({ knowledge, evidence, fromNodeId: "one", intoNodeId: "one", authorId: "author-1" }), /itself/);
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
