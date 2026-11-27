/** Stable persistence boundary shared by the application and database adapters. */

declare const idBrand: unique symbol;

export type Id<Tag extends string> = string & { readonly [idBrand]: Tag };

export type ProjectId = Id<'ProjectId'>;
export type DocumentId = Id<'DocumentId'>;
export type RevisionId = Id<'RevisionId'>;
export type KnowledgeNodeId = Id<'KnowledgeNodeId'>;
export type KnowledgeAliasId = Id<'KnowledgeAliasId'>;
export type KnowledgeRelationId = Id<'KnowledgeRelationId'>;
export type EvidenceId = Id<'EvidenceId'>;
export type AssertionId = Id<'AssertionId'>;
export type ChangeSetId = Id<'ChangeSetId'>;
export type ActorId = string;
export type IdempotencyKey = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Project {
  id: ProjectId;
  title: string;
  settings: JsonObject;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Stable continuation position for the owner-facing project library. */
export interface ProjectPageCursor {
  updatedAt: string;
  id: ProjectId;
}

export interface CreateProjectCommand {
  id?: ProjectId;
  title: string;
  settings?: JsonObject;
}

export interface UpdateProjectCommand {
  projectId: ProjectId;
  expectedVersion: number;
  title?: string;
  settings?: JsonObject;
}

/** Metadata mutations preserve immutable body revisions. */
export interface UpdateDocumentCommand {
  projectId: ProjectId;
  documentId: DocumentId;
  expectedVersion: number;
  parentId?: DocumentId | null;
  title?: string;
  orderKey?: string;
}

export interface DeleteDocumentCommand {
  projectId: ProjectId;
  documentId: DocumentId;
  expectedVersion: number;
}

/** Durable module data; caches remain outside this authoritative record store. */
export interface ModuleRecord {
  projectId: ProjectId;
  moduleId: string;
  key: string;
  value: JsonObject;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveModuleRecordCommand {
  projectId: ProjectId;
  moduleId: string;
  key: string;
  value: JsonObject;
  expectedVersion: number | null;
}

export type DocumentKind = string;

export interface Document {
  id: DocumentId;
  projectId: ProjectId;
  parentId: DocumentId | null;
  kind: DocumentKind;
  title: string;
  orderKey: string;
  headRevisionId: RevisionId | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRevision {
  id: RevisionId;
  projectId: ProjectId;
  documentId: DocumentId;
  parentRevisionId: RevisionId | null;
  markdown: string;
  sha256: string;
  authorId: ActorId;
  createdAt: string;
}

/** Offsets are UTF-16 code units measured against the same immutable base revision. */
export interface TextChange {
  fromUtf16: number;
  toUtf16: number;
  insert: string;
}

export interface CreateDocumentCommand {
  projectId: ProjectId;
  documentId?: DocumentId;
  parentId?: DocumentId | null;
  kind: DocumentKind;
  title: string;
  orderKey: string;
  /** Derive an append key from the active same-parent siblings under the project transaction lock. */
  appendToEnd?: boolean;
  markdown: string;
  authorId: ActorId;
  idempotencyKey: IdempotencyKey;
}

export interface SaveDocumentCommand {
  projectId: ProjectId;
  documentId: DocumentId;
  baseRevisionId: RevisionId;
  /** Sorted, non-overlapping edits against baseRevisionId. */
  changes: readonly TextChange[];
  /** Lowercase SHA-256 of the resulting UTF-8 Markdown body. */
  resultingSha256: string;
  authorId: ActorId;
  clientId: string;
  idempotencyKey: IdempotencyKey;
}

export interface RestoreDocumentRevisionCommand {
  projectId: ProjectId;
  documentId: DocumentId;
  /** The current head that the caller observed. */
  baseRevisionId: RevisionId;
  /** Restore by creating a new revision whose body is copied from this revision. */
  sourceRevisionId: RevisionId;
  authorId: ActorId;
  idempotencyKey: IdempotencyKey;
}

export interface DocumentWriteResult {
  document: Document;
  revision: DocumentRevision;
  replayed: boolean;
}

export interface DocumentRevisionPage {
  revisions: readonly DocumentRevision[];
  nextBefore: string | null;
}

export interface DocumentRevisionKey {
  documentId: DocumentId;
  revisionId: RevisionId;
}

export interface DocumentHeadRevisionLookup extends DocumentRevisionKey {
  revision: DocumentRevision | null;
}

export interface DocumentHeadRevisionHash extends DocumentRevisionKey {
  sha256: string | null;
}

export type KnowledgeNodeStatus = 'proposed' | 'confirmed' | 'retired';
export type KnowledgeAliasStatus = 'proposed' | 'confirmed' | 'ambiguous' | 'retired';
export type KnowledgeRelationStatus = 'proposed' | 'confirmed' | 'rejected' | 'retired';

export interface KnowledgeNode {
  id: KnowledgeNodeId;
  projectId: ProjectId;
  type: string;
  name: string;
  attributes: JsonObject;
  status: KnowledgeNodeStatus;
  version: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeNodeSearch {
  query?: string;
  type?: string;
  status?: KnowledgeNodeStatus;
  after?: { name: string; id: KnowledgeNodeId };
  limit: number;
}

export interface SaveKnowledgeNodeCommand {
  projectId: ProjectId;
  id: KnowledgeNodeId;
  type: string;
  name: string;
  attributes: JsonObject;
  status: KnowledgeNodeStatus;
  /** null creates; an integer updates only that observed version. */
  expectedVersion: number | null;
}

export interface KnowledgeAlias {
  id: KnowledgeAliasId;
  projectId: ProjectId;
  nodeId: KnowledgeNodeId;
  surface: string;
  normalized: string;
  scope: string | null;
  status: KnowledgeAliasStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SaveKnowledgeAliasCommand {
  projectId: ProjectId;
  id: KnowledgeAliasId;
  nodeId: KnowledgeNodeId;
  surface: string;
  normalized: string;
  scope: string | null;
  status: KnowledgeAliasStatus;
}

export interface KnowledgeRelation {
  id: KnowledgeRelationId;
  projectId: ProjectId;
  sourceId: KnowledgeNodeId;
  targetId: KnowledgeNodeId;
  type: string;
  attributes: JsonObject;
  validity: JsonObject;
  status: KnowledgeRelationStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveKnowledgeRelationCommand {
  projectId: ProjectId;
  id: KnowledgeRelationId;
  sourceId: KnowledgeNodeId;
  targetId: KnowledgeNodeId;
  type: string;
  attributes: JsonObject;
  validity: JsonObject;
  status: KnowledgeRelationStatus;
  /** null creates; an integer updates only that observed version. */
  expectedVersion: number | null;
}

export type EvidenceStatus = 'proposed' | 'confirmed' | 'needs_review' | 'orphaned';
export type MentionStatus = 'proposed' | 'confirmed' | 'ambiguous' | 'rejected';
export type AssertionStatus = 'proposed' | 'confirmed' | 'rejected' | 'retired';

/** A text anchor is a revision-bound evidence location, not a semantic conclusion. */
export interface EvidenceAnchor {
  id: EvidenceId;
  projectId: ProjectId;
  documentId: DocumentId;
  revisionId: RevisionId;
  fromUtf16: number;
  toUtf16: number;
  quoteSha256: string;
  status: EvidenceStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveEvidenceAnchorCommand {
  projectId: ProjectId;
  id: EvidenceId;
  documentId: DocumentId;
  revisionId: RevisionId;
  fromUtf16: number;
  toUtf16: number;
  quoteSha256: string;
  status: EvidenceStatus;
  /** null creates; an integer updates only that observed version. */
  expectedVersion: number | null;
}

export interface EvidenceAnchorHistory {
  evidenceId: EvidenceId;
  revisionId: RevisionId;
  fromUtf16: number;
  toUtf16: number;
  status: EvidenceStatus;
  recordedAt: string;
}

export interface MentionLink {
  projectId: ProjectId;
  evidenceId: EvidenceId;
  nodeId: KnowledgeNodeId;
  status: MentionStatus;
  source: string;
  confidence: number | null;
  extractorVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveMentionLinkCommand {
  projectId: ProjectId;
  evidenceId: EvidenceId;
  nodeId: KnowledgeNodeId;
  status: MentionStatus;
  source: string;
  confidence: number | null;
  extractorVersion: string | null;
}

export interface Assertion {
  id: AssertionId;
  projectId: ProjectId;
  proposition: JsonObject;
  modality: string;
  perspective: string;
  narrativeTime: JsonObject;
  confidence: number | null;
  status: AssertionStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveAssertionCommand {
  projectId: ProjectId;
  id: AssertionId;
  proposition: JsonObject;
  modality: string;
  perspective: string;
  narrativeTime: JsonObject;
  confidence: number | null;
  status: AssertionStatus;
  /** null creates; an integer updates only that observed version. */
  expectedVersion: number | null;
}

export type EvidenceRole = 'supports' | 'contradicts' | 'quotes' | 'context';

export interface AssertionEvidence {
  projectId: ProjectId;
  assertionId: AssertionId;
  evidenceId: EvidenceId;
  role: EvidenceRole;
  createdAt: string;
}

export interface LinkAssertionEvidenceCommand {
  projectId: ProjectId;
  assertionId: AssertionId;
  evidenceId: EvidenceId;
  role: EvidenceRole;
}

export type ChangeSetStatus = 'proposed' | 'approved' | 'applied' | 'rejected';

export type ChangeSetResource =
  | 'document'
  | 'module_record'
  | 'knowledge_node'
  | 'knowledge_alias'
  | 'knowledge_relation'
  | 'evidence_anchor'
  | 'mention_link'
  | 'assertion'
  | 'assertion_evidence';

export interface ChangeSetReadSetEntry {
  resource: ChangeSetResource;
  id: string;
  /** null asserts absence; unversioned link records use 1 to assert presence. */
  expectedVersion: number | null;
  /** Used with document resources to bind the exact observed body. */
  expectedRevisionId?: RevisionId | null;
}

/** The declared set of identities written by the ChangeSet operations. */
export interface ChangeSetWriteSetEntry {
  resource: ChangeSetResource;
  id: string;
}

export interface ChangeSetProvenance {
  source: string;
  actorId: ActorId | null;
  details: JsonObject;
}

export const HIERARCHY_REORDER_SOURCE = 'native-hierarchy-reorder';
export const HIERARCHY_DELETE_SOURCE = 'native-hierarchy-delete';
export const HIERARCHY_CREATE_SOURCE = 'native-hierarchy-create';
export const CORE_DOCUMENT_PATHS = 'core.document-paths';
export const PUBLISHING_CHANGESET_SOURCE = 'publishing.native';
export const NLP_FEATURE_SETTINGS_CHANGESET_SOURCE = 'nlp.feature-settings.native';

interface HierarchyParentReference {
  readonly documentId: DocumentId;
  readonly lookupId: string;
}

/** Fixed parent identities and the author-facing ID for an approved hierarchy create. */
export type HierarchyDocumentCreate =
  | { kind: 'volume'; logicalId: string }
  | { kind: 'chapter'; logicalId: string; volume: HierarchyParentReference }
  | { kind: 'scene'; logicalId: string; volume: HierarchyParentReference; chapter: HierarchyParentReference };

export function hierarchyDocumentPaths(scope: HierarchyDocumentCreate): { metadataPath: string; manuscriptPath?: string } {
  if (scope.kind === 'volume') return { metadataPath: `plot/volumes/${scope.logicalId}/volume.yaml` };
  const volumePath = `plot/volumes/${scope.volume.lookupId}`;
  if (scope.kind === 'chapter') return { metadataPath: `${volumePath}/chapters/${scope.logicalId}/chapter.yaml` };
  const { lookupId: chapter } = scope.chapter;
  return {
    metadataPath: `${volumePath}/chapters/${chapter}/scenes/${scope.logicalId}.yaml`,
    manuscriptPath: `manuscript/${scope.volume.lookupId}/${chapter}/${scope.logicalId}.md`,
  };
}

export type ChangeSetOperation =
  | { type: 'document.update'; command: UpdateDocumentCommand }
  | { type: 'document.delete'; command: DeleteDocumentCommand }
  | { type: 'module.record.save'; command: SaveModuleRecordCommand }
  | { type: 'document.create'; command: CreateDocumentCommand; hierarchy?: HierarchyDocumentCreate }
  | { type: 'document.save'; command: SaveDocumentCommand }
  | { type: 'document.restore'; command: RestoreDocumentRevisionCommand }
  | { type: 'knowledge.node.save'; command: SaveKnowledgeNodeCommand }
  | { type: 'knowledge.alias.save'; command: SaveKnowledgeAliasCommand }
  | { type: 'knowledge.relation.save'; command: SaveKnowledgeRelationCommand }
  | { type: 'evidence.anchor.save'; command: SaveEvidenceAnchorCommand }
  | { type: 'evidence.mention.save'; command: SaveMentionLinkCommand }
  | { type: 'evidence.assertion.save'; command: SaveAssertionCommand }
  | { type: 'evidence.assertion.link'; command: LinkAssertionEvidenceCommand }
  | { type: 'knowledge.merge'; command: KnowledgeMergeChangeCommand };

/** Server-derived immutable proposal payload for one atomic Knowledge merge. */
export interface KnowledgeMergeChangeCommand {
  projectId: ProjectId;
  sourceId: KnowledgeNodeId;
  targetId: KnowledgeNodeId;
  projectVersion: number;
  previewDigest: string;
  actorId: ActorId;
  origin: 'author' | 'external-agent';
  auditId: string;
  generatedAliasId: KnowledgeAliasId;
  plan: JsonObject;
}

export interface ProposeKnowledgeMergeCommand {
  projectId: ProjectId;
  sourceId: KnowledgeNodeId;
  targetId: KnowledgeNodeId;
  projectVersion: number;
  previewDigest: string;
  actorId: ActorId;
  origin: 'author' | 'external-agent';
  idempotencyKey: IdempotencyKey;
}

export interface KnowledgeMergeResult {
  target: KnowledgeNode;
  source: KnowledgeNode;
  auditId: string;
}

export interface ChangeSet {
  id: ChangeSetId;
  projectId: ProjectId;
  authorId: ActorId;
  status: ChangeSetStatus;
  operations: readonly ChangeSetOperation[];
  readSet: readonly ChangeSetReadSetEntry[];
  writeSet: readonly ChangeSetWriteSetEntry[];
  provenance: ChangeSetProvenance;
  version: number;
  idempotencyKey: IdempotencyKey;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: ActorId | null;
  appliedAt: string | null;
  rejectedAt: string | null;
  rejectedBy: ActorId | null;
}

export interface CreateChangeSetCommand {
  id?: ChangeSetId;
  projectId: ProjectId;
  authorId: ActorId;
  idempotencyKey: IdempotencyKey;
  operations: readonly ChangeSetOperation[];
  /** Preconditions are rechecked while applying the approved ChangeSet. */
  readSet: readonly ChangeSetReadSetEntry[];
  /** Must exactly match the resource identities targeted by operations. */
  writeSet: readonly ChangeSetWriteSetEntry[];
  provenance: ChangeSetProvenance;
}

export interface ChangeSetResult {
  changeSet: ChangeSet;
  replayed: boolean;
}

export type ChangeSetOperationResult =
  | DocumentWriteResult
  | Document
  | ModuleRecord
  | KnowledgeNode
  | KnowledgeAlias
  | KnowledgeRelation
  | EvidenceAnchor
  | MentionLink
  | Assertion
  | AssertionEvidence
  | KnowledgeMergeResult;

export interface ChangeSetApplicationResult {
  changeSet: ChangeSet;
  results: readonly ChangeSetOperationResult[];
  replayed: boolean;
}

export interface KnowledgeProjectionBatchLimits {
  aliasesPerNode: number;
  relationsPerNode: number;
  mentionsPerNode: number;
  assertionsPerAnchor: number;
}

export interface KnowledgeProjectionBatch {
  aliases: readonly { nodeId: KnowledgeNodeId; alias: KnowledgeAlias }[];
  relations: readonly { nodeId: KnowledgeNodeId; relation: KnowledgeRelation }[];
  mentions: readonly MentionLink[];
  anchors: readonly EvidenceAnchor[];
  revisions: readonly DocumentRevision[];
  assertionEvidence: readonly { evidenceId: EvidenceId; link: AssertionEvidence }[];
  assertions: readonly Assertion[];
}

export interface ProposalReviewQueueOptions {
  /** Omit proposals whose write payload is only visible to an author. */
  excludePrivateProposals?: boolean;
}

export interface OpenWorkExportRows {
  project: Project;
  documents: Document & { deletedAt: string | null };
  revisions: DocumentRevision;
  nodes: KnowledgeNode;
  aliases: KnowledgeAlias;
  relations: KnowledgeRelation;
  anchors: EvidenceAnchor;
  mentions: MentionLink;
  assertions: Assertion;
  assertionEvidence: AssertionEvidence & { assertionId: AssertionId };
  moduleRecords: ModuleRecord;
  omittedAuthority: { count: number };
}

export interface PersistenceReader {
  /** Iterate one export section in stable order. Each sibling group follows listDocuments order. */
  scanOpenWorkExport?<K extends keyof OpenWorkExportRows>(
    projectId: ProjectId,
    section: K,
    maximumRowBytes: number,
  ): AsyncIterable<OpenWorkExportRows[K]>;
  getModuleRecord(projectId: ProjectId, moduleId: string, key: string): Promise<ModuleRecord | undefined>;
  listModuleRecords(projectId: ProjectId, moduleId?: string): Promise<readonly ModuleRecord[]>;
  /** Count unresolved proposals in explicit project order, or all standalone projects in recent-project order when null; return only the bounded prefix. */
  listProposalReviewQueue(
    projectIds: readonly ProjectId[] | null,
    moduleId: string,
    limit: number,
    options?: ProposalReviewQueueOptions,
  ): Promise<{
    unresolvedCount: number;
    records: readonly { record: ModuleRecord; projectVersion: number }[];
  }>;
  /** Portable exchange excludes internal authority payloads at the SQL boundary. */
  listPortableModuleRecords(
    projectId: ProjectId,
  ): Promise<{ records: readonly ModuleRecord[]; omittedAuthorityModules: readonly string[] }>;
  getProject(projectId: ProjectId): Promise<Project | undefined>;
  /** Recent-project keyset page; `limit` includes the optional lookahead row. */
  listProjectPage?(limit: number, after?: ProjectPageCursor): Promise<readonly Project[]>;
  getDocument(projectId: ProjectId, documentId: DocumentId): Promise<Document | undefined>;
  listDocuments(projectId: ProjectId, parentId?: DocumentId | null, limit?: number): Promise<readonly Document[]>;
  getRevision(
    projectId: ProjectId,
    documentId: DocumentId,
    revisionId: RevisionId,
    throughHead?: RevisionId,
  ): Promise<DocumentRevision | undefined>;
  /** Resolve exact document/revision pairs in input order within the project scope. */
  getDocumentHeadRevisions(projectId: ProjectId, heads: readonly DocumentRevisionKey[]): Promise<readonly DocumentHeadRevisionLookup[]>;
  /** Resolve the hashes of exact pairs in input order without requesting revision bodies. */
  getDocumentHeadRevisionHashes(projectId: ProjectId, heads: readonly DocumentRevisionKey[]): Promise<readonly DocumentHeadRevisionHash[]>;
  listRevisions(
    projectId: ProjectId,
    documentId: DocumentId,
    limit: number,
    before?: string,
    throughHead?: RevisionId,
  ): Promise<DocumentRevisionPage>;
  /** Globally bounded metadata from the ancestry of the supplied immutable heads, in input-document order for timestamp ties. */
  listProjectRevisionHistory(
    projectId: ProjectId,
    heads: readonly DocumentRevisionKey[],
    limit: number,
  ): Promise<readonly Pick<DocumentRevision, 'id' | 'documentId' | 'createdAt'>[]>;
  getKnowledgeNode(projectId: ProjectId, nodeId: KnowledgeNodeId): Promise<KnowledgeNode | undefined>;
  listKnowledgeNodes(projectId: ProjectId, limit?: number): Promise<readonly KnowledgeNode[]>;
  /** Bounded stable Knowledge browse; aliases are searched only within this project and node. */
  searchKnowledgeNodes?(projectId: ProjectId, search: KnowledgeNodeSearch): Promise<readonly KnowledgeNode[]>;
  /** Export-only complete canonical scope, including retired nodes. */
  listAllKnowledgeNodes(projectId: ProjectId, limit?: number): Promise<readonly KnowledgeNode[]>;
  /** Export-only project assertion inventory, including unlinked assertions. */
  listAssertions(projectId: ProjectId, limit?: number): Promise<readonly Assertion[]>;
  listKnowledgeAliases(projectId: ProjectId, nodeId: KnowledgeNodeId, limit?: number): Promise<readonly KnowledgeAlias[]>;
  listKnowledgeRelations(projectId: ProjectId, nodeId: KnowledgeNodeId, limit?: number): Promise<readonly KnowledgeRelation[]>;
  /** Bounded set read for the immutable Knowledge/Evidence snapshot projection. */
  readKnowledgeProjectionBatch(
    projectId: ProjectId,
    nodeIds: readonly KnowledgeNodeId[],
    limits: KnowledgeProjectionBatchLimits,
  ): Promise<KnowledgeProjectionBatch>;
  getEvidenceAnchor(projectId: ProjectId, evidenceId: EvidenceId): Promise<EvidenceAnchor | undefined>;
  /** All document identities with retained anchors, including logically deleted documents. */
  listEvidenceDocumentIds(projectId: ProjectId, limit?: number): Promise<readonly DocumentId[]>;
  listDocumentEvidence(
    projectId: ProjectId,
    documentId: DocumentId,
    revisionId?: RevisionId,
    limit?: number,
  ): Promise<readonly EvidenceAnchor[]>;
  listEvidenceHistory(projectId: ProjectId, evidenceId: EvidenceId, limit?: number): Promise<readonly EvidenceAnchorHistory[]>;
  getMentionLink(projectId: ProjectId, evidenceId: EvidenceId, nodeId: KnowledgeNodeId): Promise<MentionLink | undefined>;
  listMentionLinks(projectId: ProjectId, evidenceId: EvidenceId, limit?: number): Promise<readonly MentionLink[]>;
  listNodeMentions(projectId: ProjectId, nodeId: KnowledgeNodeId, limit?: number): Promise<readonly MentionLink[]>;
  getAssertion(projectId: ProjectId, assertionId: AssertionId): Promise<Assertion | undefined>;
  listAssertionEvidence(projectId: ProjectId, assertionId: AssertionId, limit?: number): Promise<readonly AssertionEvidence[]>;
  listEvidenceAssertions(projectId: ProjectId, evidenceId: EvidenceId, limit?: number): Promise<readonly AssertionEvidence[]>;
  getChangeSet(projectId: ProjectId, changeSetId: ChangeSetId): Promise<ChangeSet | undefined>;
  getChangeSetByIdempotencyKey(projectId: ProjectId, key: IdempotencyKey): Promise<ChangeSet | undefined>;
  listChangeSets(projectId: ProjectId, limit?: number, options?: { excludeSources?: readonly string[] }): Promise<readonly ChangeSet[]>;
  getChangeSetReceipt(projectId: ProjectId, changeSetId: ChangeSetId): Promise<ChangeSetApplicationResult | undefined>;
}

export interface PersistenceTransaction extends PersistenceReader {
  /** Lock and fence a project revision before applying a snapshot-bound mutation. */
  assertProjectVersion(projectId: ProjectId, expectedVersion?: number): Promise<void>;
  updateProject(command: UpdateProjectCommand): Promise<Project>;
  updateDocument(command: UpdateDocumentCommand): Promise<Document>;
  deleteDocument(command: DeleteDocumentCommand): Promise<Document>;
  saveModuleRecord(command: SaveModuleRecordCommand): Promise<ModuleRecord>;
  createProject(command: CreateProjectCommand): Promise<Project>;
  createDocument(command: CreateDocumentCommand): Promise<DocumentWriteResult>;
  saveDocument(command: SaveDocumentCommand): Promise<DocumentWriteResult>;
  restoreDocumentRevision(command: RestoreDocumentRevisionCommand): Promise<DocumentWriteResult>;
  saveKnowledgeNode(command: SaveKnowledgeNodeCommand): Promise<KnowledgeNode>;
  saveKnowledgeAlias(command: SaveKnowledgeAliasCommand): Promise<KnowledgeAlias>;
  saveKnowledgeRelation(command: SaveKnowledgeRelationCommand): Promise<KnowledgeRelation>;
  saveEvidenceAnchor(command: SaveEvidenceAnchorCommand): Promise<EvidenceAnchor>;
  saveMentionLink(command: SaveMentionLinkCommand): Promise<MentionLink>;
  saveAssertion(command: SaveAssertionCommand): Promise<Assertion>;
  linkAssertionEvidence(command: LinkAssertionEvidenceCommand): Promise<AssertionEvidence>;
  createChangeSet(command: CreateChangeSetCommand): Promise<ChangeSetResult>;
  /** Derive and persist one complete merge proposal under the project lock. */
  proposeKnowledgeMerge(command: ProposeKnowledgeMergeCommand): Promise<ChangeSetResult>;
  approveChangeSet(command: {
    projectId: ProjectId;
    changeSetId: ChangeSetId;
    expectedVersion: number;
    approvedBy: ActorId;
  }): Promise<ChangeSet>;
  rejectChangeSet(command: {
    projectId: ProjectId;
    changeSetId: ChangeSetId;
    expectedVersion: number;
    rejectedBy: ActorId;
  }): Promise<ChangeSet>;
  applyChangeSet(command: { projectId: ProjectId; changeSetId: ChangeSetId; expectedVersion: number }): Promise<ChangeSetApplicationResult>;
}

export interface Persistence {
  /** Read callbacks run on one consistent database snapshot. */
  read<T>(work: (reader: PersistenceReader) => Promise<T>, options?: { signal: AbortSignal; statementTimeoutMs: number }): Promise<T>;
  /** All writes in the callback commit together or roll back together. */
  transaction<T>(work: (transaction: PersistenceTransaction) => Promise<T>): Promise<T>;
  /** Resolve only when the backing database accepts a lightweight query. */
  checkHealth?(): Promise<void>;
  close(): Promise<void>;
}

export type PersistenceErrorCode =
  | 'unavailable'
  | 'export_limit'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'invalid_change_set_state'
  | 'validation';

export interface PersistenceErrorDetails {
  resource?: string;
  id?: string;
  expected?: string | number | null;
  actual?: string | number | null;
}

export class PersistenceError extends Error {
  readonly name = 'PersistenceError';

  constructor(
    readonly code: PersistenceErrorCode,
    message: string,
    readonly details?: PersistenceErrorDetails,
  ) {
    super(message);
  }
}
