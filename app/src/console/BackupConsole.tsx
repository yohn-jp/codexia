import { useCallback } from 'react';
import { BackupDestination, BackupVerification } from './BackupDestination';
import { BackupOverview } from './BackupOverview';
import { useBackupRead } from './backup-actions';
import { type BackupRun, backupConsoleClient, backupId } from './backup-client';
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

const root = '/console/backups';
const pages = [
  [root, '保全状況'],
  [root + '/destination', '保存先設定'],
  [root + '/verification', '接続検証'],
  [root + '/history', '保全履歴'],
  [root + '/recovery', '復旧の証拠'],
] as const;
export function BackupConsole({ href, onReauthenticate }: { href: BackupHref; onReauthenticate: () => void }) {
  const pathname = window.location.pathname.replace(/\/$/u, '');
  return (
    <div className={styles.content}>
      <nav className={styles.navigation} aria-label="バックアップ管理">
        {pages.map(([path, name]) => (
          <a key={path} href={href(path)} aria-current={path === pathname ? 'page' : undefined} className={styles.navLink}>
            {name}
          </a>
        ))}
      </nav>
      {pathname === root + '/destination' ? (
        <BackupDestination href={href} onReauthenticate={onReauthenticate} />
      ) : pathname === root + '/verification' ? (
        <BackupVerification href={href} onReauthenticate={onReauthenticate} />
      ) : pathname === root + '/history' ? (
        <BackupHistory href={href} onReauthenticate={onReauthenticate} />
      ) : pathname === root + '/recovery' ? (
        <BackupRecovery onReauthenticate={onReauthenticate} />
      ) : (
        <BackupOverview href={href} onReauthenticate={onReauthenticate} />
      )}
    </div>
  );
}

export function BackupHistory({ href, onReauthenticate }: { href: BackupHref; onReauthenticate: () => void }) {
  const query = new URLSearchParams(window.location.search);
  const selected = backupId.safeParse(query.get('run')).data;
  const cursor = backupId.safeParse(query.get('cursor')).data;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [page, runDetail] = await Promise.all([
        backupConsoleClient.runs(cursor, signal),
        selected
          ? backupConsoleClient.run(selected, signal).then(
              value => ({ value, error: null }),
              error => ({ value: null, error }),
            )
          : null,
      ]);
      return { page, runDetail };
    },
    [cursor, selected],
  );
  const { read, refresh } = useBackupRead(load);
  return (
    <>
      <h2>保全履歴</h2>
      <BackupRefresh refresh={refresh} disabled={read.state === 'loading'} />
      <BackupFeedback
        busy={read.state === 'loading'}
        error={read.state === 'error' ? read.error : null}
        onReauthenticate={onReauthenticate}
      />
      {query.has('run') && !selected && <p role="alert">指定された実行 ID を確認できません。</p>}
      {read.state === 'ready' && (
        <>
          {read.value.runDetail?.value && <RunResults run={read.value.runDetail.value} />}
          {read.value.runDetail?.error ? <BackupFeedback error={read.value.runDetail.error} onReauthenticate={onReauthenticate} /> : null}
          {read.value.page.runs.length ? (
            <ul className={styles.list}>
              {read.value.page.runs.map(run => (
                <li className={styles.listItem} key={run.runId}>
                  <a
                    className="codexia-console__link"
                    href={backupQuery(href, 'history', { run: run.runId, cursor })}
                    aria-current={run.runId === selected ? 'true' : undefined}
                  >
                    {backupTime(run.createdAt)} <span className={styles.runId}>{run.runId}</span>
                  </a>
                  <span>{backupStateLabel(run.status)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>このページにバックアップの実行記録はありません。</p>
          )}
          {cursor && (
            <a className="codexia-console__link" href={backupQuery(href, 'history', {})}>
              最新の履歴
            </a>
          )}
          {read.value.page.nextCursor && (
            <a className="codexia-console__link" href={backupQuery(href, 'history', { cursor: read.value.page.nextCursor })}>
              以前の履歴
            </a>
          )}
          <p>
            <a className="codexia-console__link" href={href(root + '/recovery')}>
              独立した復元試験の証拠
            </a>
          </p>
        </>
      )}
    </>
  );
}

function RunResults({ run }: { run: BackupRun }) {
  return (
    <section className={styles.section} aria-labelledby="backup-run-heading">
      <h3 id="backup-run-heading">実行の詳細</h3>
      <BackupDetails
        items={[
          ['実行 ID', backupValue(run.runId)],
          ['照合状態', backupStateLabel(run.status)],
          ['実行段階', run.phase],
          ['設定リビジョン', run.revision ?? '未確認'],
          ['ソース', run.sourceSha ? backupValue(run.sourceSha) : '未確認'],
          ['イメージダイジェスト', run.imageDigest ? backupValue(run.imageDigest) : '未確認'],
          ['マニフェスト SHA-256', run.manifestSha256 ? backupValue(run.manifestSha256) : '未確認'],
          ...(run.offVmConfirmation?.offVmMethod === 's3'
            ? ([
                ['遠隔照合', 'S3'],
                ['独立した保全証拠の SHA-256', backupValue(run.offVmConfirmation.receiptSha256 ?? '未確認')],
                ['コミットマーカーの SHA-256', backupValue(run.offVmConfirmation.markerSha256 ?? '未確認')],
              ] as const)
            : run.offVmConfirmation?.offVmMethod === 'independent_mount'
              ? ([
                  ['遠隔照合', '独立マウントの照合。S3 では保全失敗'],
                  ['独立保管物の SHA-256', backupValue(run.offVmConfirmation.independentArtifactSha256 ?? '未確認')],
                ] as const)
              : []),
          ['観測日時', backupTime(run.observedAt)],
          ...(run.reasonCode ? ([['理由コード', backupValue(run.reasonCode)]] as const) : []),
        ]}
      />
    </section>
  );
}

const missingConditions: Readonly<Record<string, string>> = {
  verified_off_vm_backup: '遠隔暗号文の照合',
  independent_restore_drill_for_latest_backup: '最新の保全点からの独立した復元試験',
  candidate_api_readiness: '復元したデータでの API 起動確認',
};

function BackupRecovery({ onReauthenticate }: { onReauthenticate: () => void }) {
  const { read, refresh } = useBackupRead(backupConsoleClient.recovery);
  return (
    <>
      <h2>復旧の証拠</h2>
      <BackupRefresh refresh={refresh} disabled={read.state === 'loading'} />
      <BackupFeedback
        busy={read.state === 'loading'}
        error={read.state === 'error' ? read.error : null}
        onReauthenticate={onReauthenticate}
      />
      {read.state === 'ready' && (
        <BackupDetails
          items={[
            [
              '復元試験',
              read.value.status === 'DRILL_PASSED'
                ? '最新の保全点で合格'
                : read.value.status === 'stale'
                  ? '以前の保全点の記録。最新の保全点は未確認'
                  : read.value.status === 'partial'
                    ? '確認が一部未完了'
                    : '未確認',
            ],
            [
              '最新の遠隔保全',
              read.value.lastVerifiedOffVmBackup === 'unknown' ? '未確認' : backupValue(read.value.lastVerifiedOffVmBackup.runId),
            ],
            ...(read.value.restoreDrill === 'unknown'
              ? []
              : ([
                  ['試験対象の実行 ID', backupValue(read.value.restoreDrill.runId)],
                  ['試験日時', backupTime(read.value.restoreDrill.observedAt)],
                  ['マニフェスト SHA-256', backupValue(read.value.restoreDrill.manifestSha256)],
                  ['復元証拠の SHA-256', backupValue(read.value.restoreDrill.receiptSha256)],
                ] as const)),
            ...(read.value.missingConditions.length
              ? ([
                  [
                    '不足している確認',
                    <ul key="conditions">
                      {read.value.missingConditions.map(condition => (
                        <li key={condition}>
                          {Object.hasOwn(missingConditions, condition) ? missingConditions[condition] : '運用担当者による確認'}
                        </li>
                      ))}
                    </ul>,
                  ],
                ] as const)
              : []),
          ]}
        />
      )}
      <p className={styles.hint}>本番の復元は、復旧担当者が承認を受けて実施します。</p>
      <a className="codexia-console__link" href="https://github.com/yohn-jp/codexia/blob/main/docs/deployment/BACKUP.md">
        復旧担当者向けの手順
      </a>
    </>
  );
}
