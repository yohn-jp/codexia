import type { SnapshotReader } from "@codexia/contracts";
import type { ResolutionTerm, TermRegistry } from "./terminology.js";
import { normalizeTerm } from "./terminology.js";

export const KNOWLEDGE_PATH = "meta/scriptorium/knowledge-context/v1.json";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
function row(value: unknown): Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value)) throw new TypeError("Invalid native Knowledge projection");
  return value as Record<string,unknown>;
}
export async function nativeTerms(reader:SnapshotReader, registry:TermRegistry) {
  const file=await reader.read(KNOWLEDGE_PATH);
  if(!file) return {terms:[] as ResolutionTerm[],revision:null,available:false,truncated:false};
  const data=row(JSON.parse(file.content));
  if(data.version!==1||data.projectId!==reader.snapshot.projectId||!Array.isArray(data.entries)||data.entries.length>1000) throw new TypeError("Invalid native Knowledge snapshot");
  const terms:ResolutionTerm[]=[];
  const ids=new Set<string>();
  for(const raw of data.entries) {
    const entry=row(raw),node=row(entry.node);
    if(typeof node.id!=="string"||!UUID.test(node.id)||ids.has(node.id)||!Array.isArray(entry.aliases))throw new TypeError("Invalid native Knowledge entry");
    ids.add(node.id);
    if(node.status!=="confirmed"||node.deletedAt!==null)continue;
    if(typeof node.name!=="string"||!node.name.trim())throw new TypeError("Invalid Knowledge name");
    const aliases=new Set<string>(),ambiguousAliases=new Set<string>();
    for(const rawAlias of entry.aliases){
      const alias=row(rawAlias);
      if(alias.nodeId!==node.id||typeof alias.surface!=="string"||!alias.surface.trim())throw new TypeError("Invalid Knowledge alias");
      // A scoped alias cannot become a global navigation link without scope evaluation.
      if(alias.status==="confirmed"&&alias.scope===null)aliases.add(alias.surface);
      else if(alias.status==="ambiguous"||alias.status==="confirmed"&&alias.scope!==null)ambiguousAliases.add(alias.surface);
    }
    const reference=registry.knowledgeReferences?.find(ref=>ref.knowledgeId===node.id);
    terms.push({id:"knowledge-"+node.id,knowledgeId:node.id,canonical:node.name,aliases:[...aliases],
      ambiguousAliases:[...ambiguousAliases],targetPath:reference?.targetPath??"",candidateOnly:!reference||data.nodeLimitReached===true});
  }
  const nodeTruncated=data.nodeLimitReached===true;
  // Legacy v1 snapshots predate the marker but used the same 500-row alias cap.
  const aliasTruncated=data.entries.some((raw:unknown)=>{
    const entry=row(raw);
    return entry.aliasLimitReached===true || (entry.aliasLimitReached===undefined && Array.isArray(entry.aliases) && entry.aliases.length>=500);
  });
  return {terms,revision:file.revision,available:true,nodeTruncated,aliasTruncated,truncated:nodeTruncated||aliasTruncated};
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
