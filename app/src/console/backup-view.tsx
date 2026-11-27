import type { ReactNode } from 'react';
import { ApiError } from '../api-error';
import { BackupPasskeyError } from './backup-actions';
import * as styles from './backup-console.css';

const root = '/console/backups';
export type BackupHref = (path: string) => string;

export function backupQuery(href: BackupHref, page: 'history', params: { run?: string; cursor?: string }) {
  const url = new URL(href(root + '/' + page), window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}

const errorMessages: Readonly<Record<string, string>> = {
  BACKUP_DESTINATION_NOT_ALLOWED: '許可された保存先と一致しません。運用担当者に保存先の設定を確認してください。',
  BACKUP_EXECUTOR_UNAVAILABLE: 'バックアップ実行サービスを確認できません。',
  BACKUP_MAINTENANCE_WINDOW_CLOSED: '指定した保守時間帯は利用できません。',
  BACKUP_OPERATION_IN_PROGRESS: '別のバックアップ操作が進行中です。履歴で状態を確認してください。',
  BACKUP_REQUIRED_PROTECTION: '必須の遠隔保全を無効化できません。',
  BACKUP_PROBE_NOT_FOUND: '接続検証を確認できません。',
  BACKUP_RUN_NOT_FOUND: '指定された実行を確認できません。',
  BACKUP_OPERATION_NOT_FOUND: '受付結果を確認できません。同じ要求の状態を再確認してください。',
  BACKUP_PROBE_REQUIRED: '現在の設定案に対して接続検証をやり直してください。',
  BACKUP_CREDENTIAL_REQUIRED: '保存先で使用する資格情報を入力してください。',
  BACKUP_CREDENTIAL_UNAVAILABLE: '実行サービスがこの保存先の資格情報を利用できません。',
  BACKUP_RETENTION_UNVERIFIED: '要求した保持条件を保存先で確認できませんでした。',
  BACKUP_REQUEST_REUSED: '同じ要求 ID に対して異なる入力は使用できません。',
};

export function backupErrorText(error: unknown): string {
  if (error instanceof BackupPasskeyError) return 'パスキーでの再認証を確認できませんでした。操作を送信する前に再認証してください。';
  if (!(error instanceof ApiError)) return '接続または結果を確認できません。通信を確認して状態を再取得してください。';
  if (Object.hasOwn(errorMessages, error.code)) return errorMessages[error.code]!;
  switch (error.status) {
    case 401:
      return '所有者セッションが失効しました。サインインしてください。';
    case 403:
      return '所有者セッションまたは操作の権限を確認できませんでした。';
    case 404:
      return '指定されたバックアップの情報を確認できません。';
    case 409:
      return '現在の保全状態では操作を受け付けられません。状態を更新してください。';
    case 412:
      return '別の操作で設定案が更新されました。最新の設定を確認してください。';
    case 422:
      return '設定値を受理できませんでした。保存先と許可された設定を確認してください。';
    case 429:
      return '要求が多すぎます。状態を確認してから操作してください。';
    default:
      return 'バックアップサービスまたは確認結果が利用できません。通信を確認して状態を再取得してください。';
  }
}

export function BackupFeedback({ error, busy, onReauthenticate }: { error: unknown; busy?: boolean; onReauthenticate: () => void }) {
  return (
    <>
      <div role="status">{busy ? '処理しています…' : ''}</div>
      {error ? (
        <div className="codexia-console__alert">
          <p role="alert">{backupErrorText(error)}</p>
          {error instanceof ApiError && (error.status === 401 || error.status === 403) && (
            <button className="quiet-button" type="button" onClick={onReauthenticate}>
              所有者セッションを再確認
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

export function BackupDetails({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className={styles.details}>
      {items.map(([label, value]) => (
        <div key={label} className={styles.detailRow}>
          <dt className={styles.term}>{label}</dt>
          <dd className={styles.value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const stateLabels: Readonly<Record<string, string>> = {
  QUEUED: '受付済み',
  RUNNING: '実行中',
  UNKNOWN: '結果未確認',
  FAILED: '失敗',
  BLOCKED: '停止',
  REMOTE_VERIFIED: '遠隔暗号文の照合済み',
  PASSED: '接続検証に合格',
  APPLIED: '設定反映済み',
};
export const backupStateLabel = (state: string) => (Object.hasOwn(stateLabels, state) ? stateLabels[state] : '未確認');
export const backupValue = (value: string) => <code>{value}</code>;
const formatTime = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
export const backupTime = (time: string) => <time dateTime={time}>{formatTime.format(new Date(time))} UTC</time>;

export function BackupRefresh({ refresh, disabled }: { refresh: () => void; disabled?: boolean }) {
  return (
    <button className="quiet-button" type="button" disabled={disabled} onClick={refresh}>
      状態を更新
    </button>
  );
}
