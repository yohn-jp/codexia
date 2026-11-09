import { createHash, randomUUID } from "node:crypto";
import {
  PersistenceError,
  type Assertion,
  type AssertionEvidence,
  type AssertionId,
  type ChangeSet,
  type ChangeSetApplicationResult,
  type ChangeSetId,
  type ChangeSetOperation,
  type ChangeSetOperationResult,
  type ChangeSetReadSetEntry,
  type ChangeSetResource,
  type ChangeSetWriteSetEntry,
  type CreateChangeSetCommand,
  type CreateDocumentCommand,
  type CreateProjectCommand,
  type Document,
  type DocumentId,
  type DocumentRevision,
  type DocumentRevisionPage,
  type DocumentWriteResult,
  type EvidenceAnchor,
  type EvidenceAnchorHistory,
  type EvidenceId,
  type IdempotencyKey,
  type JsonObject,
  type KnowledgeAlias,
  type KnowledgeNode,
  type KnowledgeNodeId,
  type KnowledgeRelation,
  type KnowledgeRelationId,
  type LinkAssertionEvidenceCommand,
  type MentionLink,
  type Persistence,
  type PersistenceReader,
  type PersistenceTransaction,
  type Project,
  type ProjectId,
  type RevisionId,
  type RestoreDocumentRevisionCommand,
  type SaveAssertionCommand,
  type SaveDocumentCommand,
  type SaveEvidenceAnchorCommand,
  type SaveKnowledgeAliasCommand,
  type SaveKnowledgeNodeCommand,
  type SaveKnowledgeRelationCommand,
  type SaveMentionLinkCommand,
  type TextChange,
  type UpdateProjectCommand,
  type UpdateDocumentCommand,
  type DeleteDocumentCommand,
  type ModuleRecord,
  type SaveModuleRecordCommand,
} from "@codexia/persistence-contracts";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

type DbRow = QueryResultRow;

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error(`Unexpected database string value: ${String(value)}`);
}

function asNullableString(value: unknown): string | null {
  return value === null ? null : asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  throw new Error(`Unexpected database number value: ${String(value)}`);
}

function asNullableNumber(value: unknown): number | null {
  return value === null ? null : asNumber(value);
}

function asJsonObject(value: unknown): JsonObject {
  if (typeof value === "string") return JSON.parse(value) as JsonObject;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  throw new Error("Unexpected database JSON object value");
}

function asJsonArray<T>(value: unknown): T[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (Array.isArray(parsed)) return parsed as T[];
  throw new Error("Unexpected database JSON array value");
}

function mapProject(row: DbRow): Project {
  return {
    id: asString(row.id) as ProjectId,
    title: asString(row.title),
    settings: asJsonObject(row.settings),
    version: asNumber(row.version),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapDocument(row: DbRow): Document {
  return {
    id: asString(row.id) as DocumentId,
    projectId: asString(row.project_id) as ProjectId,
    parentId: asNullableString(row.parent_id) as DocumentId | null,
    kind: asString(row.kind),
    title: asString(row.title),
    orderKey: asString(row.order_key),
    headRevisionId: asNullableString(row.head_revision_id) as RevisionId | null,
    version: asNumber(row.version),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapRevision(row: DbRow): DocumentRevision {
  return {
    id: asString(row.id) as RevisionId,
    projectId: asString(row.project_id) as ProjectId,
    documentId: asString(row.document_id) as DocumentId,
    parentRevisionId: asNullableString(row.parent_revision_id) as RevisionId | null,
    markdown: asString(row.markdown),
    sha256: asString(row.sha256).trim(),
    authorId: asString(row.author_id),
    createdAt: asString(row.created_at),
  };
}

function mapKnowledgeNode(row: DbRow): KnowledgeNode {
  return {
    id: asString(row.id) as KnowledgeNodeId,
    projectId: asString(row.project_id) as ProjectId,
    type: asString(row.type),
    name: asString(row.name),
    attributes: asJsonObject(row.attributes),
    status: asString(row.status) as KnowledgeNode["status"],
    version: asNumber(row.version),
    deletedAt: asNullableString(row.deleted_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapKnowledgeAlias(row: DbRow): KnowledgeAlias {
  return {
    id: asString(row.id) as KnowledgeAlias["id"],
    projectId: asString(row.project_id) as ProjectId,
    nodeId: asString(row.node_id) as KnowledgeNodeId,
    surface: asString(row.surface),
    normalized: asString(row.normalized),
    scope: asNullableString(row.scope),
    status: asString(row.status) as KnowledgeAlias["status"],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapKnowledgeRelation(row: DbRow): KnowledgeRelation {
  return {
    id: asString(row.id) as KnowledgeRelationId,
    projectId: asString(row.project_id) as ProjectId,
    sourceId: asString(row.source_id) as KnowledgeNodeId,
    targetId: asString(row.target_id) as KnowledgeNodeId,
    type: asString(row.type),
    attributes: asJsonObject(row.attributes),
    validity: asJsonObject(row.validity),
    status: asString(row.status) as KnowledgeRelation["status"],
    version: asNumber(row.version),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapEvidenceAnchor(row: DbRow): EvidenceAnchor {
  return {
    id: asString(row.id) as EvidenceId,
    projectId: asString(row.project_id) as ProjectId,
    documentId: asString(row.document_id) as DocumentId,
    revisionId: asString(row.current_revision_id) as RevisionId,
    fromUtf16: asNumber(row.from_utf16),
    toUtf16: asNumber(row.to_utf16),
    quoteSha256: asString(row.quote_sha256).trim(),
    status: asString(row.status) as EvidenceAnchor["status"],
    version: asNumber(row.version),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapAssertion(row: DbRow): Assertion {
  return {
    id: asString(row.id) as AssertionId,
    projectId: asString(row.project_id) as ProjectId,
    proposition: asJsonObject(row.proposition),
    modality: asString(row.modality),
    perspective: asString(row.perspective),
    narrativeTime: asJsonObject(row.narrative_time),
    confidence: asNullableNumber(row.confidence),
    status: asString(row.status) as Assertion["status"],
    version: asNumber(row.version),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapChangeSet(row: DbRow): ChangeSet {
  return {
    id: asString(row.id) as ChangeSetId,
    projectId: asString(row.project_id) as ProjectId,
    authorId: asString(row.author_id),
    status: asString(row.status) as ChangeSet["status"],
    operations: asJsonArray<ChangeSetOperation>(row.operations),
    readSet: asJsonArray<ChangeSet["readSet"][number]>(row.read_set),
    writeSet: asJsonArray<ChangeSet["writeSet"][number]>(row.write_set),
    provenance: asJsonObject(row.provenance) as unknown as ChangeSet["provenance"],
    version: asNumber(row.version),
    idempotencyKey: asString(row.idempotency_key),
    createdAt: asString(row.created_at),
    approvedAt: asNullableString(row.approved_at),
    approvedBy: asNullableString(row.approved_by),
    appliedAt: asNullableString(row.applied_at),
    rejectedAt: asNullableString(row.rejected_at),
    rejectedBy: asNullableString(row.rejected_by),
  };
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]);
    return Object.fromEntries(entries);
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw validationError("JSON numbers must be finite");
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw validationError("Value is not JSON serializable");
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function bodyDigest(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function validationError(message: string): PersistenceError {
  return new PersistenceError("validation", message);
}

function notFound(resource: string, id: string): PersistenceError {
  return new PersistenceError("not_found", `${resource} was not found`, { resource, id });
}

function conflict(resource: string, id: string, expected: string | number | null, actual: string | number | null): PersistenceError {
  return new PersistenceError("conflict", `${resource} changed since it was read`, { resource, id, expected, actual });
}

function idempotencyConflict(key: IdempotencyKey): PersistenceError {
  return new PersistenceError("idempotency_conflict", "Idempotency key was already used for a different request", {
    resource: "idempotency_key",
    id: key,
  });
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw validationError(`${field} must not be empty`);
}

function assertHash(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw validationError(`${field} must be a lowercase SHA-256 digest`);
}

function assertConfidence(value: number | null): void {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw validationError("confidence must be between zero and one");
  }
}

function assertUtf16Boundary(text: string, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw validationError("Text offset is outside the revision");
  if (offset === 0 || offset === text.length) return;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    throw validationError("Text offset splits a UTF-16 surrogate pair");
  }
}

function applyTextChanges(markdown: string, changes: readonly TextChange[]): string {
  const result: string[] = [];
  let previousEnd = 0;
  for (const change of changes) {
    if (!Number.isInteger(change.fromUtf16) || !Number.isInteger(change.toUtf16) || change.fromUtf16 > change.toUtf16) {
      throw validationError("Text changes must use non-negative integer ranges");
    }
    if (change.fromUtf16 < previousEnd) throw validationError("Text changes must be sorted and non-overlapping");
    assertUtf16Boundary(markdown, change.fromUtf16);
    assertUtf16Boundary(markdown, change.toUtf16);
    result.push(markdown.slice(previousEnd, change.fromUtf16), change.insert);
    previousEnd = change.toUtf16;
  }
  result.push(markdown.slice(previousEnd));
  return result.join("");
}

function mapTextOffset(offset: number, changes: readonly TextChange[], association: -1 | 1): number {
  let delta = 0;
  for (const change of changes) {
    const insertedLength = change.insert.length;
    const removedLength = change.toUtf16 - change.fromUtf16;
    if (offset < change.fromUtf16) return offset + delta;
    if (offset > change.toUtf16) {
      delta += insertedLength - removedLength;
      continue;
    }
    if (change.fromUtf16 === change.toUtf16) {
      if (association < 0) return change.fromUtf16 + delta;
      delta += insertedLength;
      continue;
    }
    if (offset === change.fromUtf16 && association < 0) return change.fromUtf16 + delta;
    if (offset === change.toUtf16 && association > 0) {
      delta += insertedLength - removedLength;
      continue;
    }
    return change.fromUtf16 + delta + (association > 0 ? insertedLength : 0);
  }
  return offset + delta;
}

function textAnchorWasTouched(anchor: Pick<EvidenceAnchor, "fromUtf16" | "toUtf16">, changes: readonly TextChange[]): boolean {
  return changes.some((change) => change.fromUtf16 === change.toUtf16
    ? change.fromUtf16 > anchor.fromUtf16 && change.fromUtf16 < anchor.toUtf16
    : change.fromUtf16 < anchor.toUtf16 && change.toUtf16 > anchor.fromUtf16);
}

function encodeCursor(value: unknown): string {
  return asString(value);
}

function mapMentionLink(row: DbRow): MentionLink {
  return {
    projectId: asString(row.project_id) as ProjectId,
    evidenceId: asString(row.evidence_id) as EvidenceId,
    nodeId: asString(row.node_id) as KnowledgeNodeId,
    status: asString(row.status) as MentionLink["status"],
    source: asString(row.source),
    confidence: asNullableNumber(row.confidence),
    extractorVersion: asNullableString(row.extractor_version),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapAssertionEvidence(row: DbRow): AssertionEvidence {
  return {
    projectId: asString(row.project_id) as ProjectId,
    assertionId: asString(row.assertion_id) as AssertionId,
    evidenceId: asString(row.evidence_id) as EvidenceId,
    role: asString(row.evidence_role) as AssertionEvidence["role"],
    createdAt: asString(row.created_at),
  };
}

function databaseError(error: unknown): unknown {
  if (error instanceof PersistenceError) return error;
  if (!error || typeof error !== "object" || !("code" in error)) return error;
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return new PersistenceError("conflict", "A persistence constraint rejected the write");
  if (code === "23503" || code === "23514" || code === "22P02") {
    return new PersistenceError("validation", "A persistence constraint rejected the write");
  }
  return error;
}

function operationWriteTarget(operation: ChangeSetOperation): ChangeSetWriteSetEntry {
  switch (operation.type) {
    case "document.create":
      if (!operation.command.documentId) throw validationError("ChangeSet document creates require a stable documentId");
      return { resource: "document", id: operation.command.documentId };
    case "document.update":
    case "document.delete":
    case "document.save":
    case "document.restore": return { resource: "document", id: operation.command.documentId };
    case "module.record.save": return { resource: "module_record", id: JSON.stringify([operation.command.moduleId, operation.command.key]) };
    case "knowledge.node.save": return { resource: "knowledge_node", id: operation.command.id };
    case "knowledge.alias.save": return { resource: "knowledge_alias", id: operation.command.id };
    case "knowledge.relation.save": return { resource: "knowledge_relation", id: operation.command.id };
    case "evidence.anchor.save": return { resource: "evidence_anchor", id: operation.command.id };
    case "evidence.mention.save": return {
      resource: "mention_link",
      id: `${operation.command.evidenceId}:${operation.command.nodeId}`,
    };
    case "evidence.assertion.save": return { resource: "assertion", id: operation.command.id };
    case "evidence.assertion.link": return {
      resource: "assertion_evidence",
      id: `${operation.command.assertionId}:${operation.command.evidenceId}`,
    };
    default: {
      const exhaustive: never = operation;
      throw validationError(`Unsupported ChangeSet operation: ${String(exhaustive)}`);
    }
  }
}

function changeSetResourceKey(resource: ChangeSetResource, id: string): string {
  return `${resource}:${id}`;
}

function validateChangeSetOperations(
  projectId: ProjectId,
  operations: readonly ChangeSetOperation[],
  readSet: readonly ChangeSetReadSetEntry[],
  writeSet: readonly ChangeSetWriteSetEntry[],
  provenance: { source: string; actorId: string | null; details: JsonObject },
): void {
  if (operations.length === 0) throw validationError("A ChangeSet must contain at least one operation");
  for (const operation of operations) {
    if (operation.type === "module.record.save" && operation.command.moduleId.startsWith("core.")) throw validationError("Core record namespaces cannot be mutated by ChangeSets");
    if (operation.command.projectId !== projectId) throw validationError("All ChangeSet operations must use its project scope");
  }
  assertNonEmpty(provenance.source, "ChangeSet provenance source");
  digest(provenance.details);

  for (const entry of readSet) {
    assertNonEmpty(entry.id, "ChangeSet read-set id");
    if (entry.expectedVersion !== null && (!Number.isInteger(entry.expectedVersion) || entry.expectedVersion < 1)) {
      throw validationError("ChangeSet read-set versions must be positive integers or null");
    }
    if (entry.expectedRevisionId !== undefined && entry.resource !== "document") {
      throw validationError("Only document read-set entries can name a revision");
    }
  }
  const readKeys = readSet.map((entry) => changeSetResourceKey(entry.resource, entry.id));
  if (new Set(readKeys).size !== readKeys.length) throw validationError("ChangeSet read-set entries must be unique");

  for (const entry of writeSet) assertNonEmpty(entry.id, "ChangeSet write-set id");
  const declaredWriteKeys = writeSet.map((entry) => changeSetResourceKey(entry.resource, entry.id));
  if (new Set(declaredWriteKeys).size !== declaredWriteKeys.length) throw validationError("ChangeSet write-set entries must be unique");
  const operationWriteKeys = operations.map((operation) => {
    const target = operationWriteTarget(operation);
    return changeSetResourceKey(target.resource, target.id);
  });
  if (JSON.stringify([...new Set(operationWriteKeys)].sort()) !== JSON.stringify([...declaredWriteKeys].sort())) {
    throw validationError("ChangeSet writeSet must exactly describe the operations");
  }
}

class PostgresTransaction implements PersistenceTransaction {
  readonly changedProjects = new Set<ProjectId>();

  constructor(private readonly client: PoolClient, private readonly readOnly: boolean) {}

  private async query<Row extends DbRow = DbRow>(text: string, values: readonly unknown[] = []) {
    return this.client.query<Row>(text, [...values]);
  }

  private ensureWritable(): void {
    if (this.readOnly) throw new Error("Cannot write through a persistence read snapshot");
  }

  private markChanged(projectId: ProjectId): void {
    this.changedProjects.add(projectId);
  }

  async getProject(projectId: ProjectId): Promise<Project | undefined> {
    const result = await this.query("SELECT * FROM project WHERE id = $1", [projectId]);
    return result.rows[0] ? mapProject(result.rows[0]) : undefined;
  }

  async listProjects(limit = 100): Promise<readonly Project[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw validationError("Project page size must be between 1 and 200");
    const result = await this.query("SELECT * FROM project ORDER BY updated_at DESC, id LIMIT $1", [limit]);
    return result.rows.map(mapProject);
  }

  async getDocument(projectId: ProjectId, documentId: DocumentId): Promise<Document | undefined> {
    const result = await this.query("SELECT * FROM document WHERE project_id = $1 AND id = $2 AND deleted_at IS NULL", [projectId, documentId]);
    return result.rows[0] ? mapDocument(result.rows[0]) : undefined;
  }

  async listDocuments(projectId: ProjectId, parentId?: DocumentId | null, limit = 500): Promise<readonly Document[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw validationError("Document page size must be between 1 and 1000");
    const result = parentId === undefined
      ? await this.query("SELECT * FROM document WHERE project_id = $1 AND deleted_at IS NULL ORDER BY parent_id NULLS FIRST, order_key, id LIMIT $2", [projectId, limit])
      : await this.query("SELECT * FROM document WHERE project_id = $1 AND deleted_at IS NULL AND parent_id IS NOT DISTINCT FROM $2 ORDER BY order_key, id LIMIT $3", [projectId, parentId, limit]);
    return result.rows.map(mapDocument);
  }

  async getRevision(projectId: ProjectId, documentId: DocumentId, revisionId: RevisionId): Promise<DocumentRevision | undefined> {
    const result = await this.query(
      "SELECT * FROM document_revision WHERE project_id = $1 AND document_id = $2 AND id = $3",
      [projectId, documentId, revisionId],
    );
    return result.rows[0] ? mapRevision(result.rows[0]) : undefined;
  }

  async listRevisions(projectId: ProjectId, documentId: DocumentId, limit: number, before?: string): Promise<DocumentRevisionPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw validationError("Revision page size must be between 1 and 200");
    const result = await this.query(
      `SELECT revision.* FROM document_revision AS revision
       WHERE revision.project_id = $1 AND revision.document_id = $2
         AND ($3::uuid IS NULL OR (revision.created_at, revision.id) < (
           SELECT cursor.created_at, cursor.id FROM document_revision AS cursor
           WHERE cursor.project_id = $1 AND cursor.document_id = $2 AND cursor.id = $3
         ))
       ORDER BY revision.created_at DESC, revision.id DESC LIMIT $4`,
      [projectId, documentId, before ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    return {
      revisions: rows.map(mapRevision),
      nextBefore: hasMore && rows.length > 0 ? encodeCursor(rows[rows.length - 1]?.id) : null,
    };
  }

  async getKnowledgeNode(projectId: ProjectId, nodeId: KnowledgeNodeId): Promise<KnowledgeNode | undefined> {
    const result = await this.query("SELECT * FROM knowledge_node WHERE project_id = $1 AND id = $2", [projectId, nodeId]);
    return result.rows[0] ? mapKnowledgeNode(result.rows[0]) : undefined;
  }

  async listKnowledgeNodes(projectId: ProjectId, limit = 100): Promise<readonly KnowledgeNode[]> {
    const result = await this.query(
      "SELECT * FROM knowledge_node WHERE project_id = $1 AND deleted_at IS NULL ORDER BY name, id LIMIT $2",
      [projectId, limit],
    );
    return result.rows.map(mapKnowledgeNode);
  }

  async listKnowledgeAliases(projectId: ProjectId, nodeId: KnowledgeNodeId): Promise<readonly KnowledgeAlias[]> {
    const result = await this.query(
      "SELECT * FROM knowledge_alias WHERE project_id = $1 AND node_id = $2 ORDER BY normalized, id",
      [projectId, nodeId],
    );
    return result.rows.map(mapKnowledgeAlias);
  }

  async listKnowledgeRelations(projectId: ProjectId, nodeId: KnowledgeNodeId): Promise<readonly KnowledgeRelation[]> {
    const result = await this.query(
      "SELECT * FROM knowledge_relation WHERE project_id = $1 AND (source_id = $2 OR target_id = $2) ORDER BY type, id",
      [projectId, nodeId],
    );
    return result.rows.map(mapKnowledgeRelation);
  }

  async getEvidenceAnchor(projectId: ProjectId, evidenceId: EvidenceId): Promise<EvidenceAnchor | undefined> {
    const result = await this.query("SELECT * FROM text_anchor WHERE project_id = $1 AND id = $2", [projectId, evidenceId]);
    return result.rows[0] ? mapEvidenceAnchor(result.rows[0]) : undefined;
  }

  async listDocumentEvidence(projectId: ProjectId, documentId: DocumentId, revisionId?: RevisionId, limit = 200): Promise<readonly EvidenceAnchor[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw validationError("Evidence page size must be between 1 and 500");
    const result = await this.query(
      `SELECT * FROM text_anchor
       WHERE project_id = $1 AND document_id = $2 AND ($3::uuid IS NULL OR current_revision_id = $3)
       ORDER BY from_utf16, id LIMIT $4`,
      [projectId, documentId, revisionId ?? null, limit],
    );
    return result.rows.map(mapEvidenceAnchor);
  }

  async listEvidenceHistory(projectId: ProjectId, evidenceId: EvidenceId): Promise<readonly EvidenceAnchorHistory[]> {
    const result = await this.query(
      `SELECT evidence_id, revision_id, from_utf16, to_utf16, status, recorded_at
       FROM anchor_history WHERE project_id = $1 AND evidence_id = $2 ORDER BY version`,
      [projectId, evidenceId],
    );
    return result.rows.map((row) => ({
      evidenceId: asString(row.evidence_id) as EvidenceId,
      revisionId: asString(row.revision_id) as RevisionId,
      fromUtf16: asNumber(row.from_utf16),
      toUtf16: asNumber(row.to_utf16),
      status: asString(row.status) as EvidenceAnchorHistory["status"],
      recordedAt: asString(row.recorded_at),
    }));
  }

  async listMentionLinks(projectId: ProjectId, evidenceId: EvidenceId): Promise<readonly MentionLink[]> {
    const result = await this.query(
      "SELECT * FROM mention_link WHERE project_id = $1 AND evidence_id = $2 ORDER BY node_id",
      [projectId, evidenceId],
    );
    return result.rows.map(mapMentionLink);
  }

  async listNodeMentions(projectId: ProjectId, nodeId: KnowledgeNodeId, limit = 200): Promise<readonly MentionLink[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw validationError("Mention page size must be between 1 and 500");
    const result = await this.query(
      `SELECT * FROM mention_link WHERE project_id = $1 AND node_id = $2
       ORDER BY updated_at DESC, evidence_id LIMIT $3`,
      [projectId, nodeId, limit],
    );
    return result.rows.map(mapMentionLink);
  }

  async getAssertion(projectId: ProjectId, assertionId: AssertionId): Promise<Assertion | undefined> {
    const result = await this.query("SELECT * FROM assertion WHERE project_id = $1 AND id = $2", [projectId, assertionId]);
    return result.rows[0] ? mapAssertion(result.rows[0]) : undefined;
  }

  async listAssertionEvidence(projectId: ProjectId, assertionId: AssertionId): Promise<readonly AssertionEvidence[]> {
    const result = await this.query(
      "SELECT * FROM assertion_evidence WHERE project_id = $1 AND assertion_id = $2 ORDER BY evidence_id",
      [projectId, assertionId],
    );
    return result.rows.map(mapAssertionEvidence);
  }

  async listEvidenceAssertions(projectId: ProjectId, evidenceId: EvidenceId, limit = 100): Promise<readonly AssertionEvidence[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw validationError("Assertion evidence page size must be between 1 and 200");
    const result = await this.query(
      "SELECT * FROM assertion_evidence WHERE project_id = $1 AND evidence_id = $2 ORDER BY assertion_id, evidence_role LIMIT $3",
      [projectId, evidenceId, limit],
    );
    return result.rows.map(mapAssertionEvidence);
  }

  async getChangeSet(projectId: ProjectId, changeSetId: ChangeSetId): Promise<ChangeSet | undefined> {
    const result = await this.query("SELECT * FROM change_set WHERE project_id = $1 AND id = $2", [projectId, changeSetId]);
    return result.rows[0] ? mapChangeSet(result.rows[0]) : undefined;
  }

  async createProject(command: CreateProjectCommand): Promise<Project> {
    this.ensureWritable();
    assertNonEmpty(command.title, "Project title");
    const id = command.id ?? randomUUID() as ProjectId;
    const result = await this.query(
      "INSERT INTO project(id, title, settings) VALUES ($1, $2, $3::jsonb) RETURNING *",
      [id, command.title, toJson(command.settings ?? {})],
    );
    return mapProject(result.rows[0]!);
  }

  async updateProject(command: UpdateProjectCommand): Promise<Project> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    if (command.title !== undefined) assertNonEmpty(command.title, "Project title");
    const result = await this.query(
      `UPDATE project SET title = COALESCE($3, title), settings = COALESCE($4::jsonb, settings),
       updated_at = clock_timestamp() WHERE id = $1 AND version = $2 RETURNING *`,
      [command.projectId, command.expectedVersion, command.title ?? null, command.settings === undefined ? null : toJson(command.settings)],
    );
    if (!result.rows[0]) throw conflict("project", command.projectId, command.expectedVersion, (await this.getProject(command.projectId))?.version ?? null);
    this.markChanged(command.projectId);
    return {...mapProject(result.rows[0]), version: asNumber(result.rows[0].version) + 1};
  }

  async assertProjectVersion(projectId: ProjectId, expectedVersion?: number): Promise<void> {
    this.ensureWritable();
    const result = await this.query("SELECT version FROM project WHERE id = $1 FOR UPDATE", [projectId]);
    if (!result.rows[0]) throw notFound("project", projectId);
    const actual = asNumber(result.rows[0].version);
    if (expectedVersion !== undefined && actual !== expectedVersion) throw conflict("project", projectId, expectedVersion, actual);
  }

  private async lockProject(projectId: ProjectId): Promise<void> {
    const result = await this.query("SELECT id FROM project WHERE id = $1 FOR UPDATE", [projectId]);
    if (!result.rows[0]) throw notFound("project", projectId);
  }

  async updateDocument(command: UpdateDocumentCommand): Promise<Document> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    if (command.title !== undefined) assertNonEmpty(command.title, "Document title");
    if (command.parentId !== undefined && command.parentId !== null) {
      if (!(await this.getDocument(command.projectId, command.parentId))) throw notFound("parent document", command.parentId);
      const cycle = await this.query(
        `WITH RECURSIVE ancestors AS (
           SELECT id, parent_id FROM document WHERE project_id = $1 AND id = $2
           UNION SELECT d.id, d.parent_id FROM document d JOIN ancestors a ON d.id = a.parent_id WHERE d.project_id = $1
         ) SELECT 1 FROM ancestors WHERE id = $3`, [command.projectId, command.parentId, command.documentId]);
      if (cycle.rows.length) throw validationError("Document hierarchy cannot contain a cycle");
    }
    const result = await this.query(
      `UPDATE document SET parent_id = CASE WHEN $4 THEN $5::uuid ELSE parent_id END,
       title = COALESCE($6, title), order_key = COALESCE($7, order_key), version = version + 1,
       updated_at = clock_timestamp() WHERE project_id = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING *`,
      [command.projectId, command.documentId, command.expectedVersion, command.parentId !== undefined, command.parentId ?? null, command.title ?? null, command.orderKey ?? null]);
    if (!result.rows[0]) throw conflict("document", command.documentId, command.expectedVersion, (await this.getDocument(command.projectId, command.documentId))?.version ?? null);
    this.markChanged(command.projectId);
    return mapDocument(result.rows[0]);
  }

  async deleteDocument(command: DeleteDocumentCommand): Promise<Document> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    const children = await this.query("SELECT 1 FROM document WHERE project_id = $1 AND parent_id = $2 AND deleted_at IS NULL LIMIT 1", [command.projectId, command.documentId]);
    if (children.rows.length) throw validationError("Delete child documents before their parent");
    const result = await this.query(
      `UPDATE document SET deleted_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp()
       WHERE project_id = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING *`,
      [command.projectId, command.documentId, command.expectedVersion]);
    if (!result.rows[0]) throw conflict("document", command.documentId, command.expectedVersion, (await this.getDocument(command.projectId, command.documentId))?.version ?? null);
    this.markChanged(command.projectId);
    return mapDocument(result.rows[0]);
  }

  async getModuleRecord(projectId: ProjectId, moduleId: string, key: string): Promise<ModuleRecord | undefined> {
    const result = await this.query("SELECT * FROM module_record WHERE project_id = $1 AND module_id = $2 AND key = $3", [projectId, moduleId, key]);
    return result.rows[0] ? this.mapModuleRecord(result.rows[0]) : undefined;
  }

  async listModuleRecords(projectId: ProjectId, moduleId?: string): Promise<readonly ModuleRecord[]> {
    const result = await this.query("SELECT * FROM module_record WHERE project_id = $1 AND ($2::text IS NULL OR module_id = $2) ORDER BY module_id, key", [projectId, moduleId ?? null]);
    return result.rows.map((row) => this.mapModuleRecord(row));
  }

  private mapModuleRecord(row: DbRow): ModuleRecord {
    return { projectId: asString(row.project_id) as ProjectId, moduleId: asString(row.module_id), key: asString(row.key), value: asJsonObject(row.value), version: asNumber(row.version), createdAt: asString(row.created_at), updatedAt: asString(row.updated_at) };
  }

  async saveModuleRecord(command: SaveModuleRecordCommand): Promise<ModuleRecord> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.moduleId, "Module id");
    assertNonEmpty(command.key, "Module record key");
    const result = command.expectedVersion === null
      ? await this.query(`INSERT INTO module_record(project_id, module_id, key, value) VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT DO NOTHING RETURNING *`, [command.projectId, command.moduleId, command.key, toJson(command.value)])
      : await this.query(`UPDATE module_record SET value = $4::jsonb, version = version + 1, updated_at = clock_timestamp()
          WHERE project_id = $1 AND module_id = $2 AND key = $3 AND version = $5 RETURNING *`, [command.projectId, command.moduleId, command.key, toJson(command.value), command.expectedVersion]);
    if (!result.rows[0]) throw conflict("module_record", JSON.stringify([command.moduleId, command.key]), command.expectedVersion, (await this.getModuleRecord(command.projectId, command.moduleId, command.key))?.version ?? null);
    if (!command.moduleId.startsWith("core.authority.")) this.markChanged(command.projectId);
    return this.mapModuleRecord(result.rows[0]);
  }

  /** Serialize same-project retries before checking the durable idempotency receipt. */
  private async lockIdempotencyKey(projectId: ProjectId, key: IdempotencyKey): Promise<void> {
    await this.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [JSON.stringify([projectId, key])]);
  }

  private async existingIdempotentWrite(
    projectId: ProjectId,
    idempotencyKey: IdempotencyKey,
    requestSha256: string,
  ): Promise<DocumentWriteResult | undefined> {
    const result = await this.query(
      "SELECT request_sha256, response_document, new_revision_id, document_id FROM edit_operation WHERE project_id = $1 AND idempotency_key = $2",
      [projectId, idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (asString(row.request_sha256).trim() !== requestSha256) throw idempotencyConflict(idempotencyKey);
    const revision = await this.getRevision(projectId, asString(row.document_id) as DocumentId, asString(row.new_revision_id) as RevisionId);
    if (!revision) throw new Error("Idempotency record references a missing immutable revision");
    return {
      document: asJsonObject(row.response_document) as unknown as Document,
      revision,
      replayed: true,
    };
  }

  private async insertRevision(command: {
    projectId: ProjectId;
    documentId: DocumentId;
    parentRevisionId: RevisionId | null;
    markdown: string;
    authorId: string;
  }): Promise<DocumentRevision> {
    const id = randomUUID() as RevisionId;
    const result = await this.query(
      `INSERT INTO document_revision(project_id, document_id, id, parent_revision_id, markdown, sha256, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [command.projectId, command.documentId, id, command.parentRevisionId, command.markdown, bodyDigest(command.markdown), command.authorId],
    );
    return mapRevision(result.rows[0]!);
  }

  private async updateDocumentHead(
    projectId: ProjectId,
    documentId: DocumentId,
    expectedHead: RevisionId | null,
    revisionId: RevisionId,
  ): Promise<Document> {
    const result = await this.query(
      `UPDATE document SET head_revision_id = $4, version = version + 1, updated_at = clock_timestamp()
       WHERE project_id = $1 AND id = $2 AND deleted_at IS NULL AND head_revision_id IS NOT DISTINCT FROM $3
       RETURNING *`,
      [projectId, documentId, expectedHead, revisionId],
    );
    if (!result.rows[0]) {
      const current = await this.getDocument(projectId, documentId);
      if (!current) throw notFound("document", documentId);
      throw conflict("document_revision", documentId, expectedHead, current.headRevisionId);
    }
    this.markChanged(projectId);
    return mapDocument(result.rows[0]);
  }

  private async recordDocumentOperation(command: {
    projectId: ProjectId;
    documentId: DocumentId;
    baseRevisionId: RevisionId | null;
    revision: DocumentRevision;
    document: Document;
    idempotencyKey: IdempotencyKey;
    operationType: "document.create" | "document.save" | "document.restore";
    requestSha256: string;
    changeDescription: unknown;
    clientId: string;
  }): Promise<void> {
    await this.query(
      `INSERT INTO edit_operation(
         project_id, idempotency_key, operation_type, document_id, base_revision_id, new_revision_id,
         request_sha256, change_desc, client_id, response_document
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb)`,
      [
        command.projectId, command.idempotencyKey, command.operationType, command.documentId,
        command.baseRevisionId, command.revision.id, command.requestSha256,
        toJson(command.changeDescription), command.clientId, toJson(command.document),
      ],
    );
  }

  async createDocument(command: CreateDocumentCommand): Promise<DocumentWriteResult> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.idempotencyKey, "Idempotency key");
    assertNonEmpty(command.authorId, "Author id");
    assertNonEmpty(command.title, "Document title");
    assertNonEmpty(command.kind, "Document kind");
    const requestSha256 = digest({
      type: "document.create",
      projectId: command.projectId,
      documentId: command.documentId ?? null,
      parentId: command.parentId ?? null,
      kind: command.kind,
      title: command.title,
      orderKey: command.orderKey,
      markdown: command.markdown,
      authorId: command.authorId,
    });
    await this.lockIdempotencyKey(command.projectId, command.idempotencyKey);
    const replay = await this.existingIdempotentWrite(command.projectId, command.idempotencyKey, requestSha256);
    if (replay) return replay;
    if (!(await this.getProject(command.projectId))) throw notFound("project", command.projectId);

    await this.lockProject(command.projectId);
    const documentId = command.documentId ?? randomUUID() as DocumentId;
    const parentId = command.parentId ?? null;
    if (parentId && !(await this.getDocument(command.projectId, parentId))) throw notFound("parent document", parentId);
    await this.query(
      `INSERT INTO document(project_id, id, parent_id, kind, title, order_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [command.projectId, documentId, parentId, command.kind, command.title, command.orderKey],
    );
    const revision = await this.insertRevision({
      projectId: command.projectId,
      documentId,
      parentRevisionId: null,
      markdown: command.markdown,
      authorId: command.authorId,
    });
    const document = await this.updateDocumentHead(command.projectId, documentId, null, revision.id);
    await this.recordDocumentOperation({
      projectId: command.projectId,
      documentId,
      baseRevisionId: null,
      revision,
      document,
      idempotencyKey: command.idempotencyKey,
      operationType: "document.create",
      requestSha256,
      changeDescription: { initialBodySha256: revision.sha256 },
      clientId: "",
    });
    return { document, revision, replayed: false };
  }

  private async lockedHead(projectId: ProjectId, documentId: DocumentId): Promise<Document> {
    const result = await this.query(
      "SELECT * FROM document WHERE project_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
      [projectId, documentId],
    );
    if (!result.rows[0]) throw notFound("document", documentId);
    return mapDocument(result.rows[0]);
  }

  private async advanceEvidenceAnchors(
    projectId: ProjectId,
    documentId: DocumentId,
    baseRevisionId: RevisionId,
    nextRevisionId: RevisionId,
    nextMarkdown: string,
    changes: readonly TextChange[],
  ): Promise<void> {
    const result = await this.query(
      `SELECT * FROM text_anchor
       WHERE project_id = $1 AND document_id = $2 AND current_revision_id = $3
       ORDER BY id FOR UPDATE`,
      [projectId, documentId, baseRevisionId],
    );
    for (const row of result.rows) {
      const anchor = mapEvidenceAnchor(row);
      const wasOrphaned = anchor.status === "orphaned";
      const touched = !wasOrphaned && textAnchorWasTouched(anchor, changes);
      let fromUtf16 = mapTextOffset(anchor.fromUtf16, changes, touched ? -1 : 1);
      let toUtf16 = mapTextOffset(anchor.toUtf16, changes, touched ? 1 : -1);
      fromUtf16 = Math.min(nextMarkdown.length, Math.max(0, fromUtf16));
      toUtf16 = Math.min(nextMarkdown.length, Math.max(fromUtf16, toUtf16));
      const status: EvidenceAnchor["status"] = wasOrphaned || fromUtf16 === toUtf16
        ? "orphaned"
        : touched
          ? "needs_review"
          : anchor.status;
      const quoteSha256 = fromUtf16 < toUtf16
        ? bodyDigest(nextMarkdown.slice(fromUtf16, toUtf16))
        : anchor.quoteSha256;
      const updated = await this.query(
        `UPDATE text_anchor SET current_revision_id = $4, from_utf16 = $5, to_utf16 = $6,
           quote_sha256 = $7, status = $8, version = version + 1, updated_at = clock_timestamp()
         WHERE project_id = $1 AND id = $2 AND version = $3 RETURNING version`,
        [projectId, anchor.id, anchor.version, nextRevisionId, fromUtf16, toUtf16, quoteSha256, status],
      );
      const version = asNumber(updated.rows[0]!.version);
      await this.query(
        `INSERT INTO anchor_history(project_id, evidence_id, document_id, version, revision_id, from_utf16, to_utf16, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [projectId, anchor.id, documentId, version, nextRevisionId, fromUtf16, toUtf16, status],
      );
      if (touched || status === "orphaned") {
        await this.query(
          `UPDATE mention_link SET status = 'proposed', updated_at = clock_timestamp()
           WHERE project_id = $1 AND evidence_id = $2 AND status = 'confirmed'`,
          [projectId, anchor.id],
        );
      }
    }
  }

  async saveDocument(command: SaveDocumentCommand): Promise<DocumentWriteResult> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.idempotencyKey, "Idempotency key");
    assertNonEmpty(command.authorId, "Author id");
    assertNonEmpty(command.clientId, "Client id");
    assertHash(command.resultingSha256, "resultingSha256");
    const requestSha256 = digest({
      type: "document.save",
      projectId: command.projectId,
      documentId: command.documentId,
      baseRevisionId: command.baseRevisionId,
      changes: command.changes,
      resultingSha256: command.resultingSha256,
      authorId: command.authorId,
      clientId: command.clientId,
    });
    await this.lockIdempotencyKey(command.projectId, command.idempotencyKey);
    const replay = await this.existingIdempotentWrite(command.projectId, command.idempotencyKey, requestSha256);
    if (replay) return replay;

    const head = await this.lockedHead(command.projectId, command.documentId);
    if (head.headRevisionId !== command.baseRevisionId) {
      throw conflict("document_revision", command.documentId, command.baseRevisionId, head.headRevisionId);
    }
    const base = await this.getRevision(command.projectId, command.documentId, command.baseRevisionId);
    if (!base) throw notFound("document revision", command.baseRevisionId);
    const markdown = applyTextChanges(base.markdown, command.changes);
    const actualHash = bodyDigest(markdown);
    if (actualHash !== command.resultingSha256) {
      throw validationError("The supplied changes do not produce resultingSha256");
    }
    const revision = await this.insertRevision({
      projectId: command.projectId,
      documentId: command.documentId,
      parentRevisionId: base.id,
      markdown,
      authorId: command.authorId,
    });
    const document = await this.updateDocumentHead(command.projectId, command.documentId, base.id, revision.id);
    await this.advanceEvidenceAnchors(command.projectId, command.documentId, base.id, revision.id, markdown, command.changes);
    await this.recordDocumentOperation({
      projectId: command.projectId,
      documentId: command.documentId,
      baseRevisionId: base.id,
      revision,
      document,
      idempotencyKey: command.idempotencyKey,
      operationType: "document.save",
      requestSha256,
      changeDescription: command.changes,
      clientId: command.clientId,
    });
    return { document, revision, replayed: false };
  }

  async restoreDocumentRevision(command: RestoreDocumentRevisionCommand): Promise<DocumentWriteResult> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.idempotencyKey, "Idempotency key");
    assertNonEmpty(command.authorId, "Author id");
    const requestSha256 = digest({
      type: "document.restore",
      projectId: command.projectId,
      documentId: command.documentId,
      baseRevisionId: command.baseRevisionId,
      sourceRevisionId: command.sourceRevisionId,
      authorId: command.authorId,
    });
    await this.lockIdempotencyKey(command.projectId, command.idempotencyKey);
    const replay = await this.existingIdempotentWrite(command.projectId, command.idempotencyKey, requestSha256);
    if (replay) return replay;

    const head = await this.lockedHead(command.projectId, command.documentId);
    if (head.headRevisionId !== command.baseRevisionId) {
      throw conflict("document_revision", command.documentId, command.baseRevisionId, head.headRevisionId);
    }
    const source = await this.getRevision(command.projectId, command.documentId, command.sourceRevisionId);
    if (!source) throw notFound("source document revision", command.sourceRevisionId);
    const revision = await this.insertRevision({
      projectId: command.projectId,
      documentId: command.documentId,
      parentRevisionId: command.baseRevisionId,
      markdown: source.markdown,
      authorId: command.authorId,
    });
    const document = await this.updateDocumentHead(command.projectId, command.documentId, command.baseRevisionId, revision.id);
    const base = await this.getRevision(command.projectId, command.documentId, command.baseRevisionId);
    if (!base) throw notFound("base document revision", command.baseRevisionId);
    const restoreChanges: TextChange[] = base.markdown === source.markdown ? [] : [{
      fromUtf16: 0,
      toUtf16: base.markdown.length,
      insert: source.markdown,
    }];
    await this.advanceEvidenceAnchors(command.projectId, command.documentId, base.id, revision.id, source.markdown, restoreChanges);
    await this.recordDocumentOperation({
      projectId: command.projectId,
      documentId: command.documentId,
      baseRevisionId: command.baseRevisionId,
      revision,
      document,
      idempotencyKey: command.idempotencyKey,
      operationType: "document.restore",
      requestSha256,
      changeDescription: { restoredFrom: source.id },
      clientId: "",
    });
    return { document, revision, replayed: false };
  }

  async saveKnowledgeNode(command: SaveKnowledgeNodeCommand): Promise<KnowledgeNode> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.type, "Knowledge node type");
    assertNonEmpty(command.name, "Knowledge node name");
    if (command.expectedVersion === null) {
      const result = await this.query(
        `INSERT INTO knowledge_node(project_id, id, type, name, attributes, status, deleted_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, CASE WHEN $6 = 'retired' THEN clock_timestamp() END)
         RETURNING *`,
        [command.projectId, command.id, command.type, command.name, toJson(command.attributes), command.status],
      );
      this.markChanged(command.projectId);
      return mapKnowledgeNode(result.rows[0]!);
    }
    const result = await this.query(
      `UPDATE knowledge_node SET type = $3, name = $4, attributes = $5::jsonb, status = $6,
         deleted_at = CASE WHEN $6 = 'retired' THEN coalesce(deleted_at, clock_timestamp()) ELSE NULL END,
         version = version + 1, updated_at = clock_timestamp()
       WHERE project_id = $1 AND id = $2 AND version = $7 RETURNING *`,
      [command.projectId, command.id, command.type, command.name, toJson(command.attributes), command.status, command.expectedVersion],
    );
    if (!result.rows[0]) {
      const current = await this.getKnowledgeNode(command.projectId, command.id);
      if (!current) throw conflict("knowledge_node", command.id, command.expectedVersion, null);
      throw conflict("knowledge_node", command.id, command.expectedVersion, current.version);
    }
    this.markChanged(command.projectId);
    return mapKnowledgeNode(result.rows[0]);
  }

  async saveKnowledgeAlias(command: SaveKnowledgeAliasCommand): Promise<KnowledgeAlias> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.surface, "Knowledge alias surface");
    assertNonEmpty(command.normalized, "Knowledge alias normalized value");
    if (!(await this.getKnowledgeNode(command.projectId, command.nodeId))) throw notFound("knowledge node", command.nodeId);
    const result = await this.query(
      `INSERT INTO knowledge_alias(project_id, id, node_id, surface, normalized, scope, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, id) DO UPDATE SET node_id = EXCLUDED.node_id, surface = EXCLUDED.surface,
         normalized = EXCLUDED.normalized, scope = EXCLUDED.scope, status = EXCLUDED.status, updated_at = clock_timestamp()
       RETURNING *`,
      [command.projectId, command.id, command.nodeId, command.surface, command.normalized, command.scope, command.status],
    );
    this.markChanged(command.projectId);
    return mapKnowledgeAlias(result.rows[0]!);
  }

  async saveKnowledgeRelation(command: SaveKnowledgeRelationCommand): Promise<KnowledgeRelation> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.type, "Knowledge relation type");
    if (!(await this.getKnowledgeNode(command.projectId, command.sourceId))) throw notFound("source knowledge node", command.sourceId);
    if (!(await this.getKnowledgeNode(command.projectId, command.targetId))) throw notFound("target knowledge node", command.targetId);
    let result;
    if (command.expectedVersion === null) {
      result = await this.query(
        `INSERT INTO knowledge_relation(project_id, id, source_id, target_id, type, attributes, validity, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) RETURNING *`,
        [command.projectId, command.id, command.sourceId, command.targetId, command.type, toJson(command.attributes), toJson(command.validity), command.status],
      );
    } else {
      result = await this.query(
        `UPDATE knowledge_relation SET source_id = $3, target_id = $4, type = $5,
           attributes = $6::jsonb, validity = $7::jsonb, status = $8, version = version + 1,
           updated_at = clock_timestamp()
         WHERE project_id = $1 AND id = $2 AND version = $9 RETURNING *`,
        [command.projectId, command.id, command.sourceId, command.targetId, command.type, toJson(command.attributes), toJson(command.validity), command.status, command.expectedVersion],
      );
      if (!result.rows[0]) {
        const current = await this.query("SELECT version FROM knowledge_relation WHERE project_id = $1 AND id = $2", [command.projectId, command.id]);
        throw conflict("knowledge_relation", command.id, command.expectedVersion, current.rows[0] ? asNumber(current.rows[0].version) : null);
      }
    }
    this.markChanged(command.projectId);
    return mapKnowledgeRelation(result.rows[0]!);
  }

  async saveEvidenceAnchor(command: SaveEvidenceAnchorCommand): Promise<EvidenceAnchor> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertHash(command.quoteSha256, "quoteSha256");
    if (!Number.isInteger(command.fromUtf16) || !Number.isInteger(command.toUtf16) || command.fromUtf16 >= command.toUtf16) {
      throw validationError("Evidence anchors require a non-empty UTF-16 range");
    }
    const revision = await this.getRevision(command.projectId, command.documentId, command.revisionId);
    if (!revision) throw notFound("evidence document revision", command.revisionId);
    // Serialize head validation with document saves; an anchor must not be
    // created against an already-superseded revision in a concurrent writer.
    const document = await this.lockedHead(command.projectId, command.documentId);
    if (document.headRevisionId !== command.revisionId) {
      throw conflict("document_revision", command.documentId, command.revisionId, document.headRevisionId);
    }
    assertUtf16Boundary(revision.markdown, command.fromUtf16);
    assertUtf16Boundary(revision.markdown, command.toUtf16);
    if (bodyDigest(revision.markdown.slice(command.fromUtf16, command.toUtf16)) !== command.quoteSha256) {
      throw validationError("Evidence quote hash does not match the referenced revision range");
    }

    let result;
    if (command.expectedVersion === null) {
      result = await this.query(
        `INSERT INTO text_anchor(project_id, id, document_id, current_revision_id, from_utf16, to_utf16, quote_sha256, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [command.projectId, command.id, command.documentId, command.revisionId, command.fromUtf16, command.toUtf16, command.quoteSha256, command.status],
      );
    } else {
      result = await this.query(
        `UPDATE text_anchor SET current_revision_id = $4, from_utf16 = $5, to_utf16 = $6, quote_sha256 = $7,
           status = $8, version = version + 1, updated_at = clock_timestamp()
         WHERE project_id = $1 AND id = $2 AND document_id = $3 AND version = $9 RETURNING *`,
        [command.projectId, command.id, command.documentId, command.revisionId, command.fromUtf16, command.toUtf16, command.quoteSha256, command.status, command.expectedVersion],
      );
      if (!result.rows[0]) {
        const current = await this.query("SELECT version FROM text_anchor WHERE project_id = $1 AND id = $2", [command.projectId, command.id]);
        throw conflict("evidence_anchor", command.id, command.expectedVersion, current.rows[0] ? asNumber(current.rows[0].version) : null);
      }
    }
    const anchor = mapEvidenceAnchor(result.rows[0]!);
    await this.query(
      `INSERT INTO anchor_history(project_id, evidence_id, document_id, version, revision_id, from_utf16, to_utf16, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [command.projectId, command.id, command.documentId, anchor.version, command.revisionId, command.fromUtf16, command.toUtf16, command.status],
    );
    this.markChanged(command.projectId);
    return anchor;
  }

  async saveMentionLink(command: SaveMentionLinkCommand): Promise<MentionLink> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.source, "Mention source");
    assertConfidence(command.confidence);
    if (!(await this.getEvidenceAnchor(command.projectId, command.evidenceId))) throw notFound("evidence anchor", command.evidenceId);
    if (!(await this.getKnowledgeNode(command.projectId, command.nodeId))) throw notFound("knowledge node", command.nodeId);
    const result = await this.query(
      `INSERT INTO mention_link(project_id, evidence_id, node_id, status, source, confidence, extractor_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (project_id, evidence_id, node_id) DO UPDATE SET status = EXCLUDED.status,
         source = EXCLUDED.source, confidence = EXCLUDED.confidence, extractor_version = EXCLUDED.extractor_version,
         updated_at = clock_timestamp()
       RETURNING *`,
      [command.projectId, command.evidenceId, command.nodeId, command.status, command.source, command.confidence, command.extractorVersion],
    );
    this.markChanged(command.projectId);
    return mapMentionLink(result.rows[0]!);
  }

  async saveAssertion(command: SaveAssertionCommand): Promise<Assertion> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.modality, "Assertion modality");
    assertNonEmpty(command.perspective, "Assertion perspective");
    assertConfidence(command.confidence);
    let result;
    if (command.expectedVersion === null) {
      result = await this.query(
        `INSERT INTO assertion(project_id, id, proposition, modality, perspective, narrative_time, confidence, status)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
        [command.projectId, command.id, toJson(command.proposition), command.modality, command.perspective, toJson(command.narrativeTime), command.confidence, command.status],
      );
    } else {
      result = await this.query(
        `UPDATE assertion SET proposition = $3::jsonb, modality = $4, perspective = $5, narrative_time = $6::jsonb,
           confidence = $7, status = $8, version = version + 1, updated_at = clock_timestamp()
         WHERE project_id = $1 AND id = $2 AND version = $9 RETURNING *`,
        [command.projectId, command.id, toJson(command.proposition), command.modality, command.perspective, toJson(command.narrativeTime), command.confidence, command.status, command.expectedVersion],
      );
      if (!result.rows[0]) {
        const current = await this.query("SELECT version FROM assertion WHERE project_id = $1 AND id = $2", [command.projectId, command.id]);
        throw conflict("assertion", command.id, command.expectedVersion, current.rows[0] ? asNumber(current.rows[0].version) : null);
      }
    }
    this.markChanged(command.projectId);
    return mapAssertion(result.rows[0]!);
  }

  async linkAssertionEvidence(command: LinkAssertionEvidenceCommand): Promise<AssertionEvidence> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    if (!(await this.getAssertion(command.projectId, command.assertionId))) throw notFound("assertion", command.assertionId);
    if (!(await this.getEvidenceAnchor(command.projectId, command.evidenceId))) throw notFound("evidence anchor", command.evidenceId);
    const result = await this.query(
      `INSERT INTO assertion_evidence(project_id, assertion_id, evidence_id, evidence_role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, assertion_id, evidence_id) DO UPDATE SET evidence_role = EXCLUDED.evidence_role
       RETURNING *`,
      [command.projectId, command.assertionId, command.evidenceId, command.role],
    );
    this.markChanged(command.projectId);
    return mapAssertionEvidence(result.rows[0]!);
  }

  async createChangeSet(command: CreateChangeSetCommand): Promise<{ changeSet: ChangeSet; replayed: boolean }> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.authorId, "ChangeSet author id");
    assertNonEmpty(command.idempotencyKey, "ChangeSet idempotency key");
    validateChangeSetOperations(
      command.projectId,
      command.operations,
      command.readSet,
      command.writeSet,
      command.provenance,
    );
    const requestSha256 = digest({
      id: command.id ?? null,
      projectId: command.projectId,
      authorId: command.authorId,
      operations: command.operations,
      readSet: command.readSet,
      writeSet: command.writeSet,
      provenance: command.provenance,
    });
    await this.lockIdempotencyKey(command.projectId, command.idempotencyKey);
    const existing = await this.query(
      "SELECT * FROM change_set WHERE project_id = $1 AND idempotency_key = $2",
      [command.projectId, command.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (asString(existing.rows[0].request_sha256).trim() !== requestSha256) throw idempotencyConflict(command.idempotencyKey);
      return { changeSet: mapChangeSet(existing.rows[0]), replayed: true };
    }
    const id = command.id ?? randomUUID() as ChangeSetId;
    const result = await this.query(
      `INSERT INTO change_set(project_id, id, author_id, status, operations, read_set, write_set, provenance, idempotency_key, request_sha256)
       VALUES ($1, $2, $3, 'proposed', $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9) RETURNING *`,
      [
        command.projectId, id, command.authorId, toJson(command.operations), toJson(command.readSet),
        toJson(command.writeSet), toJson(command.provenance), command.idempotencyKey, requestSha256,
      ],
    );
    return { changeSet: mapChangeSet(result.rows[0]!), replayed: false };
  }

  private async transitionChangeSet(command: {
    projectId: ProjectId;
    changeSetId: ChangeSetId;
    expectedVersion: number;
    transition: "approve" | "reject";
    actorId: string;
  }): Promise<ChangeSet> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    assertNonEmpty(command.actorId, `${command.transition === "approve" ? "Approver" : "Rejector"} id`);
    const status = command.transition === "approve" ? "approved" : "rejected";
    const result = command.transition === "approve"
      ? await this.query(
        `UPDATE change_set SET status = 'approved', version = version + 1, approved_at = clock_timestamp(), approved_by = $4
         WHERE project_id = $1 AND id = $2 AND version = $3 AND status = 'proposed' RETURNING *`,
        [command.projectId, command.changeSetId, command.expectedVersion, command.actorId],
      )
      : await this.query(
        `UPDATE change_set SET status = 'rejected', version = version + 1, rejected_at = clock_timestamp(), rejected_by = $4
         WHERE project_id = $1 AND id = $2 AND version = $3 AND status = 'proposed' RETURNING *`,
        [command.projectId, command.changeSetId, command.expectedVersion, command.actorId],
      );
    if (!result.rows[0]) {
      const current = await this.getChangeSet(command.projectId, command.changeSetId);
      if (!current) throw notFound("change set", command.changeSetId);
      if (current.status !== "proposed") {
        throw new PersistenceError("invalid_change_set_state", `Cannot ${command.transition} a ${current.status} ChangeSet`, {
          resource: "change_set",
          id: command.changeSetId,
          expected: "proposed",
          actual: current.status,
        });
      }
      throw conflict("change_set", command.changeSetId, command.expectedVersion, current.version);
    }
    return mapChangeSet(result.rows[0]!);
  }

  async approveChangeSet(command: {
    projectId: ProjectId;
    changeSetId: ChangeSetId;
    expectedVersion: number;
    approvedBy: string;
  }): Promise<ChangeSet> {
    return this.transitionChangeSet({
      projectId: command.projectId,
      changeSetId: command.changeSetId,
      expectedVersion: command.expectedVersion,
      transition: "approve",
      actorId: command.approvedBy,
    });
  }

  async rejectChangeSet(command: {
    projectId: ProjectId;
    changeSetId: ChangeSetId;
    expectedVersion: number;
    rejectedBy: string;
  }): Promise<ChangeSet> {
    return this.transitionChangeSet({
      projectId: command.projectId,
      changeSetId: command.changeSetId,
      expectedVersion: command.expectedVersion,
      transition: "reject",
      actorId: command.rejectedBy,
    });
  }

  private async applyOperation(operation: ChangeSetOperation): Promise<ChangeSetOperationResult> {
    switch (operation.type) {
      case "document.update": return this.updateDocument(operation.command);
      case "document.delete": return this.deleteDocument(operation.command);
      case "module.record.save": return this.saveModuleRecord(operation.command);
      case "document.create": return this.createDocument(operation.command);
      case "document.save": return this.saveDocument(operation.command);
      case "document.restore": return this.restoreDocumentRevision(operation.command);
      case "knowledge.node.save": return this.saveKnowledgeNode(operation.command);
      case "knowledge.alias.save": return this.saveKnowledgeAlias(operation.command);
      case "knowledge.relation.save": return this.saveKnowledgeRelation(operation.command);
      case "evidence.anchor.save": return this.saveEvidenceAnchor(operation.command);
      case "evidence.mention.save": return this.saveMentionLink(operation.command);
      case "evidence.assertion.save": return this.saveAssertion(operation.command);
      case "evidence.assertion.link": return this.linkAssertionEvidence(operation.command);
      default: {
        const exhaustive: never = operation;
        throw validationError(`Unsupported ChangeSet operation: ${String(exhaustive)}`);
      }
    }
  }

  private async assertChangeSetReadSet(projectId: ProjectId, entries: readonly ChangeSetReadSetEntry[]): Promise<void> {
    for (const entry of entries) {
      let actualVersion: number | null;
      let actualRevisionId: string | null = null;
      switch (entry.resource) {
        case "document": {
          const result = await this.query(
            "SELECT version, head_revision_id FROM document WHERE project_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
            [projectId, entry.id],
          );
          actualVersion = result.rows[0] ? asNumber(result.rows[0].version) : null;
          actualRevisionId = result.rows[0] ? asNullableString(result.rows[0].head_revision_id) : null;
          break;
        }
        case "module_record": {
          let identity: unknown;
          try { identity = JSON.parse(entry.id); } catch { throw validationError("Invalid module record identity"); }
          if (!Array.isArray(identity) || identity.length !== 2 || identity.some((part) => typeof part !== "string")) throw validationError("Invalid module record identity");
          const result = await this.query("SELECT version FROM module_record WHERE project_id = $1 AND module_id = $2 AND key = $3 FOR UPDATE", [projectId, identity[0], identity[1]]);
          actualVersion = result.rows[0] ? asNumber(result.rows[0].version) : null;
          break;
        }
        case "knowledge_node":
        case "knowledge_relation":
        case "evidence_anchor":
        case "assertion": {
          const table = {
            knowledge_node: "knowledge_node",
            knowledge_relation: "knowledge_relation",
            evidence_anchor: "text_anchor",
            assertion: "assertion",
          }[entry.resource];
          const result = await this.query(
            `SELECT version FROM ${table} WHERE project_id = $1 AND id = $2 FOR UPDATE`,
            [projectId, entry.id],
          );
          actualVersion = result.rows[0] ? asNumber(result.rows[0].version) : null;
          break;
        }
        case "knowledge_alias": {
          const result = await this.query(
            "SELECT 1 FROM knowledge_alias WHERE project_id = $1 AND id = $2 FOR UPDATE",
            [projectId, entry.id],
          );
          actualVersion = result.rows[0] ? 1 : null;
          break;
        }
        case "mention_link": {
          const [evidenceId, nodeId, ...rest] = entry.id.split(":");
          if (!evidenceId || !nodeId || rest.length > 0) throw validationError("Mention-link read-set ids must be evidenceId:nodeId");
          const result = await this.query(
            "SELECT 1 FROM mention_link WHERE project_id = $1 AND evidence_id = $2 AND node_id = $3 FOR UPDATE",
            [projectId, evidenceId, nodeId],
          );
          actualVersion = result.rows[0] ? 1 : null;
          break;
        }
        case "assertion_evidence": {
          const [assertionId, evidenceId, ...rest] = entry.id.split(":");
          if (!assertionId || !evidenceId || rest.length > 0) throw validationError("Assertion-evidence read-set ids must be assertionId:evidenceId");
          const result = await this.query(
            "SELECT 1 FROM assertion_evidence WHERE project_id = $1 AND assertion_id = $2 AND evidence_id = $3 FOR UPDATE",
            [projectId, assertionId, evidenceId],
          );
          actualVersion = result.rows[0] ? 1 : null;
          break;
        }
        default: {
          const exhaustive: never = entry.resource;
          throw validationError(`Unsupported ChangeSet read-set resource: ${String(exhaustive)}`);
        }
      }
      if (actualVersion !== entry.expectedVersion) {
        throw conflict(entry.resource, entry.id, entry.expectedVersion, actualVersion);
      }
      if (entry.expectedRevisionId !== undefined && actualRevisionId !== entry.expectedRevisionId) {
        throw conflict(entry.resource, entry.id, entry.expectedRevisionId, actualRevisionId);
      }
    }
  }

  async applyChangeSet(command: {
    projectId: ProjectId;
    changeSetId: ChangeSetId;
    expectedVersion: number;
  }): Promise<ChangeSetApplicationResult> {
    this.ensureWritable();
    await this.lockProject(command.projectId);
    const selected = await this.query(
      "SELECT * FROM change_set WHERE project_id = $1 AND id = $2 FOR UPDATE",
      [command.projectId, command.changeSetId],
    );
    const row = selected.rows[0];
    if (!row) throw notFound("change set", command.changeSetId);
    const changeSet = mapChangeSet(row);
    if (changeSet.status === "applied") {
      if (command.expectedVersion !== changeSet.version - 1) {
        throw conflict("change_set", changeSet.id, command.expectedVersion, changeSet.version);
      }
      const stored = asJsonObject(row.application_result) as unknown as Omit<ChangeSetApplicationResult, "replayed">;
      return { ...stored, replayed: true };
    }
    if (changeSet.status !== "approved") {
      throw new PersistenceError("invalid_change_set_state", `Cannot apply a ${changeSet.status} ChangeSet`, {
        resource: "change_set",
        id: command.changeSetId,
        expected: "approved",
        actual: changeSet.status,
      });
    }
    if (changeSet.version !== command.expectedVersion) {
      throw conflict("change_set", changeSet.id, command.expectedVersion, changeSet.version);
    }

    validateChangeSetOperations(
      changeSet.projectId,
      changeSet.operations,
      changeSet.readSet,
      changeSet.writeSet,
      changeSet.provenance,
    );
    await this.assertChangeSetReadSet(command.projectId, changeSet.readSet);
    const results: ChangeSetOperationResult[] = [];
    for (const operation of changeSet.operations) results.push(await this.applyOperation(operation));
    const updated = await this.query(
      `UPDATE change_set SET status = 'applied', version = version + 1, applied_at = clock_timestamp(), application_result = '{}'::jsonb
       WHERE project_id = $1 AND id = $2 AND version = $3 AND status = 'approved' RETURNING *`,
      [command.projectId, command.changeSetId, command.expectedVersion],
    );
    if (!updated.rows[0]) throw conflict("change_set", changeSet.id, command.expectedVersion, null);
    const nextChangeSet = mapChangeSet(updated.rows[0]);
    const resultWithoutReplay = { changeSet: nextChangeSet, results };
    await this.query(
      "UPDATE change_set SET application_result = $3::jsonb WHERE project_id = $1 AND id = $2",
      [command.projectId, command.changeSetId, toJson(resultWithoutReplay)],
    );
    this.markChanged(command.projectId);
    const finalRow = await this.query("SELECT * FROM change_set WHERE project_id = $1 AND id = $2", [command.projectId, command.changeSetId]);
    return { changeSet: mapChangeSet(finalRow.rows[0]!), results, replayed: false };
  }
}

function mapDatabaseError(error: unknown): never {
  throw databaseError(error);
}

export class PostgresPersistence implements Persistence {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string) {
    this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async checkHealth(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async read<T>(work: (reader: PersistenceReader) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const reader = new PostgresTransaction(client, true);
      const result = await work(reader);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (transaction: PersistenceTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const transaction = new PostgresTransaction(client, false);
      const result = await work(transaction);
      const changedProjects = [...transaction.changedProjects].sort();
      if (changedProjects.length > 0) {
        await client.query(
          "UPDATE project SET version = version + 1, updated_at = clock_timestamp() WHERE id = ANY($1::uuid[])",
          [changedProjects],
        );
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPostgresPersistence(config: PoolConfig | string): PostgresPersistence {
  return new PostgresPersistence(config);
}
