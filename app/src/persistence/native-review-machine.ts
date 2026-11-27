import type { ChangeSet, ChangeSetApplicationResult } from '@codexia/persistence-contracts';
import { assign, fromPromise, setup } from 'xstate';
import type { AuthorReviewFeedItem } from '../api';

export interface NativeReviewDetail {
  changeSet: ChangeSet;
  receipt?: ChangeSetApplicationResult;
}

export type NativeReviewAction = 'approve' | 'reject' | 'apply';

export interface NativeReviewOutcome {
  kind: 'confirmed' | 'conflict' | 'unauthorized' | 'forbidden' | 'unknown';
  changeSets?: ChangeSet[];
  detail?: NativeReviewDetail;
  message: string;
}

export interface NativeReviewServices {
  load(
    projectId: string,
    canWrite: boolean,
    showCoreReviews: boolean,
    signal: AbortSignal,
  ): Promise<{
    changeSets: ChangeSet[];
    coreReviews: Array<Extract<AuthorReviewFeedItem, { kind: 'core-proposal' }>>;
  }>;
  approve(projectId: string, id: string, version: number, signal: AbortSignal): Promise<{ changeSet: ChangeSet }>;
  reject(projectId: string, id: string, version: number, signal: AbortSignal): Promise<{ changeSet: ChangeSet }>;
  apply(projectId: string, id: string, version: number, signal: AbortSignal): Promise<ChangeSetApplicationResult>;
  list(projectId: string, signal: AbortSignal): Promise<ChangeSet[]>;
  get(projectId: string, id: string, signal: AbortSignal): Promise<NativeReviewDetail>;
}

interface NativeReviewContext {
  projectId: string;
  canWrite: boolean;
  showCoreReviews: boolean;
  selectedId: string;
  requestedId: string;
  detail: NativeReviewDetail | null;
  changeSets: ChangeSet[];
  coreReviews: Array<Extract<AuthorReviewFeedItem, { kind: 'core-proposal' }>>;
  action: NativeReviewAction | null;
  message: string;
  applyVersions: ReadonlyMap<string, number>;
  outcome: NativeReviewOutcome | null;
  outcomeSequence: number;
}

type NativeReviewEvent =
  | { type: 'LOAD.REQUESTED'; requestedId?: string; canWrite?: boolean; showCoreReviews?: boolean }
  | { type: 'SELECT.REQUESTED'; id: string }
  | { type: 'ACTION'; action: NativeReviewAction };

function statusOf(context: NativeReviewContext): ChangeSet['status'] | null {
  return context.detail?.changeSet.status ?? null;
}

function conflictStatus(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'status' in error &&
      ((error as { status?: unknown }).status === 409 || (error as { status?: unknown }).status === 412),
  );
}

function errorStatus(error: unknown): number | null {
  return error && typeof error === 'object' && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : null;
}

function messageFor(error: unknown, action: NativeReviewAction): string {
  const status = errorStatus(error);
  const text =
    status === 409 || status === 412
      ? `提案の状態または前提条件が更新されています。最新状態を再確認してください。${error instanceof Error && error.message ? ` ${error.message}` : ''}`
      : status === 401
        ? '認証を確認できません。再ログインしてから状態を再確認してください。'
        : status === 403
          ? 'この操作は許可されていません。ChangeSetの状態を再確認してください。'
          : error instanceof Error
            ? error.message
            : 'ChangeSetの処理結果を確認できませんでした。';
  if (action === 'apply') return `${text} 適用receiptをサーバーから照合しています。`;
  return `${text} 結果をサーバーから照合しています。`;
}

function errorTextForRead(error: unknown): string {
  const status = errorStatus(error);
  if (status === 401) return '認証を確認できません。再ログインしてから一覧を再取得してください。';
  if (status === 403) return 'この提案を読む権限がありません。';
  if (status === 409 || status === 412)
    return `提案の状態が更新されています。最新状態を再取得してください。${error instanceof Error && error.message ? ` ${error.message}` : ''}`;
  return error instanceof Error ? error.message : '提案を読み込めませんでした。最新状態を再取得してください。';
}

export function createNativeReviewMachine(services: NativeReviewServices) {
  return setup({
    types: {
      context: {} as NativeReviewContext,
      events: {} as NativeReviewEvent,
      input: {} as { projectId: string },
    },
    actors: {
      loadFeed: fromPromise(
        async ({
          input,
          signal,
        }: {
          input: { projectId: string; canWrite: boolean; showCoreReviews: boolean; requestedId: string; selectedId: string };
          signal: AbortSignal;
        }) => {
          const { changeSets, coreReviews } = await services.load(input.projectId, input.canWrite, input.showCoreReviews, signal);
          if (changeSets.some(item => item.projectId !== input.projectId)) throw new Error('提案の作品スコープが一致しません。');
          const selectedId =
            input.requestedId && changeSets.some(item => item.id === input.requestedId)
              ? input.requestedId
              : changeSets.some(item => item.id === input.selectedId)
                ? input.selectedId
                : (changeSets[0]?.id ?? '');
          return { changeSets, coreReviews, selectedId };
        },
      ),
      inspect: fromPromise(async ({ input, signal }: { input: { projectId: string; id: string }; signal: AbortSignal }) => {
        const detail = await services.get(input.projectId, input.id, signal);
        if (detail.changeSet.projectId !== input.projectId || detail.changeSet.id !== input.id)
          throw new Error('ChangeSet詳細の識別子が一致しません。');
        return detail;
      }),
      performAndReconcile: fromPromise(
        async ({
          input,
          signal,
        }: {
          input: { projectId: string; detail: NativeReviewDetail; action: NativeReviewAction; version: number };
          signal: AbortSignal;
        }): Promise<NativeReviewOutcome> => {
          const { projectId, detail, action, version } = input;
          let actionError: unknown;
          let actionResult: NativeReviewDetail | undefined;
          try {
            if (action === 'approve') actionResult = await services.approve(projectId, detail.changeSet.id, version, signal);
            else if (action === 'reject') actionResult = await services.reject(projectId, detail.changeSet.id, version, signal);
            else {
              const receipt = await services.apply(projectId, detail.changeSet.id, version, signal);
              if (
                receipt.changeSet.projectId !== projectId ||
                receipt.changeSet.id !== detail.changeSet.id ||
                receipt.changeSet.status !== 'applied'
              ) {
                throw new Error('適用receiptの識別子または状態が一致しません。');
              }
              actionResult = { changeSet: receipt.changeSet, receipt };
            }
          } catch (error) {
            actionError = error;
          }

          try {
            const [changeSets, authoritative] = await Promise.all([
              services.list(projectId, signal).catch(() => undefined),
              services.get(projectId, detail.changeSet.id, signal),
            ]);
            if (authoritative.changeSet.projectId !== projectId || authoritative.changeSet.id !== detail.changeSet.id) {
              throw new Error('ChangeSet詳細の識別子が一致しません。');
            }
            const list = changeSets?.every(item => item.projectId === projectId) ? changeSets : undefined;
            const listRefreshMessage = list ? '' : ' 最新の一覧は再取得してください。';
            const result = authoritative;
            const denied = errorStatus(actionError) === 401 || errorStatus(actionError) === 403;
            const confirmed =
              !denied &&
              (action === 'apply'
                ? result.changeSet.status === 'applied' && Boolean(result.receipt)
                : result.changeSet.status === (action === 'approve' ? 'approved' : 'rejected'));
            return {
              kind: confirmed
                ? 'confirmed'
                : errorStatus(actionError) === 401
                  ? 'unauthorized'
                  : errorStatus(actionError) === 403
                    ? 'forbidden'
                    : actionError && conflictStatus(actionError)
                      ? 'conflict'
                      : 'unknown',
              changeSets: list,
              detail: result,
              message: confirmed
                ? action === 'approve'
                  ? `承認を確認しました。適用は別の明示操作です。${listRefreshMessage}`
                  : action === 'reject'
                    ? `却下を確認しました。正本への変更はありません。${listRefreshMessage}`
                    : result.receipt?.replayed
                      ? `適用receiptを再確認しました。${listRefreshMessage}`
                      : `適用receiptを確認しました。${listRefreshMessage}`
                : action === 'apply' && result.changeSet.status === 'approved' && !denied && !conflictStatus(actionError)
                  ? '適用receiptはまだ確認できません。再試行は同じChangeSet versionで行います。'
                  : messageFor(actionError ?? new Error('要求後の状態を確認できませんでした。'), action),
            };
          } catch (refreshError) {
            if (
              !actionError &&
              actionResult &&
              actionResult.changeSet.projectId === projectId &&
              actionResult.changeSet.id === detail.changeSet.id &&
              (action === 'apply'
                ? actionResult.changeSet.status === 'applied' && Boolean(actionResult.receipt)
                : actionResult.changeSet.status === (action === 'approve' ? 'approved' : 'rejected'))
            ) {
              return {
                kind: 'confirmed',
                detail: actionResult,
                message:
                  action === 'apply'
                    ? '適用receiptを確認しました。最新の一覧は再取得してください。'
                    : action === 'approve'
                      ? '承認を確認しました。適用は別の明示操作です。最新の一覧は再取得してください。'
                      : '却下を確認しました。最新の一覧は再取得してください。',
              };
            }
            return {
              kind:
                errorStatus(actionError ?? refreshError) === 401
                  ? 'unauthorized'
                  : errorStatus(actionError ?? refreshError) === 403
                    ? 'forbidden'
                    : conflictStatus(actionError)
                      ? 'conflict'
                      : 'unknown',
              message: `${messageFor(actionError ?? refreshError, action)} 最新状態の再確認を押してください。`,
            };
          }
        },
      ),
    },
    guards: {
      outcomeUnknown: ({ context }) => context.outcome?.kind === 'unknown',
      outcomeConflict: ({ context }) => context.outcome?.kind === 'conflict',
      outcomeUnauthorized: ({ context }) => context.outcome?.kind === 'unauthorized',
      outcomeForbidden: ({ context }) => context.outcome?.kind === 'forbidden',
      readUnauthorized: ({ event }) => 'error' in event && errorStatus(event.error) === 401,
      readForbidden: ({ event }) => 'error' in event && errorStatus(event.error) === 403,
      readConflict: ({ event }) => 'error' in event && conflictStatus(event.error),
      canApprove: ({ context, event }) => event.type === 'ACTION' && event.action === 'approve' && statusOf(context) === 'proposed',
      canReject: ({ context, event }) => event.type === 'ACTION' && event.action === 'reject' && statusOf(context) === 'proposed',
      canApply: ({ context, event }) => event.type === 'ACTION' && event.action === 'apply' && statusOf(context) === 'approved',
    },
    actions: {
      recordReadError: assign(({ event }) => ({ message: 'error' in event ? errorTextForRead(event.error) : '' })),
      beginLoad: assign(({ context, event }) => ({
        message: '',
        requestedId: event.type === 'LOAD.REQUESTED' ? (event.requestedId ?? '') : '',
        canWrite: event.type === 'LOAD.REQUESTED' ? (event.canWrite ?? context.canWrite) : context.canWrite,
        showCoreReviews: event.type === 'LOAD.REQUESTED' ? (event.showCoreReviews ?? context.showCoreReviews) : context.showCoreReviews,
      })),
      beginInspect: assign(({ event }) => (event.type === 'SELECT.REQUESTED' ? { selectedId: event.id, detail: null, message: '' } : {})),
      beginAction: assign(({ context, event }) => {
        if (event.type !== 'ACTION' || !context.detail) return {};
        const { id, version } = context.detail.changeSet;
        const applyVersions = new Map(context.applyVersions);
        if (event.action === 'apply' && !applyVersions.has(id)) applyVersions.set(id, version);
        return { action: event.action, message: '', outcome: null, applyVersions };
      }),
    },
  }).createMachine({
    id: 'nativeChangeSetReview',
    initial: 'idle',
    context: ({ input }) => ({
      projectId: input.projectId,
      canWrite: false,
      showCoreReviews: false,
      selectedId: '',
      requestedId: '',
      detail: null,
      changeSets: [],
      coreReviews: [],
      action: null,
      message: '',
      applyVersions: new Map(),
      outcome: null,
      outcomeSequence: 0,
    }),
    states: {
      idle: {
        on: {
          'LOAD.REQUESTED': { target: 'loading', actions: 'beginLoad' },
          'SELECT.REQUESTED': { target: 'inspecting', actions: 'beginInspect' },
          ACTION: [
            { guard: 'canApprove', target: 'working', actions: 'beginAction' },
            { guard: 'canReject', target: 'working', actions: 'beginAction' },
            { guard: 'canApply', target: 'working', actions: 'beginAction' },
          ],
        },
      },
      unknown: {
        on: {
          'LOAD.REQUESTED': { target: 'loading', actions: 'beginLoad' },
          'SELECT.REQUESTED': { target: 'inspecting', actions: 'beginInspect' },
          ACTION: [
            { guard: 'canApprove', target: 'working', actions: 'beginAction' },
            { guard: 'canReject', target: 'working', actions: 'beginAction' },
            { guard: 'canApply', target: 'working', actions: 'beginAction' },
          ],
        },
      },
      conflict: {
        on: {
          'LOAD.REQUESTED': { target: 'loading', actions: 'beginLoad' },
          'SELECT.REQUESTED': { target: 'inspecting', actions: 'beginInspect' },
        },
      },
      confirmed: {
        on: {
          'LOAD.REQUESTED': { target: 'loading', actions: 'beginLoad' },
          'SELECT.REQUESTED': { target: 'inspecting', actions: 'beginInspect' },
          ACTION: [
            { guard: 'canApprove', target: 'working', actions: 'beginAction' },
            { guard: 'canReject', target: 'working', actions: 'beginAction' },
            { guard: 'canApply', target: 'working', actions: 'beginAction' },
          ],
        },
      },
      working: {
        invoke: {
          src: 'performAndReconcile',
          input: ({ context }) => {
            const { action, applyVersions, detail, projectId } = context;
            if (!action || !detail) throw new Error('ChangeSet操作の対象がありません。');
            const { id, version } = detail.changeSet;
            return { projectId, detail, action, version: action === 'apply' ? (applyVersions.get(id) ?? version) : version };
          },
          onDone: {
            target: 'settling',
            actions: assign(({ context, event }) => {
              const outcome = event.output as NativeReviewOutcome;
              const applyVersions = new Map(context.applyVersions);
              if (context.action === 'apply' && outcome.kind !== 'unknown') applyVersions.delete(context.selectedId);
              return {
                outcome,
                outcomeSequence: context.outcomeSequence + 1,
                detail: outcome.detail ?? context.detail,
                changeSets: outcome.changeSets ?? context.changeSets,
                message: outcome.message,
                applyVersions,
              };
            }),
          },
          onError: {
            target: 'settling',
            actions: assign(({ context, event }) => ({
              outcome: { kind: 'unknown', message: messageFor(event.error, context.action ?? 'apply') } satisfies NativeReviewOutcome,
              outcomeSequence: context.outcomeSequence + 1,
              message: messageFor(event.error, context.action ?? 'apply'),
            })),
          },
        },
      },
      loading: {
        on: { 'LOAD.REQUESTED': { target: 'loading', reenter: true, actions: 'beginLoad' } },
        invoke: {
          src: 'loadFeed',
          input: ({ context }) => ({
            projectId: context.projectId,
            canWrite: context.canWrite,
            showCoreReviews: context.showCoreReviews,
            requestedId: context.requestedId,
            selectedId: context.selectedId,
          }),
          onDone: {
            target: 'inspectLoaded',
            actions: assign(({ context, event }) => {
              const result = event.output as {
                changeSets: ChangeSet[];
                coreReviews: NativeReviewContext['coreReviews'];
                selectedId: string;
              };
              return {
                changeSets: result.changeSets,
                coreReviews: result.coreReviews,
                selectedId: result.selectedId,
                detail: null,
                outcome: null,
                message: '',
              };
            }),
          },
          onError: { target: 'readFailed', actions: 'recordReadError' },
        },
      },
      inspectLoaded: {
        always: [{ guard: ({ context }) => Boolean(context.selectedId), target: 'inspecting' }, { target: 'idle' }],
      },
      inspecting: {
        on: {
          'LOAD.REQUESTED': { target: 'loading', actions: 'beginLoad' },
          'SELECT.REQUESTED': { target: 'inspecting', reenter: true, actions: 'beginInspect' },
        },
        invoke: {
          src: 'inspect',
          input: ({ context }) => ({ projectId: context.projectId, id: context.selectedId }),
          onDone: [
            {
              guard: ({ context, event }) =>
                context.applyVersions.has(event.output.changeSet.id) &&
                event.output.changeSet.status === 'applied' &&
                Boolean(event.output.receipt),
              target: 'confirmed',
              actions: assign(({ context, event }) => {
                const detail = event.output;
                const applyVersions = new Map(context.applyVersions);
                applyVersions.delete(detail.changeSet.id);
                const message = '適用receiptを再確認しました。';
                return {
                  detail,
                  applyVersions,
                  outcome: { kind: 'confirmed', detail, message } satisfies NativeReviewOutcome,
                  outcomeSequence: context.outcomeSequence + 1,
                  message,
                };
              }),
            },
            {
              target: 'idle',
              actions: assign(({ event }) => ({ detail: event.output, outcome: null, message: '' })),
            },
          ],
          onError: { target: 'readFailed', actions: 'recordReadError' },
        },
      },
      settling: {
        always: [
          { guard: 'outcomeUnknown', target: 'unknown' },
          { guard: 'outcomeConflict', target: 'conflict' },
          { guard: 'outcomeUnauthorized', target: 'unauthorized' },
          { guard: 'outcomeForbidden', target: 'forbidden' },
          { target: 'confirmed' },
        ],
      },
      readFailed: {
        always: [
          { guard: 'readUnauthorized', target: 'unauthorized' },
          { guard: 'readForbidden', target: 'forbidden' },
          { guard: 'readConflict', target: 'conflict' },
          { guard: 'outcomeConflict', target: 'conflict' },
          { guard: 'outcomeUnknown', target: 'unknown' },
          { guard: 'outcomeUnauthorized', target: 'unauthorized' },
          { guard: 'outcomeForbidden', target: 'forbidden' },
          { target: 'idle' },
        ],
      },
      unauthorized: {
        on: {
          'LOAD.REQUESTED': { target: 'loading', actions: 'beginLoad' },
          'SELECT.REQUESTED': { target: 'inspecting', actions: 'beginInspect' },
        },
      },
      forbidden: {
        on: {
          'LOAD.REQUESTED': { target: 'loading', actions: 'beginLoad' },
          'SELECT.REQUESTED': { target: 'inspecting', actions: 'beginInspect' },
        },
      },
    },
  });
}
