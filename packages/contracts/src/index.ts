/** Public, transport-neutral campaign contract v1. No platform or domain dependencies. */
import { PUBLISHING_EPISODES_KEY } from "./publishing-episodes.js";
import { PUBLISHING_SHARE_GRANTS_KEY } from "./publishing-share-grants.js";

export const CONTRACT_VERSION = 1 as const;
export const MAX_JOB_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_JOB_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_PROPOSAL_EVIDENCE_BYTES = 1024 * 1024;
export const BUILTIN_MODULE_IDS = Object.freeze(["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp", "search"] as const);
export type ModuleId = (typeof BUILTIN_MODULE_IDS)[number];
export {
  MCP_OAUTH_SCOPES,
  buildMcpProtectedResourceMetadata,
  createMcpProtectedResourceMetadataResponse,
  protectedResourceMetadataUrl,
  type McpProtectedResourceMetadata,
  type McpProtectedResourceOptions,
} from "./oauth-metadata.js";
/** PostgreSQL project revision; never a Git object identity. */
export interface SnapshotId {
  projectId: string;
  projectVersion: number;
}
export interface FileRevision { path: string; revision: string | null }
export const PRIVATE_PUBLISHING_PATHS = Object.freeze([
  "meta/scriptorium/modules/publishing/episodes.yaml",
  "meta/scriptorium/modules/publishing/share-grants.jsonl",
]);
export function isPrivatePublishingPath(path: string): boolean {
  return PRIVATE_PUBLISHING_PATHS.includes(path);
}
/** Identifies module data retained for preservation outside live authoring. */
export function isModulePreservationArchivePath(path: string): boolean {
  return /^meta\/scriptorium\/modules\/[^/]+\/legacy(?:\/|$)/u.test(path);
}
/** Binds a directory membership and every listed file revision, including absent members. */
export interface ScopeRevision { prefix: string; revision: string }
/** Return a decimal order key after every existing text-ordered key without rewriting them. */
export function nextOrderKey(orderKeys: readonly string[]): string {
  const last = [...orderKeys].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).at(-1);
  if (last === undefined) return "0000000001";
  if (!/^\d+$/.test(last)) return `${last}0`;
  const incremented = (BigInt(last) + 1n).toString().padStart(last.length, "0");
  // An unpadded boundary such as 9 -> 10 would sort backwards as text. Extending
  // the greatest existing key stays after it, and remains a decimal Story order.
  return incremented > last ? incremented : `${last}0`;
}
/** Binds the canonical PostgreSQL membership of one hierarchy sibling set. */
export interface DocumentSetRevision {
  kind: "volume" | "chapter" | "scene";
  parentId: string | null;
  documentIds: string[];
}
/** Contents are full UTF-8 or base64; null is an explicit deletion. */
export interface FileChange extends FileRevision {
  content: string | null;
  encoding?: "utf8" | "base64";
  /** Exact PostgreSQL manuscript edits; omitted by legacy full-document proposals. */
  textChanges?: readonly { fromUtf16: number; toUtf16: number; insert: string }[];
}
export type EffectClass = "manuscript" | "structure" | "metadata" | "settings" | "migration";
export interface ChangeOperation {
  id: string;
  generation: number;
  projectId: string;
  baseProjectVersion: number;
  effect: EffectClass;
  reads: FileRevision[];
  readScopes?: ScopeRevision[];
  readDocumentSets?: DocumentSetRevision[];
  /** Exact Knowledge projection observed by this operation. */
  readKnowledgeRevision?: string;
  writes: FileChange[];
  message: string;
  evidenceIds?: string[];
}
export interface ApplyReceipt {
  operationId: string;
  generation: number;
  projectVersion: number;
  revisions: FileRevision[];
}
export interface ProjectObservation {
  snapshot: SnapshotId;
  observedAt: string;
  state: "fresh" | "failed" | "unknown";
}
/** Presentation fields from the project record at the enclosing snapshot. */
export interface SnapshotProjectPresentation {
  /** Reader-facing title after applying the project's display settings. */
  readonly title: string;
  readonly subtitle?: string;
}
export interface KnowledgeProjectionRef {
  readonly kind: "knowledge-projection";
  readonly snapshot: Readonly<SnapshotId>;
  readonly revision: string;
}
export interface KnowledgeProjectionEvidence {
  readonly anchor: Readonly<{ id: string; documentId: string; revisionId: string; status: string }>;
  readonly mention: Readonly<{ status: string }>;
  readonly current: boolean;
  readonly storySceneId: string | null;
  /** Verified quote at the anchor's immutable revision, if it fits the projection budget. */
  readonly quote: string | null;
  readonly quoteOmission?: "projection-budget";
  readonly assertions: readonly Readonly<{ assertion: Readonly<{ status: string }>; role: string }>[];
  readonly assertionLimitReached: boolean;
}
export interface KnowledgeProjectionEntry {
  readonly node: Readonly<{ id: string; name: string; type: string; status: string; attributes: Readonly<Record<string, unknown>>; deletedAt: string | null }>;
  readonly aliases: readonly Readonly<{ nodeId: string; surface: string; status: string; scope: string | null }>[];
  readonly relations: readonly Readonly<{ sourceId: string; targetId: string; status: string }>[];
  readonly evidence: readonly KnowledgeProjectionEvidence[];
  readonly evidenceLimitReached: boolean;
  readonly aliasLimitReached: boolean;
  readonly relationLimitReached: boolean;
}
export interface KnowledgeProjectionData {
  readonly documentMappings: readonly Readonly<{ documentId: string; storySceneId: string; mapping: "explicit" | "ambiguous" }>[];
  readonly entries: readonly KnowledgeProjectionEntry[];
  readonly nodeLimitReached: boolean;
}
export interface SnapshotKnowledgeProjection extends KnowledgeProjectionData {
  readonly source: KnowledgeProjectionRef;
}
export interface SnapshotFile {
  content: string;
  revision: string;
  /** Canonical PostgreSQL kind for projected metadata and body files, even when bytes omit it. */
  documentKind?: string;
  /** Snapshot-local PostgreSQL document sequence, consistent with sibling order. */
  documentOrder?: number;
}
export interface SnapshotReader {
  snapshot: SnapshotId;
  readonly knowledge?: SnapshotKnowledgeProjection;
  projectPresentation?: SnapshotProjectPresentation;
  /** Typed projection of canonical PostgreSQL Story documents for native readers. */
  nativeStoryDocuments?: readonly NativeStoryDocument[];
  read(path: string, encoding?: "utf8" | "base64"): Promise<SnapshotFile | null>;
  /** Read up to SNAPSHOT_READ_MANY_LIMIT files at this snapshot, in input order with null for absent paths. */
  readMany?(paths: readonly string[], encoding?: "utf8" | "base64"): Promise<readonly (SnapshotFile | null)[]>;
  list(prefix: string): Promise<string[]>;
  /** Optional metadata-backed path revisions; values must match read(path).revision. */
  listRevisions?(prefix: string): Promise<FileRevision[]>;
}
/** Immutable Story metadata projection bound to the enclosing SnapshotReader snapshot. */
export interface NativeStoryDocument {
  id: string;
  kind: string;
  title: string;
  orderKey: string;
  metadataPath: string;
  metadataRevision: string;
  /** Exact UTF-8 content of metadataPath at metadataRevision. */
  metadataContent: string;
  documentOrder: number;
  metadata: Record<string, unknown>;
}
/** Snapshot-scoped file reads for optional consumers such as local search indexes. */
export interface DocumentSource {
  version: 1;
  snapshot: SnapshotId;
  enumerate(prefix?: string): Promise<FileRevision[]>;
  readMany(paths: readonly string[]): Promise<Array<{ path: string; content: string; revision: string }>>;
  changes(previous: readonly FileRevision[], prefix?: string): Promise<{ upserted: FileRevision[]; removed: string[] }>;
}
export interface ProposalEvidence {
  id: string;
  snapshot: SnapshotId;
  module: ModuleId;
  kind: string;
  paths: FileRevision[];
  /** Bounded module-owned JSON, never credentials or executable code. */
  details: unknown;
}
export interface ChangeProposal {
  id: string;
  snapshot: SnapshotId;
  operations: ChangeOperation[];
  source: "author" | "module" | "mcp";
  evidence?: ProposalEvidence[];
}
/** Author review state. Unaccepted payload remains in private/browser recovery. */
export interface ProposalStatus {
  proposal: ChangeProposal;
  /** False when only accepted operations remain, without provisional evidence. */
  payloadComplete?: boolean;
  /** Digest binding of the original complete normalized proposal, including provisional data. */
  originalDigest?: string;
  /** Original proposal operation IDs in order, including privately retained operations. */
  operationIds?: string[];
  state: "proposed" | "partially_approved" | "approved" | "applied";
  approvedOperationIds: string[];
  /** Durable author scope for each approved operation; retries cannot change the first approver. */
  approvedByOperationId?: Record<string, string>;
  applications: ApplyReceipt[];
  /** Atomically applied in PostgreSQL. */
  appliedOperationIds: string[];
  stale: boolean;
}
export interface Approval { proposalId: string; operationIds: string[]; authorScope: string }
/** Port shared by module and external callers: no author authority. */
export interface ProposalCoordinator {
  observe(projectId: string): Promise<ProjectObservation>;
  reader(projectId: string, pinned?: SnapshotId): Promise<SnapshotReader>;
  propose(projectId: string, proposal: ChangeProposal): Promise<ChangeProposal>;
}
/** Host-only port; modules and MCP never receive author approval authority. */
export interface MutationCoordinator extends ProposalCoordinator {
  approve(projectId: string, approval: Approval): Promise<void>;
  apply(projectId: string, operation: ChangeOperation): Promise<ApplyReceipt>;
}
export interface JobRequest<T = unknown> {
  id: string;
  module: ModuleId;
  task: string;
  snapshot: SnapshotId;
  model: string;
  modelVersion: string;
  moduleVersion: string;
  deadline: number;
  input: T;
}
export interface JobResult<T = unknown> {
  id: string;
  snapshot: SnapshotId;
  model: string;
  modelVersion: string;
  moduleVersion: string;
  output: T;
}
export interface MachineError { code: string; message: string; retryable: boolean }
export type JobOutcome<T = unknown> = { ok: true; result: JobResult<T> } | { ok: false; id: string; snapshot: SnapshotId; error: MachineError };
export interface ValueSchema<T = unknown> { parse(value: unknown): T }
export type ActionResult<T = unknown> = { ok: true; snapshot: SnapshotId; data: T; proposals?: ChangeProposal[] } | { ok: false; snapshot: SnapshotId; error: MachineError };
/** Optional host-owned history for a source domain task; never grants author approval. */
export interface DomainJobDescriptor { type: string }
export interface ActionDescriptor { id: string; module: ModuleId | "core"; effect: "read" | "propose" | "compute"; job?: DomainJobDescriptor }
export type ModuleRecordJsonValue = null | string | number | boolean | ModuleRecordJsonValue[] | ModuleRecordJsonObject;
export type ModuleRecordJsonObject = { [key: string]: ModuleRecordJsonValue };
export { NLP_FEATURE_SETTINGS_KEY, NLP_LEGACY_FEATURE_SETTINGS_PATH, parseNlpFeatureSettings, type NlpFeatureSettings } from "./nlp-feature-settings.js";
export interface OwnModuleRecord { value: ModuleRecordJsonObject; version: number }
export interface OwnModuleRecordProposal {
  key: string;
  value: ModuleRecordJsonObject;
  expectedVersion: number | null;
  idempotencyKey: string;
}
export interface NativeChangeSetReference { id: string; projectId: string }
export { PUBLISHING_SHARE_GRANTS_KEY, parsePublishingShareGrantIndex, convertPublishingShareGrantJsonl, type PublishingShareGrant } from "./publishing-share-grants.js";
export { PUBLISHING_EPISODES_KEY, parsePublishingEpisodesRecord, parsePublishingEpisodeUpdate, convertPublishingEpisodesYaml, type PublishingEpisodeDocument, type PublishingEpisode } from "./publishing-episodes.js";
export const PUBLISHING_RECORD_KEYS = [PUBLISHING_EPISODES_KEY, PUBLISHING_SHARE_GRANTS_KEY] as const;
export function isPublishingRecordKey(key: string): key is (typeof PUBLISHING_RECORD_KEYS)[number] {
  return PUBLISHING_RECORD_KEYS.some(candidate => candidate === key);
}
export interface ModuleActionContext {
  projectId: string;
  reader: SnapshotReader;
  /** Host-verified identity binding for an MCP HTTP session. */
  mcpSessionIdentity?: string;
  /** Same authenticated project/snapshot; never exposes author mutation ports. */
  invoke(actionId: string, input: unknown, signal?: AbortSignal): Promise<ActionResult>;
  listActions(): Promise<ActionDescriptor[]>;
  /** Explicit read-only composition with another project of this owner. */
  linkedReader(projectId: string): Promise<SnapshotReader>;
  signal: AbortSignal;
  /** Actual fractional progress of this host-tracked domain invocation. */
  reportProgress?(progress: number): Promise<void>;
  /** Only proposes; approval remains an authenticated author action. */
  propose(operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string, signal?: AbortSignal): Promise<ChangeProposal>;
  /** Read a record owned by this module at the enclosing snapshot. */
  readOwnModuleRecord?(key: string): Promise<OwnModuleRecord | undefined>;
  /** Propose an update to this module's own record under the existing author approval boundary. */
  proposeOwnModuleRecord?(input: OwnModuleRecordProposal): Promise<NativeChangeSetReference>;
  runJob<T = unknown>(request: JobRequest, signal?: AbortSignal): Promise<JobOutcome<T>>;
}
export interface ModuleAction {
  id: string;
  effect: "read" | "propose" | "compute";
  /** Declared by the owning module; the host records the exact outer action result privately. */
  job?: DomainJobDescriptor;
  inputSchema: ValueSchema;
  outputSchema: ValueSchema;
  invoke(input: unknown, context: ModuleActionContext): Promise<ActionResult>;
}
export interface UiContribution {
  /** Versioned composition metadata; absent values retain the original panel semantics. */
  contractVersion?: 1;
  kind?: "panel" | "editor-adornment" | "context-action";
  contexts?: Array<"workspace" | "editor" | "reading">;
  multipleInstances?: boolean;
  id: string;
  module: ModuleId;
  slot: "editor" | "dock" | "inspection" | "review" | "settings";
  title: string;
  action: string;
}
export interface ModuleManifest {
  id: ModuleId;
  version: string;
  contractVersion: number;
  dependencies: ModuleId[];
  provides: string[];
  requires: string[];
  /** Availability-gated source features do not force the optional provider into a profile. */
  optionalRequires?: string[];
  serverEntry?: string;
  browserEntry?: string;
  workerEntry?: string;
  statePaths: string[];
  locality: "local" | "optional-external";
  /** Host-owned HTTP registration descriptors; handlers are checked against these when the module activates. */
  http?: HttpContributionDescriptor[];
}
export interface WorkerService {
  request<T = unknown>(request: JobRequest, signal: AbortSignal): Promise<JobOutcome<T>>;
  cancel(jobId: string): boolean;
  dispose(): Promise<void>;
}
export interface CapabilityDefinition<T = unknown> {
  id: string;
  version: string;
  /** Called only on first lease; registering a factory allocates no heavy resource. */
  create(context: ModuleContext): Promise<T>;
  dispose?(value: T): Promise<void>;
}
export interface ModuleContext {
  cacheDirectory: string;
  signal: AbortSignal;
  acquireCapability<T>(id: string): Promise<{ value: T; release(): Promise<void> }>;
  /** Resolves this installed module's declared worker, with bounded supervised IPC. */
  createWorkerService(): Promise<WorkerService>;
}
export interface HttpContribution {
  id: string;
  /** Relative path template under the host-owned project or stable-repository prefix. */
  path: string;
  methods: Array<"GET" | "HEAD" | "POST" | "DELETE">;
  access: "owner" | "public";
  effect: "read" | "compute" | "propose";
  handle(request: Request, context: ModuleActionContext): Promise<Response>;
}
export type HttpContributionDescriptor = Omit<HttpContribution, "handle">;
export interface ModuleDefinition {
  manifest: ModuleManifest;
  capabilities?: CapabilityDefinition[];
  http?: HttpContribution[];
  actions: ModuleAction[];
  ui: UiContribution[];
  dispose(): Promise<void>;
}
export type ModuleAvailability = "not-included" | "disabled" | "enabled-idle" | "active";
export interface ModuleStatus { id: ModuleId; availability: ModuleAvailability; version?: string; activeJobs: number }

export class ContractError extends Error {
  readonly code = "invalid_contract";
  constructor(message: string) { super(message); this.name = "ContractError"; }
}
export function assertProjectPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 1024 || /[\\\x00-\x1f]/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new ContractError("Unsafe project path");
  }
}
export const SNAPSHOT_READ_MANY_LIMIT = 32;

function documentPrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return undefined;
  assertProjectPath(prefix);
  return prefix;
}

function assertDocumentRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ContractError("Snapshot document has an invalid revision");
  }
}

function assertDocumentPath(path: unknown, prefix?: string): asserts path is string {
  assertProjectPath(path);
  if (prefix !== undefined && path !== prefix && !path.startsWith(`${prefix}/`)) {
    throw new ContractError("Snapshot document is outside the requested scope");
  }
}

async function inBatches<T, R>(values: readonly T[], action: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let offset = 0; offset < values.length; offset += SNAPSHOT_READ_MANY_LIMIT) {
    output.push(...await Promise.all(values.slice(offset, offset + SNAPSHOT_READ_MANY_LIMIT).map(action)));
  }
  return output;
}

/** Adds bounded bulk reads and revision deltas over the existing immutable reader. */
export function createDocumentSource(reader: SnapshotReader): DocumentSource {
  const snapshot = structuredClone(reader.snapshot);
  return {
    version: 1,
    snapshot,
    async enumerate(prefix) {
      const scope = documentPrefix(prefix);
      const listed = reader.listRevisions
        ? await reader.listRevisions(scope ?? "")
        : await inBatches(await reader.list(scope ?? ""), async path => {
            assertDocumentPath(path, scope);
            const file = await reader.read(path);
            if (!file) throw new ContractError("Snapshot document is unavailable");
            assertDocumentRevision(file.revision);
            return { path, revision: file.revision };
          });
      const seen = new Set<string>();
      for (const item of listed) {
        if (!item || typeof item !== "object") throw new ContractError("Invalid snapshot document listing");
        assertDocumentPath(item.path, scope);
        if (item.revision !== null) assertDocumentRevision(item.revision);
        if (seen.has(item.path)) throw new ContractError("Snapshot document listing contains duplicate paths");
        seen.add(item.path);
      }
      return listed.map(item => ({ ...item })).sort((left, right) => left.path.localeCompare(right.path));
    },
    async readMany(paths) {
      const seen = new Set<string>();
      for (const path of paths) {
        assertDocumentPath(path);
        if (seen.has(path)) throw new ContractError("Snapshot document read contains duplicate paths");
        seen.add(path);
      }
      function documentFile(path: string, file: SnapshotFile | null | undefined) {
        if (!file) throw new ContractError("Snapshot document is unavailable");
        assertDocumentRevision(file.revision);
        return { path, content: file.content, revision: file.revision };
      }
      if (!reader.readMany) return inBatches(paths, async path => documentFile(path, await reader.read(path)));

      const result: Array<{ path: string; content: string; revision: string }> = [];
      for (let offset = 0; offset < paths.length; offset += SNAPSHOT_READ_MANY_LIMIT) {
        const batch = paths.slice(offset, offset + SNAPSHOT_READ_MANY_LIMIT);
        const files = await reader.readMany(batch);
        if (files.length !== batch.length) throw new ContractError("Invalid snapshot document batch");
        result.push(...batch.map((path, index) => documentFile(path, files[index])));
      }
      return result;
    },
    async changes(previous, prefix) {
      const scope = documentPrefix(prefix);
      const prior = new Map<string, string | null>();
      for (const item of previous) {
        if (!item || typeof item !== "object") throw new ContractError("Invalid previous snapshot document");
        assertDocumentPath(item.path);
        if (scope !== undefined && item.path !== scope && !item.path.startsWith(`${scope}/`)) continue;
        if (item.revision !== null && typeof item.revision !== "string") {
          throw new ContractError("Invalid previous snapshot document revision");
        }
        if (prior.has(item.path)) throw new ContractError("Previous snapshot document listing contains duplicate paths");
        prior.set(item.path, item.revision);
      }
      const current = await this.enumerate(scope);
      const currentPaths = new Set(current.map(item => item.path));
      return {
        upserted: current.filter(item => prior.get(item.path) !== item.revision),
        removed: [...prior.keys()].filter(path => !currentPaths.has(path)).sort((left, right) => left.localeCompare(right)),
      };
    },
  };
}
export function snapshotKey(snapshot: SnapshotId): string {
  return JSON.stringify([snapshot.projectId, snapshot.projectVersion]);
}
/** Content-neutral semantic read-set guard; callers choose the relevant project subtree. */
export async function snapshotScopeRevision(reader: SnapshotReader, prefix: string): Promise<string> {
  assertProjectPath(prefix);
  const files = reader.listRevisions
    ? await reader.listRevisions(prefix)
    : (await reader.list(prefix)).map(path => ({ path }));
  const seen = new Set<string>();
  const entries: Array<[string, string]> = [];
  for (const file of files) {
    if (!file || typeof file !== "object") throw new ContractError("Invalid snapshot scope listing");
    const { path } = file;
    assertProjectPath(path);
    if ((path !== prefix && !path.startsWith(`${prefix}/`)) || seen.has(path)) {
      throw new ContractError("Invalid snapshot scope listing");
    }
    seen.add(path);
    const revision = "revision" in file ? file.revision : (await reader.read(path))?.revision;
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
      throw new ContractError("Snapshot scope contains an unavailable file");
    }
    entries.push([path, revision]);
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(entries)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
/** Runtime boundary, also used for recovered browser payloads. Symlink checks remain Core-owned. */
export function assertChangeOperation(value: unknown): asserts value is ChangeOperation {
  const v = value as ChangeOperation | null;
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v.id) ||
      !Number.isSafeInteger(v.generation) || v.generation < 0 || typeof v.message !== "string" ||
      !v.message.trim() || v.message.length > 1024 || !Number.isSafeInteger(v.baseProjectVersion) || v.baseProjectVersion < 0 ||
      !["manuscript", "structure", "metadata", "settings", "migration"].includes(v.effect) ||
      typeof v.projectId !== "string" || !v.projectId || v.projectId.length > 512 ||
      !Array.isArray(v.reads) || !Array.isArray(v.writes) || v.reads.length > 512 || !v.writes.length || v.writes.length > 256) {
    throw new ContractError("Invalid change operation");
  }
  if (v.readScopes !== undefined) {
    if (!Array.isArray(v.readScopes) || v.readScopes.length > 32) throw new ContractError("Invalid scope preconditions");
    const prefixes = new Set<string>();
    for (const scope of v.readScopes) {
      if (!scope || typeof scope !== "object") throw new ContractError("Invalid scope precondition");
      assertProjectPath(scope.prefix);
      if (prefixes.has(scope.prefix) || typeof scope.revision !== "string" || !/^[a-f0-9]{64}$/.test(scope.revision)) {
        throw new ContractError("Invalid scope revision");
      }
      prefixes.add(scope.prefix);
    }
  }
  if (v.readKnowledgeRevision !== undefined && (typeof v.readKnowledgeRevision !== "string" || !/^[a-f0-9]{64}$/u.test(v.readKnowledgeRevision))) {
    throw new ContractError("Invalid Knowledge projection revision");
  }
  if (v.readDocumentSets !== undefined) {
    if (!Array.isArray(v.readDocumentSets) || v.readDocumentSets.length > 32) throw new ContractError("Invalid document-set preconditions");
    const sets = new Set<string>();
    for (const set of v.readDocumentSets) {
      if (!set || typeof set !== "object" || !["volume", "chapter", "scene"].includes(set.kind) ||
          (set.kind === "volume" ? set.parentId !== null : (typeof set.parentId !== "string" || !set.parentId)) ||
          !Array.isArray(set.documentIds) || set.documentIds.length > 1000 ||
          set.documentIds.some((id) => typeof id !== "string" || !id)) {
        throw new ContractError("Invalid document-set precondition");
      }
      const ids = [...set.documentIds].sort();
      if (new Set(ids).size !== ids.length) throw new ContractError("Duplicate document in document-set precondition");
      const key = JSON.stringify([set.kind, set.parentId]);
      if (sets.has(key)) throw new ContractError("Duplicate document-set precondition");
      sets.add(key);
    }
  }
  const seen = new Set<string>();
  let size = 0;
  for (const item of [...v.reads, ...v.writes]) {
    if (!item || typeof item !== "object") throw new ContractError("Invalid file precondition");
    assertProjectPath(item.path);
    if (item.revision !== null && (typeof item.revision !== "string" || !/^[a-f0-9]{64}$/.test(item.revision))) {
      throw new ContractError("Invalid file revision");
    }
  }
  for (const item of v.writes) {
    if (seen.has(item.path)) throw new ContractError("Duplicate write path");
    seen.add(item.path);
    if (item.content !== null && typeof item.content !== "string") throw new ContractError("Invalid recoverable content");
    if (item.encoding !== undefined && item.encoding !== "utf8" && item.encoding !== "base64") throw new ContractError("Invalid encoding");
    size += item.content?.length ?? 0;
    if (item.textChanges !== undefined) {
      if (v.effect !== "manuscript" || item.content === null || item.encoding === "base64" ||
          !Array.isArray(item.textChanges) || item.textChanges.length < 1 || item.textChanges.length > 256) {
        throw new ContractError("Invalid manuscript text changes");
      }
      let previousEnd = 0;
      for (const change of item.textChanges) {
        if (!change || typeof change !== "object" || !Number.isSafeInteger(change.fromUtf16) ||
            !Number.isSafeInteger(change.toUtf16) || change.fromUtf16 < previousEnd ||
            change.toUtf16 < change.fromUtf16 || typeof change.insert !== "string") {
          throw new ContractError("Invalid manuscript text change range");
        }
        previousEnd = change.toUtf16;
        size += change.insert.length;
      }
    }
    if (size > 8 * 1024 * 1024) throw new ContractError("Operation payload exceeds limit");
  }
}

/** A point-in-time copy of the active editor, including its actual persisted base. */
export interface BrowserEditorDocument {
  sceneId: string;
  documentPath: string;
  documentRevision: string | null;
  /** Combined scene/manuscript revision from the editor's persisted view. */
  sceneRevision: string;
  text: string;
  snapshot: SnapshotId;
  /** Remote baseline, kept distinct from a locally checkpointed editor view. */
  baseSnapshot: SnapshotId;
  /** Exact scene metadata file revision in that remote baseline. */
  baseSceneRevision: string | null;
}

/** Browser modules mount real domain UI into shared slots without author approval authority. */
export interface BrowserModuleContext {
  projectId: string;
  snapshot: SnapshotId;
  signal: AbortSignal;
  /** Read on demand so typing does not remount contributions or capture an obsolete draft. */
  readCurrentEditor?(): BrowserEditorDocument | null;
  invoke(actionId: string, input: unknown): Promise<ActionResult>;
  /** The shell journals the complete proposal before acknowledging it to the module UI. */
  propose(operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string): Promise<ChangeProposal>;
  /** Host-validated navigation within the bound project/snapshot. */
  navigateDocument?(path: string): Promise<void>;
  refresh(): Promise<void>;
}
export interface BrowserModuleDefinition {
  mount(contributionId: string, element: HTMLElement, context: BrowserModuleContext): Promise<() => void>;
  /** Public read-only source views receive no author or private-work capability. */
  mountPublic?(viewId: string, element: HTMLElement, request: Request): Promise<() => void>;
}

/** Private owner state for continuing a work on another device; never manuscript content. */
export type RecentActivityDeviceType = "desktop" | "mobile";
export interface RecentActivityInput {
  sceneId: string;
  /** Source-compatible 1-based UI sentence position, or null when unknown. */
  sentenceOffset: number | null;
  /** Omission preserves this device's previous reading page; null clears it. */
  pageIndex?: number | null;
  deviceType: RecentActivityDeviceType;
}
export interface RecentActivityItem extends RecentActivityInput {
  updatedAt: string;
}
export interface RecentActivityResponse {
  items: RecentActivityItem[];
}
