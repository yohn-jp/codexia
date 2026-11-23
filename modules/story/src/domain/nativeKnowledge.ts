import { snapshotKey, type KnowledgeProjectionEntry, type SnapshotReader } from "@codexia/contracts";
import type { LoadedStorySnapshot } from "../snapshot.js";

function entryLimits(entry: KnowledgeProjectionEntry): string[] {
  return [
    ...(entry.aliasLimitReached ? ["alias-inventory-limit"] : []),
    ...(entry.relationLimitReached ? ["relation-inventory-limit"] : []),
    ...(entry.evidenceLimitReached ? ["mention-inventory-limit"] : []),
    ...(entry.evidence.some(item => item.assertionLimitReached) ? ["assertion-inventory-limit"] : []),
  ];
}

export async function nativeKnowledge(reader: SnapshotReader, story: LoadedStorySnapshot, sceneId?: string) {
  const projection = reader.knowledge;
  if (!projection) return { available: false, links: [], parts: [], truncated: false, omissions: [] };
  if (snapshotKey(projection.source.snapshot) !== snapshotKey(reader.snapshot)) throw new TypeError("Knowledge projection scope mismatch");
  const { entries, documentMappings, source } = projection;
  const confirmedIds = new Set(entries.filter(({ node }) => node.status === "confirmed").map(({ node }) => node.id));
  const scene = sceneId ? story.entities.get(sceneId) : undefined;
  if (sceneId && scene?.type !== "scene") throw new TypeError("Scene not found");
  const related = new Set(sceneId ? [sceneId, ...story.links.filter(link => link.from === sceneId).map(link => link.to)] : []);
  const links = entries.map(({ node }) => {
    const explicit = [...story.entities.values()].filter(entity => entity.raw.knowledge_id === node.id);
    const attribute = node.attributes.storyEntityId;
    if (typeof attribute === "string" && story.entities.has(attribute) && !explicit.some(entity => entity.id === attribute)) {
      explicit.push(story.entities.get(attribute)!);
    }
    const matches = explicit.map(entity => entity.id).sort();
    return { knowledgeId: node.id, name: node.name, status: node.status, storyEntityIds: matches,
      mapping: matches.length === 1 ? "explicit" : matches.length > 1 ? "ambiguous" : "unmapped" };
  });
  const parts = entries.flatMap((entry, index) => {
    const { node } = entry;
    if (node.status !== "confirmed" && node.status !== "proposed") return [];
    const link = links[index]!;
    const evidence = entry.evidence.filter(({ mention, anchor }) => ["confirmed", "proposed", "ambiguous"].includes(mention.status) &&
      ["proposed", "confirmed", "needs_review", "orphaned"].includes(anchor.status));
    const directEvidence = evidence.some(item => item.storySceneId === sceneId && documentMappings.some(mapping =>
      mapping.mapping === "explicit" && mapping.storySceneId === sceneId && mapping.documentId === item.anchor.documentId));
    if (sceneId && !directEvidence && !(link.mapping === "explicit" && link.storyEntityIds.some(id => related.has(id)))) return [];
    return [{ kind: "native-knowledge", value: {
      knowledgeId: node.id, name: node.name, type: node.type, status: node.status === "confirmed" ? "confirmed" : "candidate", mapping: link,
      aliases: entry.aliases.filter(alias => alias.status === "confirmed"),
      relations: entry.relations.filter(relation => relation.status === "confirmed" && confirmedIds.has(relation.sourceId) && confirmedIds.has(relation.targetId)),
      evidence: evidence.map(({ anchor, mention, assertions, storySceneId, quote, current }) => ({
        anchor, mention, assertions: assertions.filter(({ assertion }) => assertion.status === "confirmed"),
        storySceneId, sourceDocumentId: anchor.documentId, sourceRevisionId: anchor.revisionId, quote,
        status: !current || anchor.status === "orphaned" ? "stale" :
          node.status === "confirmed" && mention.status === "confirmed" && anchor.status === "confirmed" ? "confirmed" : "candidate",
      })),
      evidenceLimitReached: entry.evidenceLimitReached, source,
    } }];
  });
  const includedIds = new Set(parts.map(part => part.value.knowledgeId));
  const omissions = entries.filter(({ node }) => includedIds.has(node.id)).flatMap(({ node, evidence }) => evidence
    .filter(item => item.quote === null && ["confirmed", "proposed", "ambiguous"].includes(item.mention.status))
    .map(item => ({ knowledgeId: node.id, reason: item.quoteOmission === "projection-budget" ? "source-quote-budget" : "source-quote-unavailable" })));
  const limitReasons = new Set(entries.flatMap(entryLimits));
  if (projection.nodeLimitReached) limitReasons.add("node-inventory-limit");
  return { available: true, links, parts, truncated: limitReasons.size > 0, omissions: [...omissions, ...[...limitReasons].sort().map(reason => ({ knowledgeId: null, reason }))] };
}
