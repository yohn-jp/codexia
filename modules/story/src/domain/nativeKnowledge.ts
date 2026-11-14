import type { SnapshotReader } from "@codexia/contracts";
import type { LoadedStorySnapshot } from "../snapshot.js";

export const NATIVE_KNOWLEDGE_PATH = "meta/scriptorium/knowledge-context/v1.json";
type Row = Record<string,unknown>;
function row(value:unknown):Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Knowledge projection");
  return value as Row;
}
function rows(value:unknown):Row[] {
  if(!Array.isArray(value)) throw new TypeError("Invalid Knowledge projection collection");
  return value.map(row);
}
// Old immutable v1 projections used the same bounds before explicit markers.
function reached(entry:Row, marker:string, collection:string, cap:number):boolean {
  return entry[marker]===true || (entry[marker]===undefined && Array.isArray(entry[collection]) && entry[collection].length>=cap);
}
function entryLimits(entry:Row):string[] {
  return [
    ...(reached(entry,"aliasLimitReached","aliases",500)?["alias-inventory-limit"]:[]),
    ...(reached(entry,"relationLimitReached","relations",500)?["relation-inventory-limit"]:[]),
    ...(reached(entry,"evidenceLimitReached","evidence",100)?["mention-inventory-limit"]:[]),
    ...(rows(entry.evidence).some(item=>reached(item,"assertionLimitReached","assertions",100))?["assertion-inventory-limit"]:[]),
  ];
}
export async function nativeKnowledge(reader:SnapshotReader,story:LoadedStorySnapshot,sceneId?:string) {
  const file=await reader.read(NATIVE_KNOWLEDGE_PATH);
  if(!file) return {available:false,links:[],parts:[],truncated:false,omissions:[]};
  const raw=row(JSON.parse(file.content));
  if(raw.version!==1 || raw.projectId!==reader.snapshot.projectId)throw new TypeError("Knowledge projection scope mismatch");
  const entries=rows(raw.entries);
  const confirmed=entries.filter(entry=>row(entry.node).status==="confirmed");
  const confirmedIds=new Set(confirmed.map(entry=>row(entry.node).id));
  const scene=sceneId?story.entities.get(sceneId):undefined;
  if(sceneId&&scene?.type!=="scene")throw new TypeError("Scene not found");
  const related=new Set<string>(sceneId?[sceneId,...story.links.filter(link=>link.from===sceneId).map(link=>link.to)]:[]);
  const documentMappings=rows(raw.documentMappings??[]);
  const links=entries.map(entry=>{
    const node=row(entry.node);
    const explicit=[...story.entities.values()].filter(entity=>entity.raw.knowledge_id===node.id);
    const attribute=row(node.attributes).storyEntityId;
    if(typeof attribute==="string"&&story.entities.has(attribute)&&!explicit.some(entity=>entity.id===attribute))explicit.push(story.entities.get(attribute)!);
    const matches=explicit.map(entity=>entity.id).sort();
    return {knowledgeId:node.id,name:node.name,status:node.status,storyEntityIds:matches,
      mapping:matches.length===1?"explicit":matches.length>1?"ambiguous":"unmapped"};
  });
  const contextEntries=entries.filter(entry=>["confirmed","proposed"].includes(String(row(entry.node).status)));
  const parts=contextEntries.flatMap(entry=>{
    const node=row(entry.node);
    const link=links.find(link=>link.knowledgeId===node.id)!;
    const evidence=rows(entry.evidence).filter(item=>["confirmed","proposed","ambiguous"].includes(String(row(item.mention).status))&&["proposed","confirmed","needs_review","orphaned"].includes(String(row(item.anchor).status)));
    const directEvidence=evidence.some(item=>item.storySceneId===sceneId&&documentMappings.some(mapping=>mapping.mapping==="explicit"&&mapping.storySceneId===sceneId&&mapping.documentId===item.sourceDocumentId));
    if(sceneId&&!directEvidence&&!(link.mapping==="explicit"&&link.storyEntityIds.some(id=>related.has(id))))return [];
    return [{kind:"native-knowledge",value:{knowledgeId:node.id,name:node.name,type:node.type,status:node.status==="confirmed"?"confirmed":"candidate",mapping:link,
      aliases:rows(entry.aliases).filter(alias=>alias.status==="confirmed"),
      relations:rows(entry.relations).filter(relation=>relation.status==="confirmed"&&confirmedIds.has(relation.sourceId)&&confirmedIds.has(relation.targetId)),
      evidence:evidence.map(item=>({anchor:item.anchor,mention:item.mention,assertions:rows(item.assertions).filter(link=>row(link.assertion).status==="confirmed"),
        storySceneId:item.storySceneId??null,sourceDocumentId:item.sourceDocumentId??row(item.anchor).documentId,
        sourceRevisionId:item.sourceRevisionId??row(item.anchor).revisionId,quote:item.quoteAvailable===true&&typeof item.quote==="string"?item.quote:null,
        status:item.stale===true||item.current===false||row(item.anchor).status==="orphaned"?"stale":item.current===true&&node.status==="confirmed"&&row(item.mention).status==="confirmed"&&row(item.anchor).status==="confirmed"?"confirmed":"candidate"})),
      evidenceLimitReached:reached(entry,"evidenceLimitReached","evidence",100),source:{path:NATIVE_KNOWLEDGE_PATH,revision:file.revision}}}];
  });
  const includedIds=new Set<string>(parts.map(part=>String((part.value as {knowledgeId:unknown}).knowledgeId)));
  const omissions=entries.filter(entry=>{const id=row(entry.node).id;return typeof id==="string"&&includedIds.has(id);}).flatMap(entry=>{
    const node=row(entry.node);
    return rows(entry.evidence).filter(item=>item.quoteAvailable!==true&&["confirmed","proposed","ambiguous"].includes(String(row(item.mention).status)))
      .map(item=>({knowledgeId:node.id,reason:item.quoteOmission==="projection-budget"?"source-quote-budget":"source-quote-unavailable"}));
  });
  const limitReasons = new Set(entries.flatMap(entryLimits));
  if(raw.nodeLimitReached===true || (raw.nodeLimitReached===undefined && entries.length>=1000)) limitReasons.add("node-inventory-limit");
  return {available:true,links,parts,truncated:limitReasons.size>0,omissions:[...omissions,...[...limitReasons].sort().map(reason=>({knowledgeId:null,reason}))]};
}
