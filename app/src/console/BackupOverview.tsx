import { type FormEvent, useCallback } from 'react';
import {
  beginBackupAction,
  readBackupAction,
  readConfigOperation,
  submitBackupAction,
  backupObservation,
  useBackupRead,
  useBackupWorkflow,
} from './backup-actions';
import { backupConsoleClient } from './backup-client';
import * as styles from './backup-console.css';
import {
  BackupDetails,
  BackupFeedback,
  type BackupHref,
  BackupRefresh,
  backupQuery,
  backupStateLabel,
  backupTime,
  backupValue,
} from './backup-view';

export function BackupOverview({ href, onReauthenticate }: { href: BackupHref; onReauthenticate: () => void }) {
  const load = useCallback(async (signal: AbortSignal) => {
    const [status, config] = await Promise.all([backupConsoleClient.status(undefined, signal), backupConsoleClient.config(signal)]);
    const disable = readBackupAction('disable');
    const manual = readBackupAction('manual');
    const [disableResult, manualResult] = await Promise.all([
      disable
        ? readConfigOperation(disable, signal).then(
            value => ({ value, error: null }),
            error => ({ value: null, error }),
          )
        : null,
      manual
        ? (manual.resultId
            ? backupConsoleClient.run(manual.resultId, signal)
            : backupConsoleClient.status(manual.requestId, signal).then(receipt => receipt.run)
          ).then(
            value => ({ value: value?.requestId === manual.requestId ? value : null, error: null }),
            error => ({ value: null, error }),
          )
        : null,
    ]);
    return { status, config, disable, manual, disableResult, manualResult };
  }, []);
  const { read, refresh } = useBackupRead(load);
  const data = read.state === 'ready' ? read.value : null;
  const active = data?.config.active;
  const manual = data?.manual?.kind === 'manual' ? data.manual : null;
  const recordedRun = data?.manualResult?.value;
  const unresolvedRun = manual && !recordedRun;
  const runInProgress =
    recordedRun && (recordedRun.status === 'QUEUED' || recordedRun.status === 'RUNNING' || recordedRun.status === 'UNKNOWN');
  const operation = data?.disableResult?.value;
  const mutation = useBackupWorkflow(read, [
    backupObservation(manual, recordedRun, data?.manualResult?.error),
    backupObservation(data?.disable, operation, data?.disableResult?.error),
  ]);
  const disableUnavailable = operation?.status === 'QUEUED' || operation?.status === 'RUNNING';
  const retryDisable = data?.disable?.kind === 'disable' && !operation && mutation.canStart('disable', data.disable);

  function requestRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = String(new FormData(event.currentTarget).get('window') ?? '').trim();
    if ((!active && !unresolvedRun) || runInProgress || !/^[A-Za-z0-9_-]{1,64}$/u.test(id) || !mutation.canStart('manual', manual)) return;
    const action = unresolvedRun ? manual : beginBackupAction({ kind: 'manual', maintenanceWindowId: id });
    void mutation.submit(action, async () => {
      try {
        const saved = await submitBackupAction(action);
        if (saved.resultId) window.location.assign(backupQuery(href, 'history', { run: saved.resultId }));
      } finally {
        refresh();
      }
    });
  }

  function requestDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((!active && !retryDisable) || disableUnavailable || !mutation.canStart('disable', data?.disable)) return;
    const action = retryDisable ? data.disable : active ? beginBackupAction({ kind: 'disable', revision: active.revision }) : null;
    if (!action) return;
    void mutation.submit(action, async () => {
      try {
        await submitBackupAction(action);
      } finally {
        refresh();
      }
    });
  }

  return (
    <>
      <h2>保全状況</h2>
      <BackupRefresh refresh={refresh} disabled={read.state === 'loading' || mutation.busy} />
      <BackupFeedback
        busy={read.state === 'loading' || mutation.busy}
        error={read.state === 'error' ? read.error : (mutation.error ?? data?.manualResult?.error ?? data?.disableResult?.error)}
        onReauthenticate={onReauthenticate}
      />
      {data && (
        <>
          <BackupDetails
            items={[
              ['有効な設定', data.status.enabled ? `リビジョン ${data.status.activeRevision}` : '未設定'],
              [
                '実行サービス',
                data.status.degraded ? '保全に必要な稼働状態を確認できません' : data.status.enabled ? '劣化の報告なし' : '未確認',
              ],
              ['保存先', active ? [active.bucket, active.prefix].join(' / ') : '未設定'],
              ['資格情報', active?.credentialConfigured ? '設定済み' : '未確認'],
              ['遠隔保全の方針', active?.offVmPolicy === 'required' ? '必須' : active?.offVmPolicy === 'secondary' ? '補助' : '未設定'],
              ['ステージング', '未観測'],
              [
                '最新の遠隔暗号文照合',
                data.status.lastVerifiedOffVmBackup === 'unknown' ? (
                  '未確認'
                ) : (
                  <a
                    key="off-vm-proof"
                    className="codexia-console__link"
                    href={backupQuery(href, 'history', { run: data.status.lastVerifiedOffVmBackup.runId })}
                  >
                    {backupTime(data.status.lastVerifiedOffVmBackup.observedAt)}
                  </a>
                ),
              ],
              [
                '独立した復元試験',
                data.status.restoreDrill === 'unknown' ? (
                  '未確認'
                ) : (
                  <a key="restore-proof" className="codexia-console__link" href={href('/console/backups/recovery')}>
                    {backupTime(data.status.restoreDrill.observedAt)} の証拠を見る
                  </a>
                ),
              ],
            ]}
          />
          {!active && (
            <a className="codexia-console__link" href={href('/console/backups/destination')}>
              保存先を設定
            </a>
          )}

          <section className={styles.section} aria-labelledby="manual-backup-heading">
            <h3 id="manual-backup-heading">手動バックアップ</h3>
            {recordedRun && (
              <p>
                <a className="codexia-console__link" href={backupQuery(href, 'history', { run: recordedRun.runId })}>
                  前回要求したバックアップ
                </a>
                {' · '}
                {backupStateLabel(recordedRun.status)}
              </p>
            )}
            {unresolvedRun && <p role="status">前回の受付結果は未確認です。同じ要求 ID で照合を続けます。</p>}
            {(active || unresolvedRun) && !runInProgress && (
              <form
                className={styles.form}
                aria-labelledby="manual-backup-heading"
                action="/api/console/backups/runs"
                method="post"
                onSubmit={requestRun}
              >
                <label className={styles.field}>
                  承認済みの保守時間帯 ID（必須）
                  <input
                    className={styles.input}
                    name="window"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    maxLength={64}
                    pattern="[A-Za-z0-9_\-]{1,64}"
                    readOnly={Boolean(unresolvedRun)}
                    defaultValue={unresolvedRun ? manual.maintenanceWindowId : ''}
                  />
                </label>
                <p className={styles.hint}>
                  運用担当者が指定した ID を使用します。バックアップ中は執筆・閲覧 API と接続経路が一時停止します。
                </p>
                <label className={styles.check}>
                  <input className={styles.checkInput} name="confirmed" type="checkbox" required /> 一時停止の影響を確認した
                </label>
                <div>
                  <button type="submit" disabled={!mutation.canStart('manual', manual)}>
                    {unresolvedRun ? '再認証して同じ要求を照合' : 'パスキーで再認証してバックアップを要求'}
                  </button>
                </div>
              </form>
            )}
            {!active && !unresolvedRun && <p>手動バックアップには有効な保存先が必要です。</p>}
          </section>

          {(active || data.disable) && (
            <section className={styles.section} aria-labelledby="backup-disable-heading">
              <h3 id="backup-disable-heading">保存先の無効化</h3>
              {operation && (
                <BackupDetails
                  items={[
                    ['操作 ID', backupValue(operation.operationId)],
                    [
                      '反映状態',
                      operation.status === 'APPLIED' && active ? '現在の設定を確認してください' : backupStateLabel(operation.status),
                    ],
                    ...(operation.reasonCode ? ([['理由コード', backupValue(operation.reasonCode)]] as const) : []),
                  ]}
                />
              )}
              {(active || retryDisable) && !disableUnavailable && (
                <form
                  className={styles.form}
                  aria-labelledby="backup-disable-heading"
                  action="/api/console/backups/config/disable"
                  method="post"
                  onSubmit={requestDisable}
                >
                  <p className={styles.hint}>
                    この保存先への遠隔保全が止まります。既存の遠隔バックアップは保持されます。
                    必須の保全に独立した代替がなければ、操作は拒否されます。
                  </p>
                  <label className={styles.check}>
                    <input className={styles.checkInput} name="confirmed" type="checkbox" required /> 遠隔保全への影響を確認した
                  </label>
                  <div>
                    <button type="submit" className="quiet-button" disabled={!mutation.canStart('disable', data.disable)}>
                      {retryDisable ? '再認証して同じ無効化要求を再送' : 'パスキーで再認証して無効化を要求'}
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
