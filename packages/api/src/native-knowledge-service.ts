import { z } from "zod";
import type {
  ActorId, AssertionId, ChangeSet, ChangeSetApplicationResult, ChangeSetId, ChangeSetOperation,
  ChangeSetReadSetEntry, ChangeSetResource, ChangeSetWriteSetEntry, CreateChangeSetCommand,
  DocumentId, EvidenceId, KnowledgeNodeId, Persistence, PersistenceReader, ProjectId, RevisionId,
} from "@codexia/persistence-contracts";

export class NativeKnowledgeServiceError extends Error {
  constructor(readonly code: "snapshot_unavailable" | "invalid_input", message: string) { super(message); }
}

export type NativeKnowledgeRead = (reader: PersistenceReader) => Promise<unknown>;
export interface ProposeNativeKnowledgeChangeInput {
  persistence: Persistence;
  projectId: ProjectId;
  projectVersion: number;
  /** Resolve this identity from the authenticated actor; never accept it from the operation body. */
  actorId: ActorId;
  idempotencyKey: string;
  operations: readonly ChangeSetOperation[];
}

/** All native Knowledge/Evidence reads use one PostgreSQL snapshot and an explicit current project fence. */
export async function readNativeKnowledge<T>(persistence: Persistence, projectId: ProjectId, projectVersion: number, read: (reader: PersistenceReader) => Promise<T>): Promise<T> {
  return persistence.read(async reader => {
    const project = await reader.getProject(projectId);
    if (!project || project.version !== projectVersion) throw new NativeKnowledgeServiceError("snapshot_unavailable", "The selected native Knowledge snapshot is unavailable");
    return read(reader);
  });
}

/** Backward compatible REST reads select the current project version inside the same snapshot. */
export async function readCurrentNativeKnowledge<T>(persistence: Persistence, projectId: ProjectId, read: (reader: PersistenceReader) => Promise<T>): Promise<T> {
  return persistence.read(async reader => {
    if (!(await reader.getProject(projectId))) throw new NativeKnowledgeServiceError("snapshot_unavailable", "The selected native Knowledge snapshot is unavailable");
    return read(reader);
  });
}

function boundedLimit(limit: number, maximum: number, label: string): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw new NativeKnowledgeServiceError("invalid_input", `${label} must be between 1 and ${maximum}`);
}

function snapshotRead<T>(persistence: Persistence, projectId: ProjectId, projectVersion: number | undefined, read: (reader: PersistenceReader) => Promise<T>) {
  return projectVersion === undefined ? readCurrentNativeKnowledge(persistence, projectId, read) : readNativeKnowledge(persistence, projectId, projectVersion, read);
}

export function listNativeKnowledgeNodes(persistence: Persistence, projectId: ProjectId, limit = 100, projectVersion?: number) {
  boundedLimit(limit, 500, "Knowledge node limit");
  return snapshotRead(persistence, projectId, projectVersion, reader => reader.listKnowledgeNodes(projectId, limit));
}

export function getNativeKnowledgeNode(persistence: Persistence, projectId: ProjectId, nodeId: KnowledgeNodeId, projectVersion?: number, relatedLimit = 500) {
  boundedLimit(relatedLimit, 1000, "Knowledge relationship limit");
  return snapshotRead(persistence, projectId, projectVersion, async reader => {
    const node = await reader.getKnowledgeNode(projectId, nodeId);
    return node ? { node, aliases: await reader.listKnowledgeAliases(projectId, nodeId, relatedLimit), relations: await reader.listKnowledgeRelations(projectId, nodeId, relatedLimit) } : undefined;
  });
}

export function listNativeKnowledgeAliases(persistence: Persistence, projectId: ProjectId, nodeId: KnowledgeNodeId, limit = 500, projectVersion?: number) {
  boundedLimit(limit, 1000, "Knowledge alias limit");
  return snapshotRead(persistence, projectId, projectVersion, reader => reader.listKnowledgeAliases(projectId, nodeId, limit));
}

export function listNativeKnowledgeRelations(persistence: Persistence, projectId: ProjectId, nodeId: KnowledgeNodeId, limit = 500, projectVersion?: number) {
  boundedLimit(limit, 1000, "Knowledge relation limit");
  return snapshotRead(persistence, projectId, projectVersion, reader => reader.listKnowledgeRelations(projectId, nodeId, limit));
}

export function getNativeEvidenceAnchor(persistence: Persistence, projectId: ProjectId, evidenceId: EvidenceId, projectVersion?: number, historyLimit = 500) {
  boundedLimit(historyLimit, 1000, "Evidence history limit");
  return snapshotRead(persistence, projectId, projectVersion, async reader => {
    const anchor = await reader.getEvidenceAnchor(projectId, evidenceId);
    if (!anchor) return undefined;
    const [mentions, assertionLinks, history] = await Promise.all([
      reader.listMentionLinks(projectId, evidenceId, 500), reader.listEvidenceAssertions(projectId, evidenceId, 200), reader.listEvidenceHistory(projectId, evidenceId, historyLimit),
    ]);
    let quote = "";
    const quoteAt = async (revisionId: RevisionId, fromUtf16: number, toUtf16: number) => {
      const revision = await reader.getRevision(projectId, anchor.documentId, revisionId);
      return revision && fromUtf16 >= 0 && toUtf16 > fromUtf16 && toUtf16 <= revision.markdown.length ? revision.markdown.slice(fromUtf16, toUtf16) : "";
    };
    quote = await quoteAt(anchor.revisionId, anchor.fromUtf16, anchor.toUtf16);
    if (!quote) for (const item of [...history].reverse()) { quote = await quoteAt(item.revisionId, item.fromUtf16, item.toUtf16); if (quote) break; }
    const resolvedMentions = await Promise.all(mentions.map(async link => ({ link, node: await reader.getKnowledgeNode(projectId, link.nodeId) ?? null })));
    const resolvedAssertions = await Promise.all(assertionLinks.map(async link => ({ link, assertion: await reader.getAssertion(projectId, link.assertionId) ?? null })));
    return { anchor, quote, mentions: resolvedMentions, assertions: resolvedAssertions, history };
  });
}

export function listNativeEvidenceForDocument(persistence: Persistence, projectId: ProjectId, documentId: DocumentId, revisionId: RevisionId | undefined, limit = 200, projectVersion?: number) {
  boundedLimit(limit, 500, "Evidence limit");
  return snapshotRead(persistence, projectId, projectVersion, async reader => {
    const document = await reader.getDocument(projectId, documentId);
    if (!document) return undefined;
    const selectedRevision = revisionId ?? document.headRevisionId;
    if (!selectedRevision) return { revisionId: null, anchors: [] };
    if (!(await reader.getRevision(projectId, documentId, selectedRevision))) return undefined;
    const anchors = await reader.listDocumentEvidence(projectId, documentId, selectedRevision, limit);
    return { revisionId: selectedRevision, anchors: await Promise.all(anchors.map(anchor => getNativeEvidenceAnchorFromReader(reader, projectId, anchor.id))) };
  });
}

async function getNativeEvidenceAnchorFromReader(reader: PersistenceReader, projectId: ProjectId, evidenceId: EvidenceId) {
  const anchor = await reader.getEvidenceAnchor(projectId, evidenceId);
  if (!anchor) return undefined;
  const history = await reader.listEvidenceHistory(projectId, evidenceId, 500);
  let quote = "";
  for (const item of [anchor, ...[...history].reverse()]) {
    if (item.toUtf16 <= item.fromUtf16) continue;
    const revision = await reader.getRevision(projectId, anchor.documentId, item.revisionId);
    if (revision && item.toUtf16 <= revision.markdown.length) { quote = revision.markdown.slice(item.fromUtf16, item.toUtf16); break; }
  }
  const links = await reader.listMentionLinks(projectId, evidenceId, 500);
  const assertions = await reader.listEvidenceAssertions(projectId, evidenceId, 200);
  return { anchor, quote, mentions: await Promise.all(links.map(async link => ({ link, node: await reader.getKnowledgeNode(projectId, link.nodeId) ?? null }))), assertions: await Promise.all(assertions.map(async link => ({ link, assertion: await reader.getAssertion(projectId, link.assertionId) ?? null }))) };
}

export function listNativeEvidenceForNode(persistence: Persistence, projectId: ProjectId, nodeId: KnowledgeNodeId, limit = 200, projectVersion?: number) {
  boundedLimit(limit, 500, "Evidence limit");
  return snapshotRead(persistence, projectId, projectVersion, async reader => {
    const mentions = await reader.listNodeMentions(projectId, nodeId, limit);
    return Promise.all(mentions.map(mention => getNativeEvidenceAnchorFromReader(reader, projectId, mention.evidenceId)));
  });
}

export function getNativeAssertion(persistence: Persistence, projectId: ProjectId, assertionId: AssertionId, projectVersion?: number, evidenceLimit = 500) {
  boundedLimit(evidenceLimit, 1000, "Assertion evidence limit");
  return snapshotRead(persistence, projectId, projectVersion, async reader => {
    const assertion = await reader.getAssertion(projectId, assertionId);
    return assertion ? { assertion, evidence: await reader.listAssertionEvidence(projectId, assertionId, evidenceLimit) } : undefined;
  });
}

export function listNativeEvidenceForAssertion(persistence: Persistence, projectId: ProjectId, assertionId: AssertionId, projectVersion?: number, limit = 500) {
  boundedLimit(limit, 1000, "Assertion evidence limit");
  return snapshotRead(persistence, projectId, projectVersion, async reader => {
    const links = await reader.listAssertionEvidence(projectId, assertionId, limit);
    return Promise.all(links.map(async link => ({ link, evidence: await getNativeEvidenceAnchorFromReader(reader, projectId, link.evidenceId) })));
  });
}

function target(operation: ChangeSetOperation): { resource: ChangeSetResource; id: string; expected: number | null } {
  const c = operation.command as { id?: string; documentId?: string; evidenceId?: string; assertionId?: string; projectId: ProjectId; expectedVersion?: number | null; idempotencyKey?: string };
  switch (operation.type) {
    case "knowledge.node.save": return { resource: "knowledge_node", id: c.id!, expected: c.expectedVersion ?? null };
    case "knowledge.alias.save": return { resource: "knowledge_alias", id: c.id!, expected: null };
    case "knowledge.relation.save": return { resource: "knowledge_relation", id: c.id!, expected: c.expectedVersion ?? null };
    case "evidence.anchor.save": return { resource: "evidence_anchor", id: c.id!, expected: c.expectedVersion ?? null };
    case "evidence.mention.save": return { resource: "mention_link", id: `${operation.command.evidenceId}:${operation.command.nodeId}`, expected: null };
    case "evidence.assertion.save": return { resource: "assertion", id: operation.command.id, expected: operation.command.expectedVersion };
    case "evidence.assertion.link": return { resource: "assertion_evidence", id: `${operation.command.assertionId}:${operation.command.evidenceId}`, expected: null };
    default: throw new NativeKnowledgeServiceError("invalid_input", "Only native Knowledge and Evidence operations can be proposed");
  }
}

/** Submit bounded native operations. Actor, scope, provenance, and preconditions are server-derived. */
export async function proposeNativeKnowledgeChange(input: ProposeNativeKnowledgeChangeInput): Promise<{ changeSet: ChangeSet; replayed: boolean }> {
  if (!input.actorId.trim() || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || !Number.isInteger(input.projectVersion) || input.projectVersion < 1 || !Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 50 || Buffer.byteLength(JSON.stringify(input.operations), "utf8") > 256_000) {
    throw new NativeKnowledgeServiceError("invalid_input", "Native ChangeSet is empty or exceeds its bounded input limits");
  }
  const id = z.string().uuid();
  const nonempty = z.string().min(1).max(512).refine(value => value.trim().length > 0);
  const object = z.record(z.unknown());
  const version = z.number().int().positive().safe().nullable();
  const confidence = z.number().min(0).max(1).nullable();
  const scope = { projectId: id };
  const schema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("knowledge.node.save"), command: z.object({ ...scope, id, type: nonempty, name: nonempty, attributes: object, status: z.enum(["proposed", "confirmed", "retired"]), expectedVersion: version }).strict() }).strict(),
    z.object({ type: z.literal("knowledge.alias.save"), command: z.object({ ...scope, id, nodeId: id, surface: nonempty, normalized: nonempty, scope: nonempty.nullable(), status: z.enum(["proposed", "confirmed", "ambiguous", "retired"]) }).strict() }).strict(),
    z.object({ type: z.literal("knowledge.relation.save"), command: z.object({ ...scope, id, sourceId: id, targetId: id, type: nonempty, attributes: object, validity: object, status: z.enum(["proposed", "confirmed", "rejected", "retired"]), expectedVersion: version }).strict() }).strict(),
    z.object({ type: z.literal("evidence.anchor.save"), command: z.object({ ...scope, id, documentId: id, revisionId: id, fromUtf16: z.number().int().nonnegative().safe(), toUtf16: z.number().int().positive().safe(), quoteSha256: z.string().regex(/^[0-9a-f]{64}$/), status: z.enum(["proposed", "confirmed", "needs_review", "orphaned"]), expectedVersion: version }).strict() }).strict(),
    z.object({ type: z.literal("evidence.mention.save"), command: z.object({ ...scope, evidenceId: id, nodeId: id, status: z.enum(["proposed", "confirmed", "ambiguous", "rejected"]), source: nonempty, confidence, extractorVersion: nonempty.nullable() }).strict() }).strict(),
    z.object({ type: z.literal("evidence.assertion.save"), command: z.object({ ...scope, id, proposition: object, modality: nonempty, perspective: nonempty, narrativeTime: object, confidence, status: z.enum(["proposed", "confirmed", "rejected", "retired"]), expectedVersion: version }).strict() }).strict(),
    z.object({ type: z.literal("evidence.assertion.link"), command: z.object({ ...scope, assertionId: id, evidenceId: id, role: z.enum(["supports", "contradicts", "quotes", "context"]) }).strict() }).strict(),
  ]);
  const parsed = z.array(schema).safeParse(input.operations);
  if (!parsed.success) throw new NativeKnowledgeServiceError("invalid_input", "Native operation contains malformed or unauthorized fields");
  const operations = parsed.data.map(operation => {
    if (operation.command.projectId !== input.projectId) throw new NativeKnowledgeServiceError("invalid_input", "Native operation project scope does not match the authorized project");
    return operation as unknown as ChangeSetOperation;
  });
  const writes: ChangeSetWriteSetEntry[] = [];
  const reads: ChangeSetReadSetEntry[] = [];
  for (const operation of operations) {
    const resource = target(operation);
    writes.push({ resource: resource.resource, id: resource.id });
    reads.push({ resource: resource.resource, id: resource.id, expectedVersion: resource.expected });
  }
  const unique = (values: readonly { resource: string; id: string }[]) => new Set(values.map(v => `${v.resource}:${v.id}`)).size === values.length;
  if (!unique(writes)) throw new NativeKnowledgeServiceError("invalid_input", "A ChangeSet cannot write the same native identity twice");
  const command: CreateChangeSetCommand = {
    projectId: input.projectId, authorId: input.actorId, idempotencyKey: input.idempotencyKey,
    operations, readSet: reads, writeSet: writes,
    provenance: { source: "native-knowledge-service", actorId: input.actorId, details: { projectVersion: input.projectVersion } },
  };
  return input.persistence.transaction(transaction => transaction.createChangeSet(command));
}

export async function getNativeChangeSet(persistence: Persistence, projectId: ProjectId, changeSetId: ChangeSetId): Promise<{ changeSet: ChangeSet; receipt: ChangeSetApplicationResult | undefined } | undefined> {
  return persistence.read(async reader => {
    const changeSet = await reader.getChangeSet(projectId, changeSetId);
    return changeSet ? { changeSet, receipt: await reader.getChangeSetReceipt(projectId, changeSetId) } : undefined;
  });
}

export async function listNativeChangeSets(persistence: Persistence, projectId: ProjectId, limit = 50): Promise<readonly ChangeSet[]> {
  return persistence.read(reader => reader.listChangeSets(projectId, limit));
}

export async function approveNativeChangeSet(persistence: Persistence, projectId: ProjectId, changeSetId: ChangeSetId, expectedVersion: number, actorId: ActorId): Promise<ChangeSet> {
  return persistence.transaction(transaction => transaction.approveChangeSet({ projectId, changeSetId, expectedVersion, approvedBy: actorId }));
}
export async function rejectNativeChangeSet(persistence: Persistence, projectId: ProjectId, changeSetId: ChangeSetId, expectedVersion: number, actorId: ActorId): Promise<ChangeSet> {
  return persistence.transaction(transaction => transaction.rejectChangeSet({ projectId, changeSetId, expectedVersion, rejectedBy: actorId }));
}
export async function applyNativeChangeSet(persistence: Persistence, projectId: ProjectId, changeSetId: ChangeSetId, expectedVersion: number): Promise<ChangeSetApplicationResult> {
  return persistence.transaction(transaction => transaction.applyChangeSet({ projectId, changeSetId, expectedVersion }));
}
