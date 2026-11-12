import { createHash, randomUUID } from "node:crypto";
import {
  PersistenceError,
  type AssertionId,
  type DocumentId,
  type EvidenceId,
  type KnowledgeNodeId,
  type Persistence,
  type PersistenceReader,
  type JsonObject,
  type ProjectId,
  type RevisionId,
} from "@codexia/persistence-contracts";
import { WorkArchiveError, exportWorkArchive, importWorkArchive } from "./work-archive.js";

export interface PersistenceRouteInput {
  persistence?: Persistence;
  /** Hosted instances may access only the project assigned to that runtime. */
  assignedProjectId?: string;
  method: string;
  url: string;
  body: unknown;
  requestHeaders: import("node:http").IncomingHttpHeaders;
  /** Resolve an authenticated human author and enforce the existing write policy. */
  requireAuthor: () => Promise<string>;
}

export interface PersistenceRouteResponse {
  status: number;
  body: unknown;
}

class RouteFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function failure(status: number, code: string, message: string): never {
  throw new RouteFailure(status, code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) failure(400, "INVALID_BODY", "Request body must be a JSON object");
  return value;
}

function requiredString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    failure(400, "INVALID_BODY", `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum = 512): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maximum);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) failure(400, "INVALID_BODY", `${label} must be an integer`);
  return value as number;
}

function requestLimit(value: string | null, defaultValue: number, maximum: number): number {
  if (value === null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) failure(400, "INVALID_QUERY", `limit must be between 1 and ${maximum}`);
  return parsed;
}

function decoded(value: string, label: string): string {
  try { return decodeURIComponent(value); }
  catch { return failure(400, "INVALID_ID", `${label} is invalid`); }
}

function idempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  return requiredString(key, "Idempotency-Key", 200);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorResponse(error: unknown): PersistenceRouteResponse {
  if (error instanceof WorkArchiveError) return { status: error.status, body: { error: error.message, code: error.code } };
  if (error instanceof RouteFailure) return { status: error.status, body: { error: error.message, code: error.code } };
  if (error instanceof PersistenceError) {
    const status = error.code === "not_found" ? 404
      : error.code === "validation" ? 400
        : 409;
    const code = error.code === "not_found" ? "PERSISTENCE_NOT_FOUND"
      : error.code === "validation" ? "PERSISTENCE_VALIDATION"
        : error.code === "idempotency_conflict" ? "IDEMPOTENCY_CONFLICT"
          : "PERSISTENCE_CONFLICT";
    return { status, body: { error: error.message, code, ...(error.details ? { details: error.details } : {}) } };
  }
  throw error;
}

async function anchorView(reader: PersistenceReader, projectId: ProjectId, evidenceId: EvidenceId): Promise<unknown | undefined> {
  const anchor = await reader.getEvidenceAnchor(projectId, evidenceId);
  if (!anchor) return undefined;
  const links = await reader.listMentionLinks(projectId, evidenceId);
  const mentions = await Promise.all(links.map(async (link) => ({ link, node: await reader.getKnowledgeNode(projectId, link.nodeId) ?? null })));
  const assertionLinks = await reader.listEvidenceAssertions(projectId, evidenceId);
  const assertions = await Promise.all(assertionLinks.map(async (link) => ({ link, assertion: await reader.getAssertion(projectId, link.assertionId) ?? null })));
  let quote = "";
  if (anchor.toUtf16 > anchor.fromUtf16) {
    const revision = await reader.getRevision(projectId, anchor.documentId, anchor.revisionId);
    quote = revision?.markdown.slice(anchor.fromUtf16, anchor.toUtf16) ?? "";
  } else {
    const history = await reader.listEvidenceHistory(projectId, evidenceId);
    for (const item of [...history].reverse()) {
      if (item.toUtf16 <= item.fromUtf16) continue;
      const revision = await reader.getRevision(projectId, anchor.documentId, item.revisionId);
      if (revision) {
        quote = revision.markdown.slice(item.fromUtf16, item.toUtf16);
        break;
      }
    }
  }
  return { anchor, quote, mentions, assertions };
}

function allowedStatus<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) failure(400, "INVALID_BODY", `${label} is invalid`);
  return value as T;
}

/** Dispatch the authenticated, versioned PostgreSQL persistence surface. */
export async function handlePersistenceRoute(input: PersistenceRouteInput): Promise<PersistenceRouteResponse | null> {
  const url = new URL(input.url, "http://codexia.invalid");
  if (!url.pathname.startsWith("/api/v1/persistence/")) return null;
  if (input.method === "GET" && url.pathname === "/api/v1/persistence/status") {
    if (input.persistence?.checkHealth) {
      try {
        await input.persistence.checkHealth();
      } catch {
        return { status: 503, body: { error: "PostgreSQL persistence is not ready", code: "PERSISTENCE_UNAVAILABLE" } };
      }
    }
    return { status: 200, body: { available: Boolean(input.persistence), provider: input.persistence ? "postgres" : null } };
  }
  if (!input.persistence) return { status: 503, body: { error: "PostgreSQL persistence is not configured", code: "PERSISTENCE_UNAVAILABLE" } };

  const persistence = input.persistence;
  try {
    if (url.pathname === "/api/v1/persistence/import") {
      if (input.method !== "POST") return { status: 405, body: { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" } };
      if (input.assignedProjectId) failure(403, "ASSIGNED_PROJECT_ONLY", "Hosted runtimes cannot import new projects");
      const authorId = await input.requireAuthor();
      return { status: 201, body: await importWorkArchive(persistence, input.body, authorId) };
    }
    if (url.pathname === "/api/v1/persistence/projects") {
      if (input.method === "GET") {
        const limit = requestLimit(url.searchParams.get("limit"), 100, 200);
        if (input.assignedProjectId) {
          const project = await persistence.read((reader) => reader.getProject(input.assignedProjectId! as ProjectId));
          return { status: 200, body: project ? [project] : [] };
        }
        return { status: 200, body: await persistence.read((reader) => reader.listProjects(limit)) };
      }
      if (input.method === "POST") {
        if (input.assignedProjectId) failure(403, "ASSIGNED_PROJECT_ONLY", "Hosted runtimes cannot create projects");
        await input.requireAuthor();
        const body = bodyRecord(input.body);
        const title = requiredString(body.title, "title", 256);
        if (body.settings !== undefined && !isRecord(body.settings)) failure(400, "INVALID_BODY", "settings must be a JSON object");
        const project = await persistence.transaction((transaction) => transaction.createProject({
          ...(typeof body.id === "string" ? { id: body.id as ProjectId } : {}),
          title,
          settings: (body.settings ?? {}) as JsonObject,
        }));
        return { status: 201, body: { project } };
      }
      return { status: 405, body: { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" } };
    }

    const projectPath = url.pathname.match(/^\/api\/v1\/persistence\/projects\/([^/]+)(?:\/(.*))?$/u);
    if (!projectPath) return { status: 404, body: { error: "Persistence route not found", code: "NOT_FOUND" } };
    const projectId = decoded(projectPath[1]!, "Project id") as ProjectId;
    if (input.assignedProjectId && projectId !== input.assignedProjectId) {
      return { status: 404, body: { error: "Project was not found", code: "PERSISTENCE_NOT_FOUND" } };
    }
    const suffix = projectPath[2] ?? "";
    if (suffix === "archive" && input.method === "GET") {
      return { status: 200, body: await exportWorkArchive(persistence, projectId) };
    }
    if (!suffix) {
      if (input.method === "PATCH") {
        await input.requireAuthor();
        const body = bodyRecord(input.body);
        const project = await persistence.transaction((transaction) => transaction.updateProject({
          projectId, expectedVersion: integer(body.expectedVersion, "expectedVersion", 1),
          ...(body.title === undefined ? {} : { title: requiredString(body.title, "title", 256) }),
          ...(body.settings === undefined ? {} : { settings: (isRecord(body.settings) ? body.settings : failure(400, "INVALID_BODY", "settings must be an object")) as JsonObject }),
        }));
        return { status: 200, body: { project } };
      }
      if (input.method !== "GET") return { status: 405, body: { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" } };
      const project = await persistence.read((reader) => reader.getProject(projectId));
      return project ? { status: 200, body: { project } } : { status: 404, body: { error: "Project was not found", code: "PERSISTENCE_NOT_FOUND" } };
    }

    if (suffix === "documents") {
      if (input.method === "GET") {
        const parentValue = url.searchParams.get("parentId");
        const parentId = parentValue === null ? undefined : parentValue === "root" ? null : decoded(parentValue, "Parent document id") as DocumentId;
        const limit = requestLimit(url.searchParams.get("limit"), 500, 1000);
        const documents = await persistence.read((reader) => reader.listDocuments(projectId, parentId, limit));
        return { status: 200, body: { documents } };
      }
      if (input.method !== "POST") return { status: 405, body: { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" } };
      const authorId = await input.requireAuthor();
      const body = bodyRecord(input.body);
      const result = await persistence.transaction((transaction) => transaction.createDocument({
        projectId,
        ...(typeof body.documentId === "string" ? { documentId: body.documentId as DocumentId } : {}),
        ...(body.parentId === null ? { parentId: null } : typeof body.parentId === "string" ? { parentId: body.parentId as DocumentId } : {}),
        kind: requiredString(body.kind, "kind", 64),
        title: requiredString(body.title, "title", 256),
        orderKey: typeof body.orderKey === "string" ? body.orderKey : "0000",
        markdown: typeof body.markdown === "string" ? body.markdown : failure(400, "INVALID_BODY", "markdown must be a string"),
        authorId,
        idempotencyKey: idempotencyKey(input.requestHeaders?.["idempotency-key"]),
      }));
      return { status: 201, body: result };
    }

    if (suffix === "nodes" && input.method === "GET") {
      const limit = requestLimit(url.searchParams.get("limit"), 100, 500);
      const nodes = await persistence.read((reader) => reader.listKnowledgeNodes(projectId, limit));
      return { status: 200, body: { nodes } };
    }

    const documentPath = suffix.match(/^documents\/([^/]+)(?:\/(.*))?$/u);
    if (documentPath) {
      const documentId = decoded(documentPath[1]!, "Document id") as DocumentId;
      const documentSuffix = documentPath[2] ?? "";
      if (documentSuffix === "metadata" && input.method === "PATCH") {
        await input.requireAuthor();
        const body = bodyRecord(input.body);
        const document = await persistence.transaction((transaction) => transaction.updateDocument({
          projectId, documentId, expectedVersion: integer(body.expectedVersion, "expectedVersion", 1),
          ...(body.title === undefined ? {} : { title: requiredString(body.title, "title", 256) }),
          ...(body.orderKey === undefined ? {} : { orderKey: requiredString(body.orderKey, "orderKey", 256) }),
          ...(body.parentId === undefined ? {} : { parentId: body.parentId === null ? null : requiredString(body.parentId, "parentId") as DocumentId }),
        }));
        return { status: 200, body: { document } };
      }
      if (!documentSuffix && input.method === "DELETE") {
        await input.requireAuthor();
        const body = bodyRecord(input.body);
        const document = await persistence.transaction((transaction) => transaction.deleteDocument({
          projectId, documentId, expectedVersion: integer(body.expectedVersion, "expectedVersion", 1),
        }));
        return { status: 200, body: { document } };
      }
      if (!documentSuffix && input.method === "GET") {
        const selectedRevisionId = url.searchParams.get("revision");
        const value = await persistence.read(async (reader) => {
          const document = await reader.getDocument(projectId, documentId);
          if (!document) return undefined;
          const revisionId = selectedRevisionId ? decoded(selectedRevisionId, "Revision id") as RevisionId : document.headRevisionId;
          const revision = revisionId ? await reader.getRevision(projectId, documentId, revisionId) : undefined;
          if (revisionId && !revision) return undefined;
          return { document, revision: revision ?? null };
        });
        return value ? { status: 200, body: value } : { status: 404, body: { error: "Document was not found", code: "PERSISTENCE_NOT_FOUND" } };
      }
      if (!documentSuffix && input.method === "PATCH") {
        const authorId = await input.requireAuthor();
        const body = bodyRecord(input.body);
        if (!Array.isArray(body.changes)) failure(400, "INVALID_BODY", "changes must be an array");
        const changes = body.changes.map((value) => {
          if (!isRecord(value) || typeof value.insert !== "string") failure(400, "INVALID_BODY", "Each change must contain an insert string");
          return {
            fromUtf16: integer(value.fromUtf16, "fromUtf16"),
            toUtf16: integer(value.toUtf16, "toUtf16"),
            insert: value.insert,
          };
        });
        try {
          const result = await persistence.transaction((transaction) => transaction.saveDocument({
            projectId,
            documentId,
            baseRevisionId: requiredString(body.baseRevisionId, "baseRevisionId") as RevisionId,
            changes,
            resultingSha256: requiredString(body.resultingSha256, "resultingSha256", 64),
            authorId,
            clientId: requiredString(input.requestHeaders?.["x-client-id"] ?? body.clientId, "clientId", 128),
            idempotencyKey: idempotencyKey(input.requestHeaders?.["idempotency-key"]),
          }));
          return { status: 200, body: result };
        } catch (error) {
          if (error instanceof PersistenceError && error.code === "conflict") {
            const current = await persistence.read(async (reader) => {
              const document = await reader.getDocument(projectId, documentId);
              if (!document) return null;
              const revision = document.headRevisionId ? await reader.getRevision(projectId, documentId, document.headRevisionId) : undefined;
              return { document, revision: revision ?? null };
            });
            return { status: 409, body: { error: error.message, code: "PERSISTENCE_CONFLICT", details: error.details, current } };
          }
          throw error;
        }
      }
      if (documentSuffix === "revisions" && input.method === "GET") {
        const limit = requestLimit(url.searchParams.get("limit"), 50, 200);
        const before = url.searchParams.get("before") ?? undefined;
        return { status: 200, body: await persistence.read((reader) => reader.listRevisions(projectId, documentId, limit, before)) };
      }
      if (documentSuffix === "restore" && input.method === "POST") {
        const authorId = await input.requireAuthor();
        const body = bodyRecord(input.body);
        const result = await persistence.transaction((transaction) => transaction.restoreDocumentRevision({
          projectId,
          documentId,
          baseRevisionId: requiredString(body.baseRevisionId, "baseRevisionId") as RevisionId,
          sourceRevisionId: requiredString(body.sourceRevisionId, "sourceRevisionId") as RevisionId,
          authorId,
          idempotencyKey: idempotencyKey(input.requestHeaders?.["idempotency-key"]),
        }));
        return { status: 200, body: result };
      }
      if (documentSuffix === "anchors" && input.method === "GET") {
        const limit = requestLimit(url.searchParams.get("limit"), 200, 500);
        const revisionId = url.searchParams.get("revision");
        const result = await persistence.read(async (reader) => {
          const document = await reader.getDocument(projectId, documentId);
          if (!document) return undefined;
          const selectedRevision = revisionId ? decoded(revisionId, "Revision id") as RevisionId : document.headRevisionId;
          if (!selectedRevision) return { revisionId: null, anchors: [] };
          if (!(await reader.getRevision(projectId, documentId, selectedRevision))) return undefined;
          const anchors = await reader.listDocumentEvidence(projectId, documentId, selectedRevision, limit);
          return {
            revisionId: selectedRevision,
            anchors: await Promise.all(anchors.map((anchor) => anchorView(reader, projectId, anchor.id))),
          };
        });
        return result ? { status: 200, body: result } : { status: 404, body: { error: "Document revision was not found", code: "PERSISTENCE_NOT_FOUND" } };
      }
      if (documentSuffix === "anchors" && input.method === "POST") {
        const authorId = await input.requireAuthor();
        const body = bodyRecord(input.body);
        const evidenceId = (typeof body.id === "string" ? body.id : randomUUID()) as EvidenceId;
        const revisionId = requiredString(body.revisionId, "revisionId") as RevisionId;
        const fromUtf16 = integer(body.fromUtf16, "fromUtf16");
        const toUtf16 = integer(body.toUtf16, "toUtf16");
        const status = allowedStatus(body.status ?? "proposed", ["proposed", "confirmed"] as const, "status");
        const nodeId = optionalString(body.nodeId, "nodeId") as KnowledgeNodeId | undefined;
        const result = await persistence.transaction(async (transaction) => {
          const revision = await transaction.getRevision(projectId, documentId, revisionId);
          if (!revision) failure(404, "PERSISTENCE_NOT_FOUND", "Document revision was not found");
          if (toUtf16 <= fromUtf16 || toUtf16 > revision.markdown.length) failure(400, "INVALID_BODY", "Anchor offsets must select text in the revision");
          const anchor = await transaction.saveEvidenceAnchor({
            projectId, id: evidenceId, documentId, revisionId, fromUtf16, toUtf16,
            quoteSha256: sha256(revision.markdown.slice(fromUtf16, toUtf16)), status, expectedVersion: null,
          });
          if (nodeId) {
            await transaction.saveMentionLink({
              projectId, evidenceId, nodeId, status: status === "confirmed" ? "confirmed" : "proposed",
              source: "author", confidence: status === "confirmed" ? 1 : null, extractorVersion: null,
            });
          }
          return { anchor, quote: revision.markdown.slice(fromUtf16, toUtf16), nodeId: nodeId ?? null, authorId };
        });
        return { status: 201, body: result };
      }
      const anchorPath = documentSuffix.match(/^anchors\/([^/]+)(?:\/(.*))?$/u);
      if (anchorPath) {
        const evidenceId = decoded(anchorPath[1]!, "Evidence id") as EvidenceId;
        const anchorSuffix = anchorPath[2] ?? "";
        if (!anchorSuffix && input.method === "PATCH") {
          await input.requireAuthor();
          const body = bodyRecord(input.body);
          const result = await persistence.transaction(async (transaction) => {
            const current = await transaction.getEvidenceAnchor(projectId, evidenceId);
            if (!current || current.documentId !== documentId) failure(404, "PERSISTENCE_NOT_FOUND", "Text Anchor was not found");
            const revisionId = requiredString(body.revisionId, "revisionId") as RevisionId;
            const revision = await transaction.getRevision(projectId, documentId, revisionId);
            if (!revision) failure(404, "PERSISTENCE_NOT_FOUND", "Document revision was not found");
            const fromUtf16 = integer(body.fromUtf16, "fromUtf16");
            const toUtf16 = integer(body.toUtf16, "toUtf16");
            if (toUtf16 <= fromUtf16 || toUtf16 > revision.markdown.length) failure(400, "INVALID_BODY", "Confirmed anchors must select text in the revision");
            const status = allowedStatus(body.status, ["proposed", "confirmed"] as const, "status");
            return transaction.saveEvidenceAnchor({
              projectId, id: evidenceId, documentId, revisionId, fromUtf16, toUtf16,
              quoteSha256: sha256(revision.markdown.slice(fromUtf16, toUtf16)), status,
              expectedVersion: integer(body.expectedVersion, "expectedVersion", 1),
            });
          });
          return { status: 200, body: result };
        }
        if (anchorSuffix === "assertions" && input.method === "POST") {
          await input.requireAuthor();
          const body = bodyRecord(input.body);
          const assertionId = requiredString(body.id, "id") as AssertionId;
          const nodeId = requiredString(body.nodeId, "nodeId") as KnowledgeNodeId;
          const statement = requiredString(body.statement, "statement", 4000);
          const modality = allowedStatus(body.modality, ["fact", "belief", "disclosure", "hypothesis"] as const, "modality");
          const perspective = requiredString(body.perspective, "perspective", 128);
          const revisionId = requiredString(body.revisionId, "revisionId") as RevisionId;
          const expectedAnchorVersion = integer(body.expectedAnchorVersion, "expectedAnchorVersion", 1);
          const assertion = await persistence.transaction(async (transaction) => {
            const anchor = await transaction.getEvidenceAnchor(projectId, evidenceId);
            const document = await transaction.getDocument(projectId, documentId);
            const node = await transaction.getKnowledgeNode(projectId, nodeId);
            if (!anchor || anchor.documentId !== documentId || !document || !node || node.deletedAt || node.status === "retired") failure(404, "PERSISTENCE_NOT_FOUND", "Knowledge or Text Anchor was not found");
            if (anchor.status !== "confirmed" || anchor.version !== expectedAnchorVersion || anchor.revisionId !== revisionId || document.headRevisionId !== revisionId || anchor.fromUtf16 >= anchor.toUtf16) {
              failure(409, "ANCHOR_REQUIRES_AUTHOR_CONFIRMATION", "Use the current confirmed Text Anchor");
            }
            const created = await transaction.saveAssertion({
              projectId, id: assertionId, proposition: { kind: "knowledge-statement/v1", nodeId, statement },
              modality, perspective, narrativeTime: {}, confidence: null, status: "proposed", expectedVersion: null,
            });
            await transaction.linkAssertionEvidence({ projectId, assertionId, evidenceId, role: "supports" });
            return created;
          });
          return { status: 201, body: { assertion } };
        }
        if (anchorSuffix === "mentions" && input.method === "POST") {
          await input.requireAuthor();
          const body = bodyRecord(input.body);
          const nodeId = requiredString(body.nodeId, "nodeId") as KnowledgeNodeId;
          const status = allowedStatus(body.status ?? "proposed", ["proposed", "confirmed", "ambiguous", "rejected"] as const, "status");
          const result = await persistence.transaction(async (transaction) => {
            const anchor = await transaction.getEvidenceAnchor(projectId, evidenceId);
            if (!anchor || anchor.documentId !== documentId) failure(404, "PERSISTENCE_NOT_FOUND", "Text Anchor was not found");
            if (status === "confirmed" && (anchor.status !== "confirmed" || anchor.fromUtf16 === anchor.toUtf16)) {
              failure(409, "ANCHOR_REQUIRES_AUTHOR_CONFIRMATION", "Confirm the current Text Anchor before confirming its Knowledge link");
            }
            return transaction.saveMentionLink({
              projectId, evidenceId, nodeId, status, source: "author", confidence: status === "confirmed" ? 1 : null,
              extractorVersion: null,
            });
          });
          return { status: 200, body: result };
        }
      }
      return { status: 404, body: { error: "Persistence route not found", code: "NOT_FOUND" } };
    }

    const nodePath = suffix.match(/^nodes\/([^/]+)(?:\/(.*))?$/u);
    if (nodePath) {
      const nodeId = decoded(nodePath[1]!, "Knowledge node id") as KnowledgeNodeId;
      const nodeSuffix = nodePath[2] ?? "";
      if (!nodeSuffix && input.method === "GET") {
        const value = await persistence.read(async (reader) => {
          const node = await reader.getKnowledgeNode(projectId, nodeId);
          if (!node) return undefined;
          return { node, aliases: await reader.listKnowledgeAliases(projectId, nodeId), relations: await reader.listKnowledgeRelations(projectId, nodeId) };
        });
        return value ? { status: 200, body: value } : { status: 404, body: { error: "Knowledge node was not found", code: "PERSISTENCE_NOT_FOUND" } };
      }
      if (!nodeSuffix && input.method === "PUT") {
        await input.requireAuthor();
        const body = bodyRecord(input.body);
        const node = await persistence.transaction((transaction) => transaction.saveKnowledgeNode({
          projectId, id: nodeId, type: requiredString(body.type, "type", 64), name: requiredString(body.name, "name", 512),
          attributes: (isRecord(body.attributes) ? body.attributes : failure(400, "INVALID_BODY", "attributes must be an object")) as JsonObject,
          status: allowedStatus(body.status, ["proposed", "confirmed", "retired"] as const, "status"),
          expectedVersion: body.expectedVersion === null || body.expectedVersion === undefined ? null : integer(body.expectedVersion, "expectedVersion", 1),
        }));
        return { status: 200, body: { node } };
      }
      if (nodeSuffix === "aliases" && input.method === "POST") {
        await input.requireAuthor();
        const body = bodyRecord(input.body);
        const alias = await persistence.transaction((transaction) => transaction.saveKnowledgeAlias({
          projectId, id: (typeof body.id === "string" ? body.id : randomUUID()) as never, nodeId,
          surface: requiredString(body.surface, "surface", 512), normalized: requiredString(body.normalized, "normalized", 512),
          scope: typeof body.scope === "string" ? body.scope : null,
          status: allowedStatus(body.status ?? "proposed", ["proposed", "confirmed", "ambiguous", "retired"] as const, "status"),
        }));
        return { status: 201, body: { alias } };
      }
      if (nodeSuffix === "relations" && input.method === "POST") {
        await input.requireAuthor();
        const body = bodyRecord(input.body);
        const relation = await persistence.transaction((transaction) => transaction.saveKnowledgeRelation({
          projectId, id: (typeof body.id === "string" ? body.id : randomUUID()) as never, sourceId: nodeId,
          targetId: requiredString(body.targetId, "targetId") as KnowledgeNodeId,
          type: requiredString(body.type, "type", 128),
          attributes: (isRecord(body.attributes) ? body.attributes : {}) as JsonObject,
          validity: (isRecord(body.validity) ? body.validity : {}) as JsonObject,
          status: allowedStatus(body.status ?? "proposed", ["proposed", "confirmed", "rejected", "retired"] as const, "status"),
          expectedVersion: body.expectedVersion === null || body.expectedVersion === undefined ? null : integer(body.expectedVersion, "expectedVersion", 1),
        }));
        return { status: 201, body: { relation } };
      }
      if (nodeSuffix === "evidence" && input.method === "GET") {
        const limit = requestLimit(url.searchParams.get("limit"), 200, 500);
        const evidence = await persistence.read(async (reader) => {
          const mentions = await reader.listNodeMentions(projectId, nodeId, limit);
          return Promise.all(mentions.map((mention) => anchorView(reader, projectId, mention.evidenceId)));
        });
        return { status: 200, body: { evidence: evidence.filter((item) => item !== undefined) } };
      }
      return { status: 404, body: { error: "Persistence route not found", code: "NOT_FOUND" } };
    }

    const assertionPath = suffix.match(/^assertions\/([^/]+)(?:\/(.*))?$/u);
    if (assertionPath) {
      const assertionId = decoded(assertionPath[1]!, "Assertion id") as AssertionId;
      const assertionSuffix = assertionPath[2] ?? "";
      if (!assertionSuffix && input.method === "GET") {
        const value = await persistence.read(async (reader) => {
          const assertion = await reader.getAssertion(projectId, assertionId);
          return assertion ? { assertion, evidence: await reader.listAssertionEvidence(projectId, assertionId) } : undefined;
        });
        return value ? { status: 200, body: value } : { status: 404, body: { error: "Assertion was not found", code: "PERSISTENCE_NOT_FOUND" } };
      }
      if (!assertionSuffix && input.method === "PUT") {
        await input.requireAuthor();
        const body = bodyRecord(input.body);
        const assertion = await persistence.transaction((transaction) => transaction.saveAssertion({
          projectId, id: assertionId,
          proposition: (isRecord(body.proposition) ? body.proposition : failure(400, "INVALID_BODY", "proposition must be an object")) as JsonObject,
          modality: requiredString(body.modality, "modality", 128),
          perspective: requiredString(body.perspective, "perspective", 128),
          narrativeTime: (isRecord(body.narrativeTime) ? body.narrativeTime : {}) as JsonObject,
          confidence: body.confidence === null || body.confidence === undefined ? null : Number(body.confidence),
          status: allowedStatus(body.status, ["proposed", "confirmed", "rejected", "retired"] as const, "status"),
          expectedVersion: body.expectedVersion === null ? null : integer(body.expectedVersion, "expectedVersion", 1),
        }));
        return { status: 200, body: { assertion } };
      }
      if (assertionSuffix === "evidence" && input.method === "GET") {
        const records = await persistence.read(async (reader) => {
          const links = await reader.listAssertionEvidence(projectId, assertionId);
          return Promise.all(links.map(async (link) => ({ link, evidence: await anchorView(reader, projectId, link.evidenceId) })));
        });
        return { status: 200, body: { evidence: records } };
      }
      if (assertionSuffix === "evidence" && input.method === "POST") {
        await input.requireAuthor();
        const body = bodyRecord(input.body);
        const evidence = await persistence.transaction((transaction) => transaction.linkAssertionEvidence({
          projectId, assertionId,
          evidenceId: requiredString(body.evidenceId, "evidenceId") as EvidenceId,
          role: allowedStatus(body.role, ["supports", "contradicts", "quotes", "context"] as const, "role"),
        }));
        return { status: 201, body: { evidence } };
      }
      return { status: 404, body: { error: "Persistence route not found", code: "NOT_FOUND" } };
    }

    return { status: 404, body: { error: "Persistence route not found", code: "NOT_FOUND" } };
  } catch (error) {
    return errorResponse(error);
  }
}
