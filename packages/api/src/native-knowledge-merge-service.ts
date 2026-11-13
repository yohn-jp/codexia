import type { ActorId, ChangeSet, KnowledgeNodeId, Persistence, ProjectId } from "@codexia/persistence-contracts";
import { planKnowledgeMerge } from "@codexia/persistence-postgres/knowledge-merge";

export class NativeKnowledgeMergeServiceError extends Error {
  constructor(readonly code: "snapshot_unavailable" | "invalid_input", message: string) { super(message); }
}

/** Return the existing canonical merge preview for one current native project snapshot. */
export async function previewNativeKnowledgeMerge(
  persistence: Persistence,
  projectId: ProjectId,
  sourceId: KnowledgeNodeId,
  targetId: KnowledgeNodeId,
  projectVersion: number,
) {
  if (!Number.isSafeInteger(projectVersion) || projectVersion < 1) throw new NativeKnowledgeMergeServiceError("invalid_input", "Project version must be a positive safe integer");
  return persistence.read(async reader => {
    const project = await reader.getProject(projectId);
    if (!project || project.version !== projectVersion) throw new NativeKnowledgeMergeServiceError("snapshot_unavailable", "The selected Knowledge snapshot is unavailable");
    return planKnowledgeMerge(reader, projectId, sourceId, targetId);
  });
}

export interface ProposeNativeKnowledgeMergeInput {
  persistence: Persistence;
  projectId: ProjectId;
  sourceId: KnowledgeNodeId;
  targetId: KnowledgeNodeId;
  projectVersion: number;
  previewDigest: string;
  actorId: ActorId;
  /** Host-derived author or external-agent origin. */
  origin: "author" | "external-agent";
  idempotencyKey: string;
}

/** Persist one server-planned merge in native ChangeSet review state. */
export async function proposeNativeKnowledgeMerge(input: ProposeNativeKnowledgeMergeInput): Promise<{ changeSet: ChangeSet; replayed: boolean }> {
  if (!input.actorId.trim() || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || !Number.isSafeInteger(input.projectVersion) || input.projectVersion < 1 || !/^[0-9a-f]{64}$/u.test(input.previewDigest) || input.sourceId === input.targetId) {
    throw new NativeKnowledgeMergeServiceError("invalid_input", "Native Knowledge merge proposal is malformed");
  }
  return input.persistence.transaction(transaction => transaction.proposeKnowledgeMerge({
    projectId: input.projectId,
    sourceId: input.sourceId,
    targetId: input.targetId,
    projectVersion: input.projectVersion,
    previewDigest: input.previewDigest,
    actorId: input.actorId,
    origin: input.origin,
    idempotencyKey: input.idempotencyKey,
  }));
}
