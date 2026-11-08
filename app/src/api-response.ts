import type { PersistenceAnchorView, PersistenceDocumentAnchors, PersistenceDocumentRead, PersistenceNodeRead, PersistenceStatus, PersistenceAssertionEvidenceRead, PersistenceAssertionRead, Session } from "./api";
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
const oneOf = (v: unknown, values: readonly string[]): boolean => text(v) && values.includes(v);
const optional = <T>(v: unknown, guard: ResponseGuard<T>): v is T | undefined => v === undefined || guard(v);
const array = <T>(guard: ResponseGuard<T>): ResponseGuard<T[]> => (v): v is T[] => Array.isArray(v) && v.every(guard);
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
export const responseContracts = {
  loggedIn: (v: unknown): v is { authenticated: true } => record(v) && v.authenticated === true,
  loggedOut: (v: unknown): v is { authenticated: false } => record(v) && v.authenticated === false,
  session: (v: unknown): v is Session => record(v) && v.authenticated === true && text(v.authorScope) && (v.permissions === undefined || (Array.isArray(v.permissions) && v.permissions.every(p => oneOf(p, ["read", "write", "maintain", "admin"])))),
  persistenceStatus: (v: unknown): v is PersistenceStatus => record(v) && bool(v.available) && (v.provider === null || v.provider === "postgres"),
  persistenceProjects: array(persistenceProject),
  persistenceProject: (v: unknown): v is { project: PersistenceProject } => record(v) && persistenceProject(v.project),
  persistenceDocuments: (v: unknown): v is { documents: PersistenceDocument[] } => record(v) && array(persistenceDocument)(v.documents),
  persistenceNodes: (v: unknown): v is { nodes: KnowledgeNode[] } => record(v) && array(persistenceKnowledgeNode)(v.nodes),
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
