import { assertChangeOperation, BUILTIN_MODULE_IDS, type ActionResult, type ChangeProposal, type ApplyReceipt, type ModuleStatus, type ProposalStatus, type RecentActivityResponse, type SnapshotId, type UiContribution } from "@codexia/contracts";
import type { FileDocument, InboxItem, InboxListResponse, PersistenceAnchorView, PersistenceDocumentAnchors, PersistenceDocumentRead, PersistenceNodeRead, PersistenceStatus, PersistenceAssertionEvidenceRead, PersistenceAssertionRead, PublicJob, RuntimeVersion, Scene, SceneRead, Session, SnapshotRead, Tree, TreeRead, PortableWorkArchive, PortableWorkImportResult } from "./api";
import { ApiError } from "./api-error";
import type { Assertion, AssertionEvidence, Document as PersistenceDocument, DocumentRevision as PersistenceRevision, DocumentRevisionPage, DocumentWriteResult, EvidenceAnchor, KnowledgeAlias, KnowledgeNode, KnowledgeRelation, MentionLink, Project as PersistenceProject } from "@codexia/persistence-contracts";

export type ResponseGuard<T> = (value: unknown) => value is T;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nullableText = (v: unknown): v is string | null => v === null || text(v);
const nullableInteger = (v: unknown): v is number | null => v === null || integer(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const objectWithArrays = (v: unknown, keys: readonly string[]): boolean => record(v) && keys.every(key => Array.isArray(v[key]));
const oneOf = (v: unknown, values: readonly string[]): boolean => text(v) && values.includes(v);
const optional = <T>(v: unknown, guard: ResponseGuard<T>): v is T | undefined => v === undefined || guard(v);
const array = <T>(guard: ResponseGuard<T>): ResponseGuard<T[]> => (v): v is T[] => Array.isArray(v) && v.every(guard);
const snapshot: ResponseGuard<SnapshotId> = (v): v is SnapshotId => record(v) && text(v.projectId) && integer(v.projectVersion) && v.projectVersion > 0;
const fileRevision = (v: unknown): boolean => record(v) && text(v.path) && nullableText(v.revision);
const application: ResponseGuard<ApplyReceipt> = (v): v is ApplyReceipt => record(v) && text(v.operationId) && integer(v.generation) && integer(v.projectVersion) && v.projectVersion > 0 && Array.isArray(v.revisions) && v.revisions.every(fileRevision);
const proposal: ResponseGuard<ChangeProposal> = (v): v is ChangeProposal => {
  if (!record(v) || !text(v.id) || !snapshot(v.snapshot) || !oneOf(v.source, ["author", "module", "mcp"]) || !Array.isArray(v.operations)) return false;
  try { for (const operation of v.operations) assertChangeOperation(operation); } catch { return false; }
  return v.evidence === undefined || (Array.isArray(v.evidence) && v.evidence.every(e => record(e) && text(e.id) && snapshot(e.snapshot) && oneOf(e.module, BUILTIN_MODULE_IDS) && text(e.kind) && Array.isArray(e.paths) && e.paths.every(fileRevision)));
};
const proposalStatus: ResponseGuard<ProposalStatus> = (v): v is ProposalStatus => record(v) && proposal(v.proposal) && oneOf(v.state, ["proposed", "partially_approved", "approved", "applied"]) && strings(v.approvedOperationIds) && array(application)(v.applications) && strings(v.appliedOperationIds) && bool(v.stale) && optional(v.payloadComplete, bool) && optional(v.originalDigest, text) && optional(v.operationIds, strings);
const scene: ResponseGuard<Scene> = (v): v is Scene => record(v) && [v.id, v.title, v.text, v.revision].every(text);
const document: ResponseGuard<FileDocument> = (v): v is FileDocument => record(v) && text(v.path) && text(v.content) && nullableText(v.revision);
const tree: ResponseGuard<Tree> = (v): v is Tree => record(v) && text(v.title) && Array.isArray(v.volumes) && v.volumes.every(volume => record(volume) && text(volume.id) && text(volume.title) && Array.isArray(volume.chapters) && volume.chapters.every(chapter => record(chapter) && text(chapter.id) && text(chapter.title) && Array.isArray(chapter.scenes) && chapter.scenes.every(item => record(item) && text(item.id) && text(item.title))));
const sceneRead: ResponseGuard<SceneRead> = (v): v is SceneRead => record(v) && snapshot(v.snapshot) && scene(v.scene) && document(v.document) && document(v.metadata);
const job: ResponseGuard<PublicJob> = (v): v is PublicJob => record(v) && "result" in v && [v.id, v.type, v.createdAt, v.updatedAt].every(text) && oneOf(v.status, ["queued", "running", "done", "error"]) && (v.progress === null || (typeof v.progress === "number" && Number.isFinite(v.progress) && v.progress >= 0 && v.progress <= 1)) && nullableText(v.error) && nullableText(v.finishedAt) && optional(v.errorCode, text) && optional(v.retryable, bool);
const inbox: ResponseGuard<InboxItem> = (v): v is InboxItem => record(v) && [v.id, v.jobId, v.jobType, v.title, v.body, v.projectKey, v.createdAt].every(text) && v.kind === "job-complete" && oneOf(v.status, ["done", "error"]) && bool(v.read) && nullableText(v.userId);
const moduleStatus: ResponseGuard<ModuleStatus> = (v): v is ModuleStatus => record(v) && oneOf(v.id, BUILTIN_MODULE_IDS) && oneOf(v.availability, ["not-included", "disabled", "enabled-idle", "active"]) && integer(v.activeJobs) && optional(v.version, text);
const contribution: ResponseGuard<UiContribution> = (v): v is UiContribution => record(v) && [v.id, v.title, v.action].every(text) && oneOf(v.module, BUILTIN_MODULE_IDS) && oneOf(v.slot, ["editor", "dock", "inspection", "review", "settings"]) && (v.contractVersion === undefined || v.contractVersion === 1) && (v.kind === undefined || oneOf(v.kind, ["panel", "editor-adornment", "context-action"])) && (v.contexts === undefined || (Array.isArray(v.contexts) && v.contexts.every(c => oneOf(c, ["workspace", "editor", "reading"])))) && optional(v.multipleInstances, bool);
const jsonValue = (v: unknown): boolean => v === null || text(v) || typeof v === "number" && Number.isFinite(v) || bool(v) || Array.isArray(v) && v.every(jsonValue) || record(v) && Object.values(v).every(jsonValue);
const jsonObject = (v: unknown): v is Record<string, unknown> => record(v) && Object.values(v).every(jsonValue);
const persistenceProject: ResponseGuard<PersistenceProject> = (v): v is PersistenceProject => record(v) && text(v.id) && text(v.title) && jsonObject(v.settings) && integer(v.version) && v.version > 0 && text(v.createdAt) && text(v.updatedAt);
const persistenceDocument: ResponseGuard<PersistenceDocument> = (v): v is PersistenceDocument => record(v) && text(v.id) && text(v.projectId) && nullableText(v.parentId) && text(v.kind) && text(v.title) && text(v.orderKey) && nullableText(v.headRevisionId) && integer(v.version) && text(v.createdAt) && text(v.updatedAt);
const persistenceRevision: ResponseGuard<PersistenceRevision> = (v): v is PersistenceRevision => record(v) && text(v.id) && text(v.projectId) && text(v.documentId) && nullableText(v.parentRevisionId) && text(v.markdown) && /^[0-9a-f]{64}$/u.test(String(v.sha256)) && text(v.authorId) && text(v.createdAt);
const persistenceWrite: ResponseGuard<DocumentWriteResult> = (v): v is DocumentWriteResult => record(v) && persistenceDocument(v.document) && persistenceRevision(v.revision) && bool(v.replayed);
const persistenceRevisionPage: ResponseGuard<DocumentRevisionPage> = (v): v is DocumentRevisionPage => record(v) && array(persistenceRevision)(v.revisions) && nullableText(v.nextBefore);
const persistenceEvidence: ResponseGuard<EvidenceAnchor> = (v): v is EvidenceAnchor => record(v) && text(v.id) && text(v.projectId) && text(v.documentId) && text(v.revisionId) && integer(v.fromUtf16) && integer(v.toUtf16) && v.toUtf16 >= v.fromUtf16 && /^[0-9a-f]{64}$/u.test(String(v.quoteSha256)) && oneOf(v.status, ["proposed", "confirmed", "needs_review", "orphaned"]) && integer(v.version) && v.version > 0 && text(v.createdAt) && text(v.updatedAt);
const persistenceKnowledgeNode: ResponseGuard<KnowledgeNode> = (v): v is KnowledgeNode => record(v) && text(v.id) && text(v.projectId) && text(v.type) && text(v.name) && jsonObject(v.attributes) && oneOf(v.status, ["proposed", "confirmed", "retired"]) && integer(v.version) && nullableText(v.deletedAt) && text(v.createdAt) && text(v.updatedAt);
const persistenceKnowledgeAlias: ResponseGuard<KnowledgeAlias> = (v): v is KnowledgeAlias => record(v) && text(v.id) && text(v.projectId) && text(v.nodeId) && text(v.surface) && text(v.normalized) && nullableText(v.scope) && oneOf(v.status, ["proposed", "confirmed", "ambiguous", "retired"]) && text(v.createdAt) && text(v.updatedAt);
const persistenceKnowledgeRelation: ResponseGuard<KnowledgeRelation> = (v): v is KnowledgeRelation => record(v) && text(v.id) && text(v.projectId) && text(v.sourceId) && text(v.targetId) && text(v.type) && jsonObject(v.attributes) && jsonObject(v.validity) && oneOf(v.status, ["proposed", "confirmed", "rejected", "retired"]) && integer(v.version) && text(v.createdAt) && text(v.updatedAt);
const persistenceMention: ResponseGuard<MentionLink> = (v): v is MentionLink => record(v) && text(v.projectId) && text(v.evidenceId) && text(v.nodeId) && oneOf(v.status, ["proposed", "confirmed", "ambiguous", "rejected"]) && text(v.source) && (v.confidence === null || typeof v.confidence === "number" && Number.isFinite(v.confidence)) && nullableText(v.extractorVersion) && text(v.createdAt) && text(v.updatedAt);
const persistenceAssertion: ResponseGuard<Assertion> = (v): v is Assertion => record(v) && text(v.id) && text(v.projectId) && jsonObject(v.proposition) && text(v.modality) && text(v.perspective) && jsonObject(v.narrativeTime) && (v.confidence === null || typeof v.confidence === "number" && Number.isFinite(v.confidence)) && oneOf(v.status, ["proposed", "confirmed", "rejected", "retired"]) && integer(v.version) && text(v.createdAt) && text(v.updatedAt);
const persistenceAssertionEvidence: ResponseGuard<AssertionEvidence> = (v): v is AssertionEvidence => record(v) && text(v.projectId) && text(v.assertionId) && text(v.evidenceId) && oneOf(v.role, ["supports", "contradicts", "quotes", "context"]) && text(v.createdAt);
const persistenceAnchorView: ResponseGuard<PersistenceAnchorView> = (v): v is PersistenceAnchorView => record(v) && persistenceEvidence(v.anchor) && text(v.quote)
  && Array.isArray(v.mentions) && v.mentions.every(item => record(item) && persistenceMention(item.link) && (item.node === null || persistenceKnowledgeNode(item.node)))
  && Array.isArray(v.assertions) && v.assertions.every(item => record(item) && persistenceAssertionEvidence(item.link) && (item.assertion === null || persistenceAssertion(item.assertion)));

/** The guards follow the public DTOs; additive fields are retained, not silently stripped. */
export const responseContracts = {
  empty: (v: unknown): v is void => v === undefined,
  version: (v: unknown): v is RuntimeVersion => record(v) && [v.name, v.version, v.profile].every(text) && bool(v.hosted),
  loggedIn: (v: unknown): v is { authenticated: true } => record(v) && v.authenticated === true,
  loggedOut: (v: unknown): v is { authenticated: false } => record(v) && v.authenticated === false,
  session: (v: unknown): v is Session => record(v) && v.authenticated === true && text(v.authorScope) && (v.permissions === undefined || (Array.isArray(v.permissions) && v.permissions.every(p => oneOf(p, ["read", "write", "maintain", "admin"])))),
  tree, treeRead: (v: unknown): v is TreeRead => record(v) && snapshot(v.snapshot) && tree(v.tree),
  scene, sceneRead,
  snapshotRead: (v: unknown): v is SnapshotRead => record(v) && snapshot(v.snapshot) && array(document)(v.files),
  recentActivity: (v: unknown): v is RecentActivityResponse => record(v) && Array.isArray(v.items) && v.items.every(i => record(i) && text(i.sceneId) && nullableInteger(i.sentenceOffset) && optional(i.pageIndex, nullableInteger) && oneOf(i.deviceType, ["desktop", "mobile"]) && text(i.updatedAt)),
  proposal,
  proposals: (v: unknown): v is { proposals: ProposalStatus[] } => record(v) && array(proposalStatus)(v.proposals),
  jobs: array(job), job,
  inbox: (v: unknown): v is InboxListResponse => record(v) && array(inbox)(v.items) && integer(v.unreadCount),
  inboxItem: (v: unknown): v is { item: InboxItem } => record(v) && inbox(v.item),
  marked: (v: unknown): v is { marked: number } => record(v) && integer(v.marked),
  modules: array(moduleStatus), contributions: array(contribution),
  persistenceStatus: (v: unknown): v is PersistenceStatus => record(v) && bool(v.available) && (v.provider === null || v.provider === "postgres"),
  portableWorkArchive: (v: unknown): v is PortableWorkArchive => record(v) && v.format === "codexia-work/v1" &&
    record(v.project) && text(v.project.title) && jsonObject(v.project.settings) &&
    Array.isArray(v.documents) && v.documents.every(d => record(d) && text(d.id) && text(d.title) && text(d.markdown)) &&
    objectWithArrays(v.knowledge, ["nodes", "aliases", "relations"]) &&
    record(v.evidence) && objectWithArrays(v.evidence, ["anchors", "mentions", "assertions", "assertionEvidence"]) &&
    objectWithArrays(v.evidence.unresolved, ["anchors", "mentions", "assertionEvidence"]) &&
    Array.isArray(v.moduleRecords) && strings(v.omittedRecords),
  portableWorkImport: (v: unknown): v is PortableWorkImportResult => record(v) && persistenceProject(v.project) &&
    bool(v.replayed) && integer(v.unresolvedAnchors) && integer(v.omittedRecords),
  persistenceProjects: array(persistenceProject),
  persistenceProject: (v: unknown): v is { project: PersistenceProject } => record(v) && persistenceProject(v.project),
  persistenceDocuments: (v: unknown): v is { documents: PersistenceDocument[] } => record(v) && array(persistenceDocument)(v.documents),
  persistenceNodes: (v: unknown): v is { nodes: KnowledgeNode[] } => record(v) && array(persistenceKnowledgeNode)(v.nodes),
  persistenceDocumentEnvelope: (v: unknown): v is { document: PersistenceDocument } => record(v) && persistenceDocument(v.document),
  apply: application,
  persistenceDocument: (v: unknown): v is PersistenceDocumentRead => record(v) && persistenceDocument(v.document) && (v.revision === null || persistenceRevision(v.revision)),
  persistenceWrite,
  persistenceRevisionPage,
  persistenceAnchors: (v: unknown): v is PersistenceDocumentAnchors => record(v) && nullableText(v.revisionId) && Array.isArray(v.anchors) && v.anchors.every(persistenceAnchorView),
  persistenceAnchor: persistenceEvidence,
  persistenceAnchorCreated: (v: unknown): v is { anchor: EvidenceAnchor; quote: string; nodeId: string | null; authorId: string } => record(v) && persistenceEvidence(v.anchor) && text(v.quote) && nullableText(v.nodeId) && text(v.authorId),
  persistenceMention,
  persistenceNode: (v: unknown): v is PersistenceNodeRead => record(v) && persistenceKnowledgeNode(v.node) && array(persistenceKnowledgeAlias)(v.aliases) && array(persistenceKnowledgeRelation)(v.relations),
  persistenceNodeEnvelope: (v: unknown): v is { node: KnowledgeNode } => record(v) && persistenceKnowledgeNode(v.node),
  persistenceAliasEnvelope: (v: unknown): v is { alias: KnowledgeAlias } => record(v) && persistenceKnowledgeAlias(v.alias),
  persistenceRelationEnvelope: (v: unknown): v is { relation: KnowledgeRelation } => record(v) && persistenceKnowledgeRelation(v.relation),
  persistenceNodeEvidence: (v: unknown): v is { evidence: PersistenceAnchorView[] } => record(v) && Array.isArray(v.evidence) && v.evidence.every(persistenceAnchorView),
  persistenceAssertion: (v: unknown): v is PersistenceAssertionRead => record(v) && persistenceAssertion(v.assertion) && array(persistenceAssertionEvidence)(v.evidence),
  persistenceAssertionEnvelope: (v: unknown): v is { assertion: Assertion } => record(v) && persistenceAssertion(v.assertion),
  persistenceAssertionEvidence,
  persistenceAssertionEvidenceList: (v: unknown): v is PersistenceAssertionEvidenceRead => record(v) && Array.isArray(v.evidence) && v.evidence.every(item => record(item) && persistenceAssertionEvidence(item.link) && persistenceAnchorView(item.evidence)),
  persistenceAssertionEvidenceEnvelope: (v: unknown): v is { evidence: AssertionEvidence } => record(v) && persistenceAssertionEvidence(v.evidence),
  action: (v: unknown): v is ActionResult => record(v) && snapshot(v.snapshot) && (v.ok === true ? "data" in v && optional(v.proposals, array(proposal)) : v.ok === false && record(v.error) && text(v.error.code) && text(v.error.message) && bool(v.error.retryable)),
};

export function decodeResponse<T>(value: unknown, guard: ResponseGuard<T>): T {
  if (!guard(value)) throw new ApiError("The server returned an invalid response", 502, "INVALID_RESPONSE");
  return value;
}

export async function readApiResponse<T>(response: Response, guard: ResponseGuard<T>): Promise<T> {
  if (response.status === 204) return decodeResponse(undefined, guard);
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (response.ok) throw new ApiError("The server returned invalid JSON", 502, "INVALID_RESPONSE");
  }
  if (!response.ok) {
    const details = record(body) ? body : {};
    throw new ApiError(text(details.error) ? details.error : `Request failed (${response.status})`, response.status, text(details.code) ? details.code : "REQUEST_FAILED");
  }
  return decodeResponse(body, guard);
}
