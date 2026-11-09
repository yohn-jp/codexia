import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import { assertChangeOperation, assertProjectPath, snapshotScopeRevision, type SnapshotId, type SnapshotReader, type ChangeOperation, type ChangeProposal, type Approval, type ApplyReceipt, type ProposalStatus, type ProjectObservation, type FileChange, type MutationCoordinator } from "@codexia/contracts";
import { PersistenceError, type Persistence, type PersistenceReader, type PersistenceTransaction, type Project, type ProjectId, type Document, type DocumentId, type RevisionId, type JsonObject } from "@codexia/persistence-contracts";
import { assertPersistedProposal, assertUserOperationPaths, operationDigest, proposalDigest, isJsonValue } from "./operation-records.js";
export type { Project } from "@codexia/persistence-contracts";
export type { ProposalStatus } from "@codexia/contracts";
export interface TreeScene {
  id: string;
  title: string;
}

export interface TreeChapter {
  id: string;
  title: string;
  scenes: TreeScene[];
}

export interface TreeVolume {
  id: string;
  title: string;
  chapters: TreeChapter[];
}

export interface Tree {
  title: string;
  volumes: TreeVolume[];
}

export interface Scene {
  id: string;
  title: string;
  text: string;
  revision: string;
}

export interface Commit {
  hash: string;
  date: string;
  message: string;
}

export interface ManuscriptSnapshotMeta {
  id: string;
  sceneId: string;
  manuscriptId: string;
  createdAt: number;
  charCount: number;
  source: "postgres";
  label?: string;
  trigger?: "manual" | "submit" | "idle";
}

export interface ManuscriptSnapshot extends ManuscriptSnapshotMeta {
  /** Legacy editor body with YAML frontmatter removed. */
  body: string;
  /** Exact historical Markdown bytes decoded as UTF-8, including frontmatter. */
  document: { path: string; content: string; revision: string };
}

export interface LiteralSearchResult {
  id: string;
  type: "scene" | "chapter" | "volume" | "manuscript";
  name?: string;
  snippet?: string;
  filePath: string;
  score: number;
  field?: "body" | "name";
  /** Match offsets are UTF-16 code units within the reported field. */
  offset?: number;
  length?: number;
}

export interface SceneWritingStats {
  sceneId: string;
  charCount: number;
  pages400: number;
  status?: string;
}

export interface ChapterWritingStats {
  chapterId: string;
  charCount: number;
  pages400: number;
  scenes: SceneWritingStats[];
}

export interface VolumeWritingStats {
  volumeId: string;
  charCount: number;
  pages400: number;
  chapters: ChapterWritingStats[];
}

export interface WritingStats {
  totalCharCount: number;
  totalPages400: number;
  volumes: VolumeWritingStats[];
  sceneById: Record<string, SceneWritingStats>;
}

export type HierarchyKind = "volume" | "chapter" | "scene";

export type CreateHierarchyInput =
  | { kind: "volume"; id: string; title: string }
  | { kind: "chapter"; id: string; title: string; volumeId: string }
  | { kind: "scene"; id: string; title: string; volumeId: string; chapterId: string; manuscriptBody?: string };

export type HierarchyTarget =
  | { kind: "volume"; id: string }
  | { kind: "chapter"; id: string; volumeId: string }
  | { kind: "scene"; id: string; volumeId: string; chapterId: string };

export type ReorderHierarchyInput =
  | { kind: "volume"; orderedIds: string[] }
  | { kind: "chapter"; volumeId: string; orderedIds: string[] }
  | { kind: "scene"; volumeId: string; chapterId: string; orderedIds: string[] };

export interface BuiltChangeOperation {
  snapshot: SnapshotId;
  operation: ChangeOperation;
}


export class CoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "CoreError"; }
}
export interface CoreStoreOptions { persistence: Persistence }
type StoredFile = { content: string; encoding: "utf8" | "base64"; revision: string; documentId?: string; metadata?: boolean };
type Manifest = { snapshot: SnapshotId; files: Record<string, StoredFile>; documents: Document[]; project: Project };
const AUTHORITY = "core.authority.proposals";
const SNAPSHOTS = "core.authority.snapshots";
const ARTIFACTS = "core.artifacts";
const PATHS = "core.document-paths";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const pid = (value: string) => value as ProjectId;
function fail(status: number, code: string, message: string): never { throw new CoreError(status, code, message); }
function logicalId(document: Document, files: Record<string, StoredFile>): string {
  const metadata = Object.entries(files).find(([, file]) => file.documentId === document.id && file.metadata);
  if (metadata) { const data = YAML.parse(metadata[1].content); if (typeof data?.id === "string") return data.id; }
  return document.id;
}
function safePath(value: string): void { assertProjectPath(value); }
function body(content: string): string { return content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)?/, ""); }
function stableId(projectId: string, key: string): DocumentId {
  const value = hash(`${projectId}\0${key}`); return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}` as DocumentId;
}
function makeReader(manifest: Manifest): SnapshotReader {
  return { snapshot: structuredClone(manifest.snapshot),
    async read(filePath, encoding = "utf8") { safePath(filePath); const file = manifest.files[filePath]; if (!file) return null;
      const bytes = Buffer.from(file.content, file.encoding); return {content: bytes.toString(encoding), revision: file.revision}; },
    async list(prefix) { if (prefix) safePath(prefix); return Object.keys(manifest.files).filter((key) => !prefix || key === prefix || key.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)).sort(); },
    async listRevisions(prefix) { return (await this.list(prefix)).map((path) => ({ path, revision: manifest.files[path]!.revision })); }
  };
}

async function assertEvidenceRevisions(
  reader: SnapshotReader,
  proposal: ChangeProposal,
  operation: ChangeOperation,
): Promise<void> {
  const evidenceById = new Map((proposal.evidence ?? []).map((item) => [item.id, item]));
  for (const evidenceId of operation.evidenceIds ?? []) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) fail(400, "invalid_proposal", "Operation references missing proposal evidence");
    for (const path of evidence.paths) {
      const currentRevision = (await reader.read(path.path))?.revision ?? null;
      if (currentRevision !== path.revision) {
        fail(409, "evidence_revision_conflict", `The evidence revision changed: ${path.path}`);
      }
    }
  }
}

/** PostgreSQL is the sole durable manuscript, metadata and approved-operation authority. */
export class CoreStore implements MutationCoordinator {
  readonly persistence: Persistence;
  constructor(options: CoreStoreOptions) { this.persistence = options.persistence; }
  async listProjects(): Promise<Project[]> { return [...await this.persistence.read((reader) => reader.listProjects(200))]; }
  async createProject(input: {title: string; settings?: JsonObject}): Promise<Project> { return this.persistence.transaction((tx) => tx.createProject(input)); }
  private async currentManifest(reader: PersistenceReader, projectId: string): Promise<Manifest> {
    const project = await reader.getProject(pid(projectId)); if (!project) fail(404,"project_not_found","Project not found");
    const documents = [...await reader.listDocuments(pid(projectId),undefined,1000)];
    if (documents.length === 1000) fail(413,"snapshot_too_large","Project snapshot exceeds the supported document bound");
    const records = (await Promise.all([reader.listModuleRecords(pid(projectId),PATHS),reader.listModuleRecords(pid(projectId),ARTIFACTS)])).flat(); const files: Record<string,StoredFile> = {};
    const add = (key: string, content: string, encoding: "utf8"|"base64" = "utf8", documentId?: string, metadata?: boolean) => {
      safePath(key); if (files[key]) fail(409,"duplicate_document_path","Project contains duplicate document paths");
      files[key] = {content,encoding,revision:hash(Buffer.from(content,encoding)),...(documentId ? {documentId}:{}),...(metadata ? {metadata:true}:{})};
    };
    add("meta/project.yaml", YAML.stringify({title:project.title,...project.settings}));
    const byId = new Map(documents.map((document) => [document.id,document]));
    for (const document of documents) {
      const mapping = records.find((record) => record.moduleId === PATHS && record.key === document.id)?.value;
      const parent = document.parentId ? byId.get(document.parentId) : undefined;
      const grandparent = parent?.parentId ? byId.get(parent.parentId) : undefined;
      const metadataPath = typeof mapping?.metadataPath === "string" ? mapping.metadataPath : document.kind === "volume" ? `plot/volumes/${document.id}/volume.yaml` : document.kind === "chapter" ? `plot/volumes/${parent?.id ?? "root"}/chapters/${document.id}/chapter.yaml` : `plot/volumes/${grandparent?.id ?? "root"}/chapters/${parent?.id ?? "root"}/scenes/${document.id}.yaml`;
      const manuscriptPath = typeof mapping?.manuscriptPath === "string" ? mapping.manuscriptPath : `documents/${document.id}.md`;
      const metadata = mapping?.metadata && typeof mapping.metadata === "object" && !Array.isArray(mapping.metadata) ? mapping.metadata : {};
      add(metadataPath,YAML.stringify({...metadata,id:metadata.id ?? document.id,title:document.title,order:document.orderKey,...(document.kind === "scene" ? {manuscript:manuscriptPath}:{})}),"utf8",document.id,true);
      if (document.headRevisionId) {
        const revision = await reader.getRevision(pid(projectId),document.id,document.headRevisionId);
        if (!revision) fail(409,"missing_revision","Document head revision is missing");
        if (document.kind !== "volume" && document.kind !== "chapter") add(manuscriptPath,revision.markdown,"utf8",document.id);
      }
    }
    for (const record of records.filter((record) => record.moduleId === ARTIFACTS)) {
      if (record.value.deleted === true) continue;
      if (typeof record.value.content !== "string") fail(422,"invalid_artifact","Artifact body must be text");
      add(record.key,record.value.content,record.value.encoding === "base64" ? "base64":"utf8");
    }
    return {snapshot:{projectId,projectVersion:project.version},files,documents,project};
  }
  private async manifest(projectId: string, pinned?: SnapshotId): Promise<Manifest> {
    if (pinned && pinned.projectId !== projectId) fail(409,"snapshot_scope_mismatch","Snapshot belongs to another project");
    const result = await this.persistence.read(async (reader) => {
      if (pinned) { const saved = await reader.getModuleRecord(pid(projectId),SNAPSHOTS,`snapshot:${pinned.projectVersion}`); if (saved) return saved.value as unknown as Manifest; }
      const current = await this.currentManifest(reader,projectId);
      if (pinned && current.snapshot.projectVersion !== pinned.projectVersion) fail(409,"snapshot_unavailable","The requested immutable project snapshot is unavailable");
      return current;
    });
    // Retain exact immutable bytes for pinned module jobs and historical readers across restart.
    await this.persistence.transaction(async (tx) => { if (!(await tx.getModuleRecord(pid(projectId),SNAPSHOTS,`snapshot:${result.snapshot.projectVersion}`))) {
      try { await tx.saveModuleRecord({projectId:pid(projectId),moduleId:SNAPSHOTS,key:`snapshot:${result.snapshot.projectVersion}`,value:result as unknown as JsonObject,expectedVersion:null}); }
      catch (error) { if (!(error instanceof PersistenceError) || error.code !== "conflict") throw error; }
    }});
    return result;
  }
  async reader(projectId: string,pinned?: SnapshotId): Promise<SnapshotReader> { return makeReader(await this.manifest(projectId,pinned)); }
  async observe(projectId: string): Promise<ProjectObservation> { const project = await this.persistence.read((reader)=>reader.getProject(pid(projectId))); if (!project) fail(404,"project_not_found","Project not found"); return {snapshot:{projectId,projectVersion:project.version},observedAt:new Date().toISOString(),state:"fresh"}; }
  private treeFor(manifest: Manifest): Tree {
    const id = (document: Document) => logicalId(document,manifest.files);
    return {title:manifest.project.title,volumes:manifest.documents.filter((d)=>d.kind === "volume").map((volume)=>({id:id(volume),title:volume.title,chapters:manifest.documents.filter((d)=>d.kind === "chapter" && d.parentId === volume.id).map((chapter)=>({id:id(chapter),title:chapter.title,scenes:manifest.documents.filter((d)=>d.kind === "scene" && d.parentId === chapter.id).map((scene)=>({id:id(scene),title:scene.title}))}))}))};
  }
  async readTreeSnapshot(projectId: string,pinned?: SnapshotId): Promise<{snapshot:SnapshotId;tree:Tree}> { const manifest=await this.manifest(projectId,pinned); return {snapshot:manifest.snapshot,tree:this.treeFor(manifest)}; }
  async tree(projectId:string): Promise<Tree> { return (await this.readTreeSnapshot(projectId)).tree; }
  private findDocument(manifest:Manifest,id:string): Document { const found=manifest.documents.find((document)=>document.id===id || logicalId(document,manifest.files)===id); if (!found) fail(404,"scene_not_found","Document not found"); return found; }
  async readSceneSnapshot(projectId:string,sceneId:string,pinned?:SnapshotId) {
    const manifest=await this.manifest(projectId,pinned), document=this.findDocument(manifest,sceneId);
    const manuscript=Object.entries(manifest.files).find(([,file])=>file.documentId===document.id && !file.metadata);
    const metadata=Object.entries(manifest.files).find(([,file])=>file.documentId===document.id && file.metadata);
    if (!manuscript || !metadata) fail(404,"scene_not_found","Scene body not found");
    return {snapshot:manifest.snapshot,scene:{id:logicalId(document,manifest.files),title:document.title,text:body(manuscript[1].content),revision:hash(metadata[1].content+"\0"+manuscript[1].content)},document:{path:manuscript[0],content:manuscript[1].content,revision:manuscript[1].revision},metadata:{path:metadata[0],content:metadata[1].content,revision:metadata[1].revision}};
  }
  async readScene(projectId:string,sceneId:string):Promise<Scene> { return (await this.readSceneSnapshot(projectId,sceneId)).scene; }
  async resolveDocumentScene(projectId:string,path:string,pinned?:SnapshotId) { safePath(path); const manifest=await this.manifest(projectId,pinned); const id=manifest.files[path]?.documentId; const document=id ? manifest.documents.find((d)=>d.id===id):undefined; return {snapshot:manifest.snapshot,sceneId:document ? logicalId(document,manifest.files):null}; }
  async searchSnapshot(projectId:string,query:string,limit=20,pinned?:SnapshotId):Promise<{snapshot:SnapshotId;results:LiteralSearchResult[]}> {
    if (typeof query!=="string" || query.length>512 || !Number.isInteger(limit) || limit<1) fail(400,"invalid_search_query","Invalid search query or limit");
    const manifest=await this.manifest(projectId,pinned); const results:LiteralSearchResult[]=[];
    if (query) for (const document of manifest.documents) { const entry=Object.entries(manifest.files).find(([,file])=>file.documentId===document.id && !file.metadata); for (const field of ["name","body"] as const) {
      const text=field==="name" ? document.title:entry ? body(entry[1].content):""; const offset=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()); if(offset<0)continue;
      results.push({id:logicalId(document,manifest.files),type:document.kind as LiteralSearchResult["type"],name:document.title,snippet:text.slice(Math.max(0,offset-48),offset+query.length+48),filePath:entry?.[0] ?? "",score:field==="name"?2:1,field,offset,length:query.length});
    }}
    return {snapshot:manifest.snapshot,results:results.sort((a,b)=>b.score-a.score).slice(0,Math.min(limit,100))};
  }
  async writingStatsSnapshot(projectId:string,pinned?:SnapshotId):Promise<{snapshot:SnapshotId;stats:WritingStats}> {
    const manifest=await this.manifest(projectId,pinned); const tree=this.treeFor(manifest), sceneById:Record<string,SceneWritingStats>={}; let totalCharCount=0;
    const volumes=tree.volumes.map((volume)=>{const chapters=volume.chapters.map((chapter)=>{const scenes=chapter.scenes.map((scene)=>{const document=this.findDocument(manifest,scene.id); const file=Object.values(manifest.files).find((f)=>f.documentId===document.id&&!f.metadata); const charCount=Array.from(body(file?.content??"").replace(/\s/gu,"")).length; const stat={sceneId:scene.id,charCount,pages400:Math.ceil(charCount/400)}; sceneById[scene.id]=stat;return stat;});const charCount=scenes.reduce((sum,s)=>sum+s.charCount,0);return {chapterId:chapter.id,charCount,pages400:Math.ceil(charCount/400),scenes};});const charCount=chapters.reduce((sum,c)=>sum+c.charCount,0);totalCharCount+=charCount;return {volumeId:volume.id,charCount,pages400:Math.ceil(charCount/400),chapters};});
    return {snapshot:manifest.snapshot,stats:{totalCharCount,totalPages400:Math.ceil(totalCharCount/400),volumes,sceneById}};
  }
  private async proposalStatus(reader:PersistenceReader,projectId:string,proposalId:string):Promise<{recordVersion:number;status:ProposalStatus}|null> {
    const record=await reader.getModuleRecord(pid(projectId),AUTHORITY,`proposal:${proposalId}`); return record ? {recordVersion:record.version,status:record.value as unknown as ProposalStatus}:null;
  }
  async listProposals(projectId:string):Promise<ProposalStatus[]> { const observation=await this.observe(projectId); return this.persistence.read(async(reader)=>(await reader.listModuleRecords(pid(projectId),AUTHORITY)).filter((record)=>record.key.startsWith("proposal:")).map((record)=>({...record.value as unknown as ProposalStatus,stale:(record.value as unknown as ProposalStatus).proposal.snapshot.projectVersion!==observation.snapshot.projectVersion}))); }
  async getProposal(projectId:string,proposalId:string):Promise<ProposalStatus|null> { return this.persistence.read(async(reader)=>(await this.proposalStatus(reader,projectId,proposalId))?.status??null); }
  async propose(projectId:string,proposal:ChangeProposal):Promise<ChangeProposal> {
    try { assertPersistedProposal(proposal); } catch(error) { fail(400,"invalid_proposal",error instanceof Error?error.message:"Invalid proposal"); }
    if(proposal.snapshot.projectId!==projectId)fail(409,"proposal_scope_mismatch","Proposal belongs to another project");
    return this.persistence.transaction(async(tx)=>{
      const existing=await this.proposalStatus(tx,projectId,proposal.id); if(existing) { if(proposalDigest(existing.status.proposal)!==proposalDigest(proposal))fail(409,"proposal_identity_conflict","Proposal identity has a different payload");return existing.status.proposal; }
      await tx.assertProjectVersion(pid(projectId),proposal.snapshot.projectVersion);
      const reader = makeReader(await this.currentManifest(tx, projectId));
      for (const operation of proposal.operations) await assertEvidenceRevisions(reader, proposal, operation);
      const state:ProposalStatus={proposal:structuredClone(proposal),state:"proposed",approvedOperationIds:[],applications:[],appliedOperationIds:[],stale:false};
      await tx.saveModuleRecord({projectId:pid(projectId),moduleId:AUTHORITY,key:`proposal:${proposal.id}`,value:state as unknown as JsonObject,expectedVersion:null}); return structuredClone(proposal);
    });
  }
  async approve(projectId:string,approval:Approval):Promise<void> {
    if(!approval.authorScope?.trim()||!approval.operationIds.length||new Set(approval.operationIds).size!==approval.operationIds.length)fail(400,"invalid_approval","Author identity and unique operation identities are required");
    await this.persistence.transaction(async(tx)=>{
      const found=await this.proposalStatus(tx,projectId,approval.proposalId);if(!found)fail(404,"proposal_not_found","Proposal not found");const state=found.status;
      for(const id of approval.operationIds)if(!state.proposal.operations.some((operation)=>operation.id===id))fail(400,"invalid_approval","Operation is outside this proposal");
      state.approvedOperationIds=[...new Set([...state.approvedOperationIds,...approval.operationIds])];state.state=state.approvedOperationIds.length===state.proposal.operations.length?"approved":"partially_approved";
      await tx.saveModuleRecord({projectId:pid(projectId),moduleId:AUTHORITY,key:`proposal:${approval.proposalId}`,value:{...state,approvedBy:approval.authorScope} as unknown as JsonObject,expectedVersion:found.recordVersion});
    });
  }
  private async applyWrites(tx:PersistenceTransaction,manifest:Manifest,operation:ChangeOperation):Promise<void> {
    const projectId=pid(operation.projectId);
    const metadataWrites=operation.writes.filter((write)=>/^plot\/volumes\/.+\.yaml$/.test(write.path));
    // Parents are inserted before children; removals are processed deepest first.
    const ordered=[...metadataWrites.filter((w)=>w.content!==null).sort((a,b)=>a.path.split("/").length-b.path.split("/").length),...operation.writes.filter((w)=>!metadataWrites.includes(w)),...metadataWrites.filter((w)=>w.content===null).sort((a,b)=>b.path.split("/").length-a.path.split("/").length)];
    const documents=[...manifest.documents];
    const paths=new Map<string,string>();for(const [path,file]of Object.entries(manifest.files))if(file.documentId&&file.metadata)paths.set(path,file.documentId);
    const manuscriptCreates=new Set<string>();
    for(const write of ordered){
      if(write.path==="meta/project.yaml"){
        if(write.content===null)fail(422,"invalid_project_metadata","Project metadata cannot be deleted");const value=YAML.parse(write.content);if(!value||typeof value!=="object"||Array.isArray(value)||!isJsonValue(value))fail(422,"invalid_project_metadata","Project metadata must be an object");
        const {title,...settings}=value;await tx.updateProject({projectId,expectedVersion:(await tx.getProject(projectId))!.version,title:typeof title==="string"?title:manifest.project.title,settings});continue;
      }
      if(metadataWrites.includes(write)){
        const existingId=paths.get(write.path);const existing=existingId?documents.find((d)=>d.id===existingId):undefined;
        if(write.content===null){if(existing)await tx.deleteDocument({projectId,documentId:existing.id,expectedVersion:existing.version});continue;}
        const data=YAML.parse(write.content);if(!data||typeof data!=="object"||Array.isArray(data)||!isJsonValue(data))fail(422,"invalid_hierarchy_metadata","Hierarchy metadata must be an object");
        const volume=/^plot\/volumes\/([^/]+)\/volume.yaml$/.exec(write.path),chapter=/^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/chapter.yaml$/.exec(write.path),scene=/^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/scenes\/([^/]+).yaml$/.exec(write.path);
        if(!volume&&!chapter&&!scene)fail(422,"invalid_hierarchy_metadata","Unknown hierarchy metadata path");
        const kind=volume?"volume":chapter?"chapter":"scene";const parentPath=chapter?`plot/volumes/${chapter[1]}/volume.yaml`:scene?`plot/volumes/${scene[1]}/chapters/${scene[2]}/chapter.yaml`:null;
        const parentId=parentPath?paths.get(parentPath):null;if(parentPath&&!parentId)fail(422,"missing_hierarchy_parent","Hierarchy parent is missing");
        const title=typeof data.title==="string"?data.title:typeof data.name==="string"?data.name:String(data.id??existing?.id??"");
        const manuscriptPath=kind==="scene"?(typeof data.manuscript==="string"?data.manuscript:`manuscript/${scene![1]}/${scene![2]}/${scene![3]}.md`):undefined;if(manuscriptPath)safePath(manuscriptPath);
        const id=existing?.id??stableId(operation.projectId,write.path);
        let document:Document;
        if(existing)document=await tx.updateDocument({projectId,documentId:id,parentId:parentId as DocumentId|null,title,orderKey:String(data.order??existing.orderKey),expectedVersion:existing.version});
        else {const manuscript=manuscriptPath?operation.writes.find((w)=>w.path===manuscriptPath):undefined;document=(await tx.createDocument({projectId,documentId:id,parentId:parentId as DocumentId|null,kind,title,orderKey:String(data.order??"0"),markdown:manuscript?.content??"",authorId:"approved-author",idempotencyKey:`${operation.id}:${operation.generation}:${id}`})).document;if(manuscriptPath)manuscriptCreates.add(manuscriptPath);documents.push(document);}
        paths.set(write.path,id);const mapping=await tx.getModuleRecord(projectId,PATHS,id);await tx.saveModuleRecord({projectId,moduleId:PATHS,key:id,value:{metadataPath:write.path,...(manuscriptPath?{manuscriptPath}:{}),metadata:data},expectedVersion:mapping?.version??null});continue;
      }
      if(manuscriptCreates.has(write.path))continue;
      const known=manifest.files[write.path];
      if(known?.documentId&&!known.metadata){const document=await tx.getDocument(projectId,known.documentId as DocumentId);if(!document)continue;if(write.content===null){if(metadataWrites.some((candidate)=>candidate.content===null&&manifest.files[candidate.path]?.documentId===document.id))continue;fail(422,"invalid_document_delete","Delete a scene using its hierarchy metadata");}if(write.encoding==="base64")fail(422,"invalid_manuscript_encoding","Manuscripts must be UTF-8");const revision=await tx.getRevision(projectId,document.id,document.headRevisionId!);if(!revision)fail(409,"missing_revision","Document head is missing");await tx.saveDocument({projectId,documentId:document.id,baseRevisionId:revision.id,changes:[{fromUtf16:0,toUtf16:revision.markdown.length,insert:write.content}],resultingSha256:hash(write.content),authorId:"approved-author",clientId:"core",idempotencyKey:`${operation.id}:${operation.generation}:${write.path}`});continue;}
      if(write.path.startsWith("manuscript/")||write.path.startsWith("documents/"))fail(422,"unbound_manuscript","Manuscript writes require a canonical document or hierarchy creation");
      const record=await tx.getModuleRecord(projectId,ARTIFACTS,write.path);await tx.saveModuleRecord({projectId,moduleId:ARTIFACTS,key:write.path,value:write.content===null?{deleted:true}:{content:write.content,encoding:write.encoding??"utf8"},expectedVersion:record?.version??null});
    }
  }
  async apply(projectId:string,operation:ChangeOperation):Promise<ApplyReceipt> {
    assertChangeOperation(operation);assertUserOperationPaths(operation);if(operation.projectId!==projectId)fail(409,"operation_scope_mismatch","Operation belongs to another project");
    return this.persistence.transaction(async(tx)=>{
      await tx.assertProjectVersion(pid(projectId));
      const proposals=(await tx.listModuleRecords(pid(projectId),AUTHORITY)).filter((record)=>record.key.startsWith("proposal:"));
      const approved=proposals.find((record)=>{const state=record.value as unknown as ProposalStatus;return state.approvedOperationIds.includes(operation.id)&&state.proposal.operations.some((candidate)=>operationDigest(candidate)===operationDigest(operation));});
      if(!approved)fail(403,"operation_not_approved","The exact operation must be approved by an authenticated author");
      const state=approved.value as unknown as ProposalStatus;const replay=state.applications.find((receipt)=>receipt.operationId===operation.id&&receipt.generation===operation.generation);if(replay)return replay;
      const manifest=await this.currentManifest(tx,projectId),reader=makeReader(manifest);
      await assertEvidenceRevisions(reader, state.proposal, operation);
      for(const read of [...operation.reads,...operation.writes])if((await reader.read(read.path))?.revision!==read.revision&& !((await reader.read(read.path))===null&&read.revision===null))fail(409,"revision_conflict",`The revision changed: ${read.path}`);
      for(const scope of operation.readScopes??[])if(await snapshotScopeRevision(reader,scope.prefix)!==scope.revision)fail(409,"scope_conflict",`The scope changed: ${scope.prefix}`);
      await this.applyWrites(tx,manifest,operation);
      const after=await this.currentManifest(tx,projectId);const receipt:ApplyReceipt={operationId:operation.id,generation:operation.generation,projectVersion:Math.max(after.project.version,manifest.project.version+1),revisions:operation.writes.map((write)=>({path:write.path,revision:after.files[write.path]?.revision??null}))};
      state.applications.push(receipt);state.appliedOperationIds.push(operation.id);state.state=state.appliedOperationIds.length===state.proposal.operations.length?"applied":state.state;
      await tx.saveModuleRecord({projectId:pid(projectId),moduleId:AUTHORITY,key:approved.key,value:state as unknown as JsonObject,expectedVersion:approved.version});return receipt;
    });
  }
  private async buildOperation(projectId:string,writes:FileChange[],effect:ChangeOperation["effect"],message:string,pinned?:SnapshotId):Promise<BuiltChangeOperation> {const reader=await this.reader(projectId,pinned);return {snapshot:reader.snapshot,operation:{id:randomUUID(),generation:0,projectId,baseProjectVersion:reader.snapshot.projectVersion,effect,reads:writes.map(({path,revision})=>({path,revision})),writes,message}};}
  async buildCreateHierarchyOperation(projectId:string,input:CreateHierarchyInput,pinned?:SnapshotId):Promise<BuiltChangeOperation>{
    if(!input||!["volume","chapter","scene"].includes(input.kind)||typeof input.id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(input.id)||!input.title?.trim())fail(400,"invalid_hierarchy_operation","A path-safe identity and title are required");
    const manifest=await this.manifest(projectId,pinned);if(manifest.documents.some((document)=>logicalId(document,manifest.files)===input.id))fail(409,"hierarchy_id_exists","The hierarchy identity already exists");
    const reader=makeReader(manifest),writes:FileChange[]=[];let path:string;
    if(input.kind==="volume")path=`plot/volumes/${input.id}/volume.yaml`;
    else {const volume=this.findDocument(manifest,input.volumeId);if(volume.kind!=="volume")fail(422,"invalid_hierarchy_parent","The parent must be a volume");path=`plot/volumes/${input.volumeId}/chapters/${input.id}/chapter.yaml`;
      if(input.kind==="scene"){const chapter=this.findDocument(manifest,input.chapterId);if(chapter.kind!=="chapter"||chapter.parentId!==volume.id)fail(422,"invalid_hierarchy_parent","The chapter must belong to the volume");path=`plot/volumes/${input.volumeId}/chapters/${input.chapterId}/scenes/${input.id}.yaml`;const manuscript=`manuscript/${input.volumeId}/${input.chapterId}/${input.id}.md`;writes.push({path:manuscript,revision:null,content:input.manuscriptBody??""});}}
    if(await reader.read(path))fail(409,"hierarchy_path_exists","The hierarchy path already exists");writes.unshift({path,revision:null,content:YAML.stringify({id:input.id,title:input.title,order:manifest.documents.length+1})});
    return this.buildOperation(projectId,writes,"structure",`Create ${input.kind} ${input.id}`,manifest.snapshot);
  }
  async buildDeleteHierarchyOperation(projectId:string,input:HierarchyTarget,pinned?:SnapshotId):Promise<BuiltChangeOperation>{
    const manifest=await this.manifest(projectId,pinned),target=this.findDocument(manifest,input.id);if(target.kind!==input.kind)fail(422,"invalid_hierarchy_target","Hierarchy kind mismatch");
    const selected=new Set<string>([target.id]);let changed=true;while(changed){changed=false;for(const document of manifest.documents)if(document.parentId&&selected.has(document.parentId)&&!selected.has(document.id)){selected.add(document.id);changed=true;}}
    const writes=Object.entries(manifest.files).filter(([,file])=>file.documentId&&selected.has(file.documentId)).map(([path,file])=>({path,revision:file.revision,content:null}));return this.buildOperation(projectId,writes,"structure",`Delete ${input.kind} ${input.id}`,manifest.snapshot);
  }
  async buildReorderHierarchyOperation(projectId:string,input:ReorderHierarchyInput,pinned?:SnapshotId):Promise<BuiltChangeOperation>{
    const manifest=await this.manifest(projectId,pinned);let parent:Document|undefined;if(input.kind==="chapter")parent=this.findDocument(manifest,input.volumeId);if(input.kind==="scene")parent=this.findDocument(manifest,input.chapterId);
    const siblings=manifest.documents.filter((document)=>document.kind===input.kind&&document.parentId===(parent?.id??null));const expected=siblings.map((document)=>logicalId(document,manifest.files)).sort();if(JSON.stringify([...input.orderedIds].sort())!==JSON.stringify(expected))fail(422,"invalid_hierarchy_order","Reorder must include every sibling exactly once");
    const writes=input.orderedIds.map((id,index)=>{const document=this.findDocument(manifest,id),entry=Object.entries(manifest.files).find(([,file])=>file.documentId===document.id&&file.metadata)!;return {path:entry[0],revision:entry[1].revision,content:YAML.stringify({...YAML.parse(entry[1].content),order:String(index).padStart(10,"0")})};});return this.buildOperation(projectId,writes,"structure","Reorder hierarchy",manifest.snapshot);
  }
  async buildRestoreOperation(projectId:string,input:{sceneId:string;snapshotId:string}|string,revisionId?:string,pinned?:SnapshotId):Promise<BuiltChangeOperation>{
    const sceneId=typeof input==="string"?input:input.sceneId,sourceId=typeof input==="string"?revisionId:input.snapshotId;const manifest=await this.manifest(projectId,pinned),document=this.findDocument(manifest,sceneId);
    const revision=await this.persistence.read((reader)=>reader.getRevision(pid(projectId),document.id,sourceId as RevisionId));if(!revision)fail(404,"revision_not_found","Revision not found");const file=Object.entries(manifest.files).find(([,value])=>value.documentId===document.id&&!value.metadata)!;return this.buildOperation(projectId,[{path:file[0],revision:file[1].revision,content:revision.markdown}],"manuscript","Restore manuscript revision",manifest.snapshot);
  }
  async listManuscriptSnapshots(projectId:string,manuscriptId:string,sceneId?:string,pinned?:SnapshotId):Promise<{snapshot:SnapshotId;snapshots:ManuscriptSnapshotMeta[]}>{
    const manifest=await this.manifest(projectId,pinned),document=this.findDocument(manifest,sceneId??manuscriptId),page=await this.persistence.read((reader)=>reader.listRevisions(pid(projectId),document.id,100));return {snapshot:manifest.snapshot,snapshots:page.revisions.map((revision)=>({id:revision.id,sceneId:logicalId(document,manifest.files),manuscriptId,createdAt:Date.parse(revision.createdAt),charCount:Array.from(body(revision.markdown)).length,source:"postgres"}))};
  }
  async readManuscriptSnapshot(projectId:string,snapshotId:string,manuscriptId:string,sceneId?:string,pinned?:SnapshotId):Promise<{snapshot:SnapshotId;manuscriptSnapshot:ManuscriptSnapshot}>{
    const manifest=await this.manifest(projectId,pinned),document=this.findDocument(manifest,sceneId??manuscriptId);const revision=await this.persistence.read((reader)=>reader.getRevision(pid(projectId),document.id,snapshotId as RevisionId));if(!revision)fail(404,"revision_not_found","Revision not found");const file=Object.entries(manifest.files).find(([,value])=>value.documentId===document.id&&!value.metadata)!;return {snapshot:manifest.snapshot,manuscriptSnapshot:{id:revision.id,sceneId:logicalId(document,manifest.files),manuscriptId,createdAt:Date.parse(revision.createdAt),charCount:Array.from(body(revision.markdown)).length,source:"postgres",body:body(revision.markdown),document:{path:file[0],content:revision.markdown,revision:revision.sha256}}};
  }
  async status(projectId:string) { const observation=await this.observe(projectId);return {...observation.snapshot,state:"durable" as const}; }
  async history(projectId:string):Promise<Commit[]> { const manifest=await this.manifest(projectId); const revisions=await this.persistence.read(async(reader)=>{const pages=await Promise.all(manifest.documents.map((document)=>reader.listRevisions(pid(projectId),document.id,100)));return pages.flatMap((page)=>page.revisions);});return revisions.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100).map((revision)=>({hash:revision.id,date:revision.createdAt,message:`Document revision ${revision.documentId}`})); }
}
