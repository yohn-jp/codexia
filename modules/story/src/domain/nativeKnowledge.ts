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
export async function nativeKnowledge(reader:SnapshotReader,story:LoadedStorySnapshot,sceneId?:string) {
  const file=await reader.read(NATIVE_KNOWLEDGE_PATH);
  if(!file) return {available:false,links:[],parts:[],truncated:false};
  const raw=row(JSON.parse(file.content));
  if(raw.version!==1 || raw.projectId!==reader.snapshot.projectId)throw new TypeError("Knowledge projection scope mismatch");
  const entries=rows(raw.entries);
  const confirmed=entries.filter(entry=>row(entry.node).status==="confirmed");
  const confirmedIds=new Set(confirmed.map(entry=>row(entry.node).id));
  const scene=sceneId?story.entities.get(sceneId):undefined;
  if(sceneId&&scene?.type!=="scene")throw new TypeError("Scene not found");
  const related=new Set<string>(sceneId?[sceneId,...story.links.filter(link=>link.from===sceneId).map(link=>link.to)]:[]);
  const links=entries.map(entry=>{
    const node=row(entry.node);
    const explicit=[...story.entities.values()].filter(entity=>entity.raw.knowledge_id===node.id);
    const attribute=row(node.attributes).storyEntityId;
    if(typeof attribute==="string"&&story.entities.has(attribute)&&!explicit.some(entity=>entity.id===attribute))explicit.push(story.entities.get(attribute)!);
    const matches=explicit.map(entity=>entity.id).sort();
    return {knowledgeId:node.id,name:node.name,status:node.status,storyEntityIds:matches,
      mapping:matches.length===1?"explicit":matches.length>1?"ambiguous":"unmapped"};
  });
  const parts=confirmed.flatMap(entry=>{
    const node=row(entry.node);
    const link=links.find(link=>link.knowledgeId===node.id)!;
    const evidence=rows(entry.evidence).filter(item=>item.current===true&&row(item.mention).status==="confirmed"&&row(item.anchor).status==="confirmed");
    const directEvidence=evidence.some(item=>row(item.anchor).documentId===sceneId);
    if(sceneId&&!directEvidence&&!(link.mapping==="explicit"&&link.storyEntityIds.some(id=>related.has(id))))return [];
    return [{kind:"native-knowledge",value:{knowledgeId:node.id,name:node.name,type:node.type,mapping:link,
      aliases:rows(entry.aliases).filter(alias=>alias.status==="confirmed"),
      relations:rows(entry.relations).filter(relation=>relation.status==="confirmed"&&confirmedIds.has(relation.sourceId)&&confirmedIds.has(relation.targetId)),
      evidence:evidence.map(item=>({anchor:item.anchor,mention:item.mention,assertions:rows(item.assertions).filter(link=>row(link.assertion).status==="confirmed")})),
      evidenceLimitReached:entry.evidenceLimitReached===true,source:{path:NATIVE_KNOWLEDGE_PATH,revision:file.revision}}}];
  });
  return {available:true,links,parts,truncated:raw.nodeLimitReached===true||entries.some(entry=>entry.evidenceLimitReached===true)};
}
