import { ApiError } from "./api-error";
import { apiRequestUrl } from "./oauth";
export { ApiError } from "./api-error";
import { responseContracts as dto, readApiResponse, type ResponseGuard } from "./api-response";
import type {
  ActionResult,
  Approval,
  ChangeOperation,
  ApplyReceipt,
  ChangeProposal,
  ModuleStatus,
  ProposalStatus,
  RecentActivityInput,
  RecentActivityResponse,
  SnapshotId,
  UiContribution,
} from "@codexia/contracts";
import type {
  Assertion,
  AssertionEvidence,
  CreateDocumentCommand,
  CreateProjectCommand,
  Document as PersistenceDocument,
  DocumentRevision as PersistenceRevision,
  DocumentRevisionPage,
  DocumentWriteResult,
  EvidenceAnchor,
  KnowledgeAlias,
  KnowledgeNode,
  KnowledgeRelation,
  MentionLink,
  Project as PersistenceProject,
  ChangeSetApplicationResult,
  RestoreDocumentRevisionCommand,
  SaveAssertionCommand,
  SaveDocumentCommand,
  SaveEvidenceAnchorCommand,
  SaveKnowledgeAliasCommand,
  SaveKnowledgeNodeCommand,
  SaveKnowledgeRelationCommand,
  SaveMentionLinkCommand,
  ChangeSet,
} from "@codexia/persistence-contracts";

/** Portable current-state work, separate from operational PostgreSQL backups. */
export interface PortableWorkArchive {
  format: "codexia-work/v1";
  project: { title: string; settings: Record<string, unknown> };
  documents: Array<{ id: string; title: string; markdown: string }>;
  knowledge: { nodes: unknown[]; aliases: unknown[]; relations: unknown[] };
  evidence: { anchors: unknown[]; mentions: unknown[]; assertions: unknown[]; assertionEvidence: unknown[];
    unresolved: { anchors: unknown[]; mentions: unknown[]; assertionEvidence: unknown[] } };
  moduleRecords: unknown[];
  omittedRecords: string[];
}
export interface PortableWorkImportResult {
  project: PersistenceProject;
  replayed: boolean;
  unresolvedAnchors: number;
  omittedRecords: number;
}

/** Author review feed summary retaining each stored lifecycle's native receipt shape. */
export type AuthorReviewFeedItem =
  | {
      kind: "core-proposal";
      id: string;
      projectId: string;
      createdAt: string;
      state: ProposalStatus["state"];
      approvalModel: "per-operation";
      applicationModel: "per-operation";
      status: ProposalStatus;
      receipts: ApplyReceipt[];
      stale: boolean;
    }
  | {
      kind: "native-change-set";
      id: string;
      projectId: string;
      createdAt: string;
      state: ChangeSet["status"];
      approvalModel: "whole-change-set";
      applicationModel: "transaction";
      changeSet: ChangeSet;
      receipt: ChangeSetApplicationResult | null;
    };

export class DocumentDepartureError extends DOMException {
  constructor() {
    super("The document is leaving.", "AbortError");
  }
}

export type JobStatus = "queued" | "running" | "done" | "error";

export interface PublicJob {
  id: string;
  type: string;
  status: JobStatus;
  /** Progress is a source-compatible 0–1 hint; null means unavailable. */
  progress: number | null;
  result: unknown | null;
  error: string | null;
  errorCode?: string;
  retryable?: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type JobEvent = {
  type: "job-status" | "job-progress";
  jobId: string;
  jobType: string;
  status: JobStatus;
  progress: number | null;
  error?: string;
  at: string;
};

export interface InboxItem {
  id: string;
  kind: "job-complete";
  jobId: string;
  jobType: string;
  title: string;
  body: string;
  status: "done" | "error";
  read: boolean;
  userId: string | null;
  projectKey: string;
  createdAt: string;
}

export interface InboxListResponse {
  items: InboxItem[];
  unreadCount: number;
}

export interface Tree {
  title: string;
  volumes: Array<{
    id: string;
    title: string;
    chapters: Array<{
      id: string;
      title: string;
      scenes: Array<{ id: string; title: string }>;
    }>;
  }>;
}

export interface Scene {
  id: string;
  title: string;
  text: string;
  /** Legacy combined YAML + manuscript revision. File preconditions use SceneRead.document.revision. */
  revision: string;
}

export interface FileDocument {
  path: string;
  content: string;
  /** null distinguishes an absent file from an existing empty file. */
  revision: string | null;
}

export interface PersistenceDocumentRead {
  document: PersistenceDocument;
  revision: PersistenceRevision | null;
}

export interface PersistenceStatus {
  available: boolean;
  provider: "postgres" | null;
}

export interface PersistenceProjectPage {
  projects: PersistenceProject[];
  nextCursor: string | null;
}

export interface PersistenceNodeRead {
  node: KnowledgeNode;
  aliases: KnowledgeAlias[];
  relations: KnowledgeRelation[];
}

export interface PersistenceKnowledgePage {
  nodes: KnowledgeNode[];
  nextCursor: string | null;
  projectVersion: number;
}

export interface PersistenceAssertionRead {
  assertion: Assertion;
  evidence: AssertionEvidence[];
}

export interface PersistenceAssertionEvidenceRead {
  evidence: Array<{ link: AssertionEvidence; evidence: PersistenceAnchorView }>;
}

export interface PersistenceAnchorView {
  anchor: EvidenceAnchor;
  quote: string;
  mentions: Array<{ link: MentionLink; node: KnowledgeNode | null }>;
  assertions: Array<{ link: AssertionEvidence; assertion: Assertion | null }>;
}

export interface PersistenceDocumentAnchors {
  revisionId: string | null;
  anchors: PersistenceAnchorView[];
}

export interface SceneRead {
  snapshot: SnapshotId;
  scene: Scene;
  /** Full manuscript bytes decoded as UTF-8, including Markdown frontmatter. */
  document: FileDocument;
  /** Exact scene YAML, used only when the manuscript link needs to be added. */
  metadata: FileDocument;
}

export interface TreeRead {
  snapshot: SnapshotId;
  tree: Tree;
}

export interface EditorSnapshotRead {
  snapshot: SnapshotId;
  document: { path: string; revision: string } | null;
}

export interface Session {
  authenticated: true;
  authorScope: string;
}

export interface RuntimeVersion {
  name: string;
  version: string;
  profile: string;
}

let oauthAccessToken: string | undefined;
export interface NativeApiSession {
  apiOrigin: string | null;
  accessTokenFor(requestUrl: string): Promise<string | null>;
  fetchRequest(requestUrl: string, init: RequestInit): Promise<Response>;
}
let nativeApiSession: NativeApiSession | undefined;
const configuredApiOrigin = (import.meta as ImportMeta & { env?: { VITE_CODEXIA_API_ORIGIN?: string } }).env?.VITE_CODEXIA_API_ORIGIN;
let documentDeparting = false;
let documentLifecycle = 0;

function markDocumentDeparting(): void {
  if (documentDeparting) return;
  documentDeparting = true;
  documentLifecycle += 1;
}

function resumeDocument(): void {
  // pageshow also fires on the first load. Only a real departure invalidates
  // in-flight work and advances the lifecycle generation.
  if (!documentDeparting) return;
  documentDeparting = false;
  documentLifecycle += 1;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    // Wait until every beforeunload handler has had a chance to cancel the
    // departure before closing the browser API to new ordinary requests.
    queueMicrotask(() => {
      if (!event.defaultPrevented) markDocumentDeparting();
    });
  }, { capture: true });
  window.addEventListener("pagehide", markDocumentDeparting, { capture: true });
  window.addEventListener("pageshow", resumeDocument, { capture: true });
}

function assertDocumentCanStartRequest(init?: RequestInit): void {
  if (documentDeparting && init?.keepalive !== true) {
    throw new DocumentDepartureError();
  }
}

function hasLeftDocumentLifecycle(lifecycle: number): boolean {
  return documentDeparting || documentLifecycle !== lifecycle;
}

async function withDocumentDepartureClassification<T>(
  lifecycle: number,
  init: RequestInit,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    if (hasLeftDocumentLifecycle(lifecycle) && init.keepalive !== true) throw new DocumentDepartureError();
    return result;
  } catch (error) {
    if (hasLeftDocumentLifecycle(lifecycle) && init.keepalive !== true) throw new DocumentDepartureError();
    throw error;
  }
}

async function fetchApiRequest(path: string, init: RequestInit): Promise<Response> {
  assertDocumentCanStartRequest(init);
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (nativeApiSession) {
    const configuredOrigin = nativeApiSession.apiOrigin;
    if (!configuredOrigin) throw new ApiError("Native API origin is not configured.", 503, "NATIVE_API_ORIGIN_MISSING");
    const originUrl = new URL(configuredOrigin);
    if (originUrl.protocol !== "https:" || originUrl.pathname !== "/" || originUrl.search || originUrl.hash || originUrl.username || originUrl.password) {
      throw new ApiError("Native API origin is invalid.", 503, "NATIVE_API_ORIGIN_INVALID");
    }
    const resolved = apiRequestUrl(path, originUrl.origin);
    const requestUrl = new URL(resolved, originUrl.origin);
    if (requestUrl.origin !== originUrl.origin || !requestUrl.pathname.startsWith("/api/")) {
      throw new ApiError("Native API request escaped its configured origin.", 503, "NATIVE_API_ORIGIN_MISMATCH");
    }
    const accessToken = await nativeApiSession.accessTokenFor(requestUrl.toString());
    if (accessToken !== null && (typeof accessToken !== "string" || !accessToken)) {
      throw new ApiError("Native authentication returned an invalid API token.", 503, "NATIVE_API_TOKEN_INVALID");
    }
    headers.delete("Authorization");
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return nativeApiSession.fetchRequest(requestUrl.toString(), {
      ...init,
      headers,
      credentials: "omit",
    });
  }
  if (oauthAccessToken) headers.set("Authorization", `Bearer ${oauthAccessToken}`);
  return fetch(apiRequestUrl(path, configuredApiOrigin), {
    ...init,
    headers,
    // A bearer request never carries ambient cookies, avoiding dual
    // cookie/bearer credentials when the API has moved to its own origin.
    credentials: oauthAccessToken ? "omit" : "same-origin",
  });
}

/** Store an API access token only in the current JavaScript runtime. */
export function setOAuthAccessToken(token: string | null): void {
  oauthAccessToken = token ?? undefined;
}

/** Install an explicit native HTTPS API transport; never use WebView cookies for API data. */
export function configureNativeApiSession(session: NativeApiSession): void {
  if (!session || typeof session.accessTokenFor !== "function" || typeof session.fetchRequest !== "function") {
    throw new TypeError("Native API session transport is invalid.");
  }
  if (session.apiOrigin !== null) {
    const origin = new URL(session.apiOrigin);
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
      throw new TypeError("Native API origin must be an explicit HTTPS origin.");
    }
    apiRequestUrl("/api/session", origin.origin);
  }
  oauthAccessToken = undefined;
  nativeApiSession = session;
}

/** Return API request routing to the normal browser configuration. */
export function clearNativeApiSession(): void {
  nativeApiSession = undefined;
  oauthAccessToken = undefined;
}

function fetchApiResponse(path: string, init: RequestInit, lifecycle: number): Promise<Response> {
  return withDocumentDepartureClassification(lifecycle, init, () => fetchApiRequest(path, init));
}

async function request<T>(guard: ResponseGuard<T>, path: string, init: RequestInit = {}): Promise<T> {
  const lifecycle = documentLifecycle;
  return withDocumentDepartureClassification(lifecycle, init, async () => {
    return readApiResponse(await fetchApiResponse(path, init, lifecycle), guard);
  });
}

async function requestEventStream(path: string, signal: AbortSignal): Promise<Response> {
  if (nativeApiSession) {
    throw new ApiError("Native job event streaming is unavailable; use the Job Inbox refresh action.", 501, "NATIVE_STREAM_UNSUPPORTED");
  }
  const init = { headers: { Accept: "text/event-stream" }, signal };
  const lifecycle = documentLifecycle;
  return withDocumentDepartureClassification(lifecycle, init, async () => {
    const response = await fetchApiResponse(path, init, lifecycle);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const details = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      throw new ApiError(
        typeof details.error === "string" ? details.error : `Request failed (${response.status})`,
        response.status,
        typeof details.code === "string" ? details.code : "REQUEST_FAILED",
      );
    }
    if (!response.body) throw new ApiError("Job event stream is unavailable", response.status, "STREAM_UNAVAILABLE");
    return response;
  });
}

function projectPath(projectId: string, suffix: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/${suffix}`;
}

function persistencePath(projectId: string, suffix = ""): string {
  const root = `/api/v1/persistence/projects/${encodeURIComponent(projectId)}`;
  return suffix ? `${root}/${suffix}` : root;
}

function requestRuntimeVersion(): Promise<RuntimeVersion> {
  return request(dto.version, nativeApiSession ? "/api/version" : "/api/browser/version");
}

/** The browser talks only to the public HTTP adapter and the shared contracts. */
export const api = {
  version: requestRuntimeVersion,
  session: () => request(dto.session, "/api/session"),
  jobs: (signal?: AbortSignal) => request(dto.jobs, "/api/jobs", { ...(signal ? { signal } : {}) }),
  job: (jobId: string, signal?: AbortSignal) =>
    request(dto.job, `/api/jobs/${encodeURIComponent(jobId)}`, { ...(signal ? { signal } : {}) }),
  inbox: (unreadOnly = false, signal?: AbortSignal) => {
    const query = unreadOnly ? "?unread=1" : "";
    return request(dto.inbox, `/api/inbox${query}`, { ...(signal ? { signal } : {}) });
  },
  markInboxRead: async (id: string, signal?: AbortSignal) => {
    const response = await request(dto.inboxItem, `/api/inbox/${encodeURIComponent(id)}/read`, {
      method: "POST",
      ...(signal ? { signal } : {}),
    });
    return response.item;
  },
  markAllInboxRead: (signal?: AbortSignal) =>
    request(dto.marked, "/api/inbox/read-all", { method: "POST", ...(signal ? { signal } : {}) }),
  jobEventStream: (signal: AbortSignal) => requestEventStream("/api/jobs/events", signal),
  recentActivity: (projectId: string, signal?: AbortSignal) =>
    request(dto.recentActivity, projectPath(projectId, "recent-activity"), { ...(signal ? { signal } : {}) }),
  putRecentActivity: (projectId: string, input: RecentActivityInput, options: { signal?: AbortSignal; keepalive?: boolean; order?: string } = {}) => {
    const { order, ...init } = options;
    return request(dto.recentActivity, projectPath(projectId, "recent-activity"), {
      method: "PUT",
      body: JSON.stringify(input),
      ...(order ? { headers: { "X-Codexia-Recent-Activity-Order": order } } : {}),
      ...init,
    });
  },
  proposalStatuses: (projectId: string) => request(dto.proposals, projectPath(projectId, "proposals")),
  propose: (projectId: string, proposal: ChangeProposal, signal?: AbortSignal) => request(dto.proposal, projectPath(projectId, "proposals"), {
    method: "POST",
    body: JSON.stringify(proposal),
    ...(signal ? { ...(signal ? { signal } : {}) } : {}),
  }),
  approve: (projectId: string, approval: Approval, signal?: AbortSignal) => request(dto.empty, projectPath(projectId, "approvals"), {
    method: "POST",
    body: JSON.stringify(approval),
    ...(signal ? { signal } : {}),
  }),
  apply: (projectId: string, operation: ChangeOperation, signal?: AbortSignal) => request(dto.apply, projectPath(projectId, "apply"), {
    method: "POST", body: JSON.stringify(operation), ...(signal ? { signal } : {}),
  }),
  moduleSnapshot: async (projectId: string, documentId?: string): Promise<EditorSnapshotRead> => {
    const query = new URLSearchParams({ projection: "editor" });
    if (documentId) query.set("documentId", documentId);
    const result = await request(dto.moduleSnapshot, `${projectPath(projectId, "snapshot")}?${query}`);
    const path = documentId ? `documents/${documentId}.md` : undefined;
    if (result.document && result.document.path !== path) {
      throw new ApiError("The server returned a different editor document", 502, "INVALID_RESPONSE");
    }
    return result;
  },
  modules: (projectId: string) => request(dto.modules, projectPath(projectId, "modules")),
  contributions: (projectId: string) => request(dto.contributions, projectPath(projectId, "contributions")),
  action: (projectId: string, actionId: string, input: unknown, signal?: AbortSignal, snapshot?: SnapshotId) => request(dto.action,
    projectPath(projectId, `actions/${encodeURIComponent(actionId)}`),
    { method: "POST", body: JSON.stringify({ input, ...(snapshot ? { snapshot } : {}) }), ...(signal ? { signal } : {}) },
  ),
  resolveDocumentReference: async (projectId: string, path: string, snapshot?: SnapshotId): Promise<string | null> => {
    const resolution = await api.action(projectId, "core.document.resolve", { path }, undefined, snapshot);
    if (!resolution.ok) throw new Error(resolution.error.message);
    const { data } = resolution;
    if (resolution.snapshot.projectId !== projectId ||
        (snapshot && resolution.snapshot.projectVersion !== snapshot.projectVersion) ||
        !data || typeof data !== "object" || !("documentId" in data) ||
        (data.documentId !== null && (typeof data.documentId !== "string" || !data.documentId.trim()))) {
      throw new ApiError("The server returned an invalid document reference", 502, "INVALID_RESPONSE");
    }
    return data.documentId;
  },
  persistenceStatus: (signal?: AbortSignal) => request(dto.persistenceStatus, "/api/v1/persistence/status", { ...(signal ? { signal } : {}) }),
  exportWorkArchive: (projectId: string, signal?: AbortSignal) => request(dto.portableWorkArchive,
    persistencePath(projectId, "archive"), { ...(signal ? { signal } : {}) }),
  importWorkArchive: (archive: unknown, signal?: AbortSignal) => request(dto.portableWorkImport,
    "/api/v1/persistence/import", { method: "POST", body: JSON.stringify(archive), ...(signal ? { signal } : {}) }),
  persistenceProjectPage: (limit = 200, cursor?: string, signal?: AbortSignal): Promise<PersistenceProjectPage> => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) query.set("cursor", cursor);
    return request(dto.persistenceProjectPage, `/api/v1/persistence/projects?${query}`, { ...(signal ? { signal } : {}) });
  },
  createPersistenceProject: (command: CreateProjectCommand, signal?: AbortSignal) => request(dto.persistenceProject, "/api/v1/persistence/projects", {
    method: "POST", body: JSON.stringify(command), ...(signal ? { signal } : {}),
  }),
  persistenceProject: (projectId: string, signal?: AbortSignal) => request(dto.persistenceProject, persistencePath(projectId), { ...(signal ? { signal } : {}) }),
  nativeChangeSets: (projectId: string, limit = 50, signal?: AbortSignal) => request(dto.nativeChangeSets,
    persistencePath(projectId, `changesets?${new URLSearchParams({ limit: String(limit) })}`), { ...(signal ? { signal } : {}) }),
  authorReviewFeed: (projectId: string, limit = 50, signal?: AbortSignal) => request(dto.authorReviewFeed,
    persistencePath(projectId, `review-feed?${new URLSearchParams({ limit: String(limit) })}`), { ...(signal ? { signal } : {}) }),
  nativeChangeSet: (projectId: string, changeSetId: string, signal?: AbortSignal) => request(dto.nativeChangeSet,
    persistencePath(projectId, `changesets/${encodeURIComponent(changeSetId)}`), { ...(signal ? { signal } : {}) }),
  approveNativeChangeSet: (projectId: string, changeSetId: string, expectedVersion: number, signal?: AbortSignal) => request(dto.nativeChangeSetEnvelope,
    persistencePath(projectId, `changesets/${encodeURIComponent(changeSetId)}/approve`), { method: "POST", body: JSON.stringify({ expectedVersion }), ...(signal ? { signal } : {}) }),
  rejectNativeChangeSet: (projectId: string, changeSetId: string, expectedVersion: number, signal?: AbortSignal) => request(dto.nativeChangeSetEnvelope,
    persistencePath(projectId, `changesets/${encodeURIComponent(changeSetId)}/reject`), { method: "POST", body: JSON.stringify({ expectedVersion }), ...(signal ? { signal } : {}) }),
  applyNativeChangeSet: (projectId: string, changeSetId: string, expectedVersion: number, signal?: AbortSignal) => request(dto.nativeChangeSetApplication,
    persistencePath(projectId, `changesets/${encodeURIComponent(changeSetId)}/apply`), { method: "POST", body: JSON.stringify({ expectedVersion }), ...(signal ? { signal } : {}) }),
  persistenceDocuments: async (projectId: string, parentId?: string | null, signal?: AbortSignal) => {
    const query = new URLSearchParams({limit:"1000"});
    if (parentId !== undefined) query.set("parentId", parentId ?? "root");
    const result = await request(dto.persistenceDocuments, persistencePath(projectId, `documents?${query}`), { ...(signal ? { signal } : {}) });
    if (result.documents.length >= 1000) throw new ApiError("作品の構成が取得上限に達しています。完全な目次を表示できません。",413,"SNAPSHOT_TOO_LARGE");
    return result;
  },
  persistenceKnowledgePage: (projectId: string, filters: { q: string; type: string; status: string; cursor?: string }, signal?: AbortSignal): Promise<PersistenceKnowledgePage> => {
    const query = new URLSearchParams({ limit: "50", q: filters.q, type: filters.type, status: filters.status });
    if (filters.cursor) query.set("cursor", filters.cursor);
    return request(dto.persistenceKnowledgePage, persistencePath(projectId, `nodes?${query}`), { ...(signal ? { signal } : {}) });
  },
  updatePersistenceDocument: (projectId: string, documentId: string, command: { expectedVersion: number; title?: string; parentId?: string | null; orderKey?: string }) => request(dto.persistenceDocumentEnvelope, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}/metadata`), { method: "PATCH", body: JSON.stringify(command) }),
  deletePersistenceDocument: (projectId: string, documentId: string, expectedVersion: number) => request(dto.persistenceDocumentEnvelope, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}`), { method: "DELETE", body: JSON.stringify({ expectedVersion }) }),
  createPersistenceDocument: (
    projectId: string,
    command: Omit<CreateDocumentCommand, "projectId" | "authorId">,
    signal?: AbortSignal,
  ) => request(dto.persistenceWrite, persistencePath(projectId, "documents"), {
    method: "POST",
    headers: { "Idempotency-Key": command.idempotencyKey },
    body: JSON.stringify(command),
    ...(signal ? { signal } : {}),
  }),
  persistenceDocument: (projectId: string, documentId: string, signal?: AbortSignal, revisionId?: string) => {
    const query = revisionId ? `?${new URLSearchParams({ revision: revisionId })}` : "";
    return request(dto.persistenceDocument, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}${query}`), { ...(signal ? { signal } : {}) });
  },
  savePersistenceDocument: (
    projectId: string,
    documentId: string,
    command: Omit<SaveDocumentCommand, "projectId" | "documentId" | "authorId">,
    signal?: AbortSignal,
  ) => {
    const { idempotencyKey, clientId, ...body } = command;
    return request(dto.persistenceWrite, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}`), {
      method: "PATCH",
      headers: { "Idempotency-Key": idempotencyKey, "X-Client-Id": clientId },
      body: JSON.stringify({ ...body, clientId }),
      ...(signal ? { signal } : {}),
    });
  },
  persistenceRevisions: (projectId: string, documentId: string, limit = 50, before?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set("before", before);
    return request(dto.persistenceRevisionPage, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}/revisions?${query}`), { ...(signal ? { signal } : {}) });
  },
  restorePersistenceDocument: (
    projectId: string,
    documentId: string,
    command: Omit<RestoreDocumentRevisionCommand, "projectId" | "documentId" | "authorId">,
    signal?: AbortSignal,
  ) => request(dto.persistenceWrite, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}/restore`), {
    method: "POST", headers: { "Idempotency-Key": command.idempotencyKey }, body: JSON.stringify(command), ...(signal ? { signal } : {}),
  }),
  persistenceDocumentAnchors: (projectId: string, documentId: string, revisionId?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (revisionId) query.set("revision", revisionId);
    if (signal) query.set("limit", "500");
    const suffix = `documents/${encodeURIComponent(documentId)}/anchors${query.size ? `?${query}` : ""}`;
    return request(dto.persistenceAnchors, persistencePath(projectId, suffix), { ...(signal ? { signal } : {}) });
  },
  createPersistenceAnchor: (
    projectId: string,
    documentId: string,
    input: Pick<SaveEvidenceAnchorCommand, "id" | "revisionId" | "fromUtf16" | "toUtf16"> & { status: "proposed" | "confirmed"; nodeId?: string },
    signal?: AbortSignal,
  ) => request(dto.persistenceAnchorCreated, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}/anchors`), {
    method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
  }),
  updatePersistenceAnchor: (
    projectId: string,
    documentId: string,
    evidenceId: string,
    input: Pick<SaveEvidenceAnchorCommand, "revisionId" | "fromUtf16" | "toUtf16" | "status" | "expectedVersion">,
    signal?: AbortSignal,
  ) => request(dto.persistenceAnchor, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}/anchors/${encodeURIComponent(evidenceId)}`), {
    method: "PATCH", body: JSON.stringify(input), ...(signal ? { signal } : {}),
  }),
  savePersistenceMention: (
    projectId: string,
    documentId: string,
    evidenceId: string,
    input: Pick<SaveMentionLinkCommand, "nodeId" | "status">,
    signal?: AbortSignal,
  ) => request(dto.persistenceMention, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}/anchors/${encodeURIComponent(evidenceId)}/mentions`), {
    method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
  }),
  persistenceNode: (projectId: string, nodeId: string, signal?: AbortSignal) =>
    request(dto.persistenceNode, persistencePath(projectId, `nodes/${encodeURIComponent(nodeId)}`), { ...(signal ? { signal } : {}) }),
  savePersistenceNode: (projectId: string, nodeId: string, command: Omit<SaveKnowledgeNodeCommand, "projectId" | "id">, signal?: AbortSignal) =>
    request(dto.persistenceNodeEnvelope, persistencePath(projectId, `nodes/${encodeURIComponent(nodeId)}`), {
      method: "PUT", body: JSON.stringify(command), ...(signal ? { signal } : {}),
    }),
  previewPersistenceMerge: (projectId:string,nodeId:string,targetId:string) =>
    request(dto.persistenceMergePreview,persistencePath(projectId,`nodes/${encodeURIComponent(nodeId)}/merge-preview`),{method:"POST",body:JSON.stringify({targetId})}),
  applyPersistenceMerge: (projectId:string,nodeId:string,targetId:string,projectVersion:number,previewDigest:string) =>
    request(dto.persistenceMergeResult,persistencePath(projectId,`nodes/${encodeURIComponent(nodeId)}/merge`),{method:"POST",body:JSON.stringify({targetId,projectVersion,previewDigest,confirm:true})}),
  savePersistenceAlias: (projectId: string, nodeId: string, command: Omit<SaveKnowledgeAliasCommand, "projectId" | "nodeId">, signal?: AbortSignal) =>
    request(dto.persistenceAliasEnvelope, persistencePath(projectId, `nodes/${encodeURIComponent(nodeId)}/aliases`), {
      method: "POST", body: JSON.stringify(command), ...(signal ? { signal } : {}),
    }),
  savePersistenceRelation: (projectId: string, nodeId: string, command: Omit<SaveKnowledgeRelationCommand, "projectId" | "sourceId">, signal?: AbortSignal) =>
    request(dto.persistenceRelationEnvelope, persistencePath(projectId, `nodes/${encodeURIComponent(nodeId)}/relations`), {
      method: "POST", body: JSON.stringify(command), ...(signal ? { signal } : {}),
    }),
  persistenceNodeEvidence: (projectId: string, nodeId: string, limit = 200, signal?: AbortSignal) =>
    request(dto.persistenceNodeEvidence, persistencePath(projectId,
      `nodes/${encodeURIComponent(nodeId)}/evidence?${new URLSearchParams({ limit: String(limit) })}`), { ...(signal ? { signal } : {}) }),
  createPersistenceAnchorAssertion: (projectId: string, documentId: string, evidenceId: string, command: {
    id: string; nodeId: string; statement: string; modality: "fact" | "belief" | "disclosure" | "hypothesis";
    perspective: string; revisionId: string; expectedAnchorVersion: number;
  }, signal?: AbortSignal) =>
    request(dto.persistenceAssertionEnvelope, persistencePath(projectId, `documents/${encodeURIComponent(documentId)}/anchors/${encodeURIComponent(evidenceId)}/assertions`), {
      method: "POST", body: JSON.stringify(command), ...(signal ? { signal } : {}),
    }),
  persistenceAssertion: (projectId: string, assertionId: string, signal?: AbortSignal) =>
    request(dto.persistenceAssertion, persistencePath(projectId, `assertions/${encodeURIComponent(assertionId)}`), { ...(signal ? { signal } : {}) }),
  savePersistenceAssertion: (projectId: string, assertionId: string, command: Omit<SaveAssertionCommand, "projectId" | "id">, signal?: AbortSignal) =>
    request(dto.persistenceAssertionEnvelope, persistencePath(projectId, `assertions/${encodeURIComponent(assertionId)}`), {
      method: "PUT", body: JSON.stringify(command), ...(signal ? { signal } : {}),
    }),
  persistenceAssertionEvidence: (projectId: string, assertionId: string, signal?: AbortSignal) =>
    request(dto.persistenceAssertionEvidenceList, persistencePath(projectId, `assertions/${encodeURIComponent(assertionId)}/evidence`), { ...(signal ? { signal } : {}) }),
  linkPersistenceAssertionEvidence: (projectId: string, assertionId: string, command: Pick<AssertionEvidence, "evidenceId" | "role">, signal?: AbortSignal) =>
    request(dto.persistenceAssertionEvidenceEnvelope, persistencePath(projectId, `assertions/${encodeURIComponent(assertionId)}/evidence`), {
      method: "POST", body: JSON.stringify(command), ...(signal ? { signal } : {}),
    }),
};

