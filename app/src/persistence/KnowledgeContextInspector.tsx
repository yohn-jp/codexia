import { useEffect, useState } from "react";
import type { Assertion, KnowledgeAlias, KnowledgeAliasId, KnowledgeNode, KnowledgeRelation, KnowledgeRelationId } from "@codexia/persistence-contracts";
import { api, type PersistenceAnchorView, type PersistenceNodeRead } from "../api";

type Modality = "fact" | "belief" | "disclosure" | "hypothesis";
export function KnowledgeContextInspector({node,nodes,documentId,revisionId,clean,selectedEvidenceId,evidenceLoadKey,onOpenEvidence,onMerge,onNodeUpdate}: {
  node: KnowledgeNode; nodes: KnowledgeNode[]; documentId?: string; revisionId?: string; clean: boolean;
  selectedEvidenceId: string; evidenceLoadKey: number; onOpenEvidence: (item: PersistenceAnchorView) => void; onMerge:(target:KnowledgeNode,source:KnowledgeNode)=>void; onNodeUpdate:(node:KnowledgeNode)=>void;
}) {
  const projectId=node.projectId;
  const [detail,setDetail]=useState<PersistenceNodeRead|null>(null);
  const [anchors,setAnchors]=useState<PersistenceAnchorView[]>([]);
  const [linked,setLinked]=useState<PersistenceAnchorView[]>([]);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [reload,setReload]=useState(0);
  const [mergeTarget,setMergeTarget]=useState("");
  const [mergePreview,setMergePreview]=useState<Awaited<ReturnType<typeof api.previewPersistenceMerge>>|null>(null);
  const [mergeConfirm,setMergeConfirm]=useState(false);
  const [storyEntityId,setStoryEntityId]=useState(String(node.attributes.storyEntityId??""));
  const [surface,setSurface]=useState("");
  const [target,setTarget]=useState("");
  const [relationType,setRelationType]=useState("");
  const [statement,setStatement]=useState("");
  const [modality,setModality]=useState<Modality>("fact");
  const [perspective,setPerspective]=useState("author");
  useEffect(()=>{
    const abort=new AbortController();
    setDetail(null);setAnchors([]);setLinked([]);setError("");
    void Promise.all([api.persistenceNode(projectId,node.id,abort.signal),
      api.persistenceNodeEvidence(projectId,node.id,500,abort.signal),
      documentId&&revisionId?api.persistenceDocumentAnchors(projectId,documentId,revisionId,abort.signal):Promise.resolve(null)
    ]).then(([data,evidence,doc])=>{if(!abort.signal.aborted){setDetail(data);setLinked(evidence.evidence);setAnchors(doc?.anchors??[]);}})
      .catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:"Knowledgeを取得できませんでした。");});
    return ()=>abort.abort();
  },[projectId,node.id,node.version,documentId,revisionId,evidenceLoadKey,reload]);
  const mutate=async(action:()=>Promise<unknown>)=>{
    if(busy)return;setBusy(true);setError("");
    try{await action();setReload(n=>n+1)}catch(e){setError(e instanceof Error?e.message:"保存できませんでした。")}finally{setBusy(false)}
  };
  const aliasSave=(alias:KnowledgeAlias,status:KnowledgeAlias["status"])=>mutate(()=>api.savePersistenceAlias(projectId,node.id,{id:alias.id,surface:alias.surface,normalized:alias.normalized,scope:alias.scope,status}));
  const relationSave=(relation:KnowledgeRelation,status:KnowledgeRelation["status"])=>mutate(()=>api.savePersistenceRelation(projectId,relation.sourceId,{id:relation.id,targetId:relation.targetId,type:relation.type,attributes:relation.attributes,validity:relation.validity,status,expectedVersion:relation.version}));
  const assertionSave=(assertion:Assertion,status:Assertion["status"])=>mutate(()=>api.savePersistenceAssertion(projectId,assertion.id,{proposition:assertion.proposition,modality:assertion.modality,perspective:assertion.perspective,narrativeTime:assertion.narrativeTime,confidence:assertion.confidence,status,expectedVersion:assertion.version}));
  const current=anchors.find(item=>item.anchor.id===selectedEvidenceId&&item.anchor.revisionId===revisionId&&item.anchor.status==="confirmed"&&item.mentions.some(({link})=>link.nodeId===node.id&&link.status!=="rejected"));
  const evidence=new Map<string,PersistenceAnchorView>();
  for(const item of [...linked,...anchors])evidence.set(item.anchor.id,item);
  const assertions=new Map<string,{assertion:Assertion;item:PersistenceAnchorView}>();
  for(const item of evidence.values())for(const link of item.assertions){
    if(link.assertion?.proposition.nodeId===node.id)assertions.set(link.assertion.id,{assertion:link.assertion,item});
  }
  const canEdit=node.status!=="retired"&&!node.deletedAt;
  return <section aria-label="Knowledge詳細">
    <h3>{node.name}の設定・関係</h3>
    {error&&<p role="alert">{error}</p>}
    {!detail&&!error&&<p role="status">詳細を読み込んでいます。</p>}
    {detail&&<>
      <h4>Storyとの明示的な関連付け</h4>
      <label>Story entity ID<input value={storyEntityId} onChange={e=>setStoryEntityId(e.target.value)}/></label>
      <button type="button" disabled={busy||!canEdit} onClick={()=>void mutate(async()=>{const result=await api.savePersistenceNode(projectId,node.id,{type:node.type,name:node.name,attributes:{...node.attributes,storyEntityId:storyEntityId.trim()||null},status:node.status,expectedVersion:node.version});onNodeUpdate(result.node)})}>関連付けを保存</button>
      <h4>Knowledge統合</h4>
      <label>統合先<select value={mergeTarget} onChange={e=>{setMergeTarget(e.target.value);setMergePreview(null);setMergeConfirm(false)}}><option value="">選択</option>{nodes.filter(n=>n.id!==node.id&&n.type===node.type&&n.status==="confirmed"&&!n.deletedAt).map(n=><option key={n.id} value={n.id}>{n.name} ({n.id})</option>)}</select></label>
      <button type="button" disabled={busy||!canEdit||!mergeTarget} onClick={()=>void mutate(async()=>{setMergeConfirm(false);setMergePreview(await api.previewPersistenceMerge(projectId,node.id,mergeTarget))})}>統合内容を確認</button>
      {mergePreview&&<div><p>{mergePreview.source.name} → {mergePreview.target.name}</p><p>別名 {mergePreview.sourceAliases.length}・関係 {mergePreview.sourceRelations.length}・根拠 {mergePreview.sourceMentions.length}・命題 {mergePreview.assertions.length}</p>
      <ul>{mergePreview.conflicts.map(conflict=><li key={conflict}>{conflict}</li>)}</ul><details><summary>統合対象</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(mergePreview,null,2)}</pre></details>
      <label><input type="checkbox" checked={mergeConfirm} onChange={e=>setMergeConfirm(e.target.checked)}/>統合元を退役し、参照を統合先に移すことを確認しました。</label>
      <button type="button" disabled={busy||!mergeConfirm||mergePreview.conflicts.length>0} onClick={()=>void mutate(async()=>{const result=await api.applyPersistenceMerge(projectId,node.id,mergeTarget,mergePreview.projectVersion,mergePreview.previewDigest);onMerge(result.target,result.source);setMergePreview(null)})}>作者承認で統合</button></div>}
      <h4>別名</h4>
      <ul>{detail.aliases.map(alias=><li key={alias.id}>{alias.surface} · {alias.status}
        {alias.status!=="confirmed"&&alias.status!=="retired"&&<button type="button" disabled={busy||!canEdit} onClick={()=>void aliasSave(alias,"confirmed")}>別名を確定</button>}
        {alias.status!=="retired"&&<><button type="button" disabled={busy||!canEdit} onClick={()=>void aliasSave(alias,"ambiguous")}>曖昧にする</button><button type="button" disabled={busy||!canEdit} onClick={()=>void aliasSave(alias,"retired")}>別名を退役</button></>}
      </li>)}</ul>
      <form onSubmit={e=>{e.preventDefault();void mutate(async()=>{await api.savePersistenceAlias(projectId,node.id,{id:crypto.randomUUID() as KnowledgeAliasId,surface:surface.trim(),normalized:surface.trim().normalize("NFKC").toLocaleLowerCase("ja"),scope:null,status:"proposed"});setSurface("")})}}>
        <label>別名候補<input value={surface} onChange={e=>setSurface(e.target.value)} maxLength={512} required /></label>
        <button type="submit" disabled={busy||!canEdit||!surface.trim()}>別名候補を追加</button>
      </form>
      <h4>関係</h4>
      <ul>{detail.relations.map(relation=><li key={relation.id}>{nodes.find(n=>n.id===relation.sourceId)?.name??relation.sourceId} → {relation.type} → {nodes.find(n=>n.id===relation.targetId)?.name??relation.targetId} · {relation.status}
        {relation.status==="proposed"&&<><button type="button" disabled={busy||!canEdit} onClick={()=>void relationSave(relation,"confirmed")}>関係を確定</button><button type="button" disabled={busy||!canEdit} onClick={()=>void relationSave(relation,"rejected")}>関係を却下</button></>}
        {relation.status==="confirmed"&&<button type="button" disabled={busy||!canEdit} onClick={()=>void relationSave(relation,"retired")}>関係を退役</button>}
      </li>)}</ul>
      <form onSubmit={e=>{e.preventDefault();const other=nodes.find(n=>n.id===target&&n.projectId===projectId&&n.status!=="retired");if(!other)return;void mutate(async()=>{await api.savePersistenceRelation(projectId,node.id,{id:crypto.randomUUID() as KnowledgeRelationId,targetId:other.id,type:relationType.trim(),attributes:{},validity:{},status:"proposed",expectedVersion:null});setRelationType("");setTarget("")})}}>
        <label>関係の種類<input value={relationType} onChange={e=>setRelationType(e.target.value)} maxLength={128} required /></label>
        <label>関係先<select value={target} onChange={e=>setTarget(e.target.value)} required><option value="">選択</option>{nodes.filter(n=>n.id!==node.id&&n.projectId===projectId&&n.status!=="retired").map(n=><option value={n.id} key={n.id}>{n.name}</option>)}</select></label>
        <button type="submit" disabled={busy||!canEdit||!target||!relationType.trim()}>関係候補を追加</button>
      </form>
    </>}
    <h4>根拠付き命題</h4>
    <ul>{[...assertions.values()].map(({assertion,item})=><li key={assertion.id}>
      <p>{String(assertion.proposition.statement??"")} · {assertion.modality} · {assertion.perspective} · {assertion.status}</p>
      <button type="button" onClick={()=>onOpenEvidence(item)}>根拠を開く: {item.quote}</button>
      {assertion.status==="proposed"&&<><button type="button" disabled={busy||!canEdit||node.status!=="confirmed"||item.anchor.status!=="confirmed"} onClick={()=>void assertionSave(assertion,"confirmed")}>命題を確定</button><button type="button" disabled={busy||!canEdit} onClick={()=>void assertionSave(assertion,"rejected")}>命題を却下</button></>}
      {assertion.status==="confirmed"&&<button type="button" disabled={busy||!canEdit} onClick={()=>void assertionSave(assertion,"retired")}>命題を退役</button>}
    </li>)}</ul>
    <p>{current?"選択したText Anchorを根拠に命題を作成します。":"このKnowledgeにリンクした保存済みの確認済みText Anchorを選択してください。"}</p>
    <form onSubmit={e=>{e.preventDefault();if(!current||!documentId||!revisionId||!clean||!statement.trim()||!perspective.trim())return;void mutate(async()=>{await api.createPersistenceAnchorAssertion(projectId,documentId,current.anchor.id,{id:crypto.randomUUID(),nodeId:node.id,statement:statement.trim(),modality,perspective:perspective.trim(),revisionId,expectedAnchorVersion:current.anchor.version});setStatement("")})}}>
      <label>命題<textarea value={statement} onChange={e=>setStatement(e.target.value)} maxLength={4000} required /></label>
      <label>種別<select value={modality} onChange={e=>setModality(e.target.value as Modality)}><option value="fact">世界の事実</option><option value="belief">人物の認識</option><option value="disclosure">読者への開示</option><option value="hypothesis">仮説</option></select></label>
      <label>視点<input value={perspective} onChange={e=>setPerspective(e.target.value)} maxLength={128} required /></label>
      <button type="submit" disabled={busy||!canEdit||!clean||!current||!statement.trim()||!perspective.trim()}>命題候補を保存</button>
    </form>
  </section>;
}
