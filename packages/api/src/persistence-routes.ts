import { createHash, randomUUID } from 'node:crypto';
import { CoreStore } from '@codexia/core';
import {
  type AssertionId,
  type DocumentId,
  type EvidenceId,
  type JsonObject,
  type KnowledgeNodeId,
  type Persistence,
  PersistenceError,
  type PersistenceReader,
  type ProjectId,
  type RevisionId,
} from '@codexia/persistence-contracts';
import { applyKnowledgeMerge, planKnowledgeMerge } from '@codexia/persistence-postgres/knowledge-merge';
import {
  applyNativeChangeSet,
  approveNativeChangeSet,
  getNativeAssertion,
  getNativeChangeSet,
  getNativeKnowledgeNode,
  listNativeChangeSets,
  listNativeEvidenceForAssertion,
  listNativeEvidenceForDocument,
  listNativeEvidenceForNode,
  listNativeKnowledgeNodes,
  NativeKnowledgeServiceError,
  proposeNativeKnowledgeChange,
  readCurrentNativeKnowledge,
  readNativeKnowledge,
  rejectNativeChangeSet,
} from './native-knowledge-service.js';
import { decodeProjectPageCursor, encodeProjectPageCursor } from './project-pagination.js';
import { exportWorkArchive, importWorkArchive, WorkArchiveError } from './work-archive.js';

export interface PersistenceRouteInput {
  persistence?: Persistence;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  requestHeaders: import('node:http').IncomingHttpHeaders;
  /** Derived by the host from the authenticated review authority. */
  canReviewPrivateChangeSets?: boolean;
  /** Resolve an authenticated human author and enforce the existing write policy. */
  requireAuthor: () => Promise<string>;
}

export interface PersistenceRouteResponse {
  status: number;
  body: unknown;
}

class RouteFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function failure(status: number, code: string, message: string): never {
  throw new RouteFailure(status, code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    failure(400, 'INVALID_BODY', `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum = 512): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maximum);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) failure(400, 'INVALID_BODY', `${label} must be an integer`);
  return value as number;
}

function requestLimit(value: string | null, defaultValue: number, maximum: number): number {
  if (value === null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) failure(400, 'INVALID_QUERY', `limit must be between 1 and ${maximum}`);
  return parsed;
}

function decoded(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return failure(400, 'INVALID_ID', `${label} is invalid`);
  }
}

function idempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  return requiredString(key, 'Idempotency-Key', 200);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

type KnowledgeCursor = { projectId: string; version: number; query: string; type: string; status: string; name: string; id: string };
function parseKnowledgeCursor(value: string | null): KnowledgeCursor | undefined {
  if (value === null) return undefined;
  try {
    if (value.length > 4096) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<KnowledgeCursor>;
    if (
      typeof parsed.projectId !== 'string' ||
      !Number.isSafeInteger(parsed.version) ||
      (parsed.version as number) < 1 ||
      typeof parsed.query !== 'string' ||
      typeof parsed.type !== 'string' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(parsed.id)
    )
      throw new Error();
    return parsed as KnowledgeCursor;
  } catch {
    return failure(400, 'INVALID_CURSOR', 'Knowledge cursor is invalid');
  }
}
function knowledgeCursor(cursor: KnowledgeCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function errorResponse(error: unknown): PersistenceRouteResponse {
  if (error instanceof WorkArchiveError) return { status: error.status, body: { error: error.message, code: error.code } };
  if (error instanceof NativeKnowledgeServiceError)
    return { status: error.code === 'snapshot_unavailable' ? 409 : 400, body: { error: error.message, code: error.code.toUpperCase() } };
  if (error instanceof RouteFailure) return { status: error.status, body: { error: error.message, code: error.code } };
  if (error instanceof PersistenceError) {
    if (error.code === 'unavailable') {
      return { status: 503, body: { error: error.message, code: 'PERSISTENCE_UNAVAILABLE' } };
    }
    const status = error.code === 'not_found' ? 404 : error.code === 'validation' ? 400 : 409;
    const code =
      error.code === 'not_found'
        ? 'PERSISTENCE_NOT_FOUND'
        : error.code === 'validation'
          ? 'PERSISTENCE_VALIDATION'
          : error.code === 'idempotency_conflict'
            ? 'IDEMPOTENCY_CONFLICT'
            : 'PERSISTENCE_CONFLICT';
    return { status, body: { error: error.message, code, ...(error.details ? { details: error.details } : {}) } };
  }
  throw error;
}

function allowedStatus<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) failure(400, 'INVALID_BODY', `${label} is invalid`);
  return value as T;
}

type PersistenceHandler = (input: PersistenceRouteInput, persistence: Persistence) => Promise<PersistenceRouteResponse>;

function selectedProjectVersion(query: URLSearchParams): number | undefined {
  const selected = query.get('projectVersion');
  if (selected === null) return undefined;
  const version = Number(selected);
  if (!Number.isInteger(version) || version < 1) failure(400, 'INVALID_QUERY', 'projectVersion must be a positive integer');
  return version;
}

function nativeRead<T>(
  input: PersistenceRouteInput,
  persistence: Persistence,
  projectId: ProjectId,
  read: (reader: PersistenceReader) => Promise<T>,
) {
  const version = selectedProjectVersion(input.query);
  return version === undefined
    ? readCurrentNativeKnowledge(persistence, projectId, read)
    : readNativeKnowledge(persistence, projectId, version, read);
}

const handlers: Record<string, PersistenceHandler> = {
  persistence_status_get: async input => {
    if (input.persistence?.checkHealth) {
      try {
        await input.persistence.checkHealth();
      } catch {
        return { status: 503, body: { error: 'PostgreSQL persistence is not ready', code: 'PERSISTENCE_UNAVAILABLE' } };
      }
    }
    return { status: 200, body: { available: Boolean(input.persistence), provider: input.persistence ? 'postgres' : null } };
  },
  persistence_import_post: async (input, persistence) => {
    const authorId = await input.requireAuthor();
    return { status: 201, body: await importWorkArchive(persistence, input.body, authorId) };
  },
  persistence_projects_get: async (input, persistence) => {
    const limit = requestLimit(input.query.get('limit'), 200, 200);
    let cursor: ReturnType<typeof decodeProjectPageCursor>;
    try {
      cursor = decodeProjectPageCursor(input.query.get('cursor'));
    } catch {
      failure(400, 'INVALID_CURSOR', 'Project cursor is invalid');
    }
    const rows = await persistence.read(reader => {
      if (!reader.listProjectPage) failure(503, 'PROJECT_PAGINATION_UNAVAILABLE', 'Project pagination is unavailable');
      return reader.listProjectPage(limit + 1, cursor);
    });
    const projects = rows.slice(0, limit);
    const last = projects.at(-1);
    const nextCursor = rows.length > limit && last ? encodeProjectPageCursor({ updatedAt: last.updatedAt, id: last.id }) : null;
    return { status: 200, body: { projects, nextCursor } };
  },
  persistence_projects_post: async (input, persistence) => {
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const title = requiredString(body.title, 'title', 256);
    if (body.settings !== undefined && !isRecord(body.settings)) failure(400, 'INVALID_BODY', 'settings must be a JSON object');
    const project = await persistence.transaction(transaction =>
      transaction.createProject({
        ...(typeof body.id === 'string' ? { id: body.id as ProjectId } : {}),
        title,
        settings: (body.settings ?? {}) as JsonObject,
      }),
    );
    return { status: 201, body: { project } };
  },
  persistence_review_feed_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    await input.requireAuthor();
    const limit = requestLimit(input.query.get('limit'), 50, 200);
    const items = await new CoreStore({ persistence }).listAuthorReviews(projectId, limit);
    return { status: 200, body: { items } };
  },
  persistence_changesets_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const limit = requestLimit(input.query.get('limit'), 50, 200);
    return {
      status: 200,
      body: { changeSets: await listNativeChangeSets(persistence, projectId, limit, input.canReviewPrivateChangeSets) },
    };
  },
  persistence_changesets_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const actorId = await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const operations = body.operations;
    if (!Array.isArray(operations)) failure(400, 'INVALID_BODY', 'operations must be an array');
    const result = await proposeNativeKnowledgeChange({
      persistence,
      projectId,
      projectVersion: integer(body.projectVersion, 'projectVersion', 1),
      actorId,
      idempotencyKey: idempotencyKey(input.requestHeaders?.['idempotency-key']),
      operations: operations as import('@codexia/persistence-contracts').ChangeSetOperation[],
    });
    return { status: 201, body: result };
  },
  persistence_changeset_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const changeSetId = input.params.changeSetId as import('@codexia/persistence-contracts').ChangeSetId;
    const result = await getNativeChangeSet(persistence, projectId, changeSetId, input.canReviewPrivateChangeSets);
    return result
      ? { status: 200, body: result }
      : { status: 404, body: { error: 'ChangeSet was not found', code: 'PERSISTENCE_NOT_FOUND' } };
  },
  persistence_project_archive_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    return { status: 200, body: await exportWorkArchive(persistence, projectId) };
  },
  persistence_project_patch: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const project = await persistence.transaction(transaction =>
      transaction.updateProject({
        projectId,
        expectedVersion: integer(body.expectedVersion, 'expectedVersion', 1),
        ...(body.title === undefined ? {} : { title: requiredString(body.title, 'title', 256) }),
        ...(body.settings === undefined
          ? {}
          : {
              settings: (isRecord(body.settings)
                ? body.settings
                : failure(400, 'INVALID_BODY', 'settings must be an object')) as JsonObject,
            }),
      }),
    );
    return { status: 200, body: { project } };
  },
  persistence_project_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const project = await persistence.read(reader => reader.getProject(projectId));
    return project
      ? { status: 200, body: { project } }
      : { status: 404, body: { error: 'Project was not found', code: 'PERSISTENCE_NOT_FOUND' } };
  },
  persistence_documents_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const parentValue = input.query.get('parentId');
    const parentId =
      parentValue === null ? undefined : parentValue === 'root' ? null : (decoded(parentValue, 'Parent document id') as DocumentId);
    const limit = requestLimit(input.query.get('limit'), 500, 1000);
    const version = selectedProjectVersion(input.query);
    const list = (reader: PersistenceReader) => reader.listDocuments(projectId, parentId, limit);
    const documents = await (version === undefined ? persistence.read(list) : readNativeKnowledge(persistence, projectId, version, list));
    return { status: 200, body: { documents } };
  },
  persistence_documents_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const authorId = await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const result = await persistence.transaction(transaction =>
      transaction.createDocument({
        projectId,
        ...(typeof body.documentId === 'string' ? { documentId: body.documentId as DocumentId } : {}),
        ...(body.parentId === null
          ? { parentId: null }
          : typeof body.parentId === 'string'
            ? { parentId: body.parentId as DocumentId }
            : {}),
        kind: requiredString(body.kind, 'kind', 64),
        title: requiredString(body.title, 'title', 256),
        orderKey: typeof body.orderKey === 'string' ? body.orderKey : '0000',
        ...(body.appendToEnd === undefined || body.appendToEnd === false
          ? {}
          : body.appendToEnd === true
            ? { appendToEnd: true }
            : failure(400, 'INVALID_BODY', 'appendToEnd must be a boolean')),
        markdown: typeof body.markdown === 'string' ? body.markdown : failure(400, 'INVALID_BODY', 'markdown must be a string'),
        authorId,
        idempotencyKey: idempotencyKey(input.requestHeaders?.['idempotency-key']),
      }),
    );
    return { status: 201, body: result };
  },
  persistence_nodes_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const query = input.query.get('q') ?? '';
    const type = input.query.get('type') ?? '';
    const status = input.query.get('status') ?? '';
    const suppliedCursor = parseKnowledgeCursor(input.query.get('cursor'));
    const browsing = input.query.has('q') || input.query.has('type') || input.query.has('status') || suppliedCursor !== undefined;
    if (!browsing) {
      const limit = requestLimit(input.query.get('limit'), 100, 500);
      const nodes = await listNativeKnowledgeNodes(persistence, projectId, limit, selectedProjectVersion(input.query));
      return { status: 200, body: { nodes } };
    }
    if (
      query.length > 128 ||
      type.length > 64 ||
      Array.from(type).some(character => character < ' ' || character === '\x7f') ||
      (status && !['proposed', 'confirmed', 'retired'].includes(status))
    )
      failure(400, 'INVALID_QUERY', 'Knowledge filters are invalid');
    const limit = requestLimit(input.query.get('limit'), 50, 100);
    if (
      suppliedCursor &&
      (suppliedCursor.projectId !== projectId ||
        suppliedCursor.query !== query ||
        suppliedCursor.type !== type ||
        suppliedCursor.status !== status)
    ) {
      failure(400, 'INVALID_CURSOR', 'Knowledge cursor does not match these filters');
    }
    const requestedVersion = selectedProjectVersion(input.query);
    if (suppliedCursor && requestedVersion !== undefined && suppliedCursor.version !== requestedVersion) {
      failure(400, 'INVALID_CURSOR', 'Knowledge cursor does not match the selected project version');
    }
    const version = suppliedCursor?.version ?? requestedVersion;
    const page = await nativeRead(input, persistence, projectId, async reader => {
      const project = await reader.getProject(projectId);
      if (!project) throw new NativeKnowledgeServiceError('snapshot_unavailable', 'The selected native Knowledge snapshot is unavailable');
      if (version !== undefined && project.version !== version)
        throw new NativeKnowledgeServiceError('snapshot_unavailable', 'Knowledge changed; restart the search');
      if (!reader.searchKnowledgeNodes) throw new NativeKnowledgeServiceError('invalid_input', 'Knowledge browse is unavailable');
      const nodes = await reader.searchKnowledgeNodes(projectId, {
        query,
        type: type || undefined,
        status: status ? (status as 'proposed' | 'confirmed' | 'retired') : undefined,
        after: suppliedCursor
          ? { name: suppliedCursor.name, id: suppliedCursor.id as import('@codexia/persistence-contracts').KnowledgeNodeId }
          : undefined,
        limit: limit + 1,
      });
      return { version: project.version, nodes };
    });
    const hasMore = page.nodes.length > limit;
    const nodes = page.nodes.slice(0, limit);
    const last = nodes.at(-1);
    const nextCursor =
      hasMore && last ? knowledgeCursor({ projectId, version: page.version, query, type, status, name: last.name, id: last.id }) : null;
    return { status: 200, body: { nodes, nextCursor, projectVersion: page.version } };
  },
  persistence_document_metadata_patch: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const document = await persistence.transaction(transaction =>
      transaction.updateDocument({
        projectId,
        documentId,
        expectedVersion: integer(body.expectedVersion, 'expectedVersion', 1),
        ...(body.title === undefined ? {} : { title: requiredString(body.title, 'title', 256) }),
        ...(body.orderKey === undefined ? {} : { orderKey: requiredString(body.orderKey, 'orderKey', 256) }),
        ...(body.parentId === undefined
          ? {}
          : { parentId: body.parentId === null ? null : (requiredString(body.parentId, 'parentId') as DocumentId) }),
      }),
    );
    return { status: 200, body: { document } };
  },
  persistence_document_delete: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const document = await persistence.transaction(transaction =>
      transaction.deleteDocument({
        projectId,
        documentId,
        expectedVersion: integer(body.expectedVersion, 'expectedVersion', 1),
      }),
    );
    return { status: 200, body: { document } };
  },
  persistence_document_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    const selectedRevisionId = input.query.get('revision');
    const value = await nativeRead(input, persistence, projectId, async reader => {
      const document = await reader.getDocument(projectId, documentId);
      if (!document) return undefined;
      const revisionId = selectedRevisionId ? (decoded(selectedRevisionId, 'Revision id') as RevisionId) : document.headRevisionId;
      const revision = revisionId ? await reader.getRevision(projectId, documentId, revisionId) : undefined;
      if (revisionId && !revision) return undefined;
      return { document, revision: revision ?? null };
    });
    return value ? { status: 200, body: value } : { status: 404, body: { error: 'Document was not found', code: 'PERSISTENCE_NOT_FOUND' } };
  },
  persistence_document_patch: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    const authorId = await input.requireAuthor();
    const body = input.body as {
      baseRevisionId: string;
      changes: { fromUtf16: number; toUtf16: number; insert: string }[];
      resultingSha256: string;
      clientId?: string;
    };
    const changes = body.changes.map(({ fromUtf16, toUtf16, insert }) => ({
      fromUtf16: integer(fromUtf16, 'fromUtf16'),
      toUtf16: integer(toUtf16, 'toUtf16'),
      insert,
    }));
    try {
      const result = await persistence.transaction(transaction =>
        transaction.saveDocument({
          projectId,
          documentId,
          baseRevisionId: requiredString(body.baseRevisionId, 'baseRevisionId') as RevisionId,
          changes,
          resultingSha256: requiredString(body.resultingSha256, 'resultingSha256', 64),
          authorId,
          clientId: requiredString(input.requestHeaders?.['x-client-id'] ?? body.clientId, 'clientId', 128),
          idempotencyKey: idempotencyKey(input.requestHeaders?.['idempotency-key']),
        }),
      );
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof PersistenceError && error.code === 'conflict') {
        const current = await persistence.read(async reader => {
          const document = await reader.getDocument(projectId, documentId);
          if (!document) return null;
          const revision = document.headRevisionId ? await reader.getRevision(projectId, documentId, document.headRevisionId) : undefined;
          return { document, revision: revision ?? null };
        });
        return { status: 409, body: { error: error.message, code: 'PERSISTENCE_CONFLICT', details: error.details, current } };
      }
      throw error;
    }
  },
  persistence_document_revisions_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    const limit = requestLimit(input.query.get('limit'), 50, 200);
    const before = input.query.get('before') ?? undefined;
    return { status: 200, body: await persistence.read(reader => reader.listRevisions(projectId, documentId, limit, before)) };
  },
  persistence_document_restore_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    const authorId = await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const result = await persistence.transaction(transaction =>
      transaction.restoreDocumentRevision({
        projectId,
        documentId,
        baseRevisionId: requiredString(body.baseRevisionId, 'baseRevisionId') as RevisionId,
        sourceRevisionId: requiredString(body.sourceRevisionId, 'sourceRevisionId') as RevisionId,
        authorId,
        idempotencyKey: idempotencyKey(input.requestHeaders?.['idempotency-key']),
      }),
    );
    return { status: 200, body: result };
  },
  persistence_document_anchors_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    const limit = requestLimit(input.query.get('limit'), 200, 500);
    const revisionId = input.query.get('revision');
    const result = await listNativeEvidenceForDocument(
      persistence,
      projectId,
      documentId,
      revisionId ? (decoded(revisionId, 'Revision id') as RevisionId) : undefined,
      limit,
      selectedProjectVersion(input.query),
    );
    return result
      ? { status: 200, body: result }
      : { status: 404, body: { error: 'Document revision was not found', code: 'PERSISTENCE_NOT_FOUND' } };
  },
  persistence_document_anchors_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    const authorId = await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const evidenceId = (typeof body.id === 'string' ? body.id : randomUUID()) as EvidenceId;
    const revisionId = requiredString(body.revisionId, 'revisionId') as RevisionId;
    const fromUtf16 = integer(body.fromUtf16, 'fromUtf16');
    const toUtf16 = integer(body.toUtf16, 'toUtf16');
    const status = allowedStatus(body.status ?? 'proposed', ['proposed', 'confirmed'] as const, 'status');
    const nodeId = optionalString(body.nodeId, 'nodeId') as KnowledgeNodeId | undefined;
    const result = await persistence.transaction(async transaction => {
      const revision = await transaction.getRevision(projectId, documentId, revisionId);
      if (!revision) failure(404, 'PERSISTENCE_NOT_FOUND', 'Document revision was not found');
      if (toUtf16 <= fromUtf16 || toUtf16 > revision.markdown.length)
        failure(400, 'INVALID_BODY', 'Anchor offsets must select text in the revision');
      const anchor = await transaction.saveEvidenceAnchor({
        projectId,
        id: evidenceId,
        documentId,
        revisionId,
        fromUtf16,
        toUtf16,
        quoteSha256: sha256(revision.markdown.slice(fromUtf16, toUtf16)),
        status,
        expectedVersion: null,
      });
      if (nodeId) {
        await transaction.saveMentionLink({
          projectId,
          evidenceId,
          nodeId,
          status: status === 'confirmed' ? 'confirmed' : 'proposed',
          source: 'author',
          confidence: status === 'confirmed' ? 1 : null,
          extractorVersion: null,
        });
      }
      return { anchor, quote: revision.markdown.slice(fromUtf16, toUtf16), nodeId: nodeId ?? null, authorId };
    });
    return { status: 201, body: result };
  },
  persistence_document_anchor_patch: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    const evidenceId = input.params.anchorId as EvidenceId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const result = await persistence.transaction(async transaction => {
      const current = await transaction.getEvidenceAnchor(projectId, evidenceId);
      if (!current || current.documentId !== documentId) failure(404, 'PERSISTENCE_NOT_FOUND', 'Text Anchor was not found');
      const revisionId = requiredString(body.revisionId, 'revisionId') as RevisionId;
      const revision = await transaction.getRevision(projectId, documentId, revisionId);
      if (!revision) failure(404, 'PERSISTENCE_NOT_FOUND', 'Document revision was not found');
      const fromUtf16 = integer(body.fromUtf16, 'fromUtf16');
      const toUtf16 = integer(body.toUtf16, 'toUtf16');
      if (toUtf16 <= fromUtf16 || toUtf16 > revision.markdown.length)
        failure(400, 'INVALID_BODY', 'Confirmed anchors must select text in the revision');
      const status = allowedStatus(body.status, ['proposed', 'confirmed'] as const, 'status');
      return transaction.saveEvidenceAnchor({
        projectId,
        id: evidenceId,
        documentId,
        revisionId,
        fromUtf16,
        toUtf16,
        quoteSha256: sha256(revision.markdown.slice(fromUtf16, toUtf16)),
        status,
        expectedVersion: integer(body.expectedVersion, 'expectedVersion', 1),
      });
    });
    return { status: 200, body: result };
  },
  persistence_anchor_assertions_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    const evidenceId = input.params.anchorId as EvidenceId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const assertionId = requiredString(body.id, 'id') as AssertionId;
    const nodeId = requiredString(body.nodeId, 'nodeId') as KnowledgeNodeId;
    const statement = requiredString(body.statement, 'statement', 4000);
    const modality = allowedStatus(body.modality, ['fact', 'belief', 'disclosure', 'hypothesis'] as const, 'modality');
    const perspective = requiredString(body.perspective, 'perspective', 128);
    const revisionId = requiredString(body.revisionId, 'revisionId') as RevisionId;
    const expectedAnchorVersion = integer(body.expectedAnchorVersion, 'expectedAnchorVersion', 1);
    const assertion = await persistence.transaction(async transaction => {
      await transaction.assertProjectVersion(projectId);
      const anchor = await transaction.getEvidenceAnchor(projectId, evidenceId);
      const document = await transaction.getDocument(projectId, documentId);
      const node = await transaction.getKnowledgeNode(projectId, nodeId);
      if (!anchor || anchor.documentId !== documentId || !document || !node || node.deletedAt || node.status === 'retired')
        failure(404, 'PERSISTENCE_NOT_FOUND', 'Knowledge or Text Anchor was not found');
      if (
        anchor.status !== 'confirmed' ||
        anchor.version !== expectedAnchorVersion ||
        anchor.revisionId !== revisionId ||
        document.headRevisionId !== revisionId ||
        anchor.fromUtf16 >= anchor.toUtf16
      ) {
        failure(409, 'ANCHOR_REQUIRES_AUTHOR_CONFIRMATION', 'Use the current confirmed Text Anchor');
      }
      const mention = await transaction.getMentionLink(projectId, evidenceId, nodeId);
      if (!mention || mention.status === 'rejected')
        failure(409, 'KNOWLEDGE_LINK_REQUIRED', 'Link the Text Anchor to this Knowledge node before proposing an assertion');
      const created = await transaction.saveAssertion({
        projectId,
        id: assertionId,
        proposition: { kind: 'knowledge-statement/v1', nodeId, statement },
        modality,
        perspective,
        narrativeTime: {},
        confidence: null,
        status: 'proposed',
        expectedVersion: null,
      });
      await transaction.linkAssertionEvidence({ projectId, assertionId, evidenceId, role: 'supports' });
      return created;
    });
    return { status: 201, body: { assertion } };
  },
  persistence_anchor_mentions_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const documentId = input.params.documentId as DocumentId;
    const evidenceId = input.params.anchorId as EvidenceId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const nodeId = requiredString(body.nodeId, 'nodeId') as KnowledgeNodeId;
    const status = allowedStatus(body.status ?? 'proposed', ['proposed', 'confirmed', 'ambiguous', 'rejected'] as const, 'status');
    const result = await persistence.transaction(async transaction => {
      await transaction.assertProjectVersion(projectId);
      const anchor = await transaction.getEvidenceAnchor(projectId, evidenceId);
      if (!anchor || anchor.documentId !== documentId) failure(404, 'PERSISTENCE_NOT_FOUND', 'Text Anchor was not found');
      if (status === 'confirmed' && (anchor.status !== 'confirmed' || anchor.fromUtf16 === anchor.toUtf16)) {
        failure(409, 'ANCHOR_REQUIRES_AUTHOR_CONFIRMATION', 'Confirm the current Text Anchor before confirming its Knowledge link');
      }
      return transaction.saveMentionLink({
        projectId,
        evidenceId,
        nodeId,
        status,
        source: 'author',
        confidence: status === 'confirmed' ? 1 : null,
        extractorVersion: null,
      });
    });
    return { status: 200, body: result };
  },
  persistence_node_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const nodeId = input.params.nodeId as KnowledgeNodeId;
    const value = await getNativeKnowledgeNode(persistence, projectId, nodeId, selectedProjectVersion(input.query));
    return value
      ? { status: 200, body: value }
      : { status: 404, body: { error: 'Knowledge node was not found', code: 'PERSISTENCE_NOT_FOUND' } };
  },
  persistence_node_put: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const nodeId = input.params.nodeId as KnowledgeNodeId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const node = await persistence.transaction(transaction =>
      transaction.saveKnowledgeNode({
        projectId,
        id: nodeId,
        type: requiredString(body.type, 'type', 64),
        name: requiredString(body.name, 'name', 512),
        attributes: (isRecord(body.attributes)
          ? body.attributes
          : failure(400, 'INVALID_BODY', 'attributes must be an object')) as JsonObject,
        status: allowedStatus(body.status, ['proposed', 'confirmed', 'retired'] as const, 'status'),
        expectedVersion:
          body.expectedVersion === null || body.expectedVersion === undefined ? null : integer(body.expectedVersion, 'expectedVersion', 1),
      }),
    );
    return { status: 200, body: { node } };
  },
  persistence_node_merge_preview_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const nodeId = input.params.nodeId as KnowledgeNodeId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const targetId = requiredString(body.targetId, 'targetId') as KnowledgeNodeId;
    return { status: 200, body: await persistence.read(reader => planKnowledgeMerge(reader, projectId, nodeId, targetId)) };
  },
  persistence_node_merge_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const nodeId = input.params.nodeId as KnowledgeNodeId;
    const authorId = await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    if (body.confirm !== true) failure(400, 'AUTHOR_CONFIRMATION_REQUIRED', 'Confirm the displayed merge preview');
    const targetId = requiredString(body.targetId, 'targetId') as KnowledgeNodeId;
    const projectVersion = integer(body.projectVersion, 'projectVersion', 0);
    const previewDigest = requiredString(body.previewDigest, 'previewDigest', 64);
    return {
      status: 200,
      body: await persistence.transaction(tx =>
        applyKnowledgeMerge(tx, projectId, nodeId, targetId, projectVersion, previewDigest, authorId),
      ),
    };
  },
  persistence_node_aliases_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const nodeId = input.params.nodeId as KnowledgeNodeId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const alias = await persistence.transaction(transaction =>
      transaction.saveKnowledgeAlias({
        projectId,
        id: (typeof body.id === 'string' ? body.id : randomUUID()) as never,
        nodeId,
        surface: requiredString(body.surface, 'surface', 512),
        normalized: requiredString(body.normalized, 'normalized', 512),
        scope: typeof body.scope === 'string' ? body.scope : null,
        status: allowedStatus(body.status ?? 'proposed', ['proposed', 'confirmed', 'ambiguous', 'retired'] as const, 'status'),
      }),
    );
    return { status: 201, body: { alias } };
  },
  persistence_node_relations_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const nodeId = input.params.nodeId as KnowledgeNodeId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const relation = await persistence.transaction(transaction =>
      transaction.saveKnowledgeRelation({
        projectId,
        id: (typeof body.id === 'string' ? body.id : randomUUID()) as never,
        sourceId: nodeId,
        targetId: requiredString(body.targetId, 'targetId') as KnowledgeNodeId,
        type: requiredString(body.type, 'type', 128),
        attributes: (isRecord(body.attributes) ? body.attributes : {}) as JsonObject,
        validity: (isRecord(body.validity) ? body.validity : {}) as JsonObject,
        status: allowedStatus(body.status ?? 'proposed', ['proposed', 'confirmed', 'rejected', 'retired'] as const, 'status'),
        expectedVersion:
          body.expectedVersion === null || body.expectedVersion === undefined ? null : integer(body.expectedVersion, 'expectedVersion', 1),
      }),
    );
    return { status: 201, body: { relation } };
  },
  persistence_node_evidence_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const nodeId = input.params.nodeId as KnowledgeNodeId;
    const limit = requestLimit(input.query.get('limit'), 200, 500);
    const evidence = await listNativeEvidenceForNode(persistence, projectId, nodeId, limit, selectedProjectVersion(input.query));
    return { status: 200, body: { evidence: evidence.filter(item => item !== undefined) } };
  },
  persistence_assertion_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const assertionId = input.params.assertionId as AssertionId;
    const value = await getNativeAssertion(persistence, projectId, assertionId, selectedProjectVersion(input.query));
    return value
      ? { status: 200, body: value }
      : { status: 404, body: { error: 'Assertion was not found', code: 'PERSISTENCE_NOT_FOUND' } };
  },
  persistence_assertion_put: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const assertionId = input.params.assertionId as AssertionId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const assertion = await persistence.transaction(async transaction => {
      await transaction.assertProjectVersion(projectId);
      const existing = await transaction.getAssertion(projectId, assertionId);
      if (existing?.proposition.kind === 'knowledge-statement/v1' && body.status === 'confirmed') {
        const links = await transaction.listAssertionEvidence(projectId, assertionId);
        let currentEvidence = false;
        for (const link of links) {
          const anchor = await transaction.getEvidenceAnchor(projectId, link.evidenceId);
          const document = anchor && (await transaction.getDocument(projectId, anchor.documentId));
          if (
            anchor &&
            document?.headRevisionId === anchor.revisionId &&
            anchor.status === 'confirmed' &&
            anchor.fromUtf16 < anchor.toUtf16 &&
            link.role === 'supports'
          )
            currentEvidence = true;
        }
        if (!currentEvidence)
          failure(409, 'ANCHOR_REQUIRES_AUTHOR_CONFIRMATION', 'Confirm a current supporting Text Anchor before confirming this assertion');
        const node =
          typeof existing.proposition.nodeId === 'string' &&
          (await transaction.getKnowledgeNode(projectId, existing.proposition.nodeId as KnowledgeNodeId));
        if (!node || node.status !== 'confirmed' || node.deletedAt)
          failure(409, 'KNOWLEDGE_REQUIRES_AUTHOR_CONFIRMATION', 'Confirm the Knowledge node before confirming this assertion');
      }
      return transaction.saveAssertion({
        projectId,
        id: assertionId,
        proposition: (isRecord(body.proposition)
          ? body.proposition
          : failure(400, 'INVALID_BODY', 'proposition must be an object')) as JsonObject,
        modality: requiredString(body.modality, 'modality', 128),
        perspective: requiredString(body.perspective, 'perspective', 128),
        narrativeTime: (isRecord(body.narrativeTime) ? body.narrativeTime : {}) as JsonObject,
        confidence: body.confidence === null || body.confidence === undefined ? null : Number(body.confidence),
        status: allowedStatus(body.status, ['proposed', 'confirmed', 'rejected', 'retired'] as const, 'status'),
        expectedVersion: body.expectedVersion === null ? null : integer(body.expectedVersion, 'expectedVersion', 1),
      });
    });
    return { status: 200, body: { assertion } };
  },
  persistence_assertion_evidence_get: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const assertionId = input.params.assertionId as AssertionId;
    const records = await listNativeEvidenceForAssertion(persistence, projectId, assertionId, selectedProjectVersion(input.query));
    return { status: 200, body: { evidence: records } };
  },
  persistence_assertion_evidence_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const assertionId = input.params.assertionId as AssertionId;
    await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const evidence = await persistence.transaction(transaction =>
      transaction.linkAssertionEvidence({
        projectId,
        assertionId,
        evidenceId: requiredString(body.evidenceId, 'evidenceId') as EvidenceId,
        role: allowedStatus(body.role, ['supports', 'contradicts', 'quotes', 'context'] as const, 'role'),
      }),
    );
    return { status: 201, body: { evidence } };
  },
  persistence_changeset_approve_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const changeSetId = input.params.changeSetId as import('@codexia/persistence-contracts').ChangeSetId;
    const actorId = await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const expectedVersion = integer(body.expectedVersion, 'expectedVersion', 1);
    return {
      status: 200,
      body: { changeSet: await approveNativeChangeSet(persistence, projectId, changeSetId, expectedVersion, actorId) },
    };
  },
  persistence_changeset_reject_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const changeSetId = input.params.changeSetId as import('@codexia/persistence-contracts').ChangeSetId;
    const actorId = await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const expectedVersion = integer(body.expectedVersion, 'expectedVersion', 1);
    return { status: 200, body: { changeSet: await rejectNativeChangeSet(persistence, projectId, changeSetId, expectedVersion, actorId) } };
  },
  persistence_changeset_apply_post: async (input, persistence) => {
    const projectId = input.params.projectId as ProjectId;
    const changeSetId = input.params.changeSetId as import('@codexia/persistence-contracts').ChangeSetId;
    const actorId = await input.requireAuthor();
    const body = input.body as Record<string, unknown>;
    const expectedVersion = integer(body.expectedVersion, 'expectedVersion', 1);
    return { status: 200, body: await applyNativeChangeSet(persistence, projectId, changeSetId, expectedVersion) };
  },
};

export async function handlePersistenceOperation(operationId: string, input: PersistenceRouteInput): Promise<PersistenceRouteResponse> {
  const handler = handlers[operationId];
  if (!handler) throw new Error(`Unknown persistence operation ${operationId}`);
  if (!input.persistence && operationId !== 'persistence_status_get') {
    return { status: 503, body: { error: 'PostgreSQL persistence is not configured', code: 'PERSISTENCE_UNAVAILABLE' } };
  }
  try {
    return await handler(input, input.persistence!);
  } catch (error) {
    return errorResponse(error);
  }
}
