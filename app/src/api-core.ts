import { assertChangeOperation } from '@codexia/contracts';
import type {
  ActionResult,
  ApplyReceipt,
  Approval,
  ChangeOperation,
  ChangeProposal,
  ModuleStatus,
  ProposalStatus,
  RecentActivityInput,
  RecentActivityResponse,
  SnapshotId,
  UiContribution,
} from '@codexia/contracts';
import * as generated from './generated/http/client';
import * as generatedSchemas from './generated/http/schemas';
import type * as wire from './generated/http/schemas';
import { ApiError } from './api-error';
import { hasNativeApiSession } from './api-transport';

export type JobStatus = wire.PublicJobBody['status'];
export type PublicJob = wire.PublicJobBody;
export type InboxItem = wire.InboxItemBody;
export type InboxListResponse = wire.InboxListBody;
export type Session = wire.ApiSessionBody;
export type RuntimeVersion = wire.DesktopVersionResponse;
export type EditorSnapshotRead = wire.ProjectSnapshotResponse;
export type JobEvent = {
  type: 'job-status' | 'job-progress';
  jobId: string;
  jobType: string;
  status: JobStatus;
  progress: number | null;
  error?: string;
  at: string;
};

function assertProposalStatus(status: wire.CoreProposalStatusBody): asserts status is wire.CoreProposalStatusBody & {
  proposal: ChangeProposal;
  applications: ApplyReceipt[];
} {
  for (const operation of status.proposal.operations) assertChangeOperation(operation);
}

function validateProposalStatus(status: wire.CoreProposalStatusBody): ProposalStatus {
  try {
    assertProposalStatus(status);
  } catch {
    throw new ApiError('The server returned an invalid response', 502, 'INVALID_RESPONSE');
  }
  return status as unknown as ProposalStatus;
}

function validateProposalStatuses(response: wire.ProposalListBody): { proposals: ProposalStatus[] } {
  return { proposals: response.proposals.map(validateProposalStatus) };
}

function invalidResponse(): never {
  throw new ApiError('The server returned an invalid response', 502, 'INVALID_RESPONSE');
}

function validateActionResult(response: wire.DesktopActionResultBody): ActionResult {
  const result: unknown = response;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return invalidResponse();
  const value = result as Record<string, unknown>;
  const snapshot = value.snapshot;
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    typeof (snapshot as Record<string, unknown>).projectId !== 'string' ||
    !Number.isSafeInteger((snapshot as Record<string, unknown>).projectVersion) ||
    Number((snapshot as Record<string, unknown>).projectVersion) < 1
  ) return invalidResponse();
  if (value.ok === true) {
    if (!('data' in value) || (value.proposals !== undefined && !Array.isArray(value.proposals))) return invalidResponse();
    if (Array.isArray(value.proposals)) {
      for (const proposal of value.proposals) {
        if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return invalidResponse();
        const operations = (proposal as Record<string, unknown>).operations;
        if (!Array.isArray(operations)) return invalidResponse();
        try {
          for (const operation of operations) assertChangeOperation(operation);
        } catch {
          return invalidResponse();
        }
      }
    }
    return value as unknown as ActionResult;
  }
  if (value.ok === false) {
    const error = value.error;
    if (
      !error || typeof error !== 'object' || Array.isArray(error) ||
      typeof (error as Record<string, unknown>).code !== 'string' ||
      typeof (error as Record<string, unknown>).message !== 'string' ||
      typeof (error as Record<string, unknown>).retryable !== 'boolean'
    ) return invalidResponse();
    return value as unknown as ActionResult;
  }
  return invalidResponse();
}

function requestOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

/** Desktop Web core operations generated from the TypeSpec HTTP contract. */
export const coreApi = {
  version: (): Promise<RuntimeVersion> =>
    hasNativeApiSession() ? generated.apiVersionGet() : generated.apiBrowserVersionGet(),
  session: (): Promise<Session> => generated.apiSessionGet(),
  jobs: (signal?: AbortSignal): Promise<PublicJob[]> => generated.jobsListGet(requestOptions(signal)),
  job: (jobId: string, signal?: AbortSignal): Promise<PublicJob> => generated.jobGet(jobId, requestOptions(signal)),
  inbox: (unreadOnly = false, signal?: AbortSignal): Promise<InboxListResponse> =>
    generated.inboxListGet(unreadOnly ? { unread: '1' } : undefined, requestOptions(signal)),
  markInboxRead: async (id: string, signal?: AbortSignal): Promise<InboxItem> =>
    (await generated.inboxItemReadPost(id, requestOptions(signal))).item,
  markAllInboxRead: (signal?: AbortSignal): Promise<wire.InboxReadAllBody> => generated.inboxReadAllPost(requestOptions(signal)),
  jobEventStream: (signal: AbortSignal): Promise<Response> =>
    generated.jobEventsGet({ signal, responseMode: 'raw' }) as unknown as Promise<Response>,
  recentActivity: (projectId: string, signal?: AbortSignal): Promise<RecentActivityResponse> =>
    generated.projectRecentActivityGet(projectId, requestOptions(signal)) as Promise<RecentActivityResponse>,
  putRecentActivity: (
    projectId: string,
    input: RecentActivityInput,
    options: { signal?: AbortSignal; keepalive?: boolean; order?: string } = {},
  ): Promise<RecentActivityResponse> => {
    const { order, ...init } = options;
    const headers = order ? { 'X-Codexia-Recent-Activity-Order': order } : undefined;
    return generated.projectRecentActivityPut(projectId, { ...input }, {
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.keepalive !== undefined ? { keepalive: init.keepalive } : {}),
      ...(headers ? { headers } : {}),
    }) as Promise<RecentActivityResponse>;
  },
  proposalStatuses: async (projectId: string): Promise<{ proposals: ProposalStatus[] }> =>
    validateProposalStatuses(await generated.projectProposalsListGet(projectId)),
  propose: async (projectId: string, proposal: ChangeProposal, signal?: AbortSignal): Promise<ChangeProposal> => {
    const response = await generated.projectProposalsCreatePost(projectId, { ...proposal }, requestOptions(signal));
    try {
      for (const operation of response.operations) assertChangeOperation(operation);
    } catch {
      throw new ApiError('The server returned an invalid response', 502, 'INVALID_RESPONSE');
    }
    return response as unknown as ChangeProposal;
  },
  approve: (projectId: string, approval: Approval, signal?: AbortSignal): Promise<void> =>
    generated.projectApprovalsPost(projectId, { ...approval }, { ...requestOptions(signal), responseMode: 'no-content' }).then(() => undefined),
  apply: (projectId: string, operation: ChangeOperation, signal?: AbortSignal): Promise<ApplyReceipt> =>
    generated.projectApplyPost(projectId, { ...operation }, requestOptions(signal)) as Promise<ApplyReceipt>,
  moduleSnapshot: async (projectId: string, documentId?: string): Promise<EditorSnapshotRead> => {
    const result = await generated.projectSnapshotGet(
      projectId,
      { projection: 'editor', ...(documentId ? { documentId } : {}) },
    );
    const expectedPath = documentId ? `documents/${documentId}.md` : undefined;
    if (result.document && result.document.path !== expectedPath) {
      throw new ApiError('The server returned a different editor document', 502, 'INVALID_RESPONSE');
    }
    return result;
  },
  modules: (projectId: string): Promise<ModuleStatus[]> =>
    generated.projectModulesGet(projectId) as Promise<ModuleStatus[]>,
  contributions: (projectId: string): Promise<UiContribution[]> =>
    generated.projectContributionsGet(projectId) as Promise<UiContribution[]>,
  action: (
    projectId: string,
    actionId: string,
    input: unknown,
    signal?: AbortSignal,
    snapshot?: SnapshotId,
  ): Promise<ActionResult> =>
    generated.projectActionPost(projectId, actionId, { input, ...(snapshot ? { snapshot } : {}) }, {
      ...requestOptions(signal),
      schema: generatedSchemas.DesktopActionResultBody,
    })
      .then(response => validateActionResult(response as unknown as wire.DesktopActionResultBody)),
  resolveDocumentReference: async (projectId: string, path: string, snapshot?: SnapshotId): Promise<string | null> => {
    const resolution = await coreApi.action(projectId, 'core.document.resolve', { path }, undefined, snapshot);
    if (!resolution.ok) throw new Error(resolution.error.message);
    const { data } = resolution;
    if (
      resolution.snapshot.projectId !== projectId ||
      (snapshot && resolution.snapshot.projectVersion !== snapshot.projectVersion) ||
      !data ||
      typeof data !== 'object' ||
      !('documentId' in data) ||
      (data.documentId !== null && (typeof data.documentId !== 'string' || !data.documentId.trim()))
    ) {
      throw new ApiError('The server returned an invalid document reference', 502, 'INVALID_RESPONSE');
    }
    return data.documentId;
  },
};
