import type { ActionResult, ModuleAction, ModuleActionContext, SnapshotId, ValueSchema } from "@codexia/contracts";
import type { ActorId, ChangeSetId, ChangeSetOperation, EvidenceId, KnowledgeNodeId, Persistence, ProjectId, RevisionId } from "@codexia/persistence-contracts";
import {
  getNativeAssertion, getNativeChangeSet, getNativeEvidenceAnchor, getNativeKnowledgeNode,
  listNativeChangeSets, listNativeEvidenceForAssertion, listNativeEvidenceForDocument,
  listNativeEvidenceForNode, listNativeKnowledgeAliases, listNativeKnowledgeNodes,
  listNativeKnowledgeRelations, NativeKnowledgeServiceError, proposeNativeKnowledgeChange,
} from "./native-knowledge-service.js";

export interface NativeKnowledgeActionHost {
  persistence: Persistence;
  projectId: ProjectId;
  actorId: ActorId;
  origin: "author" | "external-agent";
  authorizeProposal: () => Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
function input(allowed: readonly string[], required: readonly string[] = []): ValueSchema {
  return { parse(value: unknown) {
    if (!record(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) throw new Error("Action input contains missing or unauthorized fields");
    return value;
  } };
}
const output: ValueSchema = { parse(value: unknown) {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw new Error("Native Knowledge result is not JSON serializable"); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 8 * 1024 * 1024) throw new Error("Native Knowledge result is not JSON serializable or exceeds the result limit");
  return value;
} };
function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new NativeKnowledgeServiceError("invalid_input", "Limit or projectVersion must be a positive integer");
  return value;
}
function id<T extends string>(value: unknown, label: string): T {
  if (!uuid(value)) throw new NativeKnowledgeServiceError("invalid_input", `${label} must be a PostgreSQL UUID`);
  return value as T;
}
function selectedVersion(value: unknown, context: ModuleActionContext, projectId: string): number {
  assertProjectScope(context, projectId);
  const selected = context.reader.snapshot.projectVersion;
  if (value !== undefined && value !== selected) throw new NativeKnowledgeServiceError("snapshot_unavailable", "Requested projectVersion does not match the selected Action reader");
  return selected;
}
function assertProjectScope(context: ModuleActionContext, projectId: string): void {
  if (context.projectId !== context.reader.snapshot.projectId || context.projectId !== projectId) throw new NativeKnowledgeServiceError("snapshot_unavailable", "Action project does not match its selected reader");
}
function proposalVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new NativeKnowledgeServiceError("invalid_input", "projectVersion must be an explicitly observed positive integer");
  return value;
}
function failure(context: ModuleActionContext, error: unknown): ActionResult {
  const candidate = error as { code?: unknown; message?: unknown };
  return { ok: false, snapshot: context.reader.snapshot, error: {
    code: typeof candidate?.code === "string" ? candidate.code : "native_knowledge_failed",
    message: typeof candidate?.message === "string" ? candidate.message.slice(0, 512) : "Native Knowledge action failed",
    retryable: false,
  } };
}

/** Host-owned Core catalog for native PostgreSQL Knowledge, Evidence, and ChangeSet state. */
export function createNativeKnowledgeActions(host: NativeKnowledgeActionHost): ModuleAction[] {
  const { persistence, projectId } = host;
  const read = (id: string, schema: ValueSchema, execute: (value: Record<string, unknown>, context: ModuleActionContext) => Promise<unknown>): ModuleAction => ({
    id, effect: "read", inputSchema: schema, outputSchema: output,
    async invoke(raw, context) {
      try {
        if (context.signal.aborted) throw Object.assign(new Error("Action was cancelled"), { code: "action_cancelled" });
        assertProjectScope(context, projectId);
        const value = raw as Record<string, unknown>;
        const data = await execute(value, context);
        if (context.signal.aborted) throw Object.assign(new Error("Action was cancelled"), { code: "action_cancelled" });
        return { ok: true, snapshot: context.reader.snapshot, data: data === undefined ? null : data };
      } catch (error) { return failure(context, error); }
    },
  });
  const version = (value: Record<string, unknown>, context: ModuleActionContext) => selectedVersion(value.projectVersion, context, projectId);
  const actions: ModuleAction[] = [
    read("core.knowledge.nodes.list", input(["projectVersion", "limit"]), (v, c) => listNativeKnowledgeNodes(persistence, projectId, positive(v.limit, 100), version(v, c))),
    read("core.knowledge.node.get", input(["nodeId", "projectVersion", "relatedLimit"], ["nodeId"]), (v, c) => getNativeKnowledgeNode(persistence, projectId, id<KnowledgeNodeId>(v.nodeId, "nodeId"), version(v, c), positive(v.relatedLimit, 500))),
    read("core.knowledge.aliases.list", input(["nodeId", "projectVersion", "limit"], ["nodeId"]), (v, c) => listNativeKnowledgeAliases(persistence, projectId, id<KnowledgeNodeId>(v.nodeId, "nodeId"), positive(v.limit, 500), version(v, c))),
    read("core.knowledge.relations.list", input(["nodeId", "projectVersion", "limit"], ["nodeId"]), (v, c) => listNativeKnowledgeRelations(persistence, projectId, id<KnowledgeNodeId>(v.nodeId, "nodeId"), positive(v.limit, 500), version(v, c))),
    read("core.evidence.anchor.get", input(["evidenceId", "projectVersion", "historyLimit"], ["evidenceId"]), (v, c) => getNativeEvidenceAnchor(persistence, projectId, id<EvidenceId>(v.evidenceId, "evidenceId"), version(v, c), positive(v.historyLimit, 500))),
    read("core.evidence.document.list", input(["documentId", "revisionId", "projectVersion", "limit"], ["documentId"]), (v, c) => listNativeEvidenceForDocument(persistence, projectId, id(v.documentId, "documentId"), v.revisionId === undefined ? undefined : id<RevisionId>(v.revisionId, "revisionId"), positive(v.limit, 200), version(v, c))),
    read("core.evidence.node.list", input(["nodeId", "projectVersion", "limit"], ["nodeId"]), (v, c) => listNativeEvidenceForNode(persistence, projectId, id<KnowledgeNodeId>(v.nodeId, "nodeId"), positive(v.limit, 200), version(v, c))),
    read("core.evidence.assertion.get", input(["assertionId", "projectVersion", "evidenceLimit"], ["assertionId"]), (v, c) => getNativeAssertion(persistence, projectId, id(v.assertionId, "assertionId"), version(v, c), positive(v.evidenceLimit, 500))),
    read("core.evidence.assertion.list", input(["assertionId", "projectVersion", "limit"], ["assertionId"]), (v, c) => listNativeEvidenceForAssertion(persistence, projectId, id(v.assertionId, "assertionId"), version(v, c), positive(v.limit, 500))),
    read("core.changesets.list", input(["limit"]), async v => ({ current: true, changeSets: await listNativeChangeSets(persistence, projectId, Math.min(100, positive(v.limit, 50))) })),
    read("core.changeset.get", input(["changeSetId"], ["changeSetId"]), async v => {
      const result = await getNativeChangeSet(persistence, projectId, id<ChangeSetId>(v.changeSetId, "changeSetId"));
      return result ? { current: true, ...result } : undefined;
    }),
    {
      id: "core.knowledge.propose", effect: "propose",
      inputSchema: input(["projectVersion", "idempotencyKey", "operations"], ["projectVersion", "idempotencyKey", "operations"]), outputSchema: output,
      async invoke(raw, context) {
        try {
          if (context.signal.aborted) throw Object.assign(new Error("Action was cancelled"), { code: "action_cancelled" });
          assertProjectScope(context, projectId);
          await host.authorizeProposal();
          if (context.signal.aborted) throw Object.assign(new Error("Action was cancelled"), { code: "action_cancelled" });
          const value = raw as Record<string, unknown>;
          const selected = proposalVersion(value.projectVersion);
          if (selected > context.reader.snapshot.projectVersion) throw new NativeKnowledgeServiceError("snapshot_unavailable", "Proposal source is newer than the selected Action reader");
          if (typeof value.idempotencyKey !== "string" || !Array.isArray(value.operations)) throw new NativeKnowledgeServiceError("invalid_input", "idempotencyKey and operations are required");
          const result = await proposeNativeKnowledgeChange({ persistence, projectId, actorId: host.actorId, projectVersion: selected, idempotencyKey: value.idempotencyKey, operations: value.operations as ChangeSetOperation[], origin: host.origin });
          if (context.signal.aborted) throw Object.assign(new Error("Action was cancelled"), { code: "action_cancelled" });
          return { ok: true, snapshot: context.reader.snapshot, data: result };
        } catch (error) { return failure(context, error); }
      },
    },
  ];
  return actions;
}
