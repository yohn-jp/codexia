import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AssertionId, DocumentId, EvidenceId, JsonObject, KnowledgeAliasId, KnowledgeNodeId,
  KnowledgeRelationId, Persistence, Project, ProjectId, RevisionId,
} from "@codexia/persistence-contracts";

/**
 * Portable author-owned current-state exchange, not a PostgreSQL/WAL backup.
 * The archive never claims to preserve original revision IDs, historical
 * versions, private grants, source credentials or pending approvals.
 */
export const WORK_ARCHIVE_FORMAT = "codexia-work/v1" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const id = z.string().regex(UUID);
const nonEmpty = z.string().min(1).max(512);
const jsonObject = z.record(z.unknown());
const bounded = <T extends z.ZodTypeAny>(schema: T, limit: number) => z.array(schema).max(limit);
const documentSchema = z.object({
  id, parentId: id.nullable(), kind: nonEmpty, title: nonEmpty, orderKey: z.string().max(512),
  markdown: z.string(), revisionId: id,
}).strict();
const nodeSchema = z.object({
  id, type: nonEmpty, name: nonEmpty, attributes: jsonObject,
  status: z.enum(["proposed", "confirmed", "retired"]),
}).strict();
const aliasSchema = z.object({
  id, nodeId: id, surface: nonEmpty, normalized: nonEmpty, scope: z.string().nullable(),
  status: z.enum(["proposed", "confirmed", "ambiguous", "retired"]),
}).strict();
const relationSchema = z.object({
  id, sourceId: id, targetId: id, type: nonEmpty,
  attributes: jsonObject, validity: jsonObject,
  status: z.enum(["proposed", "confirmed", "rejected", "retired"]),
}).strict();
const anchorSchema = z.object({
  id, documentId: id, revisionId: id, fromUtf16: z.number().int().nonnegative(),
  toUtf16: z.number().int().nonnegative(), quoteSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  status: z.enum(["proposed", "confirmed", "needs_review", "orphaned"]),
}).strict();
const mentionSchema = z.object({
  evidenceId: id, nodeId: id, status: z.enum(["proposed", "confirmed", "ambiguous", "rejected"]),
  source: nonEmpty, confidence: z.number().min(0).max(1).nullable(), extractorVersion: z.string().nullable(),
}).strict();
const assertionSchema = z.object({
  id, proposition: jsonObject, modality: nonEmpty, perspective: nonEmpty, narrativeTime: jsonObject,
  confidence: z.number().min(0).max(1).nullable(), status: z.enum(["proposed", "confirmed", "rejected", "retired"]),
}).strict();
const assertionEvidenceSchema = z.object({
  assertionId: id, evidenceId: id, role: z.enum(["supports", "contradicts", "quotes", "context"]),
}).strict();
const unresolvedSchema = z.object({
  anchors: bounded(anchorSchema, 20000),
  mentions: bounded(mentionSchema, 40000),
  assertionEvidence: bounded(assertionEvidenceSchema, 40000),
}).strict();
const moduleRecordSchema = z.object({ moduleId: nonEmpty, key: nonEmpty, value: jsonObject }).strict();

export const workArchiveSchema = z.object({
  format: z.literal(WORK_ARCHIVE_FORMAT),
  project: z.object({ title: nonEmpty, settings: jsonObject }).strict(),
  documents: bounded(documentSchema, 999),
  knowledge: z.object({
    nodes: bounded(nodeSchema, 999), aliases: bounded(aliasSchema, 10000),
    relations: bounded(relationSchema, 10000),
  }).strict(),
  evidence: z.object({
    anchors: bounded(anchorSchema, 10000),
    mentions: bounded(mentionSchema, 40000),
    assertions: bounded(assertionSchema, 999),
    assertionEvidence: bounded(assertionEvidenceSchema, 40000),
    unresolved: unresolvedSchema,
  }).strict(),
  moduleRecords: bounded(moduleRecordSchema, 10000),
  omittedRecords: bounded(z.string().max(1024), 10000),
}).strict();

export type WorkArchive = z.infer<typeof workArchiveSchema>;
export interface WorkImportResult {
  project: Project;
  replayed: boolean;
  unresolvedAnchors: number;
  omittedRecords: number;
}

export class WorkArchiveError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function fail(status: number, code: string, message: string): never {
  throw new WorkArchiveError(status, code, message);
}
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function unique(values: readonly string[], label: string): void {
  if (values.length !== new Set(values).size) fail(400, "INVALID_WORK_ARCHIVE", "Duplicate " + label + " identity");
}
function assertBounded(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") fail(400, "INVALID_WORK_ARCHIVE", "Archive is not JSON");
  if (Buffer.byteLength(encoded, "utf8") > 8 * 1024 * 1024) {
    fail(413, "WORK_ARCHIVE_TOO_LARGE", "Portable work exceeds the 8 MiB current-state exchange limit");
  }
}
function sensitiveKey(key: string): boolean {
  return /(?:secret|password|credential|token|api[-_]?key|private[-_]?key|session|share[-_]?grants)/iu.test(key);
}
function containsSensitiveObjectKeys(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveObjectKeys(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, item]) => sensitiveKey(key) || containsSensitiveObjectKeys(item, depth + 1));
  }
  return false;
}
function excludedRecord(moduleId: string, key: string, value: unknown): boolean {
  return moduleId.startsWith("core.authority.") ||
    moduleId === "core.portable.archive" ||
    sensitiveKey(key) || sensitiveKey(moduleId) || containsSensitiveObjectKeys(value);
}
function safeSettings(value: Record<string, unknown>, omitted: string[], prefix = "project.settings"): JsonObject {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey(key)) { omitted.push(prefix + "." + key); continue; }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      result[key] = safeSettings(item as Record<string, unknown>, omitted, prefix + "." + key);
    } else if (Array.isArray(item)) {
      result[key] = item.map((entry, index) => entry && typeof entry === "object" && !Array.isArray(entry)
        ? safeSettings(entry as Record<string, unknown>, omitted, prefix + "." + key + "[" + index + "]")
        : entry);
    } else result[key] = item;
  }
  return result as JsonObject;
}
function validateGraph(archive: WorkArchive): void {
  unique(archive.documents.map((item) => item.id), "document");
  unique(archive.documents.map((item) => item.revisionId), "document revision");
  unique(archive.knowledge.nodes.map((item) => item.id), "knowledge node");
  unique(archive.knowledge.aliases.map((item) => item.id), "knowledge alias");
  unique(archive.knowledge.relations.map((item) => item.id), "knowledge relation");
  unique(archive.evidence.assertions.map((item) => item.id), "assertion");
  unique([...archive.evidence.anchors, ...archive.evidence.unresolved.anchors].map((item) => item.id), "evidence");
  unique(archive.moduleRecords.map((item) => JSON.stringify([item.moduleId, item.key])), "module record");
  unique(archive.evidence.mentions.map((item) => JSON.stringify([item.evidenceId, item.nodeId])), "mention");
  unique(archive.evidence.assertionEvidence.map((item) => JSON.stringify([item.assertionId, item.evidenceId])), "assertion evidence");
  const documents = new Map(archive.documents.map((item) => [item.id, item]));
  const nodes = new Set(archive.knowledge.nodes.map((item) => item.id));
  const activeAnchors = new Set(archive.evidence.anchors.map((item) => item.id));
  const assertions = new Set(archive.evidence.assertions.map((item) => item.id));
  for (const document of archive.documents) {
    const visited = new Set<string>([document.id]);
    let parent = document.parentId;
    while (parent !== null) {
      if (visited.has(parent)) fail(400, "INVALID_WORK_ARCHIVE", "Document hierarchy contains a cycle");
      visited.add(parent);
      const target = documents.get(parent);
      if (!target) fail(400, "INVALID_WORK_ARCHIVE", "Document parent reference is missing");
      parent = target.parentId;
    }
  }
  for (const alias of archive.knowledge.aliases) {
    if (!nodes.has(alias.nodeId)) fail(400, "INVALID_WORK_ARCHIVE", "Alias references a missing node");
  }
  for (const relation of archive.knowledge.relations) {
    if (!nodes.has(relation.sourceId) || !nodes.has(relation.targetId)) fail(400, "INVALID_WORK_ARCHIVE", "Relation references a missing node");
  }
  for (const anchor of archive.evidence.anchors) {
    const document = documents.get(anchor.documentId);
    if (!document || document.revisionId !== anchor.revisionId ||
      anchor.toUtf16 <= anchor.fromUtf16 || anchor.toUtf16 > document.markdown.length ||
      digest(document.markdown.slice(anchor.fromUtf16, anchor.toUtf16)) !== anchor.quoteSha256) {
      fail(400, "INVALID_WORK_ARCHIVE", "Current evidence is not bound to the included manuscript revision");
    }
  }
  for (const mention of archive.evidence.mentions) {
    if (!nodes.has(mention.nodeId) || !activeAnchors.has(mention.evidenceId)) {
      fail(400, "INVALID_WORK_ARCHIVE", "Mention references missing current evidence or knowledge");
    }
  }
  for (const link of archive.evidence.assertionEvidence) {
    if (!assertions.has(link.assertionId) || !activeAnchors.has(link.evidenceId)) {
      fail(400, "INVALID_WORK_ARCHIVE", "Assertion link references missing current evidence or assertion");
    }
  }
  for (const record of archive.moduleRecords) {
    if (excludedRecord(record.moduleId, record.key, record.value)) {
      fail(400, "INVALID_WORK_ARCHIVE", "Archive contains reserved or sensitive module records");
    }
  }
}
export function parseWorkArchive(value: unknown): WorkArchive {
  assertBounded(value);
  const parsed = workArchiveSchema.safeParse(value);
  if (!parsed.success) fail(400, "INVALID_WORK_ARCHIVE", "Invalid codexia-work/v1 archive: " + parsed.error.issues[0]?.path.join("."));
  validateGraph(parsed.data);
  return parsed.data;
}

function checkSnapshotCount(count: number, maximum: number, label: string): void {
  if (count >= maximum) fail(413, "WORK_ARCHIVE_LIMIT", label + " exceeds the portable export page limit");
}
const emptyUnresolved = (): WorkArchive["evidence"]["unresolved"] => ({ anchors: [], mentions: [], assertionEvidence: [] });

export async function exportWorkArchive(persistence: Persistence, projectId: ProjectId): Promise<WorkArchive> {
  return persistence.read(async (reader) => {
    const project = await reader.getProject(projectId);
    if (!project) fail(404, "WORK_NOT_FOUND", "Work was not found");
    const omittedRecords: string[] = [];
    const documentRows = await reader.listDocuments(projectId, undefined, 1000);
    checkSnapshotCount(documentRows.length, 1000, "Documents");
    const documents: WorkArchive["documents"] = [];
    for (const document of documentRows) {
      if (!document.headRevisionId) fail(409, "WORK_ARCHIVE_INCOMPLETE", "A document has no canonical revision");
      const revision = await reader.getRevision(projectId, document.id, document.headRevisionId);
      if (!revision) fail(409, "WORK_ARCHIVE_INCOMPLETE", "A canonical manuscript revision is missing");
      documents.push({ id: document.id, parentId: document.parentId, kind: document.kind, title: document.title,
        orderKey: document.orderKey, markdown: revision.markdown, revisionId: revision.id });
    }

    const nodeRows = await reader.listAllKnowledgeNodes(projectId, 1000);
    checkSnapshotCount(nodeRows.length, 1000, "Knowledge");
    const nodes: WorkArchive["knowledge"]["nodes"] = nodeRows.map(({ id, type, name, attributes, status }) =>
      ({ id, type, name, attributes, status }));
    const aliases = new Map<string, WorkArchive["knowledge"]["aliases"][number]>();
    const relations = new Map<string, WorkArchive["knowledge"]["relations"][number]>();
    for (const node of nodeRows) {
      const aliasRows = await reader.listKnowledgeAliases(projectId, node.id, 1000);
      checkSnapshotCount(aliasRows.length, 1000, "Aliases for knowledge node " + node.id);
      for (const { id, nodeId, surface, normalized, scope, status } of aliasRows)
        aliases.set(id, { id, nodeId, surface, normalized, scope, status });
      const relationRows = await reader.listKnowledgeRelations(projectId, node.id, 1000);
      checkSnapshotCount(relationRows.length, 1000, "Relations for knowledge node " + node.id);
      for (const { id, sourceId, targetId, type, attributes, validity, status } of relationRows)
        relations.set(id, { id, sourceId, targetId, type, attributes, validity, status });
    }

    const archiveAnchors: WorkArchive["evidence"]["anchors"] = [];
    const mentions: WorkArchive["evidence"]["mentions"] = [];
    const assertionEvidence: WorkArchive["evidence"]["assertionEvidence"] = [];
    const unresolved = emptyUnresolved();
    const modules = await reader.listModuleRecords(projectId);
    const previouslyUnresolved = modules.find((item) =>
      item.moduleId === "core.portable.archive" && item.key === "unresolved-evidence");
    if (previouslyUnresolved) {
      const decoded = unresolvedSchema.safeParse(previouslyUnresolved.value);
      if (!decoded.success) fail(409, "WORK_ARCHIVE_INCOMPLETE", "Retained unresolved evidence is invalid");
      unresolved.anchors.push(...decoded.data.anchors);
      unresolved.mentions.push(...decoded.data.mentions);
      unresolved.assertionEvidence.push(...decoded.data.assertionEvidence);
    }
    const currentRevisions = new Map(documents.map((item) => [item.id, item]));
    for (const document of documentRows) {
      const anchors = await reader.listDocumentEvidence(projectId, document.id, undefined, 500);
      checkSnapshotCount(anchors.length, 500, "Evidence for document " + document.id);
      for (const anchor of anchors) {
        const entry = { id: anchor.id, documentId: anchor.documentId, revisionId: anchor.revisionId,
          fromUtf16: anchor.fromUtf16, toUtf16: anchor.toUtf16, quoteSha256: anchor.quoteSha256, status: anchor.status };
        const canonical = currentRevisions.get(document.id);
        const current = !!canonical && entry.revisionId === canonical.revisionId &&
          entry.fromUtf16 < entry.toUtf16 && entry.toUtf16 <= canonical.markdown.length &&
          digest(canonical.markdown.slice(entry.fromUtf16, entry.toUtf16)) === entry.quoteSha256;
        if (current) archiveAnchors.push(entry); else unresolved.anchors.push(entry);
        const mentionRows = await reader.listMentionLinks(projectId, anchor.id, 1000);
        checkSnapshotCount(mentionRows.length, 1000, "Mentions for evidence " + anchor.id);
        for (const item of mentionRows) {
          const link = { evidenceId: item.evidenceId, nodeId: item.nodeId, status: item.status,
            source: item.source, confidence: item.confidence, extractorVersion: item.extractorVersion };
          if (current) mentions.push(link); else unresolved.mentions.push(link);
        }
        const assertionEvidenceRows = await reader.listEvidenceAssertions(projectId, anchor.id, 200);
        checkSnapshotCount(assertionEvidenceRows.length, 200, "Assertion evidence for evidence " + anchor.id);
        for (const item of assertionEvidenceRows) {
          const link = { assertionId: item.assertionId, evidenceId: item.evidenceId, role: item.role };
          if (current) assertionEvidence.push(link); else unresolved.assertionEvidence.push(link);
        }
      }
    }
    const assertionRows = await reader.listAssertions(projectId, 1000);
    checkSnapshotCount(assertionRows.length, 1000, "Assertions");
    const assertions: WorkArchive["evidence"]["assertions"] = assertionRows.map((item) =>
      ({ id: item.id, proposition: item.proposition, modality: item.modality, perspective: item.perspective,
        narrativeTime: item.narrativeTime, confidence: item.confidence, status: item.status }));
    const moduleRecords: WorkArchive["moduleRecords"] = [];
    for (const item of modules) {
      if (excludedRecord(item.moduleId, item.key, item.value)) {
        if (!(item.moduleId === "core.portable.archive")) omittedRecords.push(item.moduleId + ":" + item.key);
        continue;
      }
      moduleRecords.push({ moduleId: item.moduleId, key: item.key, value: item.value });
    }
    const result: WorkArchive = {
      format: WORK_ARCHIVE_FORMAT,
      project: { title: project.title, settings: safeSettings(project.settings, omittedRecords) },
      documents: documents.sort((a, b) => a.id.localeCompare(b.id)),
      knowledge: {
        nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
        aliases: [...aliases.values()].sort((a, b) => a.id.localeCompare(b.id)),
        relations: [...relations.values()].sort((a, b) => a.id.localeCompare(b.id)),
      },
      evidence: {
        anchors: archiveAnchors.sort((a, b) => a.id.localeCompare(b.id)),
        mentions: mentions.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.nodeId.localeCompare(b.nodeId)),
        assertions,
        assertionEvidence: assertionEvidence.sort((a, b) => a.assertionId.localeCompare(b.assertionId) || a.evidenceId.localeCompare(b.evidenceId)),
        unresolved,
      },
      moduleRecords: moduleRecords.sort((a, b) => a.moduleId.localeCompare(b.moduleId) || a.key.localeCompare(b.key)),
      omittedRecords: omittedRecords.sort(),
    };
    assertBounded(result);
    return parseWorkArchive(result);
  });
}

function portableProjectId(archive: WorkArchive): { id: ProjectId; hash: string } {
  const hash = digest("codexia-work/v1-import" + "\0" + JSON.stringify(archive));
  const id = (hash.slice(0, 8) + "-" + hash.slice(8, 12) + "-5" + hash.slice(13, 16) +
    "-a" + hash.slice(17, 20) + "-" + hash.slice(20, 32)) as ProjectId;
  return { id, hash };
}

/** Always import into a new, deterministically idempotent project; no overwrite route exists. */
export async function importWorkArchive(persistence: Persistence, payload: unknown, authorId: string): Promise<WorkImportResult> {
  if (typeof authorId !== "string" || !authorId.trim()) fail(403, "AUTHOR_REQUIRED", "An authenticated author is required");
  const archive = parseWorkArchive(payload);
  const target = portableProjectId(archive);
  const result = await persistence.transaction(async (tx) => {
    const existing = await tx.getProject(target.id);
    if (existing) {
      const receipt = await tx.getModuleRecord(target.id, "core.portable.archive", "import-receipt");
      if (receipt?.value.payloadSha256 !== target.hash) {
        fail(409, "WORK_IMPORT_CONFLICT", "An existing project conflicts with this import identity");
      }
      return { project: existing, replayed: true, unresolvedAnchors: archive.evidence.unresolved.anchors.length,
        omittedRecords: archive.omittedRecords.length };
    }
    const project = await tx.createProject({ id: target.id, title: archive.project.title, settings: archive.project.settings as JsonObject });
    const pending = new Map(archive.documents.map((document) => [document.id, document]));
    const newRevisionByDocument = new Map<string, RevisionId>();
    while (pending.size > 0) {
      let advanced = false;
      for (const [documentId, document] of pending) {
        if (document.parentId !== null && !newRevisionByDocument.has(document.parentId)) continue;
        const created = await tx.createDocument({
          projectId: project.id, documentId: document.id as DocumentId,
          parentId: document.parentId as DocumentId | null, kind: document.kind,
          title: document.title, orderKey: document.orderKey, markdown: document.markdown,
          authorId, idempotencyKey: "portable:" + target.hash + ":" + document.id,
        });
        newRevisionByDocument.set(documentId, created.revision.id);
        pending.delete(documentId);
        advanced = true;
      }
      if (!advanced) fail(400, "INVALID_WORK_ARCHIVE", "Unable to resolve document hierarchy");
    }
    for (const node of archive.knowledge.nodes) await tx.saveKnowledgeNode({
      projectId: project.id, id: node.id as KnowledgeNodeId, type: node.type, name: node.name,
      attributes: node.attributes as JsonObject, status: node.status, expectedVersion: null,
    });
    for (const alias of archive.knowledge.aliases) await tx.saveKnowledgeAlias({
      projectId: project.id, id: alias.id as KnowledgeAliasId, nodeId: alias.nodeId as KnowledgeNodeId,
      surface: alias.surface, normalized: alias.normalized, scope: alias.scope, status: alias.status,
    });
    for (const relation of archive.knowledge.relations) await tx.saveKnowledgeRelation({
      projectId: project.id, id: relation.id as KnowledgeRelationId,
      sourceId: relation.sourceId as KnowledgeNodeId, targetId: relation.targetId as KnowledgeNodeId,
      type: relation.type, attributes: relation.attributes as JsonObject, validity: relation.validity as JsonObject,
      status: relation.status, expectedVersion: null,
    });
    for (const anchor of archive.evidence.anchors) await tx.saveEvidenceAnchor({
      projectId: project.id, id: anchor.id as EvidenceId, documentId: anchor.documentId as DocumentId,
      revisionId: newRevisionByDocument.get(anchor.documentId)!, fromUtf16: anchor.fromUtf16,
      toUtf16: anchor.toUtf16, quoteSha256: anchor.quoteSha256, status: anchor.status, expectedVersion: null,
    });
    for (const mention of archive.evidence.mentions) await tx.saveMentionLink({
      projectId: project.id, evidenceId: mention.evidenceId as EvidenceId, nodeId: mention.nodeId as KnowledgeNodeId,
      source: mention.source, confidence: mention.confidence,
      extractorVersion: mention.extractorVersion, status: mention.status,
    });
    for (const assertion of archive.evidence.assertions) await tx.saveAssertion({
      projectId: project.id, id: assertion.id as AssertionId,
      proposition: assertion.proposition as JsonObject, modality: assertion.modality,
      perspective: assertion.perspective, narrativeTime: assertion.narrativeTime as JsonObject,
      confidence: assertion.confidence, status: assertion.status, expectedVersion: null,
    });
    for (const link of archive.evidence.assertionEvidence) await tx.linkAssertionEvidence({
      projectId: project.id, assertionId: link.assertionId as AssertionId,
      evidenceId: link.evidenceId as EvidenceId, role: link.role,
    });
    for (const record of archive.moduleRecords) await tx.saveModuleRecord({
      projectId: project.id, moduleId: record.moduleId, key: record.key,
      value: record.value as JsonObject, expectedVersion: null,
    });
    if (archive.evidence.unresolved.anchors.length || archive.evidence.unresolved.mentions.length ||
      archive.evidence.unresolved.assertionEvidence.length) {
      await tx.saveModuleRecord({
        projectId: project.id, moduleId: "core.portable.archive", key: "unresolved-evidence",
        value: archive.evidence.unresolved as unknown as JsonObject, expectedVersion: null,
      });
    }
    await tx.saveModuleRecord({
      projectId: project.id, moduleId: "core.portable.archive", key: "import-receipt",
      value: { payloadSha256: target.hash, archiveFormat: WORK_ARCHIVE_FORMAT }, expectedVersion: null,
    });
    return { project, replayed: false, unresolvedAnchors: archive.evidence.unresolved.anchors.length,
      omittedRecords: archive.omittedRecords.length };
  });
  // PostgreSQL bumps the project version at COMMIT, after the transaction callback returns.
  const committed = await persistence.read((reader) => reader.getProject(result.project.id));
  if (!committed) fail(503, "WORK_IMPORT_INCOMPLETE", "Committed project could not be read back");
  return { ...result, project: committed };
}
