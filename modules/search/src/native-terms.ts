import { snapshotKey, type SnapshotReader } from "@codexia/contracts";
import type { ResolutionTerm, TermRegistry } from "./terminology.js";
import { normalizeTerm } from "./terminology.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export async function nativeTerms(reader: SnapshotReader, registry: TermRegistry) {
  const projection = reader.knowledge;
  if (!projection) return { terms: [] as ResolutionTerm[], revision: null, available: false, truncated: false };
  if (snapshotKey(projection.source.snapshot) !== snapshotKey(reader.snapshot)) throw new TypeError("Invalid native Knowledge snapshot");
  const terms: ResolutionTerm[] = [];
  const ids = new Set<string>();
  for (const entry of projection.entries) {
    const { node } = entry;
    if (!UUID.test(node.id) || ids.has(node.id)) throw new TypeError("Invalid native Knowledge entry");
    ids.add(node.id);
    if (node.status !== "confirmed" || node.deletedAt !== null) continue;
    if (!node.name.trim()) throw new TypeError("Invalid Knowledge name");
    const aliases = new Set<string>();
    const ambiguousAliases = new Set<string>();
    for (const alias of entry.aliases) {
      if (alias.nodeId !== node.id || !alias.surface.trim()) throw new TypeError("Invalid Knowledge alias");
      // A scoped alias cannot become a global navigation link without scope evaluation.
      if (alias.status === "confirmed" && alias.scope === null) aliases.add(alias.surface);
      else if (alias.status === "ambiguous" || (alias.status === "confirmed" && alias.scope !== null)) ambiguousAliases.add(alias.surface);
    }
    const reference = registry.knowledgeReferences?.find(ref => ref.knowledgeId === node.id);
    terms.push({ id: "knowledge-" + node.id, knowledgeId: node.id, canonical: node.name, aliases: [...aliases],
      ambiguousAliases: [...ambiguousAliases], targetPath: reference?.targetPath ?? "", candidateOnly: !reference || projection.nodeLimitReached });
  }
  const nodeTruncated = projection.nodeLimitReached;
  const aliasTruncated = projection.entries.some(entry => entry.aliasLimitReached);
  return { terms, revision: projection.source.revision, available: true, nodeTruncated, aliasTruncated, truncated: nodeTruncated || aliasTruncated };
}
export function combineTerms(registry:TermRegistry,native:Awaited<ReturnType<typeof nativeTerms>>):ResolutionTerm[]{
  // Distinct identities remain distinct even when their names are identical.
  const reserved=new Set(native.terms.map(term=>term.id));
  if(registry.terms.some(term=>reserved.has(term.id)))throw new TypeError("Reserved Knowledge terminology identifier");
  // If the native inventory is truncated, a missing node may share any alias. Fail closed for links.
  return [...registry.terms,...native.terms].map(term=>native.truncated?{...term,candidateOnly:true}:term);
}
export function searchableTerms(terms:readonly ResolutionTerm[]):ResolutionTerm[]{
  return terms.filter(term=>!term.candidateOnly&&term.targetPath).map(term=>{
    const blocked=new Set(term.ambiguousAliases?.map(normalizeTerm)??[]);
    return {...term,aliases:term.aliases.filter(alias=>!blocked.has(normalizeTerm(alias)))};
  });
}
