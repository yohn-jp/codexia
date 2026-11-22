import type { LoadedStorySnapshot } from "../snapshot.js";
import { temporalScene } from "./temporal.js";

export type ContextScope = "author" | "character" | "reader";
type ThreadContextMeaning = "planted" | "advanced" | "payoff";

function sceneThreadContextLinks(story: LoadedStorySnapshot, sceneId: string) {
  const byRelation = new Map<string, {
    threadId: string;
    relation: string;
    meaning: ThreadContextMeaning;
    revision: string | null;
    priority: number;
  }>();
  const scene = story.entities.get(sceneId);
  if (scene?.type !== "scene") return [];

  for (const link of story.links) {
    let threadId: string;
    let relation: string;
    let meaning: ThreadContextMeaning;
    let sourcePath: string;
    let priority: number;
    if (link.to === sceneId && (link.kind === "planted" || link.kind === "payoff")) {
      const thread = story.entities.get(link.from);
      if (thread?.type !== "thread") continue;
      threadId = thread.id;
      relation = link.kind;
      meaning = link.kind;
      sourcePath = thread.filePath;
      priority = 0;
    } else if (link.from === sceneId && (link.kind === "plants" || link.kind === "advances" || link.kind === "payoff")) {
      const thread = story.entities.get(link.to);
      if (thread?.type !== "thread") continue;
      threadId = thread.id;
      relation = link.kind;
      meaning = link.kind === "plants" ? "planted" : link.kind === "advances" ? "advanced" : "payoff";
      sourcePath = scene.filePath;
      priority = 1;
    } else {
      continue;
    }

    const key = JSON.stringify([sceneId, threadId, meaning]);
    const existing = byRelation.get(key);
    if (existing && existing.priority <= priority) continue;
    byRelation.set(key, {
      threadId,
      relation,
      meaning,
      revision: story.revisions.get(sourcePath) ?? null,
      priority,
    });
  }
  return [...byRelation.values()].map(({ priority: _priority, ...link }) => link);
}

export function sceneContextPackage(story: LoadedStorySnapshot, sceneId: string, scope: ContextScope, characterId: string | undefined, budget: number, nativeParts: Array<{kind:string;value:unknown}> = [], nativeOmissions: Array<{reason:string}> = []) {
  if (!["author", "character", "reader"].includes(scope)) throw new TypeError("Invalid context scope");
  if (!Number.isSafeInteger(budget) || budget < 128 || budget > 200000) throw new TypeError("Invalid context budget");
  if (scope === "character" && (!characterId || story.entities.get(characterId)?.type !== "character")) throw new TypeError("Character scope requires a valid character");
  const temporal = temporalScene(story, sceneId);
  const scene = story.entities.get(sceneId)!;
  const parts: Array<{ kind: string; value: unknown }> = [];
  const perspectiveLinks=story.links.filter(link=>link.from===sceneId&&link.kind==="pov").map(link=>({characterId:link.to}));
  const threadLinks = sceneThreadContextLinks(story, sceneId);
  const authorizedFacts=scope==="character"?temporal.beliefs.filter(fact=>fact.subject===characterId):scope==="reader"?temporal.disclosed:[];
  const acquiredIds=new Set(authorizedFacts.filter(fact=>fact.predicate==="knowledge"&&fact.value!==null).map(fact=>fact.value!));
  // Restricted scopes expose only author-confirmed knowledge, not whole entity notes or scene text.
  if (scope === "author") {
    const manuscript = typeof scene.raw.manuscript === "string" ? story.files.get(scene.raw.manuscript) : undefined;
    if (manuscript) parts.push({ kind: "manuscript", value: { path: manuscript.path, revision: manuscript.revision, text: manuscript.content } });
    parts.push(...nativeParts);
    for (const cell of temporal.state) parts.push({kind: "objective", value: cell});
    for (const fact of temporal.beliefs) parts.push({kind: "character-belief", value: fact});
    for (const fact of temporal.disclosed) parts.push({kind: "reader-disclosure", value: fact});
    for (const fact of temporal.candidates) parts.push({kind:"candidate-fact",value:fact});
    for (const fact of temporal.unresolved) parts.push({kind:"unresolved-fact",value:fact});
    parts.push({kind:"perspectives",value:perspectiveLinks});
    parts.push({kind:"threads",value:threadLinks});
  } else {
    for (const fact of authorizedFacts) parts.push({kind: scope === "character" ? "character-belief" : "reader-disclosure",
      value: {subject: fact.subject, predicate: fact.predicate, value: fact.value, sceneId: fact.sceneId, eventId: fact.eventId, evidence: fact.evidence}});
    for (const part of nativeParts) {
      const value=part.value as {knowledgeId?:unknown;name?:unknown;type?:unknown;status?:unknown};
      if(typeof value?.knowledgeId==="string"&&value.status==="confirmed"&&acquiredIds.has(value.knowledgeId))
        parts.push({kind:"acquired-knowledge",value:{knowledgeId:value.knowledgeId,acquiredAt:authorizedFacts.find(fact=>fact.value===value.knowledgeId)?.sceneId}});
    }
  }
  const included: Array<{index:number;part:(typeof parts)[number]}> = [];
  let used = 0;
  let omitted = 0;
  const omissions:Array<{kind:string;reason:string}> = [];
  const truncations:Array<{kind:string;reason:string}> = [];
  const prioritizedParts=parts.map((part,index)=>({part,index})).sort((a,b)=>Number(a.part.kind==="manuscript")-Number(b.part.kind==="manuscript")||a.index-b.index);
  for (const {part,index} of prioritizedParts) {
    // UTF-8 byte count is a conservative proxy, not a model tokenizer.
    let selected=part;
    let size = Buffer.byteLength(JSON.stringify(selected), "utf8");
    if (used + size > budget && part.kind==="manuscript") {
      const value=part.value as {text:string;path:string;revision:string};
      const chars=Array.from(value.text);let low=0,high=chars.length;
      while(low<high){const mid=Math.ceil((low+high)/2);const candidate={kind:part.kind,value:{...value,text:chars.slice(0,mid).join(""),truncated:true}};
        if(used+Buffer.byteLength(JSON.stringify(candidate),"utf8")<=budget)low=mid;else high=mid-1;}
      if(low>0){selected={kind:part.kind,value:{...value,text:chars.slice(0,low).join(""),truncated:true}};size=Buffer.byteLength(JSON.stringify(selected),"utf8");truncations.push({kind:"manuscript",reason:"utf8-byte-budget"});}
    }
    if (used + size > budget) { omitted++; omissions.push({kind:scope==="author"?part.kind:"scoped-context",reason:"budget"}); continue; }
    included.push({index,part:selected}); used += size;
  }
  if(scope==="author") omissions.push(...nativeOmissions.map(item=>({kind:"native-knowledge",reason:item.reason})));
  return { sceneId, scope, ...(scope === "character" ? { characterId } : {}), parts: included.sort((a,b)=>a.index-b.index).map(item=>item.part),
    budget, used, omitted, omissions, truncations, budgetUnit: "utf8-bytes", exclusions: scope === "author" ? [] : ["unconfirmed knowledge", "unscoped manuscript and author notes", "native Knowledge not explicitly acquired or disclosed", "author-only perspectives and threads"] };
}
