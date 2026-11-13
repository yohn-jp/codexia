import { createHash,randomUUID } from "node:crypto";
import type { JsonObject, KnowledgeNodeId, KnowledgeAliasId, PersistenceReader, PersistenceTransaction, ProjectId } from "@codexia/persistence-contracts";

function requireValue<T>(value:T|undefined,message:string):T {if(!value)throw new Error(message);return value;}
function containsId(value:unknown,id:string):boolean{
  if(value===id)return true;
  if(Array.isArray(value))return value.some(item=>containsId(item,id));
  return Boolean(value&&typeof value==="object"&&Object.values(value).some(item=>containsId(item,id)));
}
export async function planKnowledgeMerge(reader:PersistenceReader,projectId:ProjectId,sourceId:KnowledgeNodeId,targetId:KnowledgeNodeId){
  const project=requireValue(await reader.getProject(projectId),"Project not found");
  if(sourceId===targetId)throw new Error("Select two different nodes");
  const source=requireValue(await reader.getKnowledgeNode(projectId,sourceId),"Source Knowledge not found");
  const target=requireValue(await reader.getKnowledgeNode(projectId,targetId),"Target Knowledge not found");
  const sourceAliases=await reader.listKnowledgeAliases(projectId,sourceId);
  const targetAliases=await reader.listKnowledgeAliases(projectId,targetId);
  const sourceRelations=await reader.listKnowledgeRelations(projectId,sourceId);
  const targetRelations=await reader.listKnowledgeRelations(projectId,targetId);
  const sourceMentions=await reader.listNodeMentions(projectId,sourceId,500);
  const targetMentions=await reader.listNodeMentions(projectId,targetId,500);
  const allAssertions=await reader.listAssertions(projectId,1000);
  const assertions=allAssertions.filter(assertion=>containsId(assertion.proposition,sourceId)||containsId(assertion.narrativeTime,sourceId)||assertion.perspective===sourceId);
  const conflicts:string[]=[];
  if(source.deletedAt||target.deletedAt||source.status==="retired"||target.status!=="confirmed"||source.type!==target.type)conflicts.push("Source must be active and target must be confirmed with the same type");
  if(sourceMentions.length===500||targetMentions.length===500||allAssertions.length===1000)conflicts.push("Inventory exceeds safe complete merge bound");
  for(const [key,value] of Object.entries(source.attributes))if(key in target.attributes&&JSON.stringify(target.attributes[key])!==JSON.stringify(value))conflicts.push("Conflicting attribute: "+key);
  for(const mention of sourceMentions){
    const existing=targetMentions.find(link=>link.evidenceId===mention.evidenceId);
    if(existing&&existing.status!==mention.status)conflicts.push("Conflicting mention status: "+mention.evidenceId);
  }
  for(const assertion of assertions)if(assertion.proposition.nodeId!==sourceId||containsId(Object.fromEntries(Object.entries(assertion.proposition).filter(([key])=>key!=="nodeId")),sourceId)||containsId(assertion.narrativeTime,sourceId)||assertion.perspective===sourceId)conflicts.push("Unsupported assertion reference: "+assertion.id);
  const movedRelations=sourceRelations.filter(relation=>relation.status!=="retired"&&relation.status!=="rejected");
  for(const relation of movedRelations){
    const from=relation.sourceId===sourceId?targetId:relation.sourceId,to=relation.targetId===sourceId?targetId:relation.targetId;
    if(from===to)conflicts.push("Merge would create a self-relation: "+relation.id);
    if(targetRelations.some(other=>other.id!==relation.id&&other.status!=="retired"&&other.status!=="rejected"&&other.sourceId===from&&other.targetId===to&&other.type===relation.type))conflicts.push("Duplicate relation requires author resolution: "+relation.id);
  }
  const inventory={projectVersion:project.version,source,target,sourceAliases,targetAliases,sourceRelations,targetRelations,sourceMentions,targetMentions,assertions};
  return { ...inventory,conflicts,previewDigest:createHash("sha256").update(JSON.stringify(inventory)).digest("hex") };
}
export async function applyKnowledgeMerge(tx:PersistenceTransaction,projectId:ProjectId,sourceId:KnowledgeNodeId,targetId:KnowledgeNodeId,expectedProjectVersion:number,previewDigest:string,authorId:string){
  await tx.assertProjectVersion(projectId,expectedProjectVersion);
  const plan=await planKnowledgeMerge(tx,projectId,sourceId,targetId);
  if(plan.previewDigest!==previewDigest||plan.conflicts.length)throw new Error("Merge preview changed or has unresolved conflicts");
  const {source,target}=plan;
  const auditId=randomUUID();
  await tx.saveModuleRecord({projectId,moduleId:"core.knowledge-merge",key:auditId,value:JSON.parse(JSON.stringify({authorId,sourceId,targetId,plan})) as JsonObject,expectedVersion:null});
  const attributes={...source.attributes,...target.attributes};
  const updated=await tx.saveKnowledgeNode({projectId,id:targetId,type:target.type,name:target.name,attributes,status:"confirmed",expectedVersion:target.version});
  for(const alias of plan.sourceAliases)if(alias.status!=="retired"){
    const equivalent=plan.targetAliases.find(other=>other.normalized===alias.normalized&&other.scope===alias.scope&&other.status!=="retired");
    if(equivalent)await tx.saveKnowledgeAlias({...alias,status:"retired"});
    else await tx.saveKnowledgeAlias({...alias,nodeId:targetId});
  }
  if(source.name!==target.name&&!plan.targetAliases.some(alias=>alias.normalized===source.name.normalize("NFKC").toLocaleLowerCase("ja"))){
    await tx.saveKnowledgeAlias({projectId,id:randomUUID() as KnowledgeAliasId,nodeId:targetId,surface:source.name,normalized:source.name.normalize("NFKC").toLocaleLowerCase("ja"),scope:null,status:"proposed"});
  }
  for(const relation of plan.sourceRelations)if(relation.status!=="retired"&&relation.status!=="rejected"){
    await tx.saveKnowledgeRelation({...relation,sourceId:relation.sourceId===sourceId?targetId:relation.sourceId,targetId:relation.targetId===sourceId?targetId:relation.targetId,expectedVersion:relation.version});
  }
  for(const mention of plan.sourceMentions)if(!plan.targetMentions.some(link=>link.evidenceId===mention.evidenceId)){
    // Preserve the historical source link and the anchor's original identity and revision.
    await tx.saveMentionLink({...mention,nodeId:targetId,source:"author-merge"});
  }
  for(const assertion of plan.assertions)await tx.saveAssertion({...assertion,proposition:{...assertion.proposition,nodeId:targetId},expectedVersion:assertion.version});
  const retired=await tx.saveKnowledgeNode({projectId,id:sourceId,type:source.type,name:source.name,attributes:{...source.attributes,mergedInto:targetId,mergeAuditId:auditId},status:"retired",expectedVersion:source.version});
  return {target:updated,source:retired,auditId};
}
