import { createHash, randomUUID } from "node:crypto";
import { KNOWLEDGE_CONTEXT_PATH, projectKnowledgeContext } from "./knowledge-context.js";
import YAML from "yaml";
import { assertChangeOperation, assertProjectPath, snapshotScopeRevision, type SnapshotId, type SnapshotReader, type ChangeOperation, type ChangeProposal, type Approval, type ApplyReceipt, type ProposalStatus, type ProjectObservation, type FileChange, type MutationCoordinator } from "@codexia/contracts";
import { PersistenceError, type Persistence, type PersistenceReader, type PersistenceTransaction, type Project, type ProjectId, type Document, type DocumentId, type RevisionId, type JsonObject } from "@codexia/persistence-contracts";
import { assertPersistedProposal, assertUserOperationPaths, operationDigest, proposalDigest, isJsonValue } from "./operation-records.js";
import { createSnapshotIndex, estimateSnapshotIndexBytes, type SnapshotIndex } from "./snapshot-index.js";
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
type SnapshotIndexEntry = { index: SnapshotIndex; bytes: number };
const AUTHORITY = "core.authority.proposals";
const SNAPSHOTS = "core.authority.snapshots";
// Increment this proof epoch when the canonical projected bytes change. Older
// pinned snapshots retain their original key and are never rewritten.
const SNAPSHOT_PROJECTION_EPOCH = 1;
function projectionProofKey(version: number): string {
  return `proof:projection:${SNAPSHOT_PROJECTION_EPOCH}:snapshot:${version}`;
}
const ARTIFACTS = "core.artifacts";
const PATHS = "core.document-paths";
const MAX_SNAPSHOT_INDEX_ENTRIES = 8;
const MAX_SNAPSHOT_INDEX_BYTES = 4 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const pid = (value: string) => value as ProjectId;
function fail(status: number, code: string, message: string): never { throw new CoreError(status, code, message); }
function safePath(value: string): void { assertProjectPath(value); }
function body(content: string): string { return content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)?/, ""); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function snapshotKey(projectId: string, projectVersion: number): string { return `${projectId}\0${projectVersion}`; }
function storedManifest(value: unknown, projectId: string, projectVersion: number): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(409, "snapshot_unavailable", "The stored immutable project snapshot is invalid");
  const manifest = value as Manifest;
  if (!manifest.snapshot || manifest.snapshot.projectId !== projectId || manifest.snapshot.projectVersion !== projectVersion ||
      !manifest.project || manifest.project.id !== projectId || manifest.project.version !== projectVersion ||
      !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files) || !Array.isArray(manifest.documents)) {
    fail(409, "snapshot_unavailable", "The stored immutable project snapshot does not match its project version");
  }
  return manifest;
}
function manifestFingerprint(manifest: Manifest): string { return hash(canonicalJson(manifest)); }
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
  private readonly snapshotIndexes = new Map<string, SnapshotIndexEntry>();
  private snapshotIndexBytes = 0;
  constructor(options: CoreStoreOptions) { this.persistence = options.persistence; }
  async listProjects(): Promise<Project[]> { return [...await this.persistence.read((reader) => reader.listProjects(200))]; }
  async createProject(input: {title: string; settings?: JsonObject}): Promise<Project> { return this.persistence.transaction((tx) => tx.createProject(input)); }
  private async currentManifest(reader: PersistenceReader, projectId: string, knownProject?: Project): Promise<Manifest> {
    const project = knownProject ?? await reader.getProject(pid(projectId));
    if (!project) fail(404,"project_not_found","Project not found");
    const documents = [...await reader.listDocuments(pid(projectId),undefined,1000)];
    if (documents.length === 1000) fail(413,"snapshot_too_large","Project snapshot exceeds the supported document bound");
    const headKeys = documents.flatMap((document) => document.headRevisionId ? [{ documentId: document.id, revisionId: document.headRevisionId }] : []);
    const headRevisions = await reader.getDocumentHeadRevisions(pid(projectId), headKeys);
    const revisionsByHead = new Map(headRevisions.map((head) => [JSON.stringify([head.documentId, head.revisionId]), head.revision]));
    const records = (await Promise.all([reader.listModuleRecords(pid(projectId),PATHS),reader.listModuleRecords(pid(projectId),ARTIFACTS)])).flat(); const files: Record<string,StoredFile> = {};
    const add = (key: string, content: string, encoding: "utf8"|"base64" = "utf8", documentId?: string, metadata?: boolean) => {
      safePath(key); if (files[key]) fail(409,"duplicate_document_path","Project contains duplicate document paths");
      files[key] = {content,encoding,revision:hash(Buffer.from(content,encoding)),...(documentId ? {documentId}:{}),...(metadata ? {metadata:true}:{})};
    };
    add("meta/project.yaml", YAML.stringify({title:project.title,...project.settings}));
    const byId = new Map(documents.map((document) => [document.id,document]));
    const mappings = new Map(records.filter((record) => record.moduleId === PATHS).map((record) => [record.key, record.value]));
    const metadataFor = (document: Document): JsonObject => {
      const metadata = mappings.get(document.id)?.metadata;
      return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...metadata } : {};
    };
    const projectedId = (document: Document): string => {
      const id = metadataFor(document).id;
      return typeof id === "string" ? id : document.id;
    };
    for (const document of documents) {
      const mapping = mappings.get(document.id);
      const parent = document.parentId ? byId.get(document.parentId) : undefined;
      const grandparent = parent?.parentId ? byId.get(parent.parentId) : undefined;
      const metadataPath = typeof mapping?.metadataPath === "string" ? mapping.metadataPath : document.kind === "volume" ? `plot/volumes/${document.id}/volume.yaml` : document.kind === "chapter" ? `plot/volumes/${parent?.id ?? "root"}/chapters/${document.id}/chapter.yaml` : `plot/volumes/${grandparent?.id ?? "root"}/chapters/${parent?.id ?? "root"}/scenes/${document.id}.yaml`;
      const manuscriptPath = typeof mapping?.manuscriptPath === "string" ? mapping.manuscriptPath : `documents/${document.id}.md`;
      const metadata = metadataFor(document);
      // Hierarchy is owned by Document.parentId, not the optional module metadata.
      // Keep mapped Story identities while deriving links from the same pinned DB read.
      if (document.kind === "chapter" || document.kind === "scene") {
        delete metadata.volume;
        delete metadata.chapter;
        if (document.kind === "chapter" && parent?.kind === "volume") {
          metadata.volume = projectedId(parent);
        }
        if (document.kind === "scene" && parent?.kind === "chapter") {
          metadata.chapter = projectedId(parent);
          if (grandparent?.kind === "volume") metadata.volume = projectedId(grandparent);
        }
      }
      add(metadataPath,YAML.stringify({...metadata,id:projectedId(document),title:document.title,order:document.orderKey,...(document.kind === "scene" ? {manuscript:manuscriptPath}:{})}),"utf8",document.id,true);
      if (document.headRevisionId) {
        const revision = revisionsByHead.get(JSON.stringify([document.id, document.headRevisionId]));
        if (!revision) fail(409,"missing_revision","Document head revision is missing");
        if (document.kind !== "volume" && document.kind !== "chapter") add(manuscriptPath,revision.markdown,"utf8",document.id);
      }
    }
    for (const record of records.filter((record) => record.moduleId === ARTIFACTS)) {
      if (record.value.deleted === true) continue;
      if (typeof record.value.content !== "string") fail(422,"invalid_artifact","Artifact body must be text");
      add(record.key,record.value.content,record.value.encoding === "base64" ? "base64":"utf8");
    }
    const documentMappings = documents.filter(document => document.kind === "scene").map(document => ({documentId:document.id,storySceneId:projectedId(document)}));
    add(KNOWLEDGE_CONTEXT_PATH, JSON.stringify(await projectKnowledgeContext(reader,pid(projectId),documents,documentMappings)));
    return {snapshot:{projectId,projectVersion:project.version},files,documents,project};
  }
  private async manifest(projectId: string, pinned?: SnapshotId): Promise<Manifest> {
    if (pinned && pinned.projectId !== projectId) fail(409,"snapshot_scope_mismatch","Snapshot belongs to another project");
    const resolved = await this.persistence.read(async (reader) => {
      if (pinned) {
        const saved = await reader.getModuleRecord(pid(projectId),SNAPSHOTS,`snapshot:${pinned.projectVersion}`);
        if (saved) return { manifest: storedManifest(saved.value, projectId, pinned.projectVersion), needsPersistence: false };
      }
      const project = await reader.getProject(pid(projectId));
      if (!project) fail(404,"project_not_found","Project not found");
      if (pinned && project.version !== pinned.projectVersion) fail(409,"snapshot_unavailable","The requested immutable project snapshot is unavailable");
      if (!pinned) {
        const saved = await reader.getModuleRecord(pid(projectId),SNAPSHOTS,`snapshot:${project.version}`);
        if (saved) {
          const manifest = storedManifest(saved.value, projectId, project.version);
          const proof = await reader.getModuleRecord(pid(projectId), SNAPSHOTS, projectionProofKey(project.version));
          if (proof?.value.snapshotRecordVersion === saved.version) return { manifest, needsPersistence: false };
          const fresh = await this.currentManifest(reader, projectId, project);
          if (manifestFingerprint(manifest) !== manifestFingerprint(fresh)) {
            fail(409, "snapshot_unavailable", "Current snapshot requires the projection compatibility transition before reuse");
          }
          return { manifest: fresh, needsPersistence: true };
        }
      }
      return { manifest: await this.currentManifest(reader,projectId,project), needsPersistence: true };
    });
    const manifest = resolved.needsPersistence ? await this.persistManifest(resolved.manifest) : resolved.manifest;
    return manifest;
  }

  private snapshotIndex(manifest: Manifest): SnapshotIndex {
    const key = snapshotKey(manifest.snapshot.projectId, manifest.snapshot.projectVersion);
    const cached = this.snapshotIndexes.get(key);
    if (cached) {
      this.snapshotIndexes.delete(key);
      this.snapshotIndexes.set(key, cached);
      return cached.index;
    }
    const index = createSnapshotIndex(manifest.documents, manifest.files);
    const bytes = estimateSnapshotIndexBytes(index);
    if (bytes <= MAX_SNAPSHOT_INDEX_BYTES) {
      this.snapshotIndexes.set(key, { index, bytes });
      this.snapshotIndexBytes += bytes;
      while (this.snapshotIndexes.size > MAX_SNAPSHOT_INDEX_ENTRIES || this.snapshotIndexBytes > MAX_SNAPSHOT_INDEX_BYTES) {
        const oldest = this.snapshotIndexes.entries().next().value as [string, SnapshotIndexEntry] | undefined;
        if (!oldest) break;
        this.snapshotIndexes.delete(oldest[0]);
        this.snapshotIndexBytes -= oldest[1].bytes;
      }
    }
    return index;
  }

  private async persistManifest(manifest: Manifest): Promise<Manifest> {
    const projectId = pid(manifest.snapshot.projectId);
    const version = manifest.snapshot.projectVersion;
    const key = `snapshot:${version}`;
    return this.persistence.transaction(async (tx) => {
      let record;
      try {
        record = await tx.saveModuleRecord({projectId,moduleId:SNAPSHOTS,key,value:manifest as unknown as JsonObject,expectedVersion:null});
      } catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== "conflict") throw error;
        record = await tx.getModuleRecord(projectId, SNAPSHOTS, key);
        if (!record) throw error;
      }
      const saved = storedManifest(record.value, projectId, version);
      if (manifestFingerprint(saved) !== manifestFingerprint(manifest)) {
        fail(409, "snapshot_unavailable", "Concurrent snapshot builders produced different immutable project snapshots");
      }
      // The immutable record and its proof are committed together, under the
      // existing project lock. Proofs are scoped to the exact record version.
      const proofKey = projectionProofKey(version);
      const proof = await tx.getModuleRecord(projectId, SNAPSHOTS, proofKey);
      if (!proof) {
        await tx.saveModuleRecord({projectId,moduleId:SNAPSHOTS,key:proofKey,value:{snapshotRecordVersion:record.version},expectedVersion:null});
      } else if (proof.value.snapshotRecordVersion !== record.version) {
        fail(409, "snapshot_unavailable", "Stored snapshot compatibility proof does not match its immutable record");
      }
      return saved;
    });
  }

  /**
   * Explicit startup compatibility transition, before accepting requests.
   * A projection change is a new semantic snapshot version, not a content edit.
   * Equivalent legacy snapshots acquire a proof; incompatible snapshots retain
   * their original pinned bytes and the project advances under its version fence.
   * Ordinary reads never perform this transition.
   */
  async prepareSnapshotReuse(projectId?: string, mode: "transition" | "validate" = "transition"): Promise<void> {
    if (projectId !== undefined) {
      await this.prepareProjectSnapshotReuse(pid(projectId), mode);
      return;
    }
    let after: ProjectId | undefined;
    for (;;) {
      const ids = await this.persistence.read(reader => reader.listProjectIds(100, after));
      for (const id of ids) await this.prepareProjectSnapshotReuse(id, mode);
      if (ids.length < 100) return;
      after = ids[ids.length - 1]!;
    }
  }

  private async prepareProjectSnapshotReuse(projectId: ProjectId, mode: "transition" | "validate"): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const legacy = await this.persistence.read(async reader => {
        const project = await reader.getProject(projectId);
        if (!project) fail(404, "project_not_found", "Project not found");
        const record = await reader.getModuleRecord(projectId, SNAPSHOTS, `snapshot:${project.version}`);
        if (!record) return null;
        const proof = await reader.getModuleRecord(projectId, SNAPSHOTS, projectionProofKey(project.version));
        if (proof?.value.snapshotRecordVersion === record.version) return null;
        const saved = storedManifest(record.value, projectId, project.version);
        const fresh = await this.currentManifest(reader, projectId, project);
        return { version: project.version, recordVersion: record.version, fresh,
          equivalent: manifestFingerprint(saved) === manifestFingerprint(fresh) };
      });
      // A candidate preflight is read-only. Successful materialization above
      // proves the legacy projection can be inspected; only the exclusive
      // writer may certify it or advance the project version.
      if (!legacy || mode === "validate") return;
      if (legacy.equivalent) {
        await this.persistManifest(legacy.fresh);
        return;
      }
      try {
        await this.persistence.transaction(async tx => {
          await tx.assertProjectVersion(projectId, legacy.version);
          const record = await tx.getModuleRecord(projectId, SNAPSHOTS, `snapshot:${legacy.version}`);
          if (!record || record.version !== legacy.recordVersion) {
            fail(409, "snapshot_unavailable", "Legacy snapshot changed during the compatibility transition");
          }
          const proof = await tx.getModuleRecord(projectId, SNAPSHOTS, projectionProofKey(legacy.version));
          if (proof) fail(409, "snapshot_unavailable", "Incompatible snapshot has an unexpected compatibility proof");
          // The projected bytes changed: allocate a new SnapshotId while
          // preserving manuscript, metadata, and every old pinned record.
          await tx.updateProject({projectId, expectedVersion:legacy.version});
        });
        return;
      } catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== "conflict") throw error;
        // A concurrent content mutation or startup transition advanced the
        // version. Re-read the current project instead of bumping it again.
      }
    }
    fail(409, "snapshot_unavailable", "Project changed repeatedly during the projection compatibility transition");
  }
  async reader(projectId: string,pinned?: SnapshotId): Promise<SnapshotReader> { return makeReader(await this.manifest(projectId,pinned)); }
  async observe(projectId: string): Promise<ProjectObservation> { const project = await this.persistence.read((reader)=>reader.getProject(pid(projectId))); if (!project) fail(404,"project_not_found","Project not found"); return {snapshot:{projectId,projectVersion:project.version},observedAt:new Date().toISOString(),state:"fresh"}; }
  private logicalId(index: SnapshotIndex, document: Document): string { return index.logicalIdByDocumentId.get(document.id) ?? document.id; }
  private treeFor(manifest: Manifest, index = this.snapshotIndex(manifest)): Tree {
    return {
      title: manifest.project.title,
      volumes: index.volumes.map((volume) => ({
        id: this.logicalId(index, volume),
        title: volume.title,
        chapters: (index.chaptersByVolumeId.get(volume.id) ?? []).map((chapter) => ({
          id: this.logicalId(index, chapter),
          title: chapter.title,
          scenes: (index.scenesByChapterId.get(chapter.id) ?? []).map((scene) => ({
            id: this.logicalId(index, scene),
            title: scene.title,
          })),
        })),
      })),
    };
  }
  async readTreeSnapshot(projectId: string,pinned?: SnapshotId): Promise<{snapshot:SnapshotId;tree:Tree}> { const manifest=await this.manifest(projectId,pinned); return {snapshot:manifest.snapshot,tree:this.treeFor(manifest)}; }
  async tree(projectId:string): Promise<Tree> { return (await this.readTreeSnapshot(projectId)).tree; }
  private findDocument(manifest:Manifest,id:string,index=this.snapshotIndex(manifest)): Document { const found=index.firstDocumentByLookupId.get(id); if (!found) fail(404,"scene_not_found","Document not found"); return found; }
  async readSceneSnapshot(projectId:string,sceneId:string,pinned?:SnapshotId) {
    const manifest=await this.manifest(projectId,pinned), index=this.snapshotIndex(manifest), document=this.findDocument(manifest,sceneId,index);
    const paths=index.pathsByDocumentId.get(document.id), manuscriptPath=paths?.bodyPath, metadataPath=paths?.metadataPath;
    const manuscript=manuscriptPath ? manifest.files[manuscriptPath] : undefined, metadata=metadataPath ? manifest.files[metadataPath] : undefined;
    if (!manuscriptPath || !metadataPath || !manuscript || !metadata) fail(404,"scene_not_found","Scene body not found");
    return {snapshot:manifest.snapshot,scene:{id:this.logicalId(index,document),title:document.title,text:body(manuscript.content),revision:hash(metadata.content+"\0"+manuscript.content)},document:{path:manuscriptPath,content:manuscript.content,revision:manuscript.revision},metadata:{path:metadataPath,content:metadata.content,revision:metadata.revision}};
  }
  async readScene(projectId:string,sceneId:string):Promise<Scene> { return (await this.readSceneSnapshot(projectId,sceneId)).scene; }
  async resolveDocumentScene(projectId:string,path:string,pinned?:SnapshotId) { safePath(path); const manifest=await this.manifest(projectId,pinned),index=this.snapshotIndex(manifest); const id=manifest.files[path]?.documentId; const document=id ? index.documentsById.get(id):undefined; return {snapshot:manifest.snapshot,sceneId:document ? this.logicalId(index,document):null}; }
  async searchSnapshot(projectId:string,query:string,limit=20,pinned?:SnapshotId):Promise<{snapshot:SnapshotId;results:LiteralSearchResult[]}> {
    if (typeof query!=="string" || query.length>512 || !Number.isInteger(limit) || limit<1) fail(400,"invalid_search_query","Invalid search query or limit");
    const manifest=await this.manifest(projectId,pinned),index=this.snapshotIndex(manifest); const results:LiteralSearchResult[]=[];
    const normalizedQuery=query.toLocaleLowerCase();
    if (query) for (const document of manifest.documents) { const bodyPath=index.pathsByDocumentId.get(document.id)?.bodyPath,entry=bodyPath ? manifest.files[bodyPath] : undefined; for (const field of ["name","body"] as const) {
      const text=field==="name" ? document.title:entry ? body(entry.content):""; const folded=text.toLocaleLowerCase(), match=folded.indexOf(normalizedQuery); if(match<0)continue;
      let offset=match, end=match+normalizedQuery.length;
      if(folded.length!==text.length) {
        let original=0, normalized=0;
        for(const character of text) {
          const next=normalized+character.toLocaleLowerCase().length;
          if(normalized<=match && match<next) offset=original;
          if(normalized<match+normalizedQuery.length && match+normalizedQuery.length<=next) { end=original+character.length; break; }
          original+=character.length; normalized=next;
        }
      }
      results.push({id:this.logicalId(index,document),type:document.kind as LiteralSearchResult["type"],name:document.title,snippet:text.slice(Math.max(0,offset-48),end+48),filePath:bodyPath ?? "",score:field==="name"?2:1,field,offset,length:end-offset});
    }}
    return {snapshot:manifest.snapshot,results:results.sort((a,b)=>b.score-a.score).slice(0,Math.min(limit,100))};
  }
  async writingStatsSnapshot(projectId:string,pinned?:SnapshotId):Promise<{snapshot:SnapshotId;stats:WritingStats}> {
    const manifest=await this.manifest(projectId,pinned),index=this.snapshotIndex(manifest),tree=this.treeFor(manifest,index),sceneById:Record<string,SceneWritingStats>={}; let totalCharCount=0;
    const volumes=tree.volumes.map((volume)=>{const chapters=volume.chapters.map((chapter)=>{const scenes=chapter.scenes.map((scene)=>{const document=this.findDocument(manifest,scene.id,index); const charCount=index.sceneCharacterCountsByDocumentId.get(document.id) ?? 0; const stat={sceneId:scene.id,charCount,pages400:Math.ceil(charCount/400)}; sceneById[scene.id]=stat;return stat;});const charCount=scenes.reduce((sum,s)=>sum+s.charCount,0);return {chapterId:chapter.id,charCount,pages400:Math.ceil(charCount/400),scenes};});const charCount=chapters.reduce((sum,c)=>sum+c.charCount,0);totalCharCount+=charCount;return {volumeId:volume.id,charCount,pages400:Math.ceil(charCount/400),chapters};});
    return {snapshot:manifest.snapshot,stats:{totalCharCount,totalPages400:Math.ceil(totalCharCount/400),volumes,sceneById}};
  }
  private async proposalStatus(reader:PersistenceReader,projectId:string,proposalId:string):Promise<{recordVersion:number;status:ProposalStatus}|null> {
    const record=await reader.getModuleRecord(pid(projectId),AUTHORITY,`proposal:${proposalId}`); return record ? {recordVersion:record.version,status:record.value as unknown as ProposalStatus}:null;
  }
  async listProposalsSnapshot(projectId:string):Promise<{snapshot:SnapshotId;proposals:ProposalStatus[]}> { return this.persistence.read(async reader => {
      const project=await reader.getProject(pid(projectId));
      if(!project) fail(404,"project_not_found","Project not found");
      const proposals=(await reader.listModuleRecords(pid(projectId),AUTHORITY)).filter(record=>record.key.startsWith("proposal:")).map(record=>{
        const status=record.value as unknown as ProposalStatus;
        return {...status,stale:status.proposal.snapshot.projectVersion!==project.version};
      });
      return {snapshot:{projectId,projectVersion:project.version},proposals};
    }); }
  async listProposals(projectId:string):Promise<ProposalStatus[]> { return (await this.listProposalsSnapshot(projectId)).proposals; }
  async reviewQueue(projectIds: readonly string[] | null): Promise<{ unresolvedCount: number; items: Array<{ projectId: string; proposal: ProposalStatus }> }> {
    return this.persistence.read(async reader => {
      const { unresolvedCount, records } = await reader.listProposalReviewQueue(projectIds === null ? null : projectIds.map(pid), AUTHORITY, 1000);
      return { unresolvedCount, items: records.map(({ record, projectVersion }) => {
        const status = record.value as unknown as ProposalStatus;
        return { projectId: record.projectId, proposal: { ...status, stale: status.proposal.snapshot.projectVersion !== projectVersion } };
      }) };
    });
  }
  async getProposal(projectId:string,proposalId:string):Promise<ProposalStatus|null> { return this.persistence.read(async reader => {
      const found=await this.proposalStatus(reader,projectId,proposalId);
      if(!found) return null;
      const project=await reader.getProject(pid(projectId));
      if(!project) return null;
      return {...found.status,stale:found.status.proposal.snapshot.projectVersion!==project.version};
    }); }
  async propose(projectId: string, proposal: ChangeProposal): Promise<ChangeProposal> {
    try {
      assertPersistedProposal(proposal);
    } catch (error) {
      fail(400, "invalid_proposal", error instanceof Error ? error.message : "Invalid proposal");
    }
    if (proposal.snapshot.projectId !== projectId) {
      fail(409, "proposal_scope_mismatch", "Proposal belongs to another project");
    }

    return this.persistence.transaction(async (transaction) => {
      const existing = await this.proposalStatus(transaction, projectId, proposal.id);
      if (existing) {
        if (proposalDigest(existing.status.proposal) !== proposalDigest(proposal)) {
          fail(409, "proposal_identity_conflict", "Proposal identity has a different payload");
        }
        return existing.status.proposal;
      }

      await transaction.assertProjectVersion(pid(projectId), proposal.snapshot.projectVersion);
      const manifest = await this.currentManifest(transaction, projectId);
      const reader = makeReader(manifest);
      for (const operation of proposal.operations) {
        await assertEvidenceRevisions(reader, proposal, operation);
      }

      const state: ProposalStatus = {
        proposal: structuredClone(proposal),
        state: "proposed",
        approvedOperationIds: [],
        applications: [],
        appliedOperationIds: [],
        stale: false,
      };
      await transaction.saveModuleRecord({
        projectId: pid(projectId),
        moduleId: AUTHORITY,
        key: `proposal:${proposal.id}`,
        value: state as unknown as JsonObject,
        expectedVersion: null,
      });
      return structuredClone(proposal);
    });
  }

  async approve(projectId: string, approval: Approval): Promise<void> {
    const uniqueOperationIds = new Set(approval.operationIds);
    if (!approval.authorScope?.trim() || !approval.operationIds.length || uniqueOperationIds.size !== approval.operationIds.length) {
      fail(400, "invalid_approval", "Author identity and unique operation identities are required");
    }

    await this.persistence.transaction(async (transaction) => {
      const found = await this.proposalStatus(transaction, projectId, approval.proposalId);
      if (!found) fail(404, "proposal_not_found", "Proposal not found");

      const state = found.status;
      for (const operationId of approval.operationIds) {
        if (!state.proposal.operations.some((operation) => operation.id === operationId)) {
          fail(400, "invalid_approval", "Operation is outside this proposal");
        }
      }

      // A repeated approval is an idempotent replay once every operation is applied.
      // Never regress the durable terminal status back to approved.
      if (state.state === "applied") return;

      state.approvedOperationIds = [...new Set([...state.approvedOperationIds, ...approval.operationIds])];
      const approvers = { ...state.approvedByOperationId };
      for (const id of approval.operationIds) approvers[id] ??= approval.authorScope;
      state.approvedByOperationId = approvers;
      state.state = state.approvedOperationIds.length === state.proposal.operations.length
        ? "approved"
        : "partially_approved";
      await transaction.saveModuleRecord({
        projectId: pid(projectId),
        moduleId: AUTHORITY,
        key: `proposal:${approval.proposalId}`,
        value: { ...state, approvedBy: approval.authorScope } as unknown as JsonObject,
        expectedVersion: found.recordVersion,
      });
    });
  }

  private async applyWrites(tx: PersistenceTransaction, manifest: Manifest, operation: ChangeOperation, authorId: string): Promise<void> {
    const projectId=pid(operation.projectId);
    const metadataWrites = operation.writes.filter((write) => /^plot\/volumes\/.+\.yaml$/.test(write.path));
    // Parents are inserted before children; removals are processed deepest first.
    const ordered = [
      ...metadataWrites
        .filter((write) => write.content !== null)
        .sort((left, right) => left.path.split("/").length - right.path.split("/").length),
      ...operation.writes.filter((write) => !metadataWrites.includes(write)),
      ...metadataWrites
        .filter((write) => write.content === null)
        .sort((left, right) => right.path.split("/").length - left.path.split("/").length),
    ];
    const documents = [...manifest.documents];
    const paths = new Map<string, string>();
    for (const [path, file] of Object.entries(manifest.files)) {
      if (file.documentId && file.metadata) paths.set(path, file.documentId);
    }
    const manuscriptCreates = new Set<string>();

    for (const write of ordered) {
      if (write.textChanges !== undefined) {
        const currentFile = manifest.files[write.path];
        if (operation.effect !== "manuscript" || !currentFile?.documentId || currentFile.metadata) {
          fail(422, "invalid_document_changes", "Exact text changes may only target an existing PostgreSQL manuscript");
        }
      }
      if (write.path === "meta/project.yaml") {
        if (write.content === null) {
          fail(422, "invalid_project_metadata", "Project metadata cannot be deleted");
        }
        const value = YAML.parse(write.content);
        if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonValue(value)) {
          fail(422, "invalid_project_metadata", "Project metadata must be an object");
        }
        const { title, ...settings } = value;
        await tx.updateProject({
          projectId,
          expectedVersion: (await tx.getProject(projectId))!.version,
          title: typeof title === "string" ? title : manifest.project.title,
          settings,
        });
        continue;
      }

      if (metadataWrites.includes(write)) {
        const existingId = paths.get(write.path);
        const existing = existingId ? documents.find((document) => document.id === existingId) : undefined;
        if (write.content === null) {
          if (existing) {
            await tx.deleteDocument({ projectId, documentId: existing.id, expectedVersion: existing.version });
          }
          continue;
        }

        const data = YAML.parse(write.content);
        if (!data || typeof data !== "object" || Array.isArray(data) || !isJsonValue(data)) {
          fail(422, "invalid_hierarchy_metadata", "Hierarchy metadata must be an object");
        }
        const volume = /^plot\/volumes\/([^/]+)\/volume.yaml$/.exec(write.path);
        const chapter = /^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/chapter.yaml$/.exec(write.path);
        const scene = /^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/scenes\/([^/]+).yaml$/.exec(write.path);
        if (!volume && !chapter && !scene) {
          fail(422, "invalid_hierarchy_metadata", "Unknown hierarchy metadata path");
        }

        const kind = volume ? "volume" : chapter ? "chapter" : "scene";
        const parentPath = chapter
          ? `plot/volumes/${chapter[1]}/volume.yaml`
          : scene
            ? `plot/volumes/${scene[1]}/chapters/${scene[2]}/chapter.yaml`
            : null;
        const parentId = parentPath ? paths.get(parentPath) : null;
        if (!existing && parentPath && !parentId) fail(422, "missing_hierarchy_parent", "Hierarchy parent is missing");

        const title = typeof data.title === "string"
          ? data.title
          : typeof data.name === "string"
            ? data.name
            : String(data.id ?? existing?.id ?? "");
        const manuscriptPath = kind === "scene"
          ? typeof data.manuscript === "string"
            ? data.manuscript
            : `manuscript/${scene![1]}/${scene![2]}/${scene![3]}.md`
          : undefined;
        if (manuscriptPath) safePath(manuscriptPath);

        const id = existing?.id ?? stableId(operation.projectId, write.path);
        let document: Document;
        if (existing) {
          document = await tx.updateDocument({
            projectId,
            documentId: id,
            // The projected metadata path may describe the document's former
            // hierarchy location. Parent identity is canonical in PostgreSQL;
            // updating a title or order must not reparent an existing record.
            parentId: existing.parentId,
            title,
            orderKey: String(data.order ?? existing.orderKey),
            expectedVersion: existing.version,
          });
        } else {
          const manuscript = manuscriptPath
            ? operation.writes.find((candidate) => candidate.path === manuscriptPath)
            : undefined;
          document = (await tx.createDocument({
            projectId,
            documentId: id,
            parentId: parentId as DocumentId | null,
            kind,
            title,
            orderKey: String(data.order ?? "0"),
            markdown: manuscript?.content ?? "",
            authorId,
            idempotencyKey: `${operation.id}:${operation.generation}:${id}`,
          })).document;
          if (manuscriptPath) manuscriptCreates.add(manuscriptPath);
          documents.push(document);
        }

        paths.set(write.path, id);
        const mapping = await tx.getModuleRecord(projectId, PATHS, id);
        await tx.saveModuleRecord({
          projectId,
          moduleId: PATHS,
          key: id,
          value: { metadataPath: write.path, ...(manuscriptPath ? { manuscriptPath } : {}), metadata: data },
          expectedVersion: mapping?.version ?? null,
        });
        continue;
      }

      if (manuscriptCreates.has(write.path)) continue;
      const known = manifest.files[write.path];
      if (known?.documentId && !known.metadata) {
        const document = await tx.getDocument(projectId, known.documentId as DocumentId);
        if (!document) continue;
        if (write.content === null) {
          const sceneIsBeingDeleted = metadataWrites.some((candidate) =>
            candidate.content === null && manifest.files[candidate.path]?.documentId === document.id,
          );
          if (sceneIsBeingDeleted) continue;
          fail(422, "invalid_document_delete", "Delete a scene using its hierarchy metadata");
        }
        if (write.encoding === "base64") {
          fail(422, "invalid_manuscript_encoding", "Manuscripts must be UTF-8");
        }

        const revision = await tx.getRevision(projectId, document.id, document.headRevisionId!);
        if (!revision) fail(409, "missing_revision", "Document head is missing");
        await tx.saveDocument({
          projectId,
          documentId: document.id,
          baseRevisionId: revision.id,
          changes: write.textChanges ?? [{ fromUtf16: 0, toUtf16: revision.markdown.length, insert: write.content }],
          resultingSha256: hash(write.content),
          authorId,
          clientId: "core",
          idempotencyKey: `${operation.id}:${operation.generation}:${write.path}`,
        });
        continue;
      }

      if (write.path.startsWith("manuscript/") || write.path.startsWith("documents/")) {
        fail(422, "unbound_manuscript", "Manuscript writes require a canonical document or hierarchy creation");
      }
      const record = await tx.getModuleRecord(projectId, ARTIFACTS, write.path);
      await tx.saveModuleRecord({
        projectId,
        moduleId: ARTIFACTS,
        key: write.path,
        value: write.content === null
          ? { deleted: true }
          : { content: write.content, encoding: write.encoding ?? "utf8" },
        expectedVersion: record?.version ?? null,
      });
    }
  }
  async apply(projectId: string, operation: ChangeOperation): Promise<ApplyReceipt> {
    assertChangeOperation(operation);
    assertUserOperationPaths(operation);
    if (operation.projectId !== projectId) {
      fail(409, "operation_scope_mismatch", "Operation belongs to another project");
    }

    return this.persistence.transaction(async (transaction) => {
      // Serialize every project mutation before reading approval or precondition state.
      await transaction.assertProjectVersion(pid(projectId));
      const proposalRecords = (await transaction.listModuleRecords(pid(projectId), AUTHORITY))
        .filter((record) => record.key.startsWith("proposal:"));
      const approved = proposalRecords.find((record) => {
        const status = record.value as unknown as ProposalStatus;
        return status.approvedOperationIds.includes(operation.id) &&
          status.proposal.operations.some((candidate) => operationDigest(candidate) === operationDigest(operation));
      });
      if (!approved) {
        fail(403, "operation_not_approved", "The exact operation must be approved by an authenticated author");
      }

      const state = approved.value as unknown as ProposalStatus;
      const replay = state.applications.find((receipt) =>
        receipt.operationId === operation.id && receipt.generation === operation.generation,
      );
      if (replay) return replay;

      const manifest = await this.currentManifest(transaction, projectId);
      const reader = makeReader(manifest);
      await assertEvidenceRevisions(reader, state.proposal, operation);
      for (const precondition of [...operation.reads, ...operation.writes]) {
        const currentRevision = (await reader.read(precondition.path))?.revision ?? null;
        if (currentRevision !== precondition.revision) {
          fail(409, "revision_conflict", `The revision changed: ${precondition.path}`);
        }
      }
      for (const scope of operation.readScopes ?? []) {
        if (await snapshotScopeRevision(reader, scope.prefix) !== scope.revision) {
          fail(409, "scope_conflict", `The scope changed: ${scope.prefix}`);
        }
      }
      for (const set of operation.readDocumentSets ?? []) {
        const siblings = (await transaction.listDocuments(pid(projectId), set.parentId as DocumentId | null, 1000))
          .filter((document) => document.kind === set.kind)
          .map((document) => document.id)
          .sort();
        if (JSON.stringify(siblings) !== JSON.stringify([...set.documentIds].sort())) {
          fail(409, "scope_conflict", `The ${set.kind} sibling set changed`);
        }
      }
      const legacyHierarchyReorder = !operation.readDocumentSets?.length &&
        operation.effect === "structure" && operation.message === "Reorder hierarchy" &&
        operation.writes.length > 0 && operation.writes.every(({ path }) =>
          /^plot\/volumes\/[^/]+\/volume\.yaml$/.test(path) ||
          /^plot\/volumes\/[^/]+\/chapters\/[^/]+\/chapter\.yaml$/.test(path) ||
          /^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.yaml$/.test(path));
      if (legacyHierarchyReorder && manifest.snapshot.projectVersion !== operation.baseProjectVersion) {
        fail(409, "scope_conflict", "A legacy hierarchy reorder cannot be applied after project content changed");
      }

      const authorId = state.approvedByOperationId?.[operation.id]
        ?? (state as ProposalStatus & { approvedBy?: string }).approvedBy;
      if (!authorId) fail(409, "approval_actor_missing", "Approved operation has no durable author identity");
      await this.applyWrites(transaction, manifest, operation, authorId);
      const after = await this.currentManifest(transaction, projectId);
      const receipt: ApplyReceipt = {
        operationId: operation.id,
        generation: operation.generation,
        projectVersion: Math.max(after.project.version, manifest.project.version + 1),
        revisions: operation.writes.map((write) => ({
          path: write.path,
          revision: after.files[write.path]?.revision ?? null,
        })),
      };

      state.applications.push(receipt);
      state.appliedOperationIds.push(operation.id);
      if (state.appliedOperationIds.length === state.proposal.operations.length) state.state = "applied";
      await transaction.saveModuleRecord({
        projectId: pid(projectId),
        moduleId: AUTHORITY,
        key: approved.key,
        value: state as unknown as JsonObject,
        expectedVersion: approved.version,
      });
      return receipt;
    });
  }
  private async buildOperation(projectId:string,writes:FileChange[],effect:ChangeOperation["effect"],message:string,pinned?:SnapshotId):Promise<BuiltChangeOperation> {const reader=await this.reader(projectId,pinned);return {snapshot:reader.snapshot,operation:{id:randomUUID(),generation:0,projectId,baseProjectVersion:reader.snapshot.projectVersion,effect,reads:writes.map(({path,revision})=>({path,revision})),writes,message}};}
  async buildCreateHierarchyOperation(projectId:string,input:CreateHierarchyInput,pinned?:SnapshotId):Promise<BuiltChangeOperation>{
    if(!input||!["volume","chapter","scene"].includes(input.kind)||typeof input.id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(input.id)||!input.title?.trim())fail(400,"invalid_hierarchy_operation","A path-safe identity and title are required");
    const manifest=await this.manifest(projectId,pinned),index=this.snapshotIndex(manifest);if(index.logicalDocumentIds.has(input.id))fail(409,"hierarchy_id_exists","The hierarchy identity already exists");
    const reader=makeReader(manifest),writes:FileChange[]=[];let path:string;
    if(input.kind==="volume")path=`plot/volumes/${input.id}/volume.yaml`;
    else {const volume=this.findDocument(manifest,input.volumeId);if(volume.kind!=="volume")fail(422,"invalid_hierarchy_parent","The parent must be a volume");path=`plot/volumes/${input.volumeId}/chapters/${input.id}/chapter.yaml`;
      if(input.kind==="scene"){const chapter=this.findDocument(manifest,input.chapterId);if(chapter.kind!=="chapter"||chapter.parentId!==volume.id)fail(422,"invalid_hierarchy_parent","The chapter must belong to the volume");path=`plot/volumes/${input.volumeId}/chapters/${input.chapterId}/scenes/${input.id}.yaml`;const manuscript=`manuscript/${input.volumeId}/${input.chapterId}/${input.id}.md`;writes.push({path:manuscript,revision:null,content:input.manuscriptBody??""});}}
    if(await reader.read(path))fail(409,"hierarchy_path_exists","The hierarchy path already exists");writes.unshift({path,revision:null,content:YAML.stringify({id:input.id,title:input.title,order:manifest.documents.length+1})});
    return this.buildOperation(projectId,writes,"structure",`Create ${input.kind} ${input.id}`,manifest.snapshot);
  }
  async buildDeleteHierarchyOperation(projectId:string,input:HierarchyTarget,pinned?:SnapshotId):Promise<BuiltChangeOperation>{
    const manifest=await this.manifest(projectId,pinned),index=this.snapshotIndex(manifest),target=this.findDocument(manifest,input.id,index);if(target.kind!==input.kind)fail(422,"invalid_hierarchy_target","Hierarchy kind mismatch");
    const selected=new Set<string>([target.id]),pending=[target.id];for(let cursor=0;cursor<pending.length;cursor++)for(const document of index.documentsByParentId.get(pending[cursor]!)??[])if(!selected.has(document.id)){selected.add(document.id);pending.push(document.id);}
    const entries=Object.entries(manifest.files).filter(([,file])=>file.documentId&&selected.has(file.documentId));
    if (!pinned) {
      // JSONB object key order differs from the original current projection.
      // Retain its document order and metadata-before-body write ordering.
      const order = new Map(manifest.documents.map((document, position) => [document.id, position]));
      entries.sort(([,left],[,right]) => order.get(left.documentId as DocumentId)! - order.get(right.documentId as DocumentId)! ||
        Number(Boolean(right.metadata)) - Number(Boolean(left.metadata)));
    }
    const writes=entries.map(([path,file])=>({path,revision:file.revision,content:null}));return this.buildOperation(projectId,writes,"structure",`Delete ${input.kind} ${input.id}`,manifest.snapshot);
  }
  async buildReorderHierarchyOperation(projectId:string,input:ReorderHierarchyInput,pinned?:SnapshotId):Promise<BuiltChangeOperation>{
    const manifest=await this.manifest(projectId,pinned),index=this.snapshotIndex(manifest);let parent:Document|undefined;if(input.kind==="chapter")parent=this.findDocument(manifest,input.volumeId,index);if(input.kind==="scene")parent=this.findDocument(manifest,input.chapterId,index);
    const siblings=(index.documentsByParentId.get(parent?.id??null)??[]).filter((document)=>document.kind===input.kind);const expected=siblings.map((document)=>this.logicalId(index,document)).sort();if(JSON.stringify([...input.orderedIds].sort())!==JSON.stringify(expected))fail(422,"invalid_hierarchy_order","Reorder must include every sibling exactly once");
    const writes=input.orderedIds.map((id,order)=>{const document=this.findDocument(manifest,id,index),path=index.pathsByDocumentId.get(document.id)?.metadataPath,entry=path ? manifest.files[path] : undefined;if(!path||!entry)fail(409,"snapshot_unavailable","Document metadata is missing from the project snapshot");return {path,revision:entry.revision,content:YAML.stringify({...YAML.parse(entry.content),order:String(order).padStart(10,"0")})};});
    const built=await this.buildOperation(projectId,writes,"structure","Reorder hierarchy",manifest.snapshot);
    built.operation.readDocumentSets=[{
      kind: input.kind,
      parentId: parent?.id ?? null,
      documentIds: siblings.map((document) => document.id).sort(),
    }];
    return built;
  }
  async buildRestoreOperation(projectId:string,input:{sceneId:string;snapshotId:string}|string,revisionId?:string,pinned?:SnapshotId):Promise<BuiltChangeOperation>{
    const sceneId=typeof input==="string"?input:input.sceneId,sourceId=typeof input==="string"?revisionId:input.snapshotId;const manifest=await this.manifest(projectId,pinned),index=this.snapshotIndex(manifest),document=this.findDocument(manifest,sceneId,index);
    const revision=document.headRevisionId ? await this.persistence.read((reader)=>reader.getRevision(pid(projectId),document.id,sourceId as RevisionId,document.headRevisionId!)) : undefined;if(!revision)fail(404,"revision_not_found","Revision not found");const path=index.pathsByDocumentId.get(document.id)?.bodyPath,file=path ? manifest.files[path] : undefined;if(!path||!file)fail(409,"snapshot_unavailable","Document body is missing from the project snapshot");return this.buildOperation(projectId,[{path,revision:file.revision,content:revision.markdown}],"manuscript","Restore manuscript revision",manifest.snapshot);
  }
  async listManuscriptSnapshots(projectId:string,manuscriptId:string,sceneId?:string,pinned?:SnapshotId):Promise<{snapshot:SnapshotId;snapshots:ManuscriptSnapshotMeta[]}>{
    const manifest=await this.manifest(projectId,pinned),index=this.snapshotIndex(manifest),document=this.findDocument(manifest,sceneId??manuscriptId,index),page=document.headRevisionId ? await this.persistence.read((reader)=>reader.listRevisions(pid(projectId),document.id,100,undefined,document.headRevisionId!)) : {revisions:[]};return {snapshot:manifest.snapshot,snapshots:page.revisions.map((revision)=>({id:revision.id,sceneId:this.logicalId(index,document),manuscriptId,createdAt:Date.parse(revision.createdAt),charCount:Array.from(body(revision.markdown)).length,source:"postgres"}))};
  }
  async readManuscriptSnapshot(projectId:string,snapshotId:string,manuscriptId:string,sceneId?:string,pinned?:SnapshotId):Promise<{snapshot:SnapshotId;manuscriptSnapshot:ManuscriptSnapshot}>{
    const manifest=await this.manifest(projectId,pinned),index=this.snapshotIndex(manifest),document=this.findDocument(manifest,sceneId??manuscriptId,index);const revision=document.headRevisionId ? await this.persistence.read((reader)=>reader.getRevision(pid(projectId),document.id,snapshotId as RevisionId,document.headRevisionId!)) : undefined;if(!revision)fail(404,"revision_not_found","Revision not found");const path=index.pathsByDocumentId.get(document.id)?.bodyPath,file=path ? manifest.files[path] : undefined;if(!path||!file)fail(409,"snapshot_unavailable","Document body is missing from the project snapshot");return {snapshot:manifest.snapshot,manuscriptSnapshot:{id:revision.id,sceneId:this.logicalId(index,document),manuscriptId,createdAt:Date.parse(revision.createdAt),charCount:Array.from(body(revision.markdown)).length,source:"postgres",body:body(revision.markdown),document:{path,content:revision.markdown,revision:revision.sha256}}};
  }
  async status(projectId:string) { const observation=await this.observe(projectId);return {...observation.snapshot,state:"durable" as const}; }
  async history(projectId:string,pinned?:SnapshotId):Promise<Commit[]> {
    const manifest = await this.manifest(projectId,pinned);
    const heads = manifest.documents.flatMap(document => document.headRevisionId ? [{documentId:document.id,revisionId:document.headRevisionId}] : []);
    const revisions = await this.persistence.read(reader => reader.listProjectRevisionHistory(pid(projectId), heads, 100));
    return revisions.map(revision => ({hash:revision.id,date:revision.createdAt,message:`Document revision ${revision.documentId}`}));
  }
}
