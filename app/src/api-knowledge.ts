import type { ApplyReceipt, NativeChangeSetReference, ProposalStatus } from '@codexia/contracts';
import type {
  Assertion,
  AssertionEvidence,
  ChangeSet,
  ChangeSetApplicationResult,
  EvidenceAnchor,
  KnowledgeAlias,
  KnowledgeNode,
  KnowledgeRelation,
  MentionLink,
  SaveAssertionCommand,
  SaveEvidenceAnchorCommand,
  SaveKnowledgeAliasCommand,
  SaveKnowledgeNodeCommand,
  SaveKnowledgeRelationCommand,
  SaveMentionLinkCommand,
} from '@codexia/persistence-contracts';
import { ApiError } from './api-error';
import { PersistenceChangeSetDesktopBody } from './generated/http/schemas/persistenceChangeSetDesktopBody.zod';
export type AuthorReviewFeedItem =
  | {
      kind: 'core-proposal';
      id: string;
      projectId: string;
      createdAt: string;
      state: ProposalStatus['state'];
      approvalModel: 'per-operation';
      applicationModel: 'per-operation';
      status: ProposalStatus;
      receipts: ApplyReceipt[];
      stale: boolean;
    }
  | {
      kind: 'native-change-set';
      id: string;
      projectId: string;
      createdAt: string;
      state: ChangeSet['status'];
      approvalModel: 'whole-change-set';
      applicationModel: 'transaction';
      changeSet: ChangeSet;
      receipt: ChangeSetApplicationResult | null;
    };

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

export interface PersistenceMergePreviewRead {
  projectVersion: number;
  previewDigest: string;
  source: KnowledgeNode;
  target: KnowledgeNode;
  conflicts: string[];
  sourceAliases: KnowledgeAlias[];
  targetAliases: KnowledgeAlias[];
  sourceRelations: KnowledgeRelation[];
  targetRelations: KnowledgeRelation[];
  sourceMentions: MentionLink[];
  targetMentions: MentionLink[];
  assertions: Assertion[];
}

import {
  persistenceAnchorAssertionsPost,
  persistenceAnchorMentionsPost,
  persistenceAssertionEvidenceGet,
  persistenceAssertionEvidencePost,
  persistenceAssertionGet,
  persistenceAssertionPut,
  persistenceChangesetApplyPost,
  persistenceChangesetApprovePost,
  persistenceChangesetGet,
  persistenceChangesetRejectPost,
  persistenceChangesetsGet,
  persistenceDocumentAnchorPatch,
  persistenceDocumentAnchorsGet,
  persistenceDocumentAnchorsPost,
  persistenceNodeAliasesPost,
  persistenceNodeEvidenceGet,
  persistenceNodeGet,
  persistenceNodeMergePost,
  persistenceNodeMergePreviewPost,
  persistenceNodePut,
  persistenceNodeRelationsPost,
  persistenceNodesGet,
  persistenceReviewFeedGet,
} from './generated/http/client';

function invalidResponse(): never {
  throw new ApiError('The server returned an invalid response', 502, 'INVALID_RESPONSE');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function options(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

function assertChangeSetProjectBinding(value: unknown): asserts value is ChangeSet {
  const parsed = PersistenceChangeSetDesktopBody.safeParse(value);
  if (!parsed.success) return invalidResponse();
  const changeSet = parsed.data as unknown as ChangeSet;
  for (const operation of changeSet.operations) {
    if (operation.command.projectId !== changeSet.projectId) {
      return invalidResponse();
    }
  }
}

function checkedProjectChangeSet<T extends { changeSet: ChangeSet }>(envelope: T): T {
  const changeSet = envelope.changeSet;
  assertChangeSetProjectBinding(changeSet);
  if (
    'receipt' in envelope &&
    envelope.receipt &&
    record(envelope.receipt) &&
    record(envelope.receipt.changeSet) &&
    (envelope.receipt.changeSet.id !== changeSet.id || envelope.receipt.changeSet.projectId !== changeSet.projectId)
  ) {
    return invalidResponse();
  }
  return envelope;
}

/**
 * Persistence Knowledge API methods. Orval validates each wire response in
 * the generated transport; the domain guards below retain invariants that the
 * wire schema cannot express, including branded IDs and related-record
 * identity checks.
 */
export const knowledgeApi = {
  nativeChangeSets: async (projectId: string, limit = 50, signal?: AbortSignal): Promise<{ changeSets: ChangeSet[] }> => {
    const result = await persistenceChangesetsGet(projectId, { limit }, options(signal));
    if (!Array.isArray(result.changeSets)) return invalidResponse();
    const changeSets = result.changeSets as unknown as ChangeSet[];
    for (const changeSet of changeSets) assertChangeSetProjectBinding(changeSet);
    return { ...result, changeSets };
  },

  authorReviewFeed: async (projectId: string, limit = 50, signal?: AbortSignal): Promise<{ items: AuthorReviewFeedItem[] }> => {
    const response = await persistenceReviewFeedGet(projectId, { limit }, options(signal));
    if (!Array.isArray(response.items)) return invalidResponse();
    const items = response.items as unknown as AuthorReviewFeedItem[];
    for (const item of items) {
      if (item.kind === 'native-change-set') {
        if (
          item.changeSet.id !== item.id ||
          item.changeSet.projectId !== item.projectId ||
          item.changeSet.status !== item.state ||
          item.changeSet.createdAt !== item.createdAt
        ) {
          return invalidResponse();
        }
        checkedProjectChangeSet({ changeSet: item.changeSet, receipt: item.receipt ?? undefined });
      } else if (
        item.status.proposal.id !== item.id ||
        item.status.proposal.snapshot.projectId !== item.projectId ||
        item.status.state !== item.state ||
        JSON.stringify(item.receipts) !== JSON.stringify(item.status.applications)
      ) {
        return invalidResponse();
      }
    }
    return { ...response, items };
  },

  nativeChangeSet: async (
    projectId: string,
    changeSetId: string,
    signal?: AbortSignal,
  ): Promise<{ changeSet: ChangeSet; receipt?: ChangeSetApplicationResult }> => {
    const result = (await persistenceChangesetGet(projectId, changeSetId, options(signal))) as unknown as {
      changeSet: ChangeSet;
      receipt?: ChangeSetApplicationResult;
    };
    if (result.receipt === null) return invalidResponse();
    return checkedProjectChangeSet(result);
  },

  approveNativeChangeSet: async (
    projectId: string,
    changeSetId: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<{ changeSet: ChangeSet }> =>
    checkedProjectChangeSet(
      (await persistenceChangesetApprovePost(projectId, changeSetId, { expectedVersion }, options(signal))) as unknown as {
        changeSet: ChangeSet;
      },
    ),

  rejectNativeChangeSet: async (
    projectId: string,
    changeSetId: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<{ changeSet: ChangeSet }> =>
    checkedProjectChangeSet(
      (await persistenceChangesetRejectPost(projectId, changeSetId, { expectedVersion }, options(signal))) as unknown as {
        changeSet: ChangeSet;
      },
    ),

  applyNativeChangeSet: async (
    projectId: string,
    changeSetId: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<ChangeSetApplicationResult> => {
    const application = (await persistenceChangesetApplyPost(
      projectId,
      changeSetId,
      { expectedVersion },
      options(signal),
    )) as unknown as ChangeSetApplicationResult;
    if (application.changeSet.status !== 'applied') return invalidResponse();
    return checkedProjectChangeSet(application);
  },

  persistenceKnowledgePage: async (
    projectId: string,
    filters: { q: string; type: string; status: string; cursor?: string },
    signal?: AbortSignal,
  ): Promise<PersistenceKnowledgePage> => {
    const { status } = filters;
    if (status !== '' && status !== 'confirmed' && status !== 'proposed' && status !== 'retired') {
      throw new TypeError('Invalid knowledge status filter');
    }
    const page = await persistenceNodesGet(
      projectId,
      {
        limit: 50,
        q: filters.q,
        type: filters.type,
        status,
        ...(filters.cursor ? { cursor: filters.cursor } : {}),
      },
      options(signal),
    );
    return page as unknown as PersistenceKnowledgePage;
  },

  persistenceDocumentAnchors: async (
    projectId: string,
    documentId: string,
    revisionId?: string,
    signal?: AbortSignal,
  ): Promise<PersistenceDocumentAnchors> =>
    (await persistenceDocumentAnchorsGet(
      projectId,
      documentId,
      {
        ...(revisionId ? { revision: revisionId } : {}),
        limit: 500,
      },
      options(signal),
    )) as unknown as PersistenceDocumentAnchors,

  createPersistenceAnchor: async (
    projectId: string,
    documentId: string,
    input: Pick<SaveEvidenceAnchorCommand, 'id' | 'revisionId' | 'fromUtf16' | 'toUtf16'> & {
      status: 'proposed' | 'confirmed';
      nodeId?: string;
    },
    signal?: AbortSignal,
  ) => {
    const created = await persistenceDocumentAnchorsPost(projectId, documentId, input, options(signal));
    if (
      !record(created) ||
      !record(created.anchor) ||
      typeof created.anchor.fromUtf16 !== 'number' ||
      typeof created.anchor.toUtf16 !== 'number' ||
      created.anchor.toUtf16 < created.anchor.fromUtf16
    )
      return invalidResponse();
    return created as typeof created & { anchor: EvidenceAnchor };
  },

  updatePersistenceAnchor: async (
    projectId: string,
    documentId: string,
    evidenceId: string,
    input: Pick<SaveEvidenceAnchorCommand, 'revisionId' | 'fromUtf16' | 'toUtf16' | 'status' | 'expectedVersion'>,
    signal?: AbortSignal,
  ): Promise<EvidenceAnchor> => {
    const result = await persistenceDocumentAnchorPatch(
      projectId,
      documentId,
      evidenceId,
      input as unknown as Parameters<typeof persistenceDocumentAnchorPatch>[3],
      options(signal),
    );
    if (result.toUtf16 < result.fromUtf16) return invalidResponse();
    return result as unknown as EvidenceAnchor;
  },

  savePersistenceMention: async (
    projectId: string,
    documentId: string,
    evidenceId: string,
    input: Pick<SaveMentionLinkCommand, 'nodeId' | 'status'>,
    signal?: AbortSignal,
  ): Promise<MentionLink> => {
    const result = await persistenceAnchorMentionsPost(projectId, documentId, evidenceId, input, options(signal));
    return result as unknown as MentionLink;
  },

  persistenceNode: async (projectId: string, nodeId: string, signal?: AbortSignal): Promise<PersistenceNodeRead> =>
    (await persistenceNodeGet(projectId, nodeId, undefined, options(signal))) as unknown as PersistenceNodeRead,

  savePersistenceNode: async (
    projectId: string,
    nodeId: string,
    command: Omit<SaveKnowledgeNodeCommand, 'projectId' | 'id'>,
    signal?: AbortSignal,
  ): Promise<{ node: KnowledgeNode }> =>
    (await persistenceNodePut(projectId, nodeId, command, options(signal))) as unknown as { node: KnowledgeNode },

  previewPersistenceMerge: async (projectId: string, nodeId: string, targetId: string): Promise<PersistenceMergePreviewRead> =>
    (await persistenceNodeMergePreviewPost(projectId, nodeId, { targetId })) as unknown as PersistenceMergePreviewRead,

  applyPersistenceMerge: async (
    projectId: string,
    nodeId: string,
    targetId: string,
    projectVersion: number,
    previewDigest: string,
  ): Promise<{ source: KnowledgeNode; target: KnowledgeNode; auditId: string }> =>
    (await persistenceNodeMergePost(projectId, nodeId, { targetId, projectVersion, previewDigest, confirm: true })) as unknown as {
      source: KnowledgeNode;
      target: KnowledgeNode;
      auditId: string;
    },

  savePersistenceAlias: async (
    projectId: string,
    nodeId: string,
    command: Omit<SaveKnowledgeAliasCommand, 'projectId' | 'nodeId'>,
    signal?: AbortSignal,
  ): Promise<{ alias: KnowledgeAlias }> =>
    (await persistenceNodeAliasesPost(projectId, nodeId, command, options(signal))) as unknown as { alias: KnowledgeAlias },

  savePersistenceRelation: async (
    projectId: string,
    nodeId: string,
    command: Omit<SaveKnowledgeRelationCommand, 'projectId' | 'sourceId'>,
    signal?: AbortSignal,
  ): Promise<{ relation: KnowledgeRelation }> =>
    (await persistenceNodeRelationsPost(projectId, nodeId, command, options(signal))) as unknown as { relation: KnowledgeRelation },

  persistenceNodeEvidence: async (
    projectId: string,
    nodeId: string,
    limit = 200,
    signal?: AbortSignal,
  ): Promise<{ evidence: PersistenceAnchorView[] }> =>
    (await persistenceNodeEvidenceGet(projectId, nodeId, { limit }, options(signal))) as unknown as { evidence: PersistenceAnchorView[] },

  createPersistenceAnchorAssertion: async (
    projectId: string,
    documentId: string,
    evidenceId: string,
    command: {
      id: string;
      nodeId: string;
      statement: string;
      modality: 'fact' | 'belief' | 'disclosure' | 'hypothesis';
      perspective: string;
      revisionId: string;
      expectedAnchorVersion: number;
    },
    signal?: AbortSignal,
  ): Promise<{ assertion: Assertion }> =>
    (await persistenceAnchorAssertionsPost(projectId, documentId, evidenceId, command, options(signal))) as unknown as {
      assertion: Assertion;
    },

  persistenceAssertion: async (projectId: string, assertionId: string, signal?: AbortSignal): Promise<PersistenceAssertionRead> =>
    (await persistenceAssertionGet(projectId, assertionId, undefined, options(signal))) as unknown as PersistenceAssertionRead,

  savePersistenceAssertion: async (
    projectId: string,
    assertionId: string,
    command: Omit<SaveAssertionCommand, 'projectId' | 'id'>,
    signal?: AbortSignal,
  ): Promise<{ assertion: Assertion }> =>
    (await persistenceAssertionPut(projectId, assertionId, command, options(signal))) as unknown as { assertion: Assertion },

  persistenceAssertionEvidence: async (
    projectId: string,
    assertionId: string,
    signal?: AbortSignal,
  ): Promise<PersistenceAssertionEvidenceRead> =>
    (await persistenceAssertionEvidenceGet(
      projectId,
      assertionId,
      undefined,
      options(signal),
    )) as unknown as PersistenceAssertionEvidenceRead,

  linkPersistenceAssertionEvidence: async (
    projectId: string,
    assertionId: string,
    command: Pick<AssertionEvidence, 'evidenceId' | 'role'>,
    signal?: AbortSignal,
  ): Promise<{ evidence: AssertionEvidence }> =>
    (await persistenceAssertionEvidencePost(projectId, assertionId, command, options(signal))) as unknown as {
      evidence: AssertionEvidence;
    },
};

/** Decode an action payload's native ChangeSet as either a full schema-checked record or a narrow reference. */
export function readActionChangeSet(value: unknown, referenceOnly: boolean): NativeChangeSetReference {
  if (!record(value) || !record(value.changeSet)) return invalidResponse();
  const changeSet = value.changeSet;
  if (referenceOnly) {
    if (
      typeof changeSet.projectId !== 'string' ||
      !changeSet.projectId ||
      typeof changeSet.id !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(changeSet.id)
    ) {
      return invalidResponse();
    }
    return { id: changeSet.id, projectId: changeSet.projectId };
  }
  assertChangeSetProjectBinding(changeSet);
  const full = changeSet as unknown as ChangeSet;
  return { id: full.id, projectId: full.projectId };
}
