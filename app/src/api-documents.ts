import type {
  CreateDocumentCommand,
  CreateProjectCommand,
  DocumentRevisionPage,
  DocumentWriteResult,
  Document as PersistenceDocument,
  Project as PersistenceProject,
  DocumentRevision as PersistenceRevision,
  RestoreDocumentRevisionCommand,
  SaveDocumentCommand,
} from '@codexia/persistence-contracts';
import { ApiError } from './api-error';
import {
  persistenceDocumentDelete,
  persistenceDocumentGet,
  persistenceDocumentMetadataPatch,
  persistenceDocumentPatch,
  persistenceDocumentRestorePost,
  persistenceDocumentRevisionsGet,
  persistenceDocumentsGet,
  persistenceDocumentsPost,
  persistenceImportPost,
  persistenceProjectArchiveGet,
  persistenceProjectGet,
  persistenceProjectsGet,
  persistenceProjectsPost,
  persistenceStatusGet,
} from './generated/http/client';
import type {
  PersistenceDocumentEnvelope as GeneratedPersistenceDocumentEnvelope,
  PersistenceDocumentGetResponse as GeneratedPersistenceDocumentGetResponse,
  PersistenceDocumentListResponse as GeneratedPersistenceDocumentListResponse,
  PersistenceDocumentCreateRequest,
  PersistenceDocumentDeleteRequest,
  PersistenceDocumentMetadataRequest,
  PersistenceDocumentRestoreRequest,
  ProjectPageResponse,
  ProjectResponse,
  SaveDocumentRequest,
  WorkArchive,
  WorkArchiveExport,
  WorkImportResult,
} from './generated/http/schemas';

/** Public API aliases use generated wire types, with domain brands at the edge. */
export type PortableWorkArchive = WorkArchiveExport;
export type PortableWorkImportResult = Omit<WorkImportResult, 'project'> & { project: PersistenceProject };
export type PersistenceProjectEnvelope = Omit<ProjectResponse, 'project'> & { project: PersistenceProject };
export type PersistenceProjectPage = Omit<ProjectPageResponse, 'projects'> & { projects: PersistenceProject[] };
export type PersistenceDocumentRead = Omit<GeneratedPersistenceDocumentGetResponse, 'document' | 'revision'> & {
  document: PersistenceDocument;
  revision: PersistenceRevision | null;
};
export type PersistenceDocumentWriteResult = DocumentWriteResult;
export type PersistenceDocumentList = Omit<GeneratedPersistenceDocumentListResponse, 'documents'> & { documents: PersistenceDocument[] };
export type PersistenceDocumentEnvelope = Omit<GeneratedPersistenceDocumentEnvelope, 'document'> & { document: PersistenceDocument };
export type PersistenceRevisionPage = DocumentRevisionPage;

const apiOptions = (signal?: AbortSignal): RequestInit => (signal ? { signal } : {});

/**
 * Persistence document and project operations generated from the TypeSpec
 * contract. The transport adds API auth, lifecycle handling and response
 * validation before these calls resolve.
 */
export const documentApi = {
  persistenceStatus: (signal?: AbortSignal) => persistenceStatusGet(apiOptions(signal)),

  exportWorkArchive: (projectId: string, signal?: AbortSignal) => persistenceProjectArchiveGet(projectId, apiOptions(signal)),

  importWorkArchive: (archive: unknown, signal?: AbortSignal) =>
    persistenceImportPost(archive as WorkArchive, apiOptions(signal)) as unknown as Promise<PortableWorkImportResult>,

  persistenceProjectPage: (limit = 200, cursor?: string, signal?: AbortSignal): Promise<PersistenceProjectPage> => {
    const params = { limit, ...(cursor !== undefined ? { cursor } : {}) };
    return persistenceProjectsGet(params, apiOptions(signal)) as unknown as Promise<PersistenceProjectPage>;
  },

  createPersistenceProject: (command: CreateProjectCommand, signal?: AbortSignal) =>
    persistenceProjectsPost(command, apiOptions(signal)) as unknown as Promise<PersistenceProjectEnvelope>,

  persistenceProject: (projectId: string, signal?: AbortSignal) =>
    persistenceProjectGet(projectId, apiOptions(signal)) as unknown as Promise<PersistenceProjectEnvelope>,

  persistenceDocuments: async (projectId: string, parentId?: string | null, signal?: AbortSignal) => {
    const limit = 1000;
    const result = await persistenceDocumentsGet(
      projectId,
      { limit, ...(parentId !== undefined ? { parentId: parentId ?? 'root' } : {}) },
      apiOptions(signal),
    );
    // The generated response schema validates the version range and wire
    // structure; additive fields remain intact after validation.
    if (result.documents.length >= limit) {
      throw new ApiError('作品の構成が取得上限に達しています。完全な目次を表示できません。', 413, 'SNAPSHOT_TOO_LARGE');
    }
    return result as unknown as PersistenceDocumentList;
  },

  updatePersistenceDocument: (
    projectId: string,
    documentId: string,
    command: { expectedVersion: number; title?: string; parentId?: string | null; orderKey?: string },
  ) =>
    persistenceDocumentMetadataPatch(
      projectId,
      documentId,
      command satisfies PersistenceDocumentMetadataRequest,
    ) as unknown as Promise<PersistenceDocumentEnvelope>,

  deletePersistenceDocument: (projectId: string, documentId: string, expectedVersion: number) =>
    persistenceDocumentDelete(projectId, documentId, {
      expectedVersion,
    } satisfies PersistenceDocumentDeleteRequest) as unknown as Promise<PersistenceDocumentEnvelope>,

  createPersistenceDocument: (projectId: string, command: Omit<CreateDocumentCommand, 'projectId' | 'authorId'>, signal?: AbortSignal) => {
    const { documentId, parentId, kind, title, orderKey, appendToEnd, markdown, idempotencyKey } = command;
    const request = { documentId, parentId, kind, title, orderKey, appendToEnd, markdown } satisfies PersistenceDocumentCreateRequest;
    return persistenceDocumentsPost(projectId, request, {
      ...apiOptions(signal),
      headers: { 'Idempotency-Key': idempotencyKey },
    }) as unknown as Promise<PersistenceDocumentWriteResult>;
  },

  persistenceDocument: (projectId: string, documentId: string, signal?: AbortSignal, revisionId?: string) => {
    const params = revisionId ? { revision: revisionId } : undefined;
    return persistenceDocumentGet(projectId, documentId, params, apiOptions(signal)) as unknown as Promise<PersistenceDocumentRead>;
  },

  savePersistenceDocument: (
    projectId: string,
    documentId: string,
    command: Omit<SaveDocumentCommand, 'projectId' | 'documentId' | 'authorId'>,
    signal?: AbortSignal,
  ) => {
    const { idempotencyKey, clientId, ...body } = command;
    const saveRequest = { ...body, changes: [...body.changes], clientId } satisfies SaveDocumentRequest;
    return persistenceDocumentPatch(projectId, documentId, saveRequest, {
      ...apiOptions(signal),
      headers: { 'Idempotency-Key': idempotencyKey, 'X-Client-Id': clientId },
    }) as unknown as Promise<PersistenceDocumentWriteResult>;
  },

  persistenceRevisions: (projectId: string, documentId: string, limit = 50, before?: string, signal?: AbortSignal) =>
    persistenceDocumentRevisionsGet(
      projectId,
      documentId,
      { limit, ...(before ? { before } : {}) },
      apiOptions(signal),
    ) as unknown as Promise<PersistenceRevisionPage>,

  restorePersistenceDocument: (
    projectId: string,
    documentId: string,
    command: Omit<RestoreDocumentRevisionCommand, 'projectId' | 'documentId' | 'authorId'>,
    signal?: AbortSignal,
  ) => {
    const { baseRevisionId, sourceRevisionId, idempotencyKey } = command;
    return persistenceDocumentRestorePost(
      projectId,
      documentId,
      { baseRevisionId, sourceRevisionId } satisfies PersistenceDocumentRestoreRequest,
      { ...apiOptions(signal), headers: { 'Idempotency-Key': idempotencyKey } },
    ) as unknown as Promise<PersistenceDocumentWriteResult>;
  },
};
