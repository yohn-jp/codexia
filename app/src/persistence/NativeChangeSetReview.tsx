import type { ChangeSet, ChangeSetApplicationResult, ChangeSetOperation, SaveEvidenceAnchorCommand } from '@codexia/persistence-contracts';
import { useActorRef, useSelector } from '@xstate/react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AuthorReviewFeedItem, api } from '../api';
import { ApiError } from '../api-error';
import { createNativeReviewMachine } from './native-review-machine';
import './NativeChangeSetReview.css';

type Detail = { changeSet: ChangeSet; receipt?: ChangeSetApplicationResult };

function errorText(error: unknown): string {
  if (error instanceof ApiError && (error.status === 409 || error.status === 412))
    return `提案の状態または前提条件が更新されています。最新状態を再確認してください。${error.message ? ` ${error.message}` : ''}`;
  if (error instanceof ApiError && error.status === 401) return '認証を確認できません。再ログインしてから状態を再確認してください。';
  return error instanceof Error ? error.message : 'ChangeSetの処理結果を確認できませんでした。';
}

function sourceProjectVersion(changeSet: ChangeSet): string {
  const value = changeSet.provenance.details.projectVersion;
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '記録なし';
}

function statusLabel(status: ChangeSet['status']): string {
  return { proposed: '提案', approved: '承認済み・未適用', applied: '適用済み', rejected: '却下' }[status];
}

function coreProposalStateLabel(state: Extract<AuthorReviewFeedItem, { kind: 'core-proposal' }>['state']): string {
  return { proposed: '承認待ち', partially_approved: '一部承認済み', approved: '承認済み・適用待ち', applied: '適用済み' }[state];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergePlanName(plan: Record<string, unknown>, key: 'source' | 'target'): string {
  const value = plan[key];
  return isRecord(value) && typeof value.name === 'string' ? value.name : 'Knowledge node';
}

function mergePlanConflicts(plan: Record<string, unknown>): string[] {
  return Array.isArray(plan.conflicts) ? plan.conflicts.filter((item): item is string => typeof item === 'string') : [];
}

function mergeWriteCount(changeSet: ChangeSet, resource: ChangeSet['writeSet'][number]['resource']): number {
  return changeSet.writeSet.filter(entry => entry.resource === resource).length;
}

function sourceLabel(source: string): string {
  if (source === 'native-knowledge-service') return '知識機能';
  if (source.startsWith('story.')) return '物語支援';
  if (source.startsWith('speaker.')) return '話者支援';
  if (source.startsWith('search.')) return '検索支援';
  return '作品内の提案';
}

type ReviewField = { label: string; value: unknown };

function operationLabel(operation: ChangeSetOperation): string {
  switch (operation.type) {
    case 'document.update':
      return '文書の情報を更新';
    case 'document.delete':
      return '文書を削除';
    case 'module.record.save':
      return 'モジュール記録を更新';
    case 'document.create':
      return '文書を作成';
    case 'document.save':
      return '原稿を変更';
    case 'document.restore':
      return '原稿Revisionを復元';
    case 'knowledge.node.save':
      return '知識を更新';
    case 'knowledge.alias.save':
      return '別名を登録';
    case 'knowledge.relation.save':
      return '関係を登録';
    case 'evidence.anchor.save':
      return '引用根拠を登録';
    case 'evidence.mention.save':
      return '根拠と知識を結ぶ';
    case 'evidence.assertion.save':
      return '命題を更新';
    case 'evidence.assertion.link':
      return '命題と根拠を結ぶ';
    case 'knowledge.merge':
      return '知識を統合';
    default:
      return '未対応の操作';
  }
}

function operationTarget(operation: ChangeSetOperation): string {
  switch (operation.type) {
    case 'document.update':
    case 'document.delete':
    case 'document.save':
    case 'document.restore':
      return operation.command.documentId;
    case 'document.create':
      return operation.command.title;
    case 'module.record.save':
      return operation.command.moduleId + ' · ' + operation.command.key;
    case 'knowledge.node.save':
      return operation.command.name || operation.command.id;
    case 'knowledge.alias.save':
      return operation.command.surface || operation.command.nodeId;
    case 'knowledge.relation.save':
      return operation.command.sourceId + ' → ' + operation.command.targetId;
    case 'evidence.anchor.save':
      return '原稿 ' + operation.command.documentId;
    case 'evidence.mention.save':
      return '知識 ' + operation.command.nodeId;
    case 'evidence.assertion.save':
      return operation.command.id;
    case 'evidence.assertion.link':
      return operation.command.assertionId;
    case 'knowledge.merge':
      return mergePlanName(operation.command.plan, 'source') + ' → ' + mergePlanName(operation.command.plan, 'target');
    default:
      return '対象を確認できません';
  }
}

function operationFields(operation: ChangeSetOperation): ReviewField[] {
  switch (operation.type) {
    case 'document.update':
      return [
        ...(operation.command.title !== undefined ? [{ label: '文書名', value: operation.command.title }] : []),
        ...(operation.command.parentId !== undefined ? [{ label: '親文書', value: operation.command.parentId ?? 'なし' }] : []),
        ...(operation.command.orderKey !== undefined ? [{ label: '並び順', value: operation.command.orderKey }] : []),
      ];
    case 'document.delete':
      return [{ label: '文書ID', value: operation.command.documentId }];
    case 'module.record.save':
      return [
        { label: 'モジュール', value: operation.command.moduleId },
        { label: '記録キー', value: operation.command.key },
        { label: '変更後の値', value: operation.command.value },
      ];
    case 'document.create':
      return [
        { label: '文書名', value: operation.command.title },
        { label: '文書種別', value: operation.command.kind },
        { label: '親文書', value: operation.command.parentId ?? 'なし' },
      ];
    case 'document.save':
      return [
        { label: '変更箇所', value: operation.command.changes.length + '件' },
        { label: '基準Revision', value: operation.command.baseRevisionId },
      ];
    case 'document.restore':
      return [
        { label: '現在の基準Revision', value: operation.command.baseRevisionId },
        { label: '復元元Revision', value: operation.command.sourceRevisionId },
      ];
    case 'knowledge.node.save':
      return [
        { label: '名前', value: operation.command.name },
        { label: '種類', value: operation.command.type },
        { label: '状態', value: operation.command.status },
        { label: '属性', value: operation.command.attributes },
      ];
    case 'knowledge.alias.save':
      return [
        { label: '別名', value: operation.command.surface },
        { label: '対象の知識ID', value: operation.command.nodeId },
        { label: '適用範囲', value: operation.command.scope ?? '指定なし' },
        { label: '状態', value: operation.command.status },
      ];
    case 'knowledge.relation.save':
      return [
        { label: '関係元', value: operation.command.sourceId },
        { label: '関係先', value: operation.command.targetId },
        { label: '関係の種類', value: operation.command.type },
        { label: '状態', value: operation.command.status },
        { label: '有効範囲', value: operation.command.validity },
      ];
    case 'evidence.anchor.save':
      return [
        { label: '文書ID', value: operation.command.documentId },
        { label: 'Revision', value: operation.command.revisionId },
        { label: '引用範囲', value: operation.command.fromUtf16 + '–' + operation.command.toUtf16 },
        { label: '状態', value: operation.command.status },
      ];
    case 'evidence.mention.save':
      return [
        { label: '根拠ID', value: operation.command.evidenceId },
        { label: '知識ID', value: operation.command.nodeId },
        { label: '抽出元', value: operation.command.source },
        { label: '確度', value: operation.command.confidence },
        { label: '状態', value: operation.command.status },
      ];
    case 'evidence.assertion.save':
      return [
        { label: '命題', value: operation.command.proposition },
        {
          label: '種別',
          value:
            ({ fact: '世界の事実', belief: '人物の認識', disclosure: '読者への開示', hypothesis: '仮説' } as Record<string, string>)[
              operation.command.modality
            ] ?? operation.command.modality,
        },
        { label: '確度', value: operation.command.confidence },
        { label: '視点', value: operation.command.perspective },
        { label: '物語上の時間', value: operation.command.narrativeTime },
        { label: '状態', value: operation.command.status },
      ];
    case 'evidence.assertion.link':
      return [
        { label: '命題ID', value: operation.command.assertionId },
        { label: '根拠ID', value: operation.command.evidenceId },
        { label: '根拠の役割', value: operation.command.role },
      ];
    case 'knowledge.merge':
      return [
        { label: '統合元', value: mergePlanName(operation.command.plan, 'source') },
        { label: '統合先', value: mergePlanName(operation.command.plan, 'target') },
        { label: 'Preview snapshot', value: operation.command.projectVersion },
        { label: 'Preview digest', value: operation.command.previewDigest },
      ];
    default:
      return [];
  }
}

function versionValue(operation: ChangeSetOperation): number | null | undefined {
  const command = operation.command as unknown as { expectedVersion?: unknown };
  return command.expectedVersion === null || typeof command.expectedVersion === 'number' ? command.expectedVersion : undefined;
}

function beforeSummary(operation: ChangeSetOperation): string {
  if (operation.type === 'document.create') return '新規文書';
  const version = versionValue(operation);
  if (version === null) return '新規登録';
  if (typeof version === 'number') return '変更前の値は提案に含まれていません（version ' + version + '）';
  if (operation.type === 'document.save') return '基準Revisionの本文を取得して照合します';
  if (operation.type === 'document.restore') return '基準Revisionの本文を取得して照合します';
  return '変更前を確認できません';
}

function readableValue(value: unknown): string {
  if (value === null) return '未設定';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '値を表示できません';
  }
}

function dateLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString('ja-JP');
}

function applyTextChanges(markdown: string, changes: readonly { fromUtf16: number; toUtf16: number; insert: string }[]): string | null {
  let next = markdown;
  let previousStart = markdown.length + 1;
  for (const change of [...changes].reverse()) {
    if (
      !Number.isSafeInteger(change.fromUtf16) ||
      !Number.isSafeInteger(change.toUtf16) ||
      change.fromUtf16 < 0 ||
      change.toUtf16 < change.fromUtf16 ||
      change.toUtf16 > markdown.length ||
      change.toUtf16 > previousStart
    )
      return null;
    next = next.slice(0, change.fromUtf16) + change.insert + next.slice(change.toUtf16);
    previousStart = change.fromUtf16;
  }
  return next;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function DocumentBodyReview({ projectId, operation }: { projectId: string; operation: ChangeSetOperation }) {
  const [result, setResult] = useState<{ before: string; after: string } | { error: string } | null>(null);
  useEffect(() => {
    if (operation.type !== 'document.save' && operation.type !== 'document.restore') return;
    const controller = new AbortController();
    setResult(null);
    const load = async () => {
      try {
        if (operation.type === 'document.save') {
          const command = operation.command;
          const base = await api.persistenceDocument(projectId, command.documentId, controller.signal, command.baseRevisionId);
          const revision = base.revision;
          if (
            !revision ||
            revision.id !== command.baseRevisionId ||
            revision.projectId !== projectId ||
            revision.documentId !== command.documentId
          ) {
            throw new Error('基準Revisionの識別子を照合できません。');
          }
          const after = applyTextChanges(revision.markdown, command.changes);
          if (after === null) throw new Error('変更範囲を基準Revisionに照合できません。');
          if ((await sha256(after)) !== command.resultingSha256) throw new Error('変更後本文のハッシュが提案と一致しません。');
          if (!controller.signal.aborted) setResult({ before: revision.markdown, after });
        } else {
          const command = operation.command;
          const [base, source] = await Promise.all([
            api.persistenceDocument(projectId, command.documentId, controller.signal, command.baseRevisionId),
            api.persistenceDocument(projectId, command.documentId, controller.signal, command.sourceRevisionId),
          ]);
          if (
            base.revision?.id !== command.baseRevisionId ||
            base.revision.projectId !== projectId ||
            base.revision.documentId !== command.documentId ||
            source.revision?.id !== command.sourceRevisionId ||
            source.revision.projectId !== projectId ||
            source.revision.documentId !== command.documentId
          ) {
            throw new Error('復元元または基準Revisionの識別子を照合できません。');
          }
          if (!controller.signal.aborted) setResult({ before: base.revision.markdown, after: source.revision.markdown });
        }
      } catch (cause) {
        if (!controller.signal.aborted) setResult({ error: cause instanceof Error ? cause.message : 'Revisionを確認できません。' });
      }
    };
    void load();
    return () => controller.abort();
  }, [projectId, operation]);

  if (operation.type === 'document.create') {
    return (
      <details className="native-review-body-copy">
        <summary>作成される本文を確認</summary>
        <ReviewText label="作成される本文">{operation.command.markdown}</ReviewText>
      </details>
    );
  }
  if (operation.type === 'document.save') {
    if (result && 'error' in result) return <p className="native-review-unknown">変更前を確認できません。{result.error}</p>;
    if (!result) return <p className="native-review-pending">基準Revisionを照合しています。</p>;
    return (
      <section className="native-review-diff-list" aria-label="検証済み原稿差分">
        {operation.command.changes.map((change, index) => (
          <div className="native-review-diff-row" key={index}>
            <div>
              <h5>変更前</h5>
              <ReviewText label={`変更前の本文、変更箇所${index + 1}`}>
                {result.before.slice(change.fromUtf16, change.toUtf16) || '（この位置に本文はありません）'}
              </ReviewText>
            </div>
            <div>
              <h5>変更後</h5>
              <ReviewText label={`変更後の本文、変更箇所${index + 1}`}>{change.insert || '（この範囲を削除）'}</ReviewText>
            </div>
          </div>
        ))}
      </section>
    );
  }
  if (operation.type === 'document.restore') {
    if (result && 'error' in result) return <p className="native-review-unknown">復元する本文を確認できません。{result.error}</p>;
    if (!result) return <p className="native-review-pending">基準と復元元のRevisionを照合しています。</p>;
    return (
      <div className="native-review-diff-row native-review-revision-bodies">
        <details>
          <summary>変更前の本文</summary>
          <ReviewText label="復元前の本文">{result.before}</ReviewText>
        </details>
        <details>
          <summary>復元後の本文</summary>
          <ReviewText label="復元後の本文">{result.after}</ReviewText>
        </details>
      </div>
    );
  }
  return null;
}

function ReviewText({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <pre>{children}</pre>
    </section>
  );
}

export function NativeChangeSetReview({
  projectId,
  canWrite = true,
  showCoreReviews = false,
  requestedChangeSetId,
  onApplied,
  onOpenSource,
}: {
  projectId: string;
  canWrite?: boolean;
  showCoreReviews?: boolean;
  requestedChangeSetId?: string;
  onApplied: (changeSet: ChangeSet) => void;
  onOpenSource?: (anchor: SaveEvidenceAnchorCommand, quote: string) => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [sourceQuote, setSourceQuote] = useState<{ key: string; quote: string } | null>(null);
  const reviewMachine = useMemo(
    () =>
      createNativeReviewMachine({
        load: async (idProject, ownerCanWrite, includeCore, signal) => {
          const feed = ownerCanWrite ? await api.authorReviewFeed(idProject, 100, signal) : null;
          const changeSets = feed
            ? feed.items
                .filter((item): item is Extract<AuthorReviewFeedItem, { kind: 'native-change-set' }> => item.kind === 'native-change-set')
                .map(item => item.changeSet)
            : (await api.nativeChangeSets(idProject, 100, signal)).changeSets;
          if (feed?.items.some(item => item.projectId !== idProject)) throw new Error('提案の作品スコープが一致しません。');
          const coreReviews = includeCore
            ? (feed?.items.filter(
                (item): item is Extract<AuthorReviewFeedItem, { kind: 'core-proposal' }> => item.kind === 'core-proposal',
              ) ?? [])
            : [];
          return { changeSets, coreReviews };
        },
        approve: (idProject, id, version, signal) => api.approveNativeChangeSet(idProject, id, version, signal),
        reject: (idProject, id, version, signal) => api.rejectNativeChangeSet(idProject, id, version, signal),
        apply: (idProject, id, version, signal) => api.applyNativeChangeSet(idProject, id, version, signal),
        list: async (idProject, signal) => (await api.nativeChangeSets(idProject, 100, signal)).changeSets,
        get: (idProject, id, signal) => api.nativeChangeSet(idProject, id, signal),
      }),
    [projectId],
  );
  const reviewActor = useActorRef(reviewMachine, { input: { projectId } });
  const reviewSnapshot = useSelector(reviewActor, snapshot => snapshot);
  const reviewBusy = reviewSnapshot.matches('working');
  const loading = reviewSnapshot.matches('loading') || reviewSnapshot.matches('inspecting');
  const busy = reviewBusy || loading;
  const reviewNeedsRefresh =
    reviewSnapshot.matches('readFailed') ||
    reviewSnapshot.matches('conflict') ||
    reviewSnapshot.matches('unauthorized') ||
    reviewSnapshot.matches('forbidden');
  const changeSets = reviewSnapshot.context.changeSets;
  const coreReviews = reviewSnapshot.context.coreReviews;
  const selectedId = reviewSnapshot.context.selectedId;
  const detail = reviewSnapshot.context.detail;
  const feedback = message || reviewSnapshot.context.message;
  const reviewOutcomeSequence = reviewSnapshot.context.outcomeSequence;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sequence = useRef(0);
  const loadedRequest = useRef(requestedChangeSetId);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const notifiedApplications = useRef(new Set<string>());

  const load = useCallback(
    (requestedId?: string) => {
      sequence.current += 1;
      setMessage('');
      setSourceQuote(null);
      reviewActor.send({ type: 'LOAD.REQUESTED', requestedId, canWrite, showCoreReviews });
    },
    [canWrite, reviewActor, showCoreReviews],
  );

  useEffect(() => {
    if (reviewOutcomeSequence === 0) return;
    const outcome = reviewActor.getSnapshot().context.outcome;
    if (outcome?.kind !== 'confirmed' || outcome.detail?.changeSet.status !== 'applied' || !outcome.detail.receipt) return;
    const applicationKey = `${projectId}:${outcome.detail.changeSet.id}`;
    if (notifiedApplications.current.has(applicationKey)) return;
    notifiedApplications.current.add(applicationKey);
    onApplied(outcome.detail.changeSet);
  }, [onApplied, projectId, reviewActor, reviewOutcomeSequence]);

  useEffect(() => {
    if (!projectId) return;
    load(loadedRequest.current ?? undefined);
    return () => {
      sequence.current += 1;
    };
  }, [load, projectId]);

  useEffect(() => {
    if (!projectId || busy || !requestedChangeSetId || requestedChangeSetId === loadedRequest.current) return;
    loadedRequest.current = requestedChangeSetId;
    load(requestedChangeSetId);
  }, [busy, load, projectId, requestedChangeSetId]);

  const inspect = useCallback(
    (id: string) => {
      sequence.current += 1;
      setSourceQuote(null);
      setMessage('');
      reviewActor.send({ type: 'SELECT.REQUESTED', id });
    },
    [reviewActor],
  );

  const updateAfterAction = useCallback(
    async (id: string, action: 'approve' | 'reject' | 'apply') => {
      if (!detail?.changeSet || detail.changeSet.id !== id || busy || !canWrite || detail.changeSet.projectId !== projectId) return;
      setMessage('');
      reviewActor.send({ type: 'ACTION', action });
    },
    [busy, canWrite, detail, projectId, reviewActor],
  );

  async function inspectSource(anchor: SaveEvidenceAnchorCommand, key: string) {
    const sourceSequence = sequence.current;
    setSourceQuote(null);
    try {
      const result = await api.persistenceDocument(projectId, anchor.documentId, undefined, anchor.revisionId);
      if (!mounted.current || sequence.current !== sourceSequence) return;
      const revision = result.revision;
      if (
        !revision ||
        revision.id !== anchor.revisionId ||
        revision.projectId !== projectId ||
        revision.documentId !== anchor.documentId ||
        anchor.fromUtf16 < 0 ||
        anchor.toUtf16 <= anchor.fromUtf16 ||
        anchor.toUtf16 > revision.markdown.length
      )
        throw new Error('提案の引用元Revisionまたは範囲を確認できません。');
      const quote = revision.markdown.slice(anchor.fromUtf16, anchor.toUtf16);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(quote)))]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
      if (!mounted.current || sequence.current !== sourceSequence) return;
      if (digest !== anchor.quoteSha256) throw new Error('引用元のハッシュが提案と一致しません。');
      setSourceQuote({ key, quote });
    } catch (error) {
      if (mounted.current && sequence.current === sourceSequence) setMessage(errorText(error));
    }
  }

  const current = detail?.changeSet;
  const firstOperation = current?.operations[0];
  return (
    <section className="proposal-review native-changeset-review" aria-labelledby="native-review-title">
      <header className="native-review-masthead">
        <div>
          <h2 id="native-review-title">変更提案</h2>
          <p className="native-review-intro">提案内容と対象を確認します。承認しても正本には反映されず、適用は別の操作です。</p>
        </div>
      </header>
      <div className="native-review-toolbar">
        <span>この作品の変更記録</span>
        <button type="button" className="native-review-refresh" disabled={busy} onClick={() => load(selectedId)}>
          最新状態を再確認
        </button>
        {loading && <span role="status">提案を読み込んでいます。</span>}
      </div>
      {feedback && (
        <p className="native-review-message" role="alert">
          {feedback}
        </p>
      )}
      {coreReviews.length > 0 && (
        <section className="native-review-core-feed" aria-label="Core提案の承認と適用状況">
          <div className="native-review-queue-heading">
            <h3>操作単位の提案記録</h3>
            <span>{coreReviews.length}件</span>
          </div>
          <p>
            保存済みのCore提案状態とPostgreSQL適用receiptを表示します。元の変更内容は、下の「確認待ちの提案」でブラウザー回復記録と照合して確認します。
          </p>
          <ul className="proposal-list">
            {coreReviews.map(item => {
              const operationCount = item.status.proposal.operations.length;
              const title = item.status.proposal.operations[0]?.message ?? '元の変更内容をこのブラウザーで確認できません';
              return (
                <li key={item.id}>
                  <article className="proposal-card">
                    <header className="native-review-detail-meta">
                      <strong>{title}</strong>
                      <span>{coreProposalStateLabel(item.state)}</span>
                    </header>
                    <p>
                      {item.status.proposal.source} · {operationCount}件の操作 · {item.receipts.length}件の適用receipt
                    </p>
                    {item.status.payloadComplete === false && (
                      <p role="status">
                        PostgreSQL記録には承認済み操作だけがあります。元の提案内容は完全ではないため、回復記録との照合前に表示・承認できません。
                      </p>
                    )}
                    {item.stale && <p role="status">基準snapshotより作品versionが進んでいます。適用時に前提条件を再確認します。</p>}
                    <details>
                      <summary>保存済みの承認状態とreceipt</summary>
                      <ReviewText label="Core提案の承認状態とreceipt">
                        {JSON.stringify(
                          {
                            proposalId: item.id,
                            approvedOperationIds: item.status.approvedOperationIds,
                            appliedOperationIds: item.status.appliedOperationIds,
                            receipts: item.receipts,
                            payloadComplete: item.status.payloadComplete ?? true,
                          },
                          null,
                          2,
                        )}
                      </ReviewText>
                    </details>
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {changeSets.length === 0 && !loading ? (
        <div className="native-review-empty">
          <span aria-hidden="true">—</span>
          <h3>この作品にネイティブ提案はありません。</h3>
          <p>承認待ちや適用済みの変更が届くと、ここに表示されます。</p>
        </div>
      ) : (
        <div className="native-review-layout">
          <aside className="native-review-queue" aria-label="ネイティブ提案一覧">
            <div className="native-review-queue-heading">
              <h3>提案一覧</h3>
              <span>{changeSets.length}件</span>
            </div>
            <ul className="proposal-list native-changeset-list">
              {changeSets.map(item => {
                const operation = item.operations[0];
                const headline = operation ? [...new Set(item.operations.map(operationLabel))].join(' / ') : '内容を確認できません';
                const target = operation ? [...new Set(item.operations.map(operationTarget))].join(' / ') : '提案payloadを確認してください';
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="native-changeset-select"
                      data-ux-control="REV-01.A"
                      data-status={item.status}
                      aria-pressed={selectedId === item.id}
                      onClick={() => void inspect(item.id)}
                      disabled={busy}
                    >
                      <span className="native-review-row-meta">
                        <span>保存済み提案</span>
                        <span className={'native-review-state is-' + item.status}>{statusLabel(item.status)}</span>
                      </span>
                      <strong>{headline}</strong>
                      <span className="native-review-row-target">{target}</span>
                      <small>
                        {sourceLabel(item.provenance.source)} · {item.operations.length}件の変更
                      </small>
                      <span className="native-review-id-token" aria-hidden="true">
                        {item.id}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
          <div className="native-review-detail">
            {!current ? (
              loading ? (
                <p className="native-review-pending" role="status">
                  選択したChangeSetの詳細を取得しています。
                </p>
              ) : (
                <p className="native-review-unknown">提案の詳細を取得できません。最新状態を再確認してください。</p>
              )
            ) : (
              <article className="proposal-card native-changeset-card">
                <header className="native-review-detail-header">
                  <div>
                    <div className="native-review-detail-meta">
                      <span className={'native-review-state is-' + current.status}>{statusLabel(current.status)}</span>
                      <span>提案の詳細</span>
                    </div>
                    <h3>{firstOperation ? operationLabel(firstOperation) : '提案内容を確認できません'}</h3>
                    {firstOperation && <p className="native-review-target">{operationTarget(firstOperation)}</p>}
                  </div>
                  <div className="native-review-created">
                    <span>作成</span>
                    <time dateTime={current.createdAt}>{dateLabel(current.createdAt)}</time>
                  </div>
                </header>
                <div className="native-review-facts">
                  <p>
                    <span>提案元</span>
                    <strong>{sourceLabel(current.provenance.source)}</strong>
                  </p>
                  <p>
                    <span>適用先</span>
                    <strong>この作品のPostgreSQL正本</strong>
                  </p>
                  <p>
                    <span>変更件数</span>
                    <strong>{current.operations.length}件</strong>
                  </p>
                </div>
                <section className="native-review-changes" aria-labelledby="native-review-changes-title">
                  <div className="native-review-section-heading">
                    <h4 id="native-review-changes-title">変更内容</h4>
                    <span>{current.operations.length}件の変更</span>
                  </div>
                  {current.operations.length === 0 && (
                    <p className="native-review-unknown">提案に操作が含まれていないため、変更内容を確認できません。</p>
                  )}
                  {current.operations.map((operation, index) => (
                    <section className="proposal-operation native-review-operation" key={operation.type + ':' + index}>
                      <div className="native-review-operation-heading">
                        <span className="native-review-operation-number">{index + 1}</span>
                        <div>
                          <h5>{operationLabel(operation)}</h5>
                          <p>{operationTarget(operation)}</p>
                        </div>
                      </div>
                      <div className="native-review-diff-overview">
                        <div className="native-review-before">
                          <span>変更前</span>
                          <p>{beforeSummary(operation)}</p>
                        </div>
                        <span className="native-review-diff-arrow" aria-hidden="true">
                          →
                        </span>
                        <div className="native-review-after">
                          <span>変更後</span>
                          <dl className="native-review-fields">
                            {operationFields(operation).map(field => (
                              <div key={field.label}>
                                <dt>{field.label}</dt>
                                <dd>
                                  {typeof field.value === 'object' && field.value !== null ? (
                                    <ReviewText label={`${field.label}の提案値`}>{readableValue(field.value)}</ReviewText>
                                  ) : (
                                    readableValue(field.value)
                                  )}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      </div>
                      <DocumentBodyReview projectId={projectId} operation={operation} />
                      {operation.type === 'knowledge.merge' && (
                        <section className="native-review-merge" aria-label="Knowledge merge proposal">
                          <p>
                            <strong>{mergePlanName(operation.command.plan, 'source')}</strong> (<code>{operation.command.sourceId}</code>) →{' '}
                            <strong>{mergePlanName(operation.command.plan, 'target')}</strong> (<code>{operation.command.targetId}</code>)
                          </p>
                          <p>
                            Preview snapshot: <code>{operation.command.projectVersion}</code> · Digest:{' '}
                            <code>{operation.command.previewDigest}</code>
                          </p>
                          <p>
                            実際の書き込み対象: 別名 {mergeWriteCount(current, 'knowledge_alias')} 件 · 関係{' '}
                            {mergeWriteCount(current, 'knowledge_relation')} 件 · 根拠リンク {mergeWriteCount(current, 'mention_link')} 件 ·
                            命題 {mergeWriteCount(current, 'assertion')} 件
                          </p>
                          {mergePlanConflicts(operation.command.plan).length > 0 ? (
                            <div role="alert">
                              <strong>競合</strong>
                              <ul>
                                {mergePlanConflicts(operation.command.plan).map(conflict => (
                                  <li key={conflict}>{conflict}</li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            <p>Preview conflicts: なし</p>
                          )}
                          <details>
                            <summary>統合計画と対象リソースを確認</summary>
                            <ReviewText label="Knowledge統合計画">{JSON.stringify(operation.command.plan, null, 2)}</ReviewText>
                          </details>
                        </section>
                      )}
                      {operation.type === 'evidence.anchor.save' && (
                        <div className="native-review-evidence">
                          <button
                            type="button"
                            className="quiet-button"
                            disabled={busy || loading}
                            onClick={() => void inspectSource(operation.command, current.id + ':' + index)}
                          >
                            引用元Revisionを確認
                          </button>
                          {sourceQuote?.key === current.id + ':' + index && (
                            <div className="native-review-quote">
                              <q>{sourceQuote.quote}</q>
                              <p>
                                Revision: <code>{operation.command.revisionId}</code> · {operation.command.status}
                              </p>
                              {onOpenSource && (
                                <button
                                  type="button"
                                  className="quiet-button"
                                  onClick={() =>
                                    void onOpenSource(operation.command, sourceQuote.quote).catch(error => setMessage(errorText(error)))
                                  }
                                >
                                  原稿で確認
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      <details className="native-review-operation-payload">
                        <summary>操作payloadと期待versionを確認</summary>
                        <ReviewText label="操作payloadと期待version">{JSON.stringify(operation.command, null, 2)}</ReviewText>
                      </details>
                    </section>
                  ))}
                </section>
                <details className="native-review-technical">
                  <summary>read set・write set・作成元を確認</summary>
                  <div className="native-review-technical-grid">
                    <section>
                      <h4>読み取り前提</h4>
                      <ReviewText label="読み取り前提のJSON">{JSON.stringify(current.readSet, null, 2)}</ReviewText>
                    </section>
                    <section>
                      <h4>書き込み対象</h4>
                      <ReviewText label="書き込み対象のJSON">{JSON.stringify(current.writeSet, null, 2)}</ReviewText>
                    </section>
                    <section>
                      <h4>作成元と権限</h4>
                      <ReviewText label="作成元と権限のJSON">
                        {JSON.stringify(
                          {
                            id: current.id,
                            projectId: current.projectId,
                            authorId: current.authorId,
                            actorId: current.provenance.actorId,
                            origin: current.provenance.details.origin === 'external-agent' ? 'external-agent' : 'author',
                            source: current.provenance.source,
                            projectVersion: sourceProjectVersion(current),
                            version: current.version,
                            createdAt: current.createdAt,
                            approvedAt: current.approvedAt,
                            approvedBy: current.approvedBy,
                            rejectedAt: current.rejectedAt,
                            rejectedBy: current.rejectedBy,
                          },
                          null,
                          2,
                        )}
                      </ReviewText>
                    </section>
                  </div>
                </details>
                {current.status === 'applied' && detail?.receipt && (
                  <section className="native-review-receipt" aria-label="適用receipt">
                    <div className="native-review-section-heading">
                      <h4>適用receipt</h4>
                      <span>{detail.receipt.replayed ? '再確認' : '適用結果'}</span>
                    </div>
                    <p>正本への適用結果をサーバーのreceiptで確認しました。</p>
                    <ReviewText label="receiptの詳細JSON">{JSON.stringify(detail.receipt, null, 2)}</ReviewText>
                  </section>
                )}
                {current.status === 'applied' && !detail?.receipt && (
                  <p className="native-review-unknown" role="status">
                    適用済みの状態を確認しましたが、receiptを取得できませんでした。最新状態を再確認してください。
                  </p>
                )}
                <div className="proposal-actions native-review-actions">
                  {current.status === 'proposed' && (
                    <>
                      <p>承認後も正本は変わりません。適用前に同じ提案の内容とversionを再確認します。</p>
                      <button
                        type="button"
                        data-ux-control="REV-02.A"
                        disabled={!canWrite || busy || reviewNeedsRefresh}
                        onClick={() => void updateAfterAction(current.id, 'approve')}
                      >
                        {!canWrite ? '閲覧専用' : busy ? '処理中…' : '承認する'}
                      </button>
                      <button
                        type="button"
                        data-ux-control="REV-02.A"
                        className="quiet-button"
                        disabled={!canWrite || busy || reviewNeedsRefresh}
                        onClick={() => void updateAfterAction(current.id, 'reject')}
                      >
                        却下する
                      </button>
                    </>
                  )}
                  {current.status === 'approved' && (
                    <>
                      <p>承認済みです。適用まではPostgreSQLの正本は変更されません。</p>
                      <button
                        type="button"
                        data-ux-control="REV-02.A"
                        disabled={!canWrite || busy || reviewNeedsRefresh}
                        onClick={() => void updateAfterAction(current.id, 'apply')}
                      >
                        {!canWrite ? '閲覧専用' : busy ? '適用結果を照合中…' : '承認済み提案を適用'}
                      </button>
                    </>
                  )}
                </div>
              </article>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
