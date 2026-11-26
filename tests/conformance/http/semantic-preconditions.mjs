// Test-only pre-storage oracle. No database connection or write is allowed.
import { handlePersistenceOperation } from '../../../packages/api/src/persistence-routes.ts';
import { parseWorkArchive, WorkArchiveError } from '../../../packages/api/src/work-archive.ts';

const reachedStorage = new Error('Reached storage boundary');
const stop = async () => { throw reachedStorage; };
const persistence = { read: stop, transaction: stop };

export async function expectedDomainRejection({ operation, params, query, headers, body }) {
  if (operation === 'POST /api/v1/persistence/import') {
    try {
      parseWorkArchive(body);
      return null;
    } catch (error) {
      // A wire-shape failure is not a semantic exception.
      if (error instanceof WorkArchiveError && !error.message.startsWith('Invalid codexia-work/v1 archive:') &&
          [400, 413].includes(error.status)) {
        return { status: error.status, code: error.code, error: error.message };
      }
      return null;
    }
  }
  if (operation === 'PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}') {
    if (headers['x-client-id'] === undefined && body?.clientId === undefined) {
      return { status: 400, code: 'INVALID_BODY', error: 'clientId must be a non-empty string' };
    }
    return null;
  }
  if (operation === 'POST /api/v1/persistence/projects/{projectId}/nodes/{nodeId}/merge-preview') {
    if (typeof body?.targetId === 'string' && body.targetId === params.nodeId) {
      return { status: 400, code: 'PERSISTENCE_VALIDATION', error: 'Select two different nodes' };
    }
    return null;
  }
  const operationId = {
    'GET /api/v1/persistence/projects': 'persistence_projects_get',
    'GET /api/v1/persistence/projects/{projectId}/nodes': 'persistence_nodes_get',
    'POST /api/v1/persistence/projects/{projectId}/changesets': 'persistence_changesets_post',
  }[operation];
  if (!operationId) return null;
  try {
    const result = await handlePersistenceOperation(operationId, {
      persistence, params, query: new URLSearchParams(query), body,
      requestHeaders: headers, requireAuthor: async () => 'owner',
    });
    if (result.status !== 400) return null;
    const { code, error } = result.body;
    if (code === 'INVALID_CURSOR' && operationId !== 'persistence_changesets_post') {
      return { status: 400, code, error };
    }
    if (operationId === 'persistence_nodes_get' && code === 'INVALID_QUERY' &&
        ['limit must be between 1 and 100', 'Knowledge filters are invalid'].includes(error)) {
      return { status: 400, code, error };
    }
    if (operationId === 'persistence_changesets_post' && code === 'INVALID_INPUT' &&
        ['Native operation project scope does not match the authorized project',
          'A ChangeSet cannot write the same native identity twice',
          'Native ChangeSet is empty or exceeds its bounded input limits'].includes(error)) {
      return { status: 400, code, error };
    }
    return null;
  } catch (error) {
    if (error === reachedStorage) return null;
    throw error;
  }
}
