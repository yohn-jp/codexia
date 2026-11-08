import { ApiError } from "./api-error";
export { ApiError } from "./api-error";
import { responseContracts as dto, readApiResponse, decodeResponse, type ResponseGuard } from "./api-response";
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
  RestoreDocumentRevisionCommand,
  SaveAssertionCommand,
  SaveDocumentCommand,
  SaveEvidenceAnchorCommand,
  SaveKnowledgeAliasCommand,
  SaveKnowledgeNodeCommand,
  SaveKnowledgeRelationCommand,
  SaveMentionLinkCommand,
} from "@codexia/persistence-contracts";

export interface PersistenceDocumentRead {
  document: PersistenceDocument;
  revision: PersistenceRevision | null;
}

export interface PersistenceStatus {
  available: boolean;
  provider: "postgres" | null;
}

export interface PersistenceNodeRead {
  node: KnowledgeNode;
  aliases: KnowledgeAlias[];
  relations: KnowledgeRelation[];
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

export interface Session {
  authenticated: true;
  authorScope: string;
  permissions?: Array<"read" | "write" | "maintain" | "admin">;
}


export class DocumentDepartureError extends DOMException {
  constructor() { super("The document is leaving.", "AbortError"); }
}
let departing = false;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { departing = true; });
  window.addEventListener("pageshow", () => { departing = false; });
}
async function request<T>(guard: ResponseGuard<T>, path: string, init: RequestInit = {}): Promise<T> {
  if (departing) throw new DocumentDepartureError();
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  try {
    return await readApiResponse(await fetch(path, { ...init, headers, credentials: "same-origin" }), guard);
  } catch (error) {
    if (departing) throw new DocumentDepartureError();
    throw error;
  }
}
function persistencePath(projectId: string, suffix = ""): string {
  return `/api/v1/persistence/projects/${encodeURIComponent(projectId)}${suffix ? `/${suffix}` : ""}`;
}
export const api = {
  login: (token: string) => request(dto.loggedIn, "/api/login", { method: "POST", body: JSON.stringify({ token }) }),
  session: () => request(dto.session, "/api/session"),
  logout: () => request(dto.loggedOut, "/api/logout", { method: "POST" }),
  persistenceStatus: (signal?: AbortSignal) => request(dto.persistenceStatus, "/api/v1/persistence/status", { ...(signal ? { signal } : {}) }),
  persistenceProjects: (limit = 100, signal?: AbortSignal) => request(dto.persistenceProjects,
    `/api/v1/persistence/projects?${new URLSearchParams({ limit: String(limit) })}`, { ...(signal ? { signal } : {}) }),
  createPersistenceProject: (command: CreateProjectCommand, signal?: AbortSignal) => request(dto.persistenceProject, "/api/v1/persistence/projects", {
    method: "POST", body: JSON.stringify(command), ...(signal ? { signal } : {}),
  }),
  persistenceProject: (projectId: string, signal?: AbortSignal) => request(dto.persistenceProject, persistencePath(projectId), { ...(signal ? { signal } : {}) }),
  persistenceDocuments: (projectId: string, parentId?: string | null, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (parentId !== undefined) query.set("parentId", parentId ?? "root");
    const suffix = query.size ? `?${query}` : "";
    return request(dto.persistenceDocuments, persistencePath(projectId, `documents${suffix}`), { ...(signal ? { signal } : {}) });
  },
  persistenceNodes: (projectId: string, limit = 200, signal?: AbortSignal) => request(dto.persistenceNodes,
    persistencePath(projectId, `nodes?${new URLSearchParams({ limit: String(limit) })}`), { ...(signal ? { signal } : {}) }),
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
