import { createHash } from 'node:crypto';
import {
  type ApplyReceipt,
  type Approval,
  assertChangeOperation,
  assertProjectPath,
  type ChangeOperation,
  type ChangeProposal,
  isModulePreservationArchivePath,
  isPrivatePublishingPath,
  isPublishingRecordKey,
  type MutationCoordinator,
  type NativeChangeSetReference,
  type NativeStoryDocument,
  NLP_FEATURE_SETTINGS_KEY,
  NLP_LEGACY_FEATURE_SETTINGS_PATH,
  nextOrderKey,
  type OwnModuleRecord,
  type OwnModuleRecordProposal,
  type ProjectObservation,
  type ProposalStatus,
  PUBLISHING_EPISODES_KEY,
  PUBLISHING_RECORD_KEYS,
  parseNlpFeatureSettings,
  parsePublishingEpisodesRecord,
  parsePublishingShareGrantIndex,
  SNAPSHOT_READ_MANY_LIMIT,
  type SnapshotFile,
  type SnapshotId,
  type SnapshotKnowledgeProjection,
  type SnapshotReader,
  snapshotScopeRevision,
} from '@codexia/contracts';
import type {
  ChangeSet,
  ChangeSetApplicationResult,
  ChangeSetResult,
  DocumentHeadRevisionLookup,
  DocumentRevisionKey,
  RestoreDocumentRevisionCommand,
} from '@codexia/persistence-contracts';
import {
  type Document,
  type DocumentId,
  HIERARCHY_CREATE_SOURCE,
  HIERARCHY_DELETE_SOURCE,
  HIERARCHY_REORDER_SOURCE,
  type HierarchyDocumentCreate,
  hierarchyDocumentPaths,
  type JsonObject,
  NLP_FEATURE_SETTINGS_CHANGESET_SOURCE,
  CORE_DOCUMENT_PATHS as PATHS,
  type Persistence,
  PersistenceError,
  type PersistenceReader,
  type PersistenceTransaction,
  type Project,
  type ProjectId,
  type ProjectPageCursor,
  type ProposalReviewQueueOptions,
  PUBLISHING_CHANGESET_SOURCE,
  type RevisionId,
} from '@codexia/persistence-contracts';
import YAML from 'yaml';
import { makeKnowledgeProjection, projectKnowledgeContext } from './knowledge-context.js';
import { assertPersistedProposal, assertUserOperationPaths, isJsonValue, operationDigest, proposalDigest } from './operation-records.js';
import {
  createSnapshotIndex,
  estimateSnapshotIndexBytes,
  type InlineSnapshotFile,
  manuscriptBody,
  manuscriptCharacterCount,
  type SnapshotIndex,
  type SnapshotIndexFile,
} from './snapshot-index.js';

export type { ProposalStatus } from '@codexia/contracts';
export type { Project } from '@codexia/persistence-contracts';
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
  source: 'postgres';
  label?: string;
  trigger?: 'manual' | 'submit' | 'idle';
}

export interface ManuscriptSnapshot extends ManuscriptSnapshotMeta {
  /** Legacy editor body with YAML frontmatter removed. */
  body: string;
  /** Exact historical Markdown bytes decoded as UTF-8, including frontmatter. */
  document: { path: string; content: string; revision: string };
}

export interface LiteralSearchResult {
  id: string;
  type: 'scene' | 'chapter' | 'volume' | 'manuscript';
  name?: string;
  snippet?: string;
  filePath: string;
  score: number;
  field?: 'body' | 'name';
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

export type HierarchyKind = 'volume' | 'chapter' | 'scene';

export type CreateHierarchyInput =
  | { kind: 'volume'; id: string; title: string }
  | { kind: 'chapter'; id: string; title: string; volumeId: string }
  | { kind: 'scene'; id: string; title: string; volumeId: string; chapterId: string; manuscriptBody?: string };

export type HierarchyTarget =
  | { kind: 'volume'; id: string }
  | { kind: 'chapter'; id: string; volumeId: string }
  | { kind: 'scene'; id: string; volumeId: string; chapterId: string };

export type ReorderHierarchyInput =
  | { kind: 'volume'; orderedIds: string[] }
  | { kind: 'chapter'; volumeId: string; orderedIds: string[] }
  | { kind: 'scene'; volumeId: string; chapterId: string; orderedIds: string[] };

export interface ProposeHierarchyOptions {
  projectVersion: number;
  actorId: string;
  idempotencyKey: string;
  origin?: 'author' | 'external-agent';
}

export type ProposeHierarchyReorderOptions = ProposeHierarchyOptions;

export type ProposeManuscriptRestoreInput = Pick<RestoreDocumentRevisionCommand, 'documentId' | 'baseRevisionId' | 'sourceRevisionId'>;

export interface ProposeManuscriptRestoreOptions {
  actorId: string;
  idempotencyKey: string;
  origin?: 'author' | 'external-agent';
  snapshot?: SnapshotId;
}

export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}
export interface CoreStoreOptions {
  persistence: Persistence;
}
/**
 * A review-feed projection over the two durable proposal authorities.
 * The discriminant and protocol fields intentionally preserve their distinct
 * approval granularity and receipt semantics.
 */
export type AuthorReviewItem =
  | {
      kind: 'core-proposal';
      id: string;
      projectId: string;
      createdAt: string;
      state: ProposalStatus['state'];
      approvalModel: 'per-operation';
      applicationModel: 'per-operation';
      status: ProposalStatus;
      receipts: ProposalStatus['applications'];
      stale: boolean;
    }
  | {
      kind: 'native-change-set';
      id: string;
      projectId: string;
      createdAt: string;
      state: ChangeSet['status'];
      approvalModel: 'whole-change-set';
      applicationModel: 'transaction';
      changeSet: ChangeSet;
      receipt: ChangeSetApplicationResult | null;
    };
type StoredFile = SnapshotIndexFile;
type Manifest = {
  snapshot: SnapshotId;
  files: Record<string, StoredFile>;
  documents: Document[];
  project: Project;
  publishingRecords?: Partial<Record<(typeof PUBLISHING_RECORD_KEYS)[number], OwnModuleRecord>>;
  nlpFeatureSettings?: OwnModuleRecord | null;
  knowledge?: SnapshotKnowledgeProjection;
  logicalDocumentIds?: Record<string, string>;
};
type SnapshotIndexEntry = { index: SnapshotIndex; bytes: number };
type StoryProjectionEntry = { documents: NativeStoryDocument[]; fingerprint: string; bytes: number };
const AUTHORITY = 'core.authority.proposals';
const SNAPSHOTS = 'core.authority.snapshots';
// Increment this proof epoch when the canonical projected bytes change. Older
// pinned snapshots retain their original key and are never rewritten.
export const SNAPSHOT_PROJECTION_EPOCH = 2;
function projectionProofKey(version: number): string {
  return `proof:projection:${SNAPSHOT_PROJECTION_EPOCH}:snapshot:${version}`;
}
const ARTIFACTS = 'core.artifacts';
const RETIRED_PROJECT_SETTINGS_PATH = 'meta/project.yaml';
const RETIRED_KNOWLEDGE_CONTEXT_PATH = 'meta/scriptorium/knowledge-context/v1.json';
const MAX_SNAPSHOT_INDEX_ENTRIES = 8;
const MAX_SNAPSHOT_INDEX_BYTES = 4 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const pid = (value: string) => value as ProjectId;
function fail(status: number, code: string, message: string): never {
  throw new CoreError(status, code, message);
}
function assertCurrentOperationPaths(operation: ChangeOperation): void {
  for (const { path } of operation.writes) {
    if (path === RETIRED_PROJECT_SETTINGS_PATH) {
      fail(409, 'project_settings_reproposal_required', 'Submit the project settings update using the current project version');
    }
    if (isPrivatePublishingPath(path)) {
      fail(409, 'publishing_reproposal_required', 'Propose this update from the Publishing panel using the current project state');
    }
    if (path === NLP_LEGACY_FEATURE_SETTINGS_PATH) {
      fail(409, 'nlp_feature_settings_reproposal_required', 'Propose the NLP settings update using the current project snapshot');
    }
  }
}
function assertKnowledgeRevision(manifest: Manifest, operation: ChangeOperation): void {
  if (operation.readKnowledgeRevision !== undefined && operation.readKnowledgeRevision !== manifest.knowledge?.source.revision) {
    fail(409, 'scope_conflict', 'The Knowledge projection changed since this operation was prepared');
  }
}
function safePath(value: string): void {
  assertProjectPath(value);
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function snapshotKey(projectId: string, projectVersion: number): string {
  return `${projectId}\0${projectVersion}`;
}
function storedManifest(value: unknown, projectId: string, projectVersion: number): Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(409, 'snapshot_unavailable', 'The stored immutable project snapshot is invalid');
  const manifest = value as Manifest;
  if (
    !manifest.snapshot ||
    manifest.snapshot.projectId !== projectId ||
    manifest.snapshot.projectVersion !== projectVersion ||
    !manifest.project ||
    manifest.project.id !== projectId ||
    manifest.project.version !== projectVersion ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files) ||
    !Array.isArray(manifest.documents)
  ) {
    fail(409, 'snapshot_unavailable', 'The stored immutable project snapshot does not match its project version');
  }
  return manifest;
}
function manifestFingerprint(manifest: Manifest): string {
  return hash(canonicalJson(manifest));
}
function storyMetadata(mapping: JsonObject | undefined): JsonObject {
  const metadata = mapping?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}
function storyDocumentId(document: Document, metadata: JsonObject): string {
  return typeof metadata.id === 'string' ? metadata.id : document.id;
}
function stableId(projectId: string, key: string): DocumentId {
  const value = hash(`${projectId}\0${key}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}` as DocumentId;
}
type LoadSnapshotRevisions = (heads: readonly DocumentRevisionKey[]) => Promise<readonly DocumentHeadRevisionLookup[]>;

async function resolveSnapshotFiles(
  projectId: string,
  files: readonly (StoredFile | undefined)[],
  loadRevisions: LoadSnapshotRevisions,
): Promise<readonly (InlineSnapshotFile | null)[]> {
  const heads = files.flatMap(file => (file && 'revisionId' in file ? [file] : []));
  const rows = heads.length ? await loadRevisions(heads) : [];
  let next = 0;
  return files.map(file => {
    if (!file) return null;
    if (!('revisionId' in file)) return file;
    const lookup = rows[next++];
    const revision = lookup?.revision;
    if (
      !revision ||
      lookup.documentId !== file.documentId ||
      lookup.revisionId !== file.revisionId ||
      revision.projectId !== projectId ||
      revision.documentId !== file.documentId ||
      revision.id !== file.revisionId ||
      revision.sha256 !== file.revision
    ) {
      fail(409, 'snapshot_unavailable', 'The immutable manuscript revision does not match its snapshot');
    }
    return { content: revision.markdown, encoding: 'utf8', revision: file.revision, documentId: file.documentId };
  });
}

function snapshotFile(manifest: Manifest, path: string): StoredFile | undefined {
  safePath(path);
  return Object.hasOwn(manifest.files, path) ? manifest.files[path] : undefined;
}

function makeReader(
  manifest: Manifest,
  loadRevisions: LoadSnapshotRevisions,
  nativeStoryDocuments?: () => readonly NativeStoryDocument[],
): SnapshotReader {
  const documentKinds = new Map<string, string>(manifest.documents.map(document => [String(document.id), document.kind]));
  const documentOrder = new Map(manifest.documents.map((document, index) => [String(document.id), index]));
  const { project } = manifest;
  const settings = project.settings ?? {};
  const configuredTitle = Object.hasOwn(settings, 'title') ? settings.title : project.title;
  const title =
    [configuredTitle, settings.name].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ??
    'Project';
  const subtitle = typeof settings.subtitle === 'string' ? settings.subtitle.trim() : '';
  async function readMany(paths: readonly string[], encoding: 'utf8' | 'base64' = 'utf8'): Promise<readonly (SnapshotFile | null)[]> {
    if (paths.length > SNAPSHOT_READ_MANY_LIMIT) fail(400, 'invalid_snapshot_batch', 'Too many paths in a snapshot body batch');
    const files = await resolveSnapshotFiles(
      manifest.snapshot.projectId,
      paths.map(path => snapshotFile(manifest, path)),
      loadRevisions,
    );
    return files.map(file => {
      if (!file) return null;
      const bytes = Buffer.from(file.content, file.encoding);
      const documentKind = file.documentId ? documentKinds.get(file.documentId) : undefined;
      const order = file.documentId ? documentOrder.get(file.documentId) : undefined;
      return {
        content: bytes.toString(encoding),
        revision: file.revision,
        ...(documentKind ? { documentKind } : {}),
        ...(order === undefined ? {} : { documentOrder: order }),
      };
    });
  }
  return {
    snapshot: structuredClone(manifest.snapshot),
    projectPresentation: { title, ...(subtitle ? { subtitle } : {}) },
    get knowledge() {
      const knowledge = manifest.knowledge;
      if (!knowledge) return undefined;
      if (
        knowledge.source?.kind !== 'knowledge-projection' ||
        knowledge.source.snapshot?.projectId !== manifest.snapshot.projectId ||
        knowledge.source.snapshot.projectVersion !== manifest.snapshot.projectVersion
      ) {
        fail(409, 'snapshot_unavailable', 'Select a current snapshot for the typed Knowledge projection');
      }
      return structuredClone(knowledge);
    },
    get nativeStoryDocuments() {
      const documents = nativeStoryDocuments?.() ?? [];
      return documents.length ? structuredClone(documents) : undefined;
    },
    async read(filePath, encoding = 'utf8') {
      return (await readMany([filePath], encoding))[0] ?? null;
    },
    readMany,
    async list(prefix) {
      if (prefix) safePath(prefix);
      return Object.keys(manifest.files)
        .filter(key => !prefix || key === prefix || key.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
        .sort();
    },
    async listRevisions(prefix) {
      return (await this.list(prefix)).map(path => ({ path, revision: manifest.files[path]!.revision }));
    },
  };
}

function manifestFileRevision(manifest: Manifest, path: string): string | null {
  return snapshotFile(manifest, path)?.revision ?? null;
}

function assertEvidenceRevisions(manifest: Manifest, proposal: ChangeProposal, operation: ChangeOperation): void {
  const evidenceById = new Map((proposal.evidence ?? []).map(item => [item.id, item]));
  for (const evidenceId of operation.evidenceIds ?? []) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) fail(400, 'invalid_proposal', 'Operation references missing proposal evidence');
    for (const path of evidence.paths) {
      const currentRevision = manifestFileRevision(manifest, path.path);
      if (currentRevision !== path.revision) {
        fail(409, 'evidence_revision_conflict', `The evidence revision changed: ${path.path}`);
      }
    }
  }
}

/** PostgreSQL is the sole durable manuscript, metadata and approved-operation authority. */
export class CoreStore implements MutationCoordinator {
  readonly persistence: Persistence;
  private readonly snapshotIndexes = new Map<string, SnapshotIndexEntry>();
  private snapshotIndexBytes = 0;
  private readonly storyProjectionCache = new Map<string, StoryProjectionEntry>();
  private storyProjectionBytes = 0;
  constructor(options: CoreStoreOptions) {
    this.persistence = options.persistence;
  }
  async listProjectsPage(limit = 100, after?: ProjectPageCursor): Promise<{ projects: Project[]; nextCursor: ProjectPageCursor | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Project page size must be between 1 and 200');
    const rows = await this.persistence.read(reader => {
      if (!reader.listProjectPage) throw new Error('Project pagination is unavailable from this persistence adapter');
      return reader.listProjectPage(limit + 1, after);
    });
    const hasMore = rows.length > limit;
    const projects = [...rows.slice(0, limit)];
    const last = projects.at(-1);
    return { projects, nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null };
  }
  async createProject(input: { title: string; settings?: JsonObject }): Promise<Project> {
    return this.persistence.transaction(tx => tx.createProject(input));
  }
  private nativeStoryProjection(manifest: Manifest): NativeStoryDocument[] {
    const key = snapshotKey(manifest.snapshot.projectId, manifest.snapshot.projectVersion);
    const filesByDocument = new Map<string, { path: string; file: InlineSnapshotFile }>();
    for (const [path, file] of Object.entries(manifest.files)) {
      if (file.metadata && file.documentId && 'content' in file) filesByDocument.set(file.documentId, { path, file });
    }
    const sources = manifest.documents.flatMap((document, documentOrder) => {
      if (document.kind !== 'volume' && document.kind !== 'chapter' && document.kind !== 'scene') return [];
      const source = filesByDocument.get(document.id);
      if (!source) fail(409, 'snapshot_unavailable', 'Native Story document metadata is missing from its immutable snapshot');
      return [{ document, documentOrder, ...source }];
    });
    for (const { file } of sources) {
      if (hash(Buffer.from(file.content, file.encoding)) !== file.revision)
        fail(409, 'snapshot_unavailable', 'Native Story metadata does not match its immutable revision');
    }
    const fingerprint = hash(
      JSON.stringify(
        sources.map(({ document, documentOrder, path, file }) => [
          document.id,
          document.kind,
          document.title,
          document.orderKey,
          path,
          file.revision,
          documentOrder,
        ]),
      ),
    );
    const cached = this.storyProjectionCache.get(key);
    if (cached?.fingerprint === fingerprint) {
      this.storyProjectionCache.delete(key);
      this.storyProjectionCache.set(key, cached);
      return cached.documents;
    }
    const documents = sources.map(({ document, documentOrder, path: metadataPath, file }) => {
      const metadataContent = Buffer.from(file.content, file.encoding).toString('utf8');
      let value: unknown;
      try {
        value = YAML.parse(metadataContent);
      } catch {
        fail(409, 'snapshot_unavailable', 'Native Story metadata is invalid');
      }
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof (value as Record<string, unknown>).id !== 'string' ||
        (value as Record<string, unknown>).title !== document.title ||
        (value as Record<string, unknown>).order !== document.orderKey
      ) {
        fail(409, 'snapshot_unavailable', 'Native Story metadata does not match its canonical document identity');
      }
      return {
        id: (value as Record<string, unknown>).id as string,
        kind: document.kind,
        title: document.title,
        orderKey: document.orderKey,
        metadataPath,
        metadataRevision: file.revision,
        metadataContent,
        documentOrder,
        metadata: value as Record<string, unknown>,
      };
    });
    const bytes = Buffer.byteLength(JSON.stringify(documents), 'utf8');
    if (bytes <= MAX_SNAPSHOT_INDEX_BYTES) {
      if (cached) this.storyProjectionBytes -= cached.bytes;
      this.storyProjectionCache.delete(key);
      this.storyProjectionCache.set(key, { documents, fingerprint, bytes });
      this.storyProjectionBytes += bytes;
      while (this.storyProjectionCache.size > MAX_SNAPSHOT_INDEX_ENTRIES || this.storyProjectionBytes > MAX_SNAPSHOT_INDEX_BYTES) {
        const oldest = this.storyProjectionCache.entries().next().value as [string, StoryProjectionEntry] | undefined;
        if (!oldest) break;
        this.storyProjectionCache.delete(oldest[0]);
        this.storyProjectionBytes -= oldest[1].bytes;
      }
    }
    return documents;
  }
  private async currentManifest(reader: PersistenceReader, projectId: string, knownProject?: Project): Promise<Manifest> {
    const project = knownProject ?? (await reader.getProject(pid(projectId)));
    if (!project) fail(404, 'project_not_found', 'Project not found');
    const documents = [...(await reader.listDocuments(pid(projectId), undefined, 1000))];
    if (documents.length === 1000) fail(413, 'snapshot_too_large', 'Project snapshot exceeds the supported document bound');
    const headKeys = documents.flatMap(document =>
      document.headRevisionId ? [{ documentId: document.id, revisionId: document.headRevisionId }] : [],
    );
    const headRevisions = await reader.getDocumentHeadRevisionHashes(pid(projectId), headKeys);
    const revisionsByHead = new Map(headRevisions.map(head => [JSON.stringify([head.documentId, head.revisionId]), head.sha256]));
    const pathRecords = await reader.listModuleRecords(pid(projectId), PATHS);
    const artifacts = await reader.listModuleRecords(pid(projectId), ARTIFACTS);
    const publishingRecords: NonNullable<Manifest['publishingRecords']> = {};
    for (const key of PUBLISHING_RECORD_KEYS) {
      const record = await reader.getModuleRecord(pid(projectId), 'publishing', key);
      if (record) publishingRecords[key] = { value: record.value, version: record.version };
    }
    const nlpRecord = await reader.getModuleRecord(pid(projectId), 'nlp', NLP_FEATURE_SETTINGS_KEY);
    const nlpFeatureSettings = nlpRecord ? { value: nlpRecord.value, version: nlpRecord.version } : null;
    const files: Record<string, StoredFile> = {};
    const add = (key: string, file: StoredFile) => {
      safePath(key);
      if (files[key]) fail(409, 'duplicate_document_path', 'Project contains duplicate document paths');
      files[key] = file;
    };
    const addInline = (
      key: string,
      content: string,
      { encoding = 'utf8', documentId, metadata }: Partial<Omit<InlineSnapshotFile, 'content' | 'revision'>> = {},
    ) => {
      add(key, {
        content,
        encoding,
        revision: hash(Buffer.from(content, encoding)),
        ...(documentId ? { documentId } : {}),
        ...(metadata ? { metadata: true } : {}),
      });
    };
    const byId = new Map(documents.map(document => [document.id, document]));
    const mappings = new Map(pathRecords.map(record => [record.key, record.value]));
    const logicalDocumentIds: Record<string, string> = {};
    const metadataFor = (document: Document) => storyMetadata(mappings.get(document.id));
    const projectedId = (document: Document) => storyDocumentId(document, metadataFor(document));
    for (const document of documents) {
      const mapping = mappings.get(document.id);
      const parent = document.parentId ? byId.get(document.parentId) : undefined;
      const grandparent = parent?.parentId ? byId.get(parent.parentId) : undefined;
      const metadataPath =
        typeof mapping?.metadataPath === 'string'
          ? mapping.metadataPath
          : document.kind === 'volume'
            ? `plot/volumes/${document.id}/volume.yaml`
            : document.kind === 'chapter'
              ? `plot/volumes/${parent?.id ?? 'root'}/chapters/${document.id}/chapter.yaml`
              : document.kind === 'scene'
                ? `plot/volumes/${grandparent?.id ?? 'root'}/chapters/${parent?.id ?? 'root'}/scenes/${document.id}.yaml`
                : undefined;
      const manuscriptPath = typeof mapping?.manuscriptPath === 'string' ? mapping.manuscriptPath : `documents/${document.id}.md`;
      const logicalId = projectedId(document);
      if (metadataPath !== undefined) {
        const metadata = { ...metadataFor(document) };
        // Derive hierarchy links from the same pinned rows as the document.
        if (document.kind === 'chapter' || document.kind === 'scene') {
          delete metadata.volume;
          delete metadata.chapter;
          if (document.kind === 'chapter' && parent?.kind === 'volume') {
            metadata.volume = projectedId(parent);
          }
          if (document.kind === 'scene' && parent?.kind === 'chapter') {
            metadata.chapter = projectedId(parent);
            if (grandparent?.kind === 'volume') metadata.volume = projectedId(grandparent);
          }
        }
        const projectedMetadata = {
          ...metadata,
          id: logicalId,
          title: document.title,
          order: document.orderKey,
          ...(document.kind === 'scene' ? { manuscript: manuscriptPath } : {}),
        };
        addInline(metadataPath, YAML.stringify(projectedMetadata), { documentId: document.id, metadata: true });
      } else if (logicalId !== document.id) {
        // Preserve explicitly mapped identities for documents with no metadata file.
        logicalDocumentIds[document.id] = logicalId;
      }
      if (document.headRevisionId) {
        const revision = revisionsByHead.get(JSON.stringify([document.id, document.headRevisionId]));
        if (!revision) fail(409, 'missing_revision', 'Document head revision is missing');
        if (document.kind !== 'volume' && document.kind !== 'chapter') {
          add(manuscriptPath, { documentId: document.id, revisionId: document.headRevisionId, revision });
        }
      }
    }
    for (const record of artifacts) {
      if (
        record.value.deleted === true ||
        record.key === RETIRED_PROJECT_SETTINGS_PATH ||
        record.key === RETIRED_KNOWLEDGE_CONTEXT_PATH ||
        record.key === NLP_LEGACY_FEATURE_SETTINGS_PATH ||
        isPrivatePublishingPath(record.key)
      )
        continue;
      if (typeof record.value.content !== 'string') fail(422, 'invalid_artifact', 'Artifact body must be text');
      addInline(record.key, record.value.content, { encoding: record.value.encoding === 'base64' ? 'base64' : 'utf8' });
    }
    const documentMappings = documents
      .filter(document => document.kind === 'scene')
      .map(document => ({ documentId: document.id, storySceneId: projectedId(document) }));
    const snapshot = { projectId, projectVersion: project.version };
    const knowledge = makeKnowledgeProjection(snapshot, await projectKnowledgeContext(reader, pid(projectId), documents, documentMappings));
    return {
      snapshot,
      files,
      documents,
      project,
      publishingRecords,
      knowledge,
      nlpFeatureSettings,
      ...(Object.keys(logicalDocumentIds).length ? { logicalDocumentIds } : {}),
    };
  }
  private async manifest(projectId: string, pinned?: SnapshotId): Promise<Manifest> {
    if (pinned && pinned.projectId !== projectId) fail(409, 'snapshot_scope_mismatch', 'Snapshot belongs to another project');
    const resolved = await this.persistence.read(async reader => {
      if (pinned) {
        const saved = await reader.getModuleRecord(pid(projectId), SNAPSHOTS, `snapshot:${pinned.projectVersion}`);
        if (saved) return { manifest: storedManifest(saved.value, projectId, pinned.projectVersion), needsPersistence: false };
      }
      const project = await reader.getProject(pid(projectId));
      if (!project) fail(404, 'project_not_found', 'Project not found');
      if (pinned && project.version !== pinned.projectVersion)
        fail(409, 'snapshot_unavailable', 'The requested immutable project snapshot is unavailable');
      if (!pinned) {
        const saved = await reader.getModuleRecord(pid(projectId), SNAPSHOTS, `snapshot:${project.version}`);
        if (saved) {
          const manifest = storedManifest(saved.value, projectId, project.version);
          const proof = await reader.getModuleRecord(pid(projectId), SNAPSHOTS, projectionProofKey(project.version));
          if (proof?.value.snapshotRecordVersion !== saved.version) {
            fail(409, 'snapshot_unavailable', 'Current snapshot requires explicit projection maintenance before reuse');
          }
          return { manifest, needsPersistence: false };
        }
      }
      return { manifest: await this.currentManifest(reader, projectId, project), needsPersistence: true };
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
    const index = createSnapshotIndex(manifest.documents, manifest.files, manifest.logicalDocumentIds);
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
    return this.persistence.transaction(async tx => {
      let record: Awaited<ReturnType<PersistenceReader['getModuleRecord']>>;
      try {
        record = await tx.saveModuleRecord({
          projectId,
          moduleId: SNAPSHOTS,
          key,
          value: manifest as unknown as JsonObject,
          expectedVersion: null,
        });
      } catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== 'conflict') throw error;
        record = await tx.getModuleRecord(projectId, SNAPSHOTS, key);
        if (!record) throw error;
      }
      const saved = storedManifest(record.value, projectId, version);
      if (manifestFingerprint(saved) !== manifestFingerprint(manifest)) {
        fail(409, 'snapshot_unavailable', 'Concurrent snapshot builders produced different immutable project snapshots');
      }
      // The immutable record and its proof are committed together, under the
      // existing project lock. Proofs are scoped to the exact record version.
      const proofKey = projectionProofKey(version);
      const proof = await tx.getModuleRecord(projectId, SNAPSHOTS, proofKey);
      if (!proof) {
        await tx.saveModuleRecord({
          projectId,
          moduleId: SNAPSHOTS,
          key: proofKey,
          value: { snapshotRecordVersion: record.version },
          expectedVersion: null,
        });
      } else if (proof.value.snapshotRecordVersion !== record.version) {
        fail(409, 'snapshot_unavailable', 'Stored snapshot compatibility proof does not match its immutable record');
      }
      return saved;
    });
  }

  /**
   * Apply a projection transition for a project selected by explicit maintenance.
   * A projection change is a new semantic snapshot version, not a content edit.
   * Equivalent legacy snapshots acquire a proof; incompatible snapshots retain
   * their original pinned bytes and the project advances under its version fence.
   * Ordinary reads never perform this transition.
   */
  async prepareSnapshotReuse(project: string): Promise<void> {
    const projectId = pid(project);
    for (let attempt = 0; attempt < 3; attempt++) {
      const legacy = await this.persistence.read(async reader => {
        const project = await reader.getProject(projectId);
        if (!project) fail(404, 'project_not_found', 'Project not found');
        const record = await reader.getModuleRecord(projectId, SNAPSHOTS, `snapshot:${project.version}`);
        if (!record) return null;
        const proof = await reader.getModuleRecord(projectId, SNAPSHOTS, projectionProofKey(project.version));
        if (proof?.value.snapshotRecordVersion === record.version) return null;
        const saved = storedManifest(record.value, projectId, project.version);
        const fresh = await this.currentManifest(reader, projectId, project);
        return {
          version: project.version,
          recordVersion: record.version,
          fresh,
          equivalent: manifestFingerprint(saved) === manifestFingerprint(fresh),
        };
      });
      if (!legacy) return;
      if (legacy.equivalent) {
        await this.persistManifest(legacy.fresh);
        return;
      }
      try {
        await this.persistence.transaction(async tx => {
          await tx.assertProjectVersion(projectId, legacy.version);
          const record = await tx.getModuleRecord(projectId, SNAPSHOTS, `snapshot:${legacy.version}`);
          if (!record || record.version !== legacy.recordVersion) {
            fail(409, 'snapshot_unavailable', 'Legacy snapshot changed during the compatibility transition');
          }
          const proof = await tx.getModuleRecord(projectId, SNAPSHOTS, projectionProofKey(legacy.version));
          if (proof) fail(409, 'snapshot_unavailable', 'Incompatible snapshot has an unexpected compatibility proof');
          // The projected bytes changed: allocate a new SnapshotId while
          // preserving manuscript, metadata, and every old pinned record.
          await tx.updateProject({ projectId, expectedVersion: legacy.version });
        });
        return;
      } catch (error) {
        if (!(error instanceof PersistenceError) || error.code !== 'conflict') throw error;
        // A concurrent content mutation or maintenance transition advanced the
        // version. Re-read the current project instead of bumping it again.
      }
    }
    fail(409, 'snapshot_unavailable', 'Project changed repeatedly during the projection compatibility transition');
  }
  async reader(projectId: string, pinned?: SnapshotId): Promise<SnapshotReader> {
    const manifest = await this.manifest(projectId, pinned);
    return makeReader(
      manifest,
      heads => this.loadSnapshotRevisions(projectId, heads),
      () => this.nativeStoryProjection(manifest),
    );
  }
  private loadSnapshotRevisions(projectId: string, heads: readonly DocumentRevisionKey[]) {
    return this.persistence.read(reader => reader.getDocumentHeadRevisions(pid(projectId), heads));
  }
  private resolveSnapshotFiles(projectId: string, files: readonly (StoredFile | undefined)[]) {
    return resolveSnapshotFiles(projectId, files, heads => this.loadSnapshotRevisions(projectId, heads));
  }
  async readPublishingSnapshotRecord(projectId: string, snapshot: SnapshotId, key: string): Promise<OwnModuleRecord | undefined> {
    if (!isPublishingRecordKey(key)) fail(400, 'invalid_publishing_record', 'Publishing record key is not supported');
    const manifest = await this.manifest(projectId, snapshot);
    if (!manifest.publishingRecords) fail(409, 'snapshot_unavailable', 'Select a current snapshot for Publishing settings');
    return structuredClone(manifest.publishingRecords[key]);
  }

  async proposePublishingSnapshotRecord(
    projectId: string,
    snapshot: SnapshotId,
    input: OwnModuleRecordProposal,
    actorId: string,
  ): Promise<NativeChangeSetReference> {
    return this.proposeSnapshotModuleRecord(projectId, snapshot, input, actorId, 'publishing');
  }

  async readNlpFeatureSettingsSnapshotRecord(projectId: string, snapshot: SnapshotId): Promise<OwnModuleRecord | undefined> {
    const { nlpFeatureSettings } = await this.manifest(projectId, snapshot);
    if (nlpFeatureSettings === undefined) fail(409, 'snapshot_unavailable', 'Select a current snapshot for NLP feature settings');
    return structuredClone(nlpFeatureSettings ?? undefined);
  }

  async proposeNlpFeatureSettingsSnapshotRecord(
    projectId: string,
    snapshot: SnapshotId,
    input: OwnModuleRecordProposal,
    actorId: string,
    origin: 'author' | 'external-agent' = 'author',
  ): Promise<NativeChangeSetReference> {
    return this.proposeSnapshotModuleRecord(projectId, snapshot, input, actorId, 'nlp', origin);
  }

  private async proposeSnapshotModuleRecord(
    projectId: string,
    snapshot: SnapshotId,
    input: OwnModuleRecordProposal,
    actorId: string,
    moduleId: 'publishing' | 'nlp',
    origin?: 'author' | 'external-agent',
  ): Promise<NativeChangeSetReference> {
    const { key, value, expectedVersion, idempotencyKey } = input;
    if (snapshot.projectId !== projectId) fail(409, 'snapshot_scope_mismatch', 'Snapshot belongs to another project');
    const publishing = moduleId === 'publishing';
    const source = publishing ? PUBLISHING_CHANGESET_SOURCE : NLP_FEATURE_SETTINGS_CHANGESET_SOURCE;
    const errorCode = publishing ? 'invalid_publishing_record' : 'invalid_nlp_feature_settings';
    const label = publishing ? 'Publishing record' : 'NLP feature settings';
    if (
      !(publishing ? isPublishingRecordKey(key) : key === NLP_FEATURE_SETTINGS_KEY) ||
      !isJsonValue(value) ||
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) ||
      !idempotencyKey.trim() ||
      idempotencyKey.length > 200 ||
      !actorId.trim()
    ) {
      fail(400, errorCode, `${label}, version, idempotency key and author are required`);
    }
    let record: JsonObject;
    try {
      if (!publishing) record = parseNlpFeatureSettings(value);
      else record = key === PUBLISHING_EPISODES_KEY ? parsePublishingEpisodesRecord(value) : parsePublishingShareGrantIndex(value);
    } catch {
      fail(400, errorCode, `${label} does not match its canonical format`);
    }
    const recordId = JSON.stringify([moduleId, key]);
    const actorOrigin: JsonObject = origin === undefined ? {} : { origin };
    const requestDigest = hash(canonicalJson({ actorId, key, value: record, expectedVersion, ...actorOrigin }));
    return this.persistence.transaction(async tx => {
      await tx.assertProjectVersion(pid(projectId));
      const existing = await tx.getChangeSetByIdempotencyKey(pid(projectId), idempotencyKey);
      if (existing) {
        if (
          existing.authorId !== actorId ||
          existing.provenance.source !== source ||
          existing.provenance.details.requestDigest !== requestDigest
        ) {
          throw new PersistenceError('idempotency_conflict', 'Idempotency key was already used for a different request', {
            resource: 'idempotency_key',
            id: idempotencyKey,
          });
        }
        return { id: existing.id, projectId: existing.projectId };
      }
      const { changeSet } = await tx.createChangeSet({
        projectId: pid(projectId),
        authorId: actorId,
        idempotencyKey,
        operations: [
          {
            type: 'module.record.save',
            command: {
              projectId: pid(projectId),
              moduleId,
              key,
              value: record,
              expectedVersion,
            },
          },
        ],
        readSet: [{ resource: 'module_record', id: recordId, expectedVersion }],
        writeSet: [{ resource: 'module_record', id: recordId }],
        provenance: {
          source,
          actorId,
          details: {
            projectVersion: snapshot.projectVersion,
            requestDigest,
            ...actorOrigin,
          },
        },
      });
      return { id: changeSet.id, projectId: changeSet.projectId };
    });
  }
  async observe(projectId: string): Promise<ProjectObservation> {
    const project = await this.persistence.read(reader => reader.getProject(pid(projectId)));
    if (!project) fail(404, 'project_not_found', 'Project not found');
    return { snapshot: { projectId, projectVersion: project.version }, observedAt: new Date().toISOString(), state: 'fresh' };
  }
  private logicalId(index: SnapshotIndex, document: Document): string {
    return index.logicalIdByDocumentId.get(document.id) ?? document.id;
  }
  private treeFor(manifest: Manifest, index = this.snapshotIndex(manifest)): Tree {
    return {
      title: manifest.project.title,
      volumes: index.volumes.map(volume => ({
        id: this.logicalId(index, volume),
        title: volume.title,
        chapters: (index.chaptersByVolumeId.get(volume.id) ?? []).map(chapter => ({
          id: this.logicalId(index, chapter),
          title: chapter.title,
          scenes: (index.scenesByChapterId.get(chapter.id) ?? []).map(scene => ({
            id: this.logicalId(index, scene),
            title: scene.title,
          })),
        })),
      })),
    };
  }
  async readTreeSnapshot(projectId: string, pinned?: SnapshotId): Promise<{ snapshot: SnapshotId; tree: Tree }> {
    const manifest = await this.manifest(projectId, pinned);
    return { snapshot: manifest.snapshot, tree: this.treeFor(manifest) };
  }
  async tree(projectId: string): Promise<Tree> {
    return (await this.readTreeSnapshot(projectId)).tree;
  }
  private findDocument(manifest: Manifest, id: string, index = this.snapshotIndex(manifest)): Document {
    const found = index.firstDocumentByLookupId.get(id);
    if (!found) fail(404, 'scene_not_found', 'Document not found');
    return found;
  }
  async readSceneSnapshot(projectId: string, sceneId: string, pinned?: SnapshotId) {
    const manifest = await this.manifest(projectId, pinned),
      index = this.snapshotIndex(manifest),
      document = this.findDocument(manifest, sceneId, index);
    if (document.kind !== 'scene') fail(404, 'scene_not_found', 'Scene not found');
    const paths = index.pathsByDocumentId.get(document.id),
      manuscriptPath = paths?.bodyPath,
      metadataPath = paths?.metadataPath;
    const metadata = metadataPath ? manifest.files[metadataPath] : undefined;
    if (!manuscriptPath || !metadataPath || !metadata || !('content' in metadata)) fail(404, 'scene_not_found', 'Scene body not found');
    const [manuscript] = await this.resolveSnapshotFiles(projectId, [manifest.files[manuscriptPath]]);
    if (!manuscript) fail(404, 'scene_not_found', 'Scene body not found');
    return {
      snapshot: manifest.snapshot,
      scene: {
        id: this.logicalId(index, document),
        title: document.title,
        text: manuscriptBody(manuscript.content),
        revision: hash(metadata.content + '\0' + manuscript.content),
      },
      document: { path: manuscriptPath, content: manuscript.content, revision: manuscript.revision },
      metadata: { path: metadataPath, content: metadata.content, revision: metadata.revision },
    };
  }
  async readScene(projectId: string, sceneId: string): Promise<Scene> {
    return (await this.readSceneSnapshot(projectId, sceneId)).scene;
  }
  async resolveSnapshotDocument(projectId: string, path: string, pinned?: SnapshotId) {
    safePath(path);
    const manifest = await this.manifest(projectId, pinned);
    const id = manifest.files[path]?.documentId;
    const document = id ? this.snapshotIndex(manifest).documentsById.get(id) : undefined;
    return { snapshot: manifest.snapshot, documentId: document?.id ?? null };
  }
  async searchSnapshot(
    projectId: string,
    query: string,
    limit = 20,
    pinned?: SnapshotId,
  ): Promise<{ snapshot: SnapshotId; results: LiteralSearchResult[] }> {
    if (typeof query !== 'string' || query.length > 512 || !Number.isInteger(limit) || limit < 1)
      fail(400, 'invalid_search_query', 'Invalid search query or limit');
    const manifest = await this.manifest(projectId, pinned),
      index = this.snapshotIndex(manifest);
    const results: LiteralSearchResult[] = [];
    const normalizedQuery = query.toLocaleLowerCase();
    for (let start = 0; query && start < manifest.documents.length; start += SNAPSHOT_READ_MANY_LIMIT) {
      const documents = manifest.documents.slice(start, start + SNAPSHOT_READ_MANY_LIMIT);
      const bodyPaths = documents.map(document => index.pathsByDocumentId.get(document.id)?.bodyPath);
      const bodies = await this.resolveSnapshotFiles(
        projectId,
        bodyPaths.map(path => (path ? manifest.files[path] : undefined)),
      );
      for (const [position, document] of documents.entries()) {
        const bodyPath = bodyPaths[position];
        const entry = bodies[position];
        for (const field of ['name', 'body'] as const) {
          const text = field === 'name' ? document.title : entry ? manuscriptBody(entry.content) : '';
          const folded = text.toLocaleLowerCase(),
            match = folded.indexOf(normalizedQuery);
          if (match < 0) continue;
          let offset = match,
            end = match + normalizedQuery.length;
          if (folded.length !== text.length) {
            let original = 0,
              normalized = 0;
            for (const character of text) {
              const next = normalized + character.toLocaleLowerCase().length;
              if (normalized <= match && match < next) offset = original;
              if (normalized < match + normalizedQuery.length && match + normalizedQuery.length <= next) {
                end = original + character.length;
                break;
              }
              original += character.length;
              normalized = next;
            }
          }
          results.push({
            id: this.logicalId(index, document),
            type: document.kind as LiteralSearchResult['type'],
            name: document.title,
            snippet: text.slice(Math.max(0, offset - 48), end + 48),
            filePath: bodyPath ?? '',
            score: field === 'name' ? 2 : 1,
            field,
            offset,
            length: end - offset,
          });
        }
      }
    }
    return { snapshot: manifest.snapshot, results: results.sort((a, b) => b.score - a.score).slice(0, Math.min(limit, 100)) };
  }
  async writingStatsSnapshot(projectId: string, pinned?: SnapshotId): Promise<{ snapshot: SnapshotId; stats: WritingStats }> {
    const manifest = await this.manifest(projectId, pinned);
    const index = this.snapshotIndex(manifest);
    const sceneStats = new Map<string, SceneWritingStats>();
    const scenes = manifest.documents
      .filter(document => document.kind === 'scene')
      .map(document => {
        const sceneId = this.logicalId(index, document);
        // A scene's logical ID can resolve to an earlier document of another kind.
        return { sceneId, sourceId: this.findDocument(manifest, sceneId, index).id };
      });
    const counts = index.writingCharacterCountsByDocumentId;
    const missing = [...new Set(scenes.map(({ sourceId }) => sourceId))].filter(sourceId => !counts.has(sourceId));
    for (let start = 0; start < missing.length; start += SNAPSHOT_READ_MANY_LIMIT) {
      const documents = missing.slice(start, start + SNAPSHOT_READ_MANY_LIMIT);
      const files = documents.map(sourceId => {
        const path = index.pathsByDocumentId.get(sourceId)?.bodyPath;
        return path ? manifest.files[path] : undefined;
      });
      const bodies = await this.resolveSnapshotFiles(projectId, files);
      for (const [position, sourceId] of documents.entries()) {
        counts.set(sourceId, manuscriptCharacterCount(bodies[position]?.content ?? ''));
      }
    }
    let totalCharCount = 0;
    for (const { sceneId, sourceId } of scenes) {
      const charCount = counts.get(sourceId) ?? 0;
      sceneStats.set(sceneId, { sceneId, charCount, pages400: Math.ceil(charCount / 400) });
      totalCharCount += charCount;
    }
    const volumes = this.treeFor(manifest, index).volumes.map(volume => {
      const chapters = volume.chapters.map(chapter => {
        const scenes = chapter.scenes.map(scene => sceneStats.get(scene.id)!);
        const charCount = scenes.reduce((sum, scene) => sum + scene.charCount, 0);
        return { chapterId: chapter.id, charCount, pages400: Math.ceil(charCount / 400), scenes };
      });
      const charCount = chapters.reduce((sum, chapter) => sum + chapter.charCount, 0);
      return { volumeId: volume.id, charCount, pages400: Math.ceil(charCount / 400), chapters };
    });
    return {
      snapshot: manifest.snapshot,
      stats: {
        totalCharCount,
        totalPages400: Math.ceil(totalCharCount / 400),
        volumes,
        sceneById: Object.fromEntries(sceneStats),
      },
    };
  }
  private async proposalStatus(
    reader: PersistenceReader,
    projectId: string,
    proposalId: string,
  ): Promise<{ recordVersion: number; status: ProposalStatus } | null> {
    const record = await reader.getModuleRecord(pid(projectId), AUTHORITY, `proposal:${proposalId}`);
    return record ? { recordVersion: record.version, status: record.value as unknown as ProposalStatus } : null;
  }
  async listProposalsSnapshot(projectId: string): Promise<{ snapshot: SnapshotId; proposals: ProposalStatus[] }> {
    return this.persistence.read(async reader => {
      const project = await reader.getProject(pid(projectId));
      if (!project) fail(404, 'project_not_found', 'Project not found');
      const proposals = (await reader.listModuleRecords(pid(projectId), AUTHORITY))
        .filter(record => record.key.startsWith('proposal:'))
        .map(record => {
          const status = record.value as unknown as ProposalStatus;
          return { ...status, stale: status.proposal.snapshot.projectVersion !== project.version };
        });
      return { snapshot: { projectId, projectVersion: project.version }, proposals };
    });
  }
  async listProposals(projectId: string): Promise<ProposalStatus[]> {
    return (await this.listProposalsSnapshot(projectId)).proposals;
  }
  async reviewQueue(
    projectIds: readonly string[] | null,
    options?: ProposalReviewQueueOptions,
  ): Promise<{ unresolvedCount: number; items: Array<{ projectId: string; proposal: ProposalStatus }> }> {
    return this.persistence.read(async reader => {
      const { unresolvedCount, records } = await reader.listProposalReviewQueue(
        projectIds === null ? null : projectIds.map(pid),
        AUTHORITY,
        1000,
        options,
      );
      return {
        unresolvedCount,
        items: records.map(({ record, projectVersion }) => {
          const status = record.value as unknown as ProposalStatus;
          return {
            projectId: record.projectId,
            proposal: { ...status, stale: status.proposal.snapshot.projectVersion !== projectVersion },
          };
        }),
      };
    });
  }
  /**
   * Read both durable review authorities into one author-facing feed. This is
   * a projection only: Core proposals keep per-operation approval/application,
   * while native ChangeSets keep their single transactional receipt.
   */
  async listAuthorReviews(projectId: string, limit = 50): Promise<AuthorReviewItem[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Author review page size must be between 1 and 200');
    return this.persistence.read(async reader => {
      const project = await reader.getProject(pid(projectId));
      if (!project) fail(404, 'project_not_found', 'Project not found');
      const [proposalQueue, changeSets] = await Promise.all([
        reader.listProposalReviewQueue([pid(projectId)], AUTHORITY, limit),
        reader.listChangeSets(pid(projectId), limit),
      ]);
      const coreItems: AuthorReviewItem[] = proposalQueue.records
        .filter(({ record }) => record.key.startsWith('proposal:'))
        .map(({ record, projectVersion }) => {
          const status = record.value as unknown as ProposalStatus;
          return {
            kind: 'core-proposal',
            id: status.proposal.id,
            projectId,
            createdAt: record.createdAt,
            state: status.state,
            approvalModel: 'per-operation',
            applicationModel: 'per-operation',
            status,
            receipts: status.applications,
            stale: status.proposal.snapshot.projectVersion !== projectVersion,
          };
        });
      const nativeItems: AuthorReviewItem[] = await Promise.all(
        changeSets.map(async changeSet => ({
          kind: 'native-change-set',
          id: changeSet.id,
          projectId,
          createdAt: changeSet.createdAt,
          state: changeSet.status,
          approvalModel: 'whole-change-set',
          applicationModel: 'transaction',
          changeSet,
          receipt: changeSet.status === 'applied' ? ((await reader.getChangeSetReceipt(pid(projectId), changeSet.id)) ?? null) : null,
        })),
      );
      return [...coreItems, ...nativeItems].sort(
        (left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
      );
    });
  }
  async getProposal(projectId: string, proposalId: string): Promise<ProposalStatus | null> {
    return this.persistence.read(async reader => {
      const found = await this.proposalStatus(reader, projectId, proposalId);
      if (!found) return null;
      const project = await reader.getProject(pid(projectId));
      if (!project) return null;
      return { ...found.status, stale: found.status.proposal.snapshot.projectVersion !== project.version };
    });
  }
  async propose(projectId: string, proposal: ChangeProposal): Promise<ChangeProposal> {
    try {
      assertPersistedProposal(proposal);
    } catch (error) {
      fail(400, 'invalid_proposal', error instanceof Error ? error.message : 'Invalid proposal');
    }
    if (proposal.snapshot.projectId !== projectId) {
      fail(409, 'proposal_scope_mismatch', 'Proposal belongs to another project');
    }

    return this.persistence.transaction(async transaction => {
      const existing = await this.proposalStatus(transaction, projectId, proposal.id);
      if (existing) {
        if (proposalDigest(existing.status.proposal) !== proposalDigest(proposal)) {
          fail(409, 'proposal_identity_conflict', 'Proposal identity has a different payload');
        }
        return existing.status.proposal;
      }

      // Serialize the identity check with proposal registration so concurrent first submissions
      // can observe and replay the winner after waiting for this project's mutation lock.
      await transaction.assertProjectVersion(pid(projectId));
      const registered = await this.proposalStatus(transaction, projectId, proposal.id);
      if (registered) {
        if (proposalDigest(registered.status.proposal) !== proposalDigest(proposal)) {
          fail(409, 'proposal_identity_conflict', 'Proposal identity has a different payload');
        }
        return registered.status.proposal;
      }

      await transaction.assertProjectVersion(pid(projectId), proposal.snapshot.projectVersion);
      const manifest = await this.currentManifest(transaction, projectId);
      for (const operation of proposal.operations) {
        assertCurrentOperationPaths(operation);
        assertKnowledgeRevision(manifest, operation);
        assertEvidenceRevisions(manifest, proposal, operation);
      }

      const state: ProposalStatus = {
        proposal: structuredClone(proposal),
        state: 'proposed',
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
      fail(400, 'invalid_approval', 'Author identity and unique operation identities are required');
    }

    await this.persistence.transaction(async transaction => {
      const found = await this.proposalStatus(transaction, projectId, approval.proposalId);
      if (!found) fail(404, 'proposal_not_found', 'Proposal not found');

      const state = found.status;
      for (const operationId of approval.operationIds) {
        if (!state.proposal.operations.some(operation => operation.id === operationId)) {
          fail(400, 'invalid_approval', 'Operation is outside this proposal');
        }
      }

      // A repeated approval is an idempotent replay once every operation is applied.
      // Never regress the durable terminal status back to approved.
      if (state.state === 'applied') return;

      state.approvedOperationIds = [...new Set([...state.approvedOperationIds, ...approval.operationIds])];
      const approvers = new Map(Object.entries(state.approvedByOperationId ?? {}));
      for (const id of approval.operationIds) {
        if (!approvers.has(id)) approvers.set(id, approval.authorScope);
      }
      state.approvedByOperationId = Object.fromEntries(approvers);
      state.state = state.approvedOperationIds.length === state.proposal.operations.length ? 'approved' : 'partially_approved';
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
    const projectId = pid(operation.projectId);
    const metadataWrites = operation.writes.filter(write => /^plot\/volumes\/.+\.yaml$/.test(write.path));
    // Parents are inserted before children; removals are processed deepest first.
    const ordered = [
      ...metadataWrites
        .filter(write => write.content !== null)
        .sort((left, right) => left.path.split('/').length - right.path.split('/').length),
      ...operation.writes.filter(write => !metadataWrites.includes(write)),
      ...metadataWrites
        .filter(write => write.content === null)
        .sort((left, right) => right.path.split('/').length - left.path.split('/').length),
    ];
    const documents = [...manifest.documents];
    const paths = new Map<string, string>();
    for (const [path, file] of Object.entries(manifest.files)) {
      if (file.documentId && file.metadata) paths.set(path, file.documentId);
    }
    const snapshotIndex = this.snapshotIndex(manifest);
    const logicalIds = new Set(snapshotIndex.logicalDocumentIds);
    const logicalDocuments = new Map(documents.map(document => [this.logicalId(snapshotIndex, document), document]));
    const manuscriptCreates = new Set<string>();

    for (const write of ordered) {
      if (write.textChanges !== undefined) {
        const currentFile = manifest.files[write.path];
        if (operation.effect !== 'manuscript' || !currentFile?.documentId || currentFile.metadata) {
          fail(422, 'invalid_document_changes', 'Exact text changes may only target an existing PostgreSQL manuscript');
        }
      }
      if (metadataWrites.includes(write)) {
        const existingId = paths.get(write.path);
        const existing = existingId ? documents.find(document => document.id === existingId) : undefined;
        const volume = /^plot\/volumes\/([^/]+)\/volume\.yaml$/.exec(write.path);
        const chapter = /^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/chapter\.yaml$/.exec(write.path);
        const scene = /^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/scenes\/([^/]+).yaml$/.exec(write.path);
        if (!volume && !chapter && !scene) fail(422, 'invalid_hierarchy_metadata', 'Unknown hierarchy metadata path');
        const volumeId = chapter?.[1] ?? scene?.[1];
        const chapterId = scene?.[2];
        const documentAtPath = (path: string) => {
          const documentId = paths.get(path);
          return documentId ? documents.find(document => document.id === documentId) : undefined;
        };
        const volumeDocument = volumeId
          ? (logicalDocuments.get(volumeId) ?? documentAtPath(`plot/volumes/${volumeId}/volume.yaml`))
          : undefined;
        const chapterDocument = chapterId
          ? (logicalDocuments.get(chapterId) ?? documentAtPath(`plot/volumes/${scene![1]}/chapters/${chapterId}/chapter.yaml`))
          : undefined;
        if (write.content === null) {
          if (existing) {
            await tx.deleteDocument({ projectId, documentId: existing.id, expectedVersion: existing.version });
          }
          continue;
        }

        const data = YAML.parse(write.content);
        if (!data || typeof data !== 'object' || Array.isArray(data) || !isJsonValue(data)) {
          fail(422, 'invalid_hierarchy_metadata', 'Hierarchy metadata must be an object');
        }
        const kind = volume ? 'volume' : chapter ? 'chapter' : 'scene';
        if (!existing && volumeId && volumeDocument?.kind !== 'volume')
          fail(422, 'missing_hierarchy_parent', 'Hierarchy parent is missing');
        if (!existing && chapterId && (chapterDocument?.kind !== 'chapter' || chapterDocument.parentId !== volumeDocument?.id)) {
          fail(409, 'hierarchy_parent_changed', 'The requested chapter no longer belongs to the requested volume');
        }
        const parentId = chapter ? (volumeDocument?.id ?? null) : scene ? (chapterDocument?.id ?? null) : null;

        const title =
          typeof data.title === 'string' ? data.title : typeof data.name === 'string' ? data.name : String(data.id ?? existing?.id ?? '');
        const manuscriptPath =
          kind === 'scene'
            ? typeof data.manuscript === 'string'
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
          // Portable imports retain document UUIDs and their path mappings.
          // A mapping under an imported UUID must reserve the old hierarchy
          // path even when this project's stable path-derived UUID differs.
          const archivedPaths = await tx.listModuleRecords(projectId, PATHS);
          if (archivedPaths.some(record => record.value.metadataPath === write.path)) {
            fail(409, 'hierarchy_path_reserved', 'The hierarchy path is reserved by retained document history');
          }
          const logicalId = typeof data.id === 'string' ? data.id : id;
          if (logicalIds.has(logicalId)) {
            fail(409, 'hierarchy_id_exists', 'The hierarchy ID already belongs to an active document');
          }
          const manuscript = manuscriptPath ? operation.writes.find(candidate => candidate.path === manuscriptPath) : undefined;
          document = (
            await tx.createDocument({
              projectId,
              documentId: id,
              parentId: parentId as DocumentId | null,
              kind,
              title,
              orderKey: String(
                data.order ??
                  nextOrderKey(
                    documents
                      .filter(candidate => candidate.kind === kind && candidate.parentId === parentId)
                      .map(candidate => candidate.orderKey),
                  ),
              ),
              markdown: manuscript?.content ?? '',
              authorId,
              idempotencyKey: `${operation.id}:${operation.generation}:${id}`,
            })
          ).document;
          logicalIds.add(logicalId);
          logicalDocuments.set(logicalId, document);
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
          const sceneIsBeingDeleted = metadataWrites.some(
            candidate => candidate.content === null && manifest.files[candidate.path]?.documentId === document.id,
          );
          if (sceneIsBeingDeleted) continue;
          fail(422, 'invalid_document_delete', 'Delete a scene using its hierarchy metadata');
        }
        if (write.encoding === 'base64') {
          fail(422, 'invalid_manuscript_encoding', 'Manuscripts must be UTF-8');
        }

        const revision = await tx.getRevision(projectId, document.id, document.headRevisionId!);
        if (!revision) fail(409, 'missing_revision', 'Document head is missing');
        await tx.saveDocument({
          projectId,
          documentId: document.id,
          baseRevisionId: revision.id,
          changes:
            write.textChanges ??
            (write.content === revision.markdown ? [] : [{ fromUtf16: 0, toUtf16: revision.markdown.length, insert: write.content }]),
          resultingSha256: hash(write.content),
          authorId,
          clientId: 'core',
          idempotencyKey: `${operation.id}:${operation.generation}:${write.path}`,
        });
        continue;
      }

      if (write.path.startsWith('manuscript/') || write.path.startsWith('documents/')) {
        fail(422, 'unbound_manuscript', 'Manuscript writes require a canonical document or hierarchy creation');
      }
      const record = await tx.getModuleRecord(projectId, ARTIFACTS, write.path);
      await tx.saveModuleRecord({
        projectId,
        moduleId: ARTIFACTS,
        key: write.path,
        value: write.content === null ? { deleted: true } : { content: write.content, encoding: write.encoding ?? 'utf8' },
        expectedVersion: record?.version ?? null,
      });
    }
  }
  async apply(projectId: string, operation: ChangeOperation): Promise<ApplyReceipt> {
    assertChangeOperation(operation);
    assertUserOperationPaths(operation);
    if (operation.projectId !== projectId) {
      fail(409, 'operation_scope_mismatch', 'Operation belongs to another project');
    }

    return this.persistence.transaction(async transaction => {
      // Serialize every project mutation before reading approval or precondition state.
      await transaction.assertProjectVersion(pid(projectId));
      const proposalRecords = (await transaction.listModuleRecords(pid(projectId), AUTHORITY)).filter(record =>
        record.key.startsWith('proposal:'),
      );
      const digest = operationDigest(operation);
      const approved = proposalRecords
        .map(record => ({ record, status: record.value as unknown as ProposalStatus }))
        .filter(
          ({ status }) =>
            status.approvedOperationIds.includes(operation.id) &&
            status.proposal.operations.some(candidate => candidate.id === operation.id && operationDigest(candidate) === digest),
        );
      const first = approved[0];
      if (!first) {
        fail(403, 'operation_not_approved', 'The exact operation must be approved by an authenticated author');
      }

      const applicationFor = (status: ProposalStatus) =>
        status.applications.find(receipt => receipt.operationId === operation.id && receipt.generation === operation.generation);
      const recordApplication = async (receipt: ApplyReceipt) => {
        // All exact approved copies describe the same applied operation.
        for (const { record, status } of approved) {
          if (applicationFor(status)) continue;
          status.applications.push(receipt);
          status.appliedOperationIds.push(operation.id);
          if (status.appliedOperationIds.length === status.proposal.operations.length) status.state = 'applied';
          await transaction.saveModuleRecord({
            projectId: pid(projectId),
            moduleId: AUTHORITY,
            key: record.key,
            value: status as unknown as JsonObject,
            expectedVersion: record.version,
          });
        }
        return receipt;
      };
      const replay = approved.map(({ status }) => applicationFor(status)).find(receipt => receipt !== undefined);
      if (replay) return recordApplication(replay);

      assertCurrentOperationPaths(operation);
      if (operation.writes.some(({ path }) => isModulePreservationArchivePath(path))) {
        fail(409, 'preservation_archive_read_only', 'Module preservation archives are read-only');
      }

      // These persisted reorders lack a sibling-membership precondition.
      if (
        !operation.readDocumentSets?.length &&
        operation.effect === 'structure' &&
        operation.message === 'Reorder hierarchy' &&
        operation.writes.length > 0 &&
        operation.writes.every(
          ({ path }) =>
            /^plot\/volumes\/[^/]+\/volume\.yaml$/.test(path) ||
            /^plot\/volumes\/[^/]+\/chapters\/[^/]+\/chapter\.yaml$/.test(path) ||
            /^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.yaml$/.test(path),
        )
      ) {
        fail(409, 'hierarchy_reproposal_required', 'Submit a new hierarchy reorder using the current sibling order');
      }

      const state = first.status;
      const manifest = await this.currentManifest(transaction, projectId);
      const reader = makeReader(manifest, heads => transaction.getDocumentHeadRevisions(pid(projectId), heads));
      assertKnowledgeRevision(manifest, operation);
      assertEvidenceRevisions(manifest, state.proposal, operation);
      for (const precondition of [...operation.reads, ...operation.writes]) {
        const currentRevision = manifestFileRevision(manifest, precondition.path);
        if (currentRevision !== precondition.revision) {
          fail(409, 'revision_conflict', `The revision changed: ${precondition.path}`);
        }
      }
      for (const scope of operation.readScopes ?? []) {
        if ((await snapshotScopeRevision(reader, scope.prefix)) !== scope.revision) {
          fail(409, 'scope_conflict', `The scope changed: ${scope.prefix}`);
        }
      }
      for (const set of operation.readDocumentSets ?? []) {
        const siblings = (await transaction.listDocuments(pid(projectId), set.parentId as DocumentId | null, 1000))
          .filter(document => document.kind === set.kind)
          .map(document => document.id)
          .sort();
        if (JSON.stringify(siblings) !== JSON.stringify([...set.documentIds].sort())) {
          fail(409, 'scope_conflict', `The ${set.kind} sibling set changed`);
        }
      }
      const authorId = state.approvedByOperationId?.[operation.id] ?? (state as ProposalStatus & { approvedBy?: string }).approvedBy;
      if (!authorId) fail(409, 'approval_actor_missing', 'Approved operation has no durable author identity');
      await this.applyWrites(transaction, manifest, operation, authorId);
      const after = await this.currentManifest(transaction, projectId);
      const receipt: ApplyReceipt = {
        operationId: operation.id,
        generation: operation.generation,
        projectVersion: Math.max(after.project.version, manifest.project.version + 1),
        revisions: operation.writes.map(write => ({
          path: write.path,
          revision: after.files[write.path]?.revision ?? null,
        })),
      };

      return recordApplication(receipt);
    });
  }
  async proposeHierarchyCreate(project: string, input: CreateHierarchyInput, options: ProposeHierarchyOptions): Promise<ChangeSetResult> {
    const { projectVersion, actorId, idempotencyKey, origin = 'author' } = options;
    if (
      !input ||
      !['volume', 'chapter', 'scene'].includes(input.kind) ||
      typeof input.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(input.id) ||
      typeof input.title !== 'string' ||
      !input.title.trim()
    ) {
      fail(400, 'invalid_hierarchy_operation', 'A path-safe identity and title are required');
    }
    if (!Number.isSafeInteger(projectVersion) || projectVersion < 1 || !actorId.trim() || !idempotencyKey.trim()) {
      fail(400, 'invalid_hierarchy_operation', 'A project version, actor and idempotency key are required');
    }
    const projectId = pid(project);
    const requestDigest = hash(canonicalJson({ actorId, origin, input }));
    try {
      return await this.persistence.transaction(async tx => {
        await tx.assertProjectVersion(projectId);
        const existing = await tx.getChangeSetByIdempotencyKey(projectId, idempotencyKey);
        if (existing) {
          if (
            existing.authorId !== actorId ||
            existing.provenance.source !== HIERARCHY_CREATE_SOURCE ||
            existing.provenance.details.requestDigest !== requestDigest
          ) {
            throw new PersistenceError('idempotency_conflict', 'Idempotency key was already used for a different request', {
              resource: 'idempotency_key',
              id: idempotencyKey,
            });
          }
          return { changeSet: existing, replayed: true };
        }
        await tx.assertProjectVersion(projectId, projectVersion);
        const documents = await tx.listDocuments(projectId, undefined, 1000);
        if (documents.length === 1000) fail(413, 'snapshot_too_large', 'Project snapshot exceeds the supported document bound');
        const mappings = new Map((await tx.listModuleRecords(projectId, PATHS)).map(record => [record.key, record.value]));
        const resolveParent = (lookupId: string, kind: 'volume' | 'chapter', parentId: DocumentId | null) => {
          const matches = documents.filter(
            document =>
              document.kind === kind &&
              document.parentId === parentId &&
              (document.id === lookupId || storyDocumentId(document, storyMetadata(mappings.get(document.id))) === lookupId),
          );
          if (matches.length !== 1) fail(422, 'invalid_hierarchy_parent', 'The selected parent is missing or ambiguous');
          return { documentId: matches[0]!.id, lookupId };
        };
        let hierarchy: HierarchyDocumentCreate = { kind: 'volume', logicalId: input.id };
        let parentId: DocumentId | null = null;
        if (input.kind !== 'volume') {
          const volume = resolveParent(input.volumeId, 'volume', null);
          if (input.kind === 'chapter') {
            hierarchy = { kind: 'chapter', logicalId: input.id, volume };
            parentId = volume.documentId;
          } else {
            const chapter = resolveParent(input.chapterId, 'chapter', volume.documentId);
            hierarchy = { kind: 'scene', logicalId: input.id, volume, chapter };
            parentId = chapter.documentId;
          }
        }
        const { metadataPath } = hierarchyDocumentPaths(hierarchy);
        const documentId = stableId(projectId, metadataPath);
        const orderKey = nextOrderKey(
          documents.filter(document => document.kind === input.kind && document.parentId === parentId).map(document => document.orderKey),
        );
        return tx.createChangeSet({
          projectId,
          authorId: actorId,
          idempotencyKey,
          operations: [
            {
              type: 'document.create',
              hierarchy,
              command: {
                projectId,
                documentId,
                parentId,
                kind: input.kind,
                title: input.title,
                orderKey,
                appendToEnd: true,
                markdown: input.kind === 'scene' ? (input.manuscriptBody ?? '') : '',
                authorId: actorId,
                idempotencyKey: `hierarchy-create:${hash(idempotencyKey)}`,
              },
            },
          ],
          readSet: [],
          writeSet: [
            { resource: 'document', id: documentId },
            { resource: 'module_record', id: JSON.stringify([PATHS, documentId]) },
          ],
          provenance: { source: HIERARCHY_CREATE_SOURCE, actorId, details: { projectVersion, origin, requestDigest } },
        });
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        const resource = error.details?.resource;
        if (resource === 'hierarchy_id_exists' || resource === 'hierarchy_path_exists' || resource === 'hierarchy_path_reserved') {
          fail(409, resource, error.message);
        }
      }
      throw error;
    }
  }
  async proposeHierarchyDelete(project: string, input: HierarchyTarget, options: ProposeHierarchyOptions): Promise<ChangeSetResult> {
    const { projectVersion, actorId, idempotencyKey, origin = 'author' } = options;
    if (!Number.isSafeInteger(projectVersion) || projectVersion < 1 || !actorId.trim() || !idempotencyKey.trim()) {
      fail(400, 'invalid_hierarchy_operation', 'A project version, actor and idempotency key are required');
    }
    const projectId = pid(project);
    const requestDigest = hash(canonicalJson({ actorId, origin, input }));
    return this.persistence.transaction(async tx => {
      await tx.assertProjectVersion(projectId);
      const existing = await tx.getChangeSetByIdempotencyKey(projectId, idempotencyKey);
      if (existing) {
        if (
          existing.authorId !== actorId ||
          existing.provenance.source !== HIERARCHY_DELETE_SOURCE ||
          existing.provenance.details.requestDigest !== requestDigest
        ) {
          throw new PersistenceError('idempotency_conflict', 'Idempotency key was already used for a different request', {
            resource: 'idempotency_key',
            id: idempotencyKey,
          });
        }
        return { changeSet: existing, replayed: true };
      }
      await tx.assertProjectVersion(projectId, projectVersion);
      const documents = await tx.listDocuments(projectId, undefined, 1000);
      if (documents.length === 1000) fail(413, 'snapshot_too_large', 'Project snapshot exceeds the supported document bound');
      const mappings = new Map((await tx.listModuleRecords(projectId, PATHS)).map(record => [record.key, record.value]));
      const resolve = (id: string): Document => {
        const matches = documents.filter(
          document => document.id === id || storyDocumentId(document, storyMetadata(mappings.get(document.id))) === id,
        );
        if (!matches.length) fail(404, 'scene_not_found', 'Document not found');
        if (matches.length !== 1) fail(422, 'invalid_hierarchy_target', 'Hierarchy identity is ambiguous');
        return matches[0]!;
      };
      const target = resolve(input.id);
      if (target.kind !== input.kind) fail(422, 'invalid_hierarchy_target', 'Hierarchy kind mismatch');
      const volume = input.kind === 'volume' ? undefined : resolve(input.volumeId);
      const chapter = input.kind === 'scene' ? resolve(input.chapterId) : undefined;
      const parentId = chapter?.id ?? volume?.id ?? null;
      if (
        (volume && volume.kind !== 'volume') ||
        (chapter && (chapter.kind !== 'chapter' || chapter.parentId !== volume?.id)) ||
        target.parentId !== parentId
      ) {
        fail(409, 'hierarchy_parent_changed', 'The hierarchy item no longer belongs to the requested parent');
      }

      const children = new Map<DocumentId | null, Document[]>();
      for (const document of documents) {
        const siblings = children.get(document.parentId);
        if (siblings) siblings.push(document);
        else children.set(document.parentId, [document]);
      }
      const subtree = [target];
      const selected = new Set([target.id]);
      for (let index = 0; index < subtree.length; index++) {
        for (const child of children.get(subtree[index]!.id) ?? []) {
          if (selected.has(child.id)) continue;
          selected.add(child.id);
          subtree.push(child);
        }
      }
      subtree.reverse();
      const siblingIds = (children.get(parentId) ?? [])
        .filter(document => document.kind === input.kind)
        .map(document => document.id)
        .sort();
      return tx.createChangeSet({
        projectId,
        authorId: actorId,
        idempotencyKey,
        operations: subtree.map(document => ({
          type: 'document.delete',
          command: {
            projectId,
            documentId: document.id,
            expectedVersion: document.version,
          },
        })),
        readSet: subtree.map(document => ({ resource: 'document', id: document.id, expectedVersion: document.version })),
        writeSet: subtree.map(document => ({ resource: 'document', id: document.id })),
        provenance: {
          source: HIERARCHY_DELETE_SOURCE,
          actorId,
          details: {
            kind: input.kind,
            parentId,
            volumeId: volume?.id ?? null,
            siblingIds,
            projectVersion,
            origin,
            requestDigest,
          },
        },
      });
    });
  }

  async proposeHierarchyReorder(
    project: string,
    input: ReorderHierarchyInput,
    options: ProposeHierarchyReorderOptions,
  ): Promise<ChangeSetResult> {
    const { projectVersion, actorId, idempotencyKey, origin = 'author' } = options;
    if (!Number.isSafeInteger(projectVersion) || projectVersion < 1 || !actorId.trim() || !idempotencyKey.trim()) {
      fail(400, 'invalid_hierarchy_operation', 'A project version, actor and idempotency key are required');
    }
    const projectId = pid(project);
    const { kind, orderedIds } = input;
    if (!orderedIds.length || new Set(orderedIds).size !== orderedIds.length) {
      fail(422, 'invalid_hierarchy_order', 'Reorder must include every sibling exactly once');
    }
    const requestDigest = hash(canonicalJson({ projectVersion, actorId, origin, input }));
    return this.persistence.transaction(async tx => {
      await tx.assertProjectVersion(projectId);
      const existing = await tx.getChangeSetByIdempotencyKey(projectId, idempotencyKey);
      if (existing) {
        if (
          existing.authorId !== actorId ||
          existing.provenance.source !== HIERARCHY_REORDER_SOURCE ||
          existing.provenance.details.requestDigest !== requestDigest
        ) {
          throw new PersistenceError('idempotency_conflict', 'Idempotency key was already used for a different request', {
            resource: 'idempotency_key',
            id: idempotencyKey,
          });
        }
        return { changeSet: existing, replayed: true };
      }
      await tx.assertProjectVersion(projectId, projectVersion);
      const documents = await tx.listDocuments(projectId, undefined, 1000);
      if (documents.length === 1000) fail(413, 'snapshot_too_large', 'Project snapshot exceeds the supported document bound');
      const mappings = new Map((await tx.listModuleRecords(projectId, PATHS)).map(record => [record.key, record.value]));
      const logicalId = (document: Document) => storyDocumentId(document, storyMetadata(mappings.get(document.id)));
      const resolveParent = (id: string, parentKind: 'volume' | 'chapter', parentId?: DocumentId) => {
        const candidates = documents.filter(
          document =>
            document.kind === parentKind &&
            (parentId === undefined || document.parentId === parentId) &&
            (document.id === id || logicalId(document) === id),
        );
        if (candidates.length !== 1) fail(422, 'invalid_hierarchy_parent', 'The selected parent is missing or ambiguous');
        return candidates[0]!;
      };
      const volume = kind === 'volume' ? undefined : resolveParent(input.volumeId, 'volume');
      const chapter = kind === 'scene' ? resolveParent(input.chapterId, 'chapter', volume!.id) : undefined;
      const parentId = chapter?.id ?? volume?.id ?? null;
      const siblings = documents.filter(document => document.parentId === parentId && document.kind === kind);
      if (orderedIds.length !== siblings.length) fail(422, 'invalid_hierarchy_order', 'Reorder must include every sibling exactly once');
      const byIdentity = new Map<string, Document | null>();
      for (const document of siblings) {
        for (const id of new Set([document.id, logicalId(document)])) {
          byIdentity.set(id, byIdentity.has(id) ? null : document);
        }
      }
      const ordered = orderedIds.map(id => {
        const document = byIdentity.get(id);
        if (!document) fail(422, 'invalid_hierarchy_order', 'A sibling identity is missing or ambiguous');
        return document;
      });
      if (new Set(ordered.map(document => document.id)).size !== siblings.length) {
        fail(422, 'invalid_hierarchy_order', 'Reorder must include every sibling exactly once');
      }
      return tx.createChangeSet({
        projectId,
        authorId: actorId,
        idempotencyKey,
        operations: ordered.map((document, index) => ({
          type: 'document.update',
          command: {
            projectId,
            documentId: document.id,
            expectedVersion: document.version,
            orderKey: String(index).padStart(10, '0'),
          },
        })),
        readSet: ordered.map(document => ({ resource: 'document', id: document.id, expectedVersion: document.version })),
        writeSet: ordered.map(document => ({ resource: 'document', id: document.id })),
        provenance: {
          source: HIERARCHY_REORDER_SOURCE,
          actorId,
          details: {
            kind,
            parentId,
            volumeId: volume?.id ?? null,
            projectVersion,
            origin,
            requestDigest,
          },
        },
      });
    });
  }
  async proposeManuscriptRestore(
    project: string,
    input: ProposeManuscriptRestoreInput,
    options: ProposeManuscriptRestoreOptions,
  ): Promise<ChangeSetResult> {
    const projectId = pid(project);
    const { documentId, baseRevisionId, sourceRevisionId } = input;
    const { actorId, idempotencyKey, origin = 'author', snapshot } = options;
    if (snapshot && snapshot.projectId !== projectId) fail(409, 'snapshot_scope_mismatch', 'Snapshot belongs to another project');
    return this.persistence.transaction(async tx => {
      const proposal = await tx.createChangeSet({
        projectId,
        authorId: actorId,
        idempotencyKey,
        operations: [
          {
            type: 'document.restore',
            command: {
              projectId,
              documentId,
              baseRevisionId,
              sourceRevisionId,
              authorId: actorId,
              idempotencyKey: `restore-change-set:${hash(idempotencyKey)}`,
            },
          },
        ],
        readSet: [], // The restore command binds the exact head revision at application.
        writeSet: [{ resource: 'document', id: documentId }],
        provenance: { source: 'native-manuscript-restore', actorId, details: { origin } },
      });
      // createChangeSet holds the project lock. Validate only fresh proposals,
      // and roll back their registration if the observed ancestry has changed.
      // Re-dispatch can resolve a newer project snapshot; the revision command
      // itself is the stable request identity.
      if (proposal.replayed) return proposal;
      if (snapshot && (await tx.getProject(projectId))?.version !== snapshot.projectVersion) {
        const saved = await tx.getModuleRecord(projectId, SNAPSHOTS, `snapshot:${snapshot.projectVersion}`);
        if (!saved) fail(409, 'snapshot_unavailable', 'The requested immutable project snapshot is unavailable');
        const manifest = storedManifest(saved.value, projectId, snapshot.projectVersion);
        const observed = manifest.documents.find(document => document.id === documentId);
        if (!observed) fail(404, 'scene_not_found', 'Manuscript document not found in the selected snapshot');
        if (observed.headRevisionId !== baseRevisionId)
          fail(409, 'revision_conflict', 'Restore base does not belong to the selected snapshot');
      }
      const document = await tx.getDocument(projectId, documentId);
      if (!document || document.kind === 'volume' || document.kind === 'chapter') {
        fail(404, 'scene_not_found', 'Manuscript document not found');
      }
      if (document.headRevisionId !== baseRevisionId) fail(409, 'revision_conflict', 'The manuscript head has changed');
      if (!(await tx.getRevision(projectId, documentId, sourceRevisionId, baseRevisionId))) {
        fail(404, 'revision_not_found', 'Restore source is not in the observed manuscript history');
      }
      return proposal;
    });
  }
  async listManuscriptSnapshots(
    projectId: string,
    manuscriptId: string,
    sceneId?: string,
    pinned?: SnapshotId,
  ): Promise<{ snapshot: SnapshotId; snapshots: ManuscriptSnapshotMeta[] }> {
    const manifest = await this.manifest(projectId, pinned),
      index = this.snapshotIndex(manifest),
      document = this.findDocument(manifest, sceneId ?? manuscriptId, index),
      page = document.headRevisionId
        ? await this.persistence.read(reader => reader.listRevisions(pid(projectId), document.id, 100, undefined, document.headRevisionId!))
        : { revisions: [] };
    return {
      snapshot: manifest.snapshot,
      snapshots: page.revisions.map(revision => ({
        id: revision.id,
        sceneId: this.logicalId(index, document),
        manuscriptId,
        createdAt: Date.parse(revision.createdAt),
        charCount: Array.from(manuscriptBody(revision.markdown)).length,
        source: 'postgres',
      })),
    };
  }
  async readManuscriptSnapshot(
    projectId: string,
    snapshotId: string,
    manuscriptId: string,
    sceneId?: string,
    pinned?: SnapshotId,
  ): Promise<{ snapshot: SnapshotId; manuscriptSnapshot: ManuscriptSnapshot }> {
    const manifest = await this.manifest(projectId, pinned),
      index = this.snapshotIndex(manifest),
      document = this.findDocument(manifest, sceneId ?? manuscriptId, index);
    const revision = document.headRevisionId
      ? await this.persistence.read(reader =>
          reader.getRevision(pid(projectId), document.id, snapshotId as RevisionId, document.headRevisionId!),
        )
      : undefined;
    if (!revision) fail(404, 'revision_not_found', 'Revision not found');
    const path = index.pathsByDocumentId.get(document.id)?.bodyPath,
      file = path ? manifest.files[path] : undefined;
    if (!path || !file) fail(409, 'snapshot_unavailable', 'Document body is missing from the project snapshot');
    return {
      snapshot: manifest.snapshot,
      manuscriptSnapshot: {
        id: revision.id,
        sceneId: this.logicalId(index, document),
        manuscriptId,
        createdAt: Date.parse(revision.createdAt),
        charCount: Array.from(manuscriptBody(revision.markdown)).length,
        source: 'postgres',
        body: manuscriptBody(revision.markdown),
        document: { path, content: revision.markdown, revision: revision.sha256 },
      },
    };
  }
  async status(projectId: string) {
    const observation = await this.observe(projectId);
    return { ...observation.snapshot, state: 'durable' as const };
  }
  async history(project: string, pinned?: SnapshotId): Promise<Commit[]> {
    const projectId = pid(project);
    const pinnedDocuments = pinned ? (await this.manifest(project, pinned)).documents : undefined;
    const revisions = await this.persistence.read(async reader => {
      if (!pinnedDocuments && !(await reader.getProject(projectId))) fail(404, 'project_not_found', 'Project not found');
      const documents = pinnedDocuments ?? (await reader.listDocuments(projectId, undefined, 1000));
      if (documents.length === 1000) fail(413, 'snapshot_too_large', 'Project snapshot exceeds the supported document bound');
      const heads = documents.flatMap(document =>
        document.headRevisionId ? [{ documentId: document.id, revisionId: document.headRevisionId }] : [],
      );
      return reader.listProjectRevisionHistory(projectId, heads, 100);
    });
    return revisions.map(revision => ({
      hash: revision.id,
      date: revision.createdAt,
      message: `Document revision ${revision.documentId}`,
    }));
  }
}
