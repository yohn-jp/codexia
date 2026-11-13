import { buildSceneLocationInfos } from "./graph.js";
import { listRuleStateEvents, type SceneStateEvent } from "./worldState.js";
import type { LoadedStorySnapshot } from "../snapshot.js";

export interface WorldTime { earliest: number; latest: number }
export interface TemporalEvidence { sceneId: string; path: string; revision: string | null }
export interface TemporalFact {
  subject: string; predicate: string; value: string | null;
  sceneId: string; narrativeOrder: number; time: WorldTime | null;
  evidence: TemporalEvidence; eventId?: string;
}
export interface TemporalCell {
  subject: string; predicate: string; status: "confirmed" | "conflict" | "unknown";
  facts: TemporalFact[];
}

export function parseWorldTime(value: unknown): WorldTime | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("world_time must be null or a day range");
  const raw = value as Record<string, unknown>;
  const { earliest, latest } = raw;
  if (Object.keys(raw).length !== 2 || typeof earliest !== "number" || typeof latest !== "number" ||
      !Number.isSafeInteger(earliest) || !Number.isSafeInteger(latest) || earliest > latest) {
    throw new TypeError("world_time requires ordered integer earliest/latest days");
  }
  return { earliest, latest };
}

function sceneSource(story: LoadedStorySnapshot, sceneId: string): TemporalEvidence {
  const scene = story.entities.get(sceneId);
  if (!scene || scene.type !== "scene") throw new TypeError("Unknown scene: " + sceneId);
  return { sceneId, path: scene.filePath, revision: story.revisions.get(scene.filePath) ?? null };
}

function validConfirmed(event: SceneStateEvent): boolean {
  return event.source === "manual" && (event.status === undefined || event.status === "confirmed");
}

function valueOf(event: SceneStateEvent): string | null {
  return typeof event.payload.value === "string" && event.kind === "attribute"
    ? event.payload.value : event.object;
}

function predicateOf(event: SceneStateEvent): string {
  return event.kind === "attribute" && typeof event.payload.predicate === "string"
    ? event.payload.predicate : event.kind;
}

export function temporalScene(story: LoadedStorySnapshot, sceneId: string, hypotheses: readonly SceneStateEvent[] = []) {
  const infos = buildSceneLocationInfos(story).data;
  const info = infos.find(row => row.sceneId === sceneId);
  if (!info) throw new TypeError("Scene has no narrative position: " + sceneId);
  const byScene = new Map(infos.map(row => [row.sceneId, row]));
  const scene = story.entities.get(sceneId)!;
  const targetTime = parseWorldTime(scene.raw.world_time);
  const facts: TemporalFact[] = [];
  const unresolved: TemporalFact[] = [];
  const candidates: TemporalFact[] = [];
  const beliefs: TemporalFact[] = [];
  const disclosed: TemporalFact[] = [];
  const events = [...listRuleStateEvents(story).data, ...hypotheses];
  const replacements = new Set(events.filter(event => {
    if (!validConfirmed(event)) return false;
    const position = byScene.get(event.sceneId);
    const eventScene = story.entities.get(event.sceneId);
    if (!position || !eventScene) return false;
    if (event.payload.layer === "reader-knowledge") return position.order <= info.order;
    const time = parseWorldTime(eventScene.raw.world_time);
    return event.sceneId === sceneId || (targetTime !== null && time !== null && time.latest < targetTime.earliest);
  }).map(event => event.replacesEventId).filter((id): id is string => typeof id === "string"));
  for (const event of events) {
    const position = byScene.get(event.sceneId);
    if (!position || (event.eventId && replacements.has(event.eventId))) continue;
    const sourceScene = story.entities.get(event.sceneId)!;
    const time = parseWorldTime(sourceScene.raw.world_time);
    const fact: TemporalFact = {
      subject: event.subject, predicate: predicateOf(event), value: valueOf(event),
      sceneId: event.sceneId, narrativeOrder: position.order, time,
      evidence: sceneSource(story, event.sceneId),
      ...(event.eventId ? { eventId: event.eventId } : {}),
    };
    // No lexical mention or generated event can establish objective truth or awareness.
    if (!validConfirmed(event)) { if (event.sceneId === sceneId) candidates.push(fact); continue; }
    const layer = event.payload.layer;
    if (layer === "reader-knowledge") {
      if (position.order <= info.order) disclosed.push(fact);
      continue;
    }
    const isBelief = event.kind === "knowledge" || layer === "character-belief";
    const sameExactDay = targetTime !== null && time !== null && targetTime.earliest === targetTime.latest && time.earliest === time.latest && time.latest === targetTime.latest;
    const before = event.sceneId === sceneId || (targetTime !== null && time !== null && time.latest < targetTime.earliest) || (!isBelief && sameExactDay);
    if (!before) {
      if (targetTime === null || time === null || time.earliest <= targetTime.latest) unresolved.push(fact);
      continue;
    }
    if (isBelief) {
      if (story.entities.get(event.subject)?.type === "character") beliefs.push(fact);
      continue;
    }
    if (layer !== undefined && layer !== "objective") continue;
    if (event.kind === "ownership" && event.payload.action === "use_item") continue;
    facts.push(fact);
  }
  const groups = new Map<string, TemporalFact[]>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.subject, fact.predicate]);
    const list = groups.get(key) ?? [];
    list.push(fact); groups.set(key, list);
  }
  const state: TemporalCell[] = [];
  for (const list of groups.values()) {
    // Partial-order maximal facts: overlapping intervals are not silently ordered.
    const maximal = list.filter(fact => !list.some(other => other !== fact &&
      ((other.sceneId === sceneId && fact.sceneId !== sceneId && fact.time === null) ||
       (fact.time !== null && other.time !== null && fact.time.latest < other.time.earliest))));
    const values = new Set(maximal.map(fact => fact.value));
    state.push({ subject: list[0]!.subject, predicate: list[0]!.predicate,
      status: values.size > 1 ? "conflict" : "confirmed", facts: maximal });
  }
  for (const fact of unresolved) {
    if (fact.predicate === "knowledge") continue;
    const cell = state.find(item => item.subject === fact.subject && item.predicate === fact.predicate);
    if (cell && cell.status !== "conflict") cell.status = "unknown";
    else if (!cell) state.push({subject: fact.subject, predicate: fact.predicate, status: "unknown", facts: []});
  }
  return { sceneId, narrativeOrder: info.order, worldTime: targetTime, state, history: facts, beliefs, disclosed, unresolved, candidates,
    source: sceneSource(story, sceneId) };
}

export type ContextScope = "author" | "character" | "reader";
export function sceneContextPackage(story: LoadedStorySnapshot, sceneId: string, scope: ContextScope, characterId: string | undefined, budget: number, nativeParts: Array<{kind:string;value:unknown}> = [], nativeOmissions: Array<{reason:string}> = []) {
  if (!["author", "character", "reader"].includes(scope)) throw new TypeError("Invalid context scope");
  if (!Number.isSafeInteger(budget) || budget < 128 || budget > 200000) throw new TypeError("Invalid context budget");
  if (scope === "character" && (!characterId || story.entities.get(characterId)?.type !== "character")) throw new TypeError("Character scope requires a valid character");
  const temporal = temporalScene(story, sceneId);
  const scene = story.entities.get(sceneId)!;
  const parts: Array<{ kind: string; value: unknown }> = [];
  const perspectiveLinks=story.links.filter(link=>link.from===sceneId&&link.kind==="pov").map(link=>({characterId:link.to}));
  const threadLinks=story.links.filter(link=>link.from===sceneId&&["plants","advances","payoff"].includes(link.kind))
    .map(link=>({threadId:link.to,relation:link.kind,revision:story.revisions.get(story.entities.get(link.to)?.filePath??"")??null}));
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
