import { createHash } from "node:crypto";
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
  const operations = input.operations.map(operation => {
    if (!operation || typeof operation !== "object" || !["knowledge.node.save", "knowledge.alias.save", "knowledge.relation.save", "evidence.anchor.save", "evidence.mention.save", "evidence.assertion.save", "evidence.assertion.link"].includes(operation.type)) throw new NativeKnowledgeServiceError("invalid_input", "Invalid native operation");
    const fields: Record<string, readonly string[]> = {
      "knowledge.node.save": ["projectId", "id", "type", "name", "attributes", "status", "expectedVersion"],
      "knowledge.alias.save": ["projectId", "id", "nodeId", "surface", "normalized", "scope", "status"],
      "knowledge.relation.save": ["projectId", "id", "sourceId", "targetId", "type", "attributes", "validity", "status", "expectedVersion"],
      "evidence.anchor.save": ["projectId", "id", "documentId", "revisionId", "fromUtf16", "toUtf16", "quoteSha256", "status", "expectedVersion"],
      "evidence.mention.save": ["projectId", "evidenceId", "nodeId", "status", "source", "confidence", "extractorVersion"],
      "evidence.assertion.save": ["projectId", "id", "proposition", "modality", "perspective", "narrativeTime", "confidence", "status", "expectedVersion"],
      "evidence.assertion.link": ["projectId", "assertionId", "evidenceId", "role"],
    };
    if (!operation.command || typeof operation.command !== "object" || Array.isArray(operation.command) || Object.keys(operation).some(key => key !== "type" && key !== "command") || Object.keys(operation.command).some(key => !fields[operation.type]!.includes(key))) {
      throw new NativeKnowledgeServiceError("invalid_input", "Native operation contains malformed or unauthorized fields");
    }
    if (operation.command.projectId !== input.projectId) throw new NativeKnowledgeServiceError("invalid_input", "Native operation project scope does not match the authorized project");
    const command = { ...operation.command, projectId: input.projectId } as ChangeSetOperation["command"];
    return { ...operation, command } as ChangeSetOperation;
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
  return input.persistence.transaction(async transaction => {
    await transaction.assertProjectVersion(input.projectId, input.projectVersion);
    for (const operation of operations) {
      if (operation.type === "evidence.anchor.save") {
        const c = operation.command;
        const revision = await transaction.getRevision(input.projectId, c.documentId, c.revisionId);
        if (!revision || c.fromUtf16 < 0 || c.toUtf16 <= c.fromUtf16 || c.toUtf16 > revision.markdown.length) throw new NativeKnowledgeServiceError("invalid_input", "Evidence anchor must select a range in a project-owned source revision");
        const quoteHash = createHash("sha256").update(revision.markdown.slice(c.fromUtf16, c.toUtf16), "utf8").digest("hex");
        if (c.quoteSha256 !== quoteHash) throw new NativeKnowledgeServiceError("invalid_input", "Evidence anchor quote hash does not match its source range");
      }
    }
    return transaction.createChangeSet(command);
  });
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
