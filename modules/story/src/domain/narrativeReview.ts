import { createHash } from "node:crypto";
import type { FileRevision } from "@codexia/contracts";
import type { LoadedStorySnapshot } from "../snapshot.js";
import { analyzeThreadLifecycles } from "./threadLifecycle.js";
import { buildSceneLocationInfos, collectSceneTextInputs } from "./index.js";
import { temporalScene, type TemporalEvidence } from "./temporal.js";

export type NarrativeDisposition = "confirmed" | "rejected" | "held" | "exception";
export interface NarrativeFinding {
  id: string; rule: string; version: 1; severity: "warning" | "error";
  certainty: "rule" | "candidate"; sceneId?: string; targets: string[];
  message: string; evidence: FileRevision[];
}
export interface NarrativeDecision {
  id: string; status: NarrativeDisposition; reason: string; evidence: FileRevision[];
}
function uniqueReads(reads: readonly FileRevision[]): FileRevision[] {
  return [...new Map(reads.map(read=>[read.path,read])).values()].sort((a,b)=>a.path.localeCompare(b.path));
}
export function narrativeSourceFingerprint(story:LoadedStorySnapshot):string {
  return createHash("sha256").update(JSON.stringify([...story.revisions].filter(([path])=>!path.startsWith("meta/")).sort(([a],[b])=>a.localeCompare(b)))).digest("hex");
}
function entityEvidence(story:LoadedStorySnapshot,id:string):FileRevision[]{
  const entity=story.entities.get(id);
  if(!entity)return [];
  const paths=[entity.filePath,...(typeof entity.raw.manuscript==="string"?[entity.raw.manuscript]:[])];
  return paths.map(path=>({path,revision:story.revisions.get(path)??null}));
}
function finding(input:Omit<NarrativeFinding,"id"|"version">):NarrativeFinding{
  const evidence=uniqueReads(input.evidence);
  // Stable within the same relevant revisions; changing a cited source reopens the issue.
  const id=createHash("sha256").update(JSON.stringify([input.rule,input.sceneId??null,[...input.targets].sort(),evidence,input.message])).digest("hex");
  return {...input,evidence,id,version:1};
}
export function applyNarrativeDecisions(findings:readonly NarrativeFinding[],decisions:readonly NarrativeDecision[]){
  return findings.map(item=>{
    const decision=decisions.find(d=>d.id===item.id&&JSON.stringify(d.evidence)===JSON.stringify(item.evidence));
    return {...item,status:decision?.status??"open",reason:decision?.reason??null};
  });
}
export async function narrativeFindings(story:LoadedStorySnapshot,sceneId?:string):Promise<NarrativeFinding[]>{
  const result:NarrativeFinding[]=[];
  const scenes=buildSceneLocationInfos(story).data;
  if(sceneId&&!scenes.some(scene=>scene.sceneId===sceneId))throw new TypeError("Unknown narrative scene");
  for(const scene of scenes.filter(row=>!sceneId||row.sceneId===sceneId)){
    const entity=story.entities.get(scene.sceneId)!;
    const state=temporalScene(story,scene.sceneId);
    for(const cell of state.state){
      const evidence=cell.facts.flatMap(fact=>entityEvidence(story,fact.sceneId));
      if(cell.status==="conflict")result.push(finding({rule:"STATE_CONFLICT",severity:"error",certainty:"rule",sceneId:scene.sceneId,targets:[cell.subject],message:"Conflicting confirmed "+cell.predicate+" values",evidence:[...entityEvidence(story,scene.sceneId),...evidence]}));
      if(cell.predicate==="life"&&cell.status==="confirmed"&&cell.facts.length>0&&cell.facts.every(f=>["dead","deceased","死亡"].includes((f.value??"").toLowerCase()))&&scene.characterIds.includes(cell.subject)){
        // Explicitly labelled non-objective appearances and unknown chronology are not contradictions.
        const modes=entity.raw.appearance_modes;
        const mode=modes&&typeof modes==="object"&&!Array.isArray(modes)?(modes as Record<string,unknown>)[cell.subject]:undefined;
        if(mode===undefined||mode==="objective")result.push(finding({rule:"DEAD_CHARACTER_APPEARS",severity:"warning",certainty:"candidate",sceneId:scene.sceneId,targets:[cell.subject],message:"Character appears while confirmed world state is dead; check memory, deception, narration or resurrection",evidence:[...entityEvidence(story,scene.sceneId),...evidence]}));
      }
    }
    // Only author-declared information requirements; no lexical inference of knowledge.
    if(Array.isArray(entity.raw.knowledge_requirements))for(const requirement of entity.raw.knowledge_requirements){
      if(!requirement||typeof requirement!=="object"||Array.isArray(requirement))continue;
      const row=requirement as Record<string,unknown>;
      if(typeof row.characterId!=="string"||typeof row.knowledgeId!=="string"||row.mode!=="objective")continue;
      const characterId=row.characterId,knowledgeId=row.knowledgeId;
      if(!state.beliefs.some(f=>f.subject===characterId&&f.value===knowledgeId)){
        const sources=state.unresolved.filter(f=>f.subject===characterId).flatMap(f=>entityEvidence(story,f.sceneId));
        result.push(finding({rule:"KNOWLEDGE_NOT_ESTABLISHED",severity:"warning",certainty:"candidate",sceneId:scene.sceneId,targets:[characterId,knowledgeId],message:"Explicit information requirement has no confirmed prior character acquisition; absence is not proof of ignorance",evidence:[...entityEvidence(story,scene.sceneId),...entityEvidence(story,characterId),...entityEvidence(story,knowledgeId),...sources]}));
      }
    }
  }
  const lifecycle=await analyzeThreadLifecycles({...story,scenes:collectSceneTextInputs(story).data});
  for(const warning of lifecycle.data.warnings){
    const thread=lifecycle.data.snapshots.find(t=>t.threadId===warning.threadId);
    const ids=[thread?.plantedSceneId,thread?.resolvedSceneId,...(thread?.recalledSceneIds??[])].filter((id):id is string=>Boolean(id));
    if(sceneId&&!ids.includes(sceneId))continue;
    result.push(finding({rule:warning.code,severity:"warning",certainty:"candidate",sceneId:thread?.plantedSceneId,targets:[warning.threadId],message:warning.message,evidence:[...entityEvidence(story,warning.threadId),...ids.flatMap(id=>entityEvidence(story,id)),...scenes.flatMap(s=>entityEvidence(story,s.sceneId))]}));
  }
  return result;
}
