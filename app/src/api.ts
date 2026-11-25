import { coreApi } from './api-core';
import { documentApi } from './api-documents';
import { knowledgeApi } from './api-knowledge';

export type { EditorSnapshotRead, InboxItem, JobEvent, PublicJob } from './api-core';
export { ApiError } from './api-error';
export type { AuthorReviewFeedItem, PersistenceAnchorView, PersistenceNodeRead } from './api-knowledge';
export {
  DocumentDepartureError,
  setOAuthAccessToken,
} from './api-transport';
export type { PersistenceStatusResponse as PersistenceStatus } from './generated/http/schemas/persistenceStatusResponse.zod';

/** Outline view model assembled from persisted documents. */
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

export const api = { ...coreApi, ...documentApi, ...knowledgeApi };
