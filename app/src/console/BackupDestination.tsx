import { type FormEvent, useCallback, useState } from 'react';
import {
  beginBackupAction,
  readBackupAction,
  readConfigOperation,
  requireFreshBackupOwner,
  submitBackupAction,
  backupObservation,
  useBackupRead,
  useBackupWorkflow,
} from './backup-actions';
import { type BackupConfiguration, type BackupDraftInput, backupConsoleClient } from './backup-client';
import * as styles from './backup-console.css';
import { BackupDetails, BackupFeedback, type BackupHref, BackupRefresh, backupStateLabel, backupTime, backupValue } from './backup-view';

interface Props {
  href: BackupHref;
  onReauthenticate: () => void;
}

export function BackupDestination(props: Props) {
  const { read, refresh } = useBackupRead(backupConsoleClient.config, false);
  return (
    <>
      <h2>保存先設定</h2>
      {read.state === 'ready' ? (
        <DestinationForm config={read.value} {...props} />
      ) : (
        <>
          <BackupFeedback
            busy={read.state === 'loading'}
            error={read.state === 'error' ? read.error : null}
            onReauthenticate={props.onReauthenticate}
          />
          <BackupRefresh refresh={refresh} disabled={read.state === 'loading'} />
        </>
      )}
    </>
  );
}

function readText(data: FormData, key: string) {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}

function readDraft(form: HTMLFormElement): BackupDraftInput | null {
  const data = new FormData(form);
  const days = readText(data, 'days');
  const generations = readText(data, 'generations');
  const provider = readText(data, 'provider');
  const credentialMode = readText(data, 'credentialMode');
  const offVmPolicy = readText(data, 'offVmPolicy');
  if (
    (provider !== 'aws-s3' && provider !== 's3-compatible') ||
    (credentialMode !== 'operator-role' && credentialMode !== 'sealed-access-key') ||
    (offVmPolicy !== 'required' && offVmPolicy !== 'secondary')
  ) {
    return null;
  }
  const accessKeyId = readText(data, 'accessKeyId');
  const secretAccessKey = readText(data, 'secretAccessKey');
  const sessionToken = readText(data, 'sessionToken');
  const fields = {
    region: readText(data, 'region').trim(),
    bucket: readText(data, 'bucket').trim(),
    prefix: readText(data, 'prefix').trim(),
    credentialMode,
    offVmPolicy,
    schedule: 'disabled' as const,
    ...(days || generations
      ? { retentionRequest: { ...(days ? { days: Number(days) } : {}), ...(generations ? { generations: Number(generations) } : {}) } }
      : {}),
    ...(credentialMode === 'sealed-access-key' && (accessKeyId || secretAccessKey || sessionToken)
      ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
      : {}),
  } as const;
  return provider === 'aws-s3'
    ? { ...fields, provider, addressing: 'virtual-hosted-style' }
    : { ...fields, provider, endpoint: readText(data, 'endpoint').trim(), addressing: 'path-style' };
}

function clearCredentialInputs(form: HTMLFormElement) {
  for (const name of ['accessKeyId', 'secretAccessKey', 'sessionToken']) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement) input.value = '';
  }
}

function DestinationForm({ config, href, onReauthenticate }: Props & { config: BackupConfiguration }) {
  const current = config.draft ?? config.active;
  const [provider, setProvider] = useState(current?.provider ?? 'aws-s3');
  const [credentialMode, setCredentialMode] = useState(current?.credentialMode ?? 'operator-role');
  const [latest, setLatest] = useState<BackupConfiguration | null>(null);
  const [revision, setRevision] = useState(config.revision);
  const mutation = useBackupWorkflow();
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<unknown>(null);
  const reviewRequired = ['conflict', 'unknown', 'disconnected'].includes(mutation.state);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mutation.canStart('draft') || reviewRequired) return;
    const form = event.currentTarget;
    const body = readDraft(form);
    clearCredentialInputs(form);
    if (!body) return;
    setLatest(null);
    setReviewError(null);
    void mutation.submit({ kind: 'draft' }, async () => {
      await requireFreshBackupOwner();
      await backupConsoleClient.saveDraft(body, revision);
      window.location.assign(href('/console/backups/verification'));
    });
  }

  async function reviewLatest() {
    setReviewLoading(true);
    setReviewError(null);
    try {
      setLatest(await backupConsoleClient.config());
    } catch (error) {
      setReviewError(error);
    } finally {
      setReviewLoading(false);
    }
  }

  const retention = current?.retentionRequest;
  return (
    <>
      <p className={styles.hint}>
        運用担当者が許可した保存先を指定します。バケットと S3 互換先は、現在の設定を表示するときに伏せられます。
      </p>
      {reviewRequired && latest && (
        <div className={styles.section}>
          <p role="status">最新の設定案はリビジョン {latest.revision} です。入力内容を保持しています。</p>
          <BackupDetails
            items={[
              ['保存先', latest.draft?.bucket ?? '未設定'],
              ['プレフィックス', latest.draft?.prefix ?? '未設定'],
              ['リージョン', latest.draft?.region ?? '未設定'],
            ]}
          />
          <button
            className="quiet-button"
            type="button"
            onClick={() => {
              setRevision(latest.revision);
              mutation.reviewCurrent();
              setReviewError(null);
            }}
          >
            このリビジョンに対して入力を使う
          </button>
        </div>
      )}
      <form
        className={styles.form}
        aria-label="S3 設定案"
        method="post"
        action="/api/console/backups/config/draft"
        autoComplete="off"
        onSubmit={submit}
      >
        <fieldset className={styles.fieldGroup} disabled={mutation.busy}>
          <legend>接続先</legend>
          <label className={styles.field}>
            S3 の種類
            <select
              className={styles.input}
              name="provider"
              value={provider}
              onChange={event => setProvider(event.currentTarget.value === 's3-compatible' ? 's3-compatible' : 'aws-s3')}
            >
              <option value="aws-s3">Amazon S3</option>
              <option value="s3-compatible">S3 互換サービス</option>
            </select>
          </label>
          {provider === 's3-compatible' && (
            <label className={styles.field}>
              許可された HTTPS オリジン（必須）
              <input
                className={styles.input}
                type="url"
                name="endpoint"
                required
                maxLength={300}
                spellCheck={false}
                autoCapitalize="none"
              />
            </label>
          )}
          <p className={styles.hint}>接続方式は {provider === 'aws-s3' ? 'virtual-hosted-style' : 'path-style'} です。</p>
          <label className={styles.field}>
            リージョン（必須）
            <input
              className={styles.input}
              name="region"
              required
              spellCheck={false}
              autoCapitalize="none"
              defaultValue={current?.region}
              maxLength={64}
            />
          </label>
          <label className={styles.field}>
            バケット（必須）
            <input className={styles.input} name="bucket" required spellCheck={false} autoCapitalize="none" maxLength={63} />
          </label>
          <label className={styles.field}>
            プレフィックス（必須）
            <input
              className={styles.input}
              name="prefix"
              required
              spellCheck={false}
              autoCapitalize="none"
              defaultValue={current?.prefix}
              maxLength={900}
            />
          </label>
        </fieldset>
        <fieldset className={styles.fieldGroup} disabled={mutation.busy}>
          <legend>資格情報と保護方針</legend>
          <label className={styles.field}>
            認証方法
            <select
              className={styles.input}
              name="credentialMode"
              value={credentialMode}
              onChange={event =>
                setCredentialMode(event.currentTarget.value === 'sealed-access-key' ? 'sealed-access-key' : 'operator-role')
              }
            >
              <option value="operator-role">運用担当者が設定したロール</option>
              <option value="sealed-access-key">アクセスキー</option>
            </select>
          </label>
          {credentialMode === 'sealed-access-key' && (
            <>
              <p className={styles.hint}>
                {current?.credentialConfigured
                  ? '資格情報は設定済みです。同じ保存先で既存のキーを使う場合は空欄にしてください。'
                  : 'アクセスキー ID とシークレットアクセスキーを入力してください。'}
                キーの入力欄は送信時に消去します。
              </p>
              <label className={styles.field}>
                アクセスキー ID
                <input
                  className={styles.input}
                  name="accessKeyId"
                  type="password"
                  autoComplete="new-password"
                  maxLength={128}
                  required={!current?.credentialConfigured}
                />
              </label>
              <label className={styles.field}>
                シークレットアクセスキー
                <input
                  className={styles.input}
                  name="secretAccessKey"
                  type="password"
                  autoComplete="new-password"
                  maxLength={256}
                  required={!current?.credentialConfigured}
                />
              </label>
              <label className={styles.field}>
                セッショントークン（任意）
                <input className={styles.input} name="sessionToken" type="password" autoComplete="new-password" maxLength={4096} />
              </label>
            </>
          )}
          <label className={styles.field}>
            遠隔保全の方針（必須）
            <select className={styles.input} name="offVmPolicy" defaultValue={current?.offVmPolicy ?? ''} required>
              <option value="" disabled>
                選択してください
              </option>
              <option value="required">必須</option>
              <option value="secondary">補助</option>
            </select>
          </label>
          <label className={styles.field}>
            保持を要求する日数（任意）
            <input
              className={styles.input}
              name="days"
              type="number"
              min={1}
              max={3650}
              defaultValue={typeof retention?.days === 'number' ? retention.days : undefined}
            />
          </label>
          <label className={styles.field}>
            保持を要求する世代数（任意）
            <input
              className={styles.input}
              name="generations"
              type="number"
              min={1}
              max={10000}
              defaultValue={typeof retention?.generations === 'number' ? retention.generations : undefined}
            />
          </label>
        </fieldset>
        <div className="codexia-console__actions">
          <button type="submit" disabled={!mutation.canStart('draft') || reviewRequired || reviewLoading}>
            パスキーで再認証して設定案を保存
          </button>
          {reviewRequired && (
            <button className="quiet-button" type="button" onClick={() => void reviewLatest()} disabled={reviewLoading}>
              最新のリビジョンを確認
            </button>
          )}
        </div>
      </form>
      <BackupFeedback error={reviewError ?? mutation.error} busy={mutation.busy || reviewLoading} onReauthenticate={onReauthenticate} />
    </>
  );
}

const protectionLabel = (value: string | undefined) =>
  value === 'enabled' ? '有効' : value === 'disabled' ? '無効' : value === 'suspended' ? '一時停止' : '未観測';
const retentionLabel = (value: unknown, unit: string, absent: string) => (typeof value === 'number' ? value + unit : absent);

const pending = (status: string) => status === 'QUEUED' || status === 'RUNNING';

export function BackupVerification({ href, onReauthenticate }: Props) {
  const load = useCallback(async (signal: AbortSignal) => {
    const config = await backupConsoleClient.config(signal);
    const check = async (kind: 'probe' | 'activate') => {
      const action = readBackupAction(kind);
      if (!action || !('revision' in action) || action.revision !== config.draft?.revision)
        return { action: null, value: null, error: null };
      try {
        return { action, value: await readConfigOperation(action, signal), error: null };
      } catch (error) {
        return { action, value: null, error };
      }
    };
    const [probe, activate] = await Promise.all([check('probe'), check('activate')]);
    return { config, probe, activate };
  }, []);
  const { read, refresh } = useBackupRead(load);
  const data = read.state === 'ready' ? read.value : null;
  const draft = data?.config.draft;
  const probe = data?.probe.value;
  const operation = data?.activate.value;
  const mutation = useBackupWorkflow(read, [
    backupObservation(data?.activate.action, operation, data?.activate.error),
    backupObservation(data?.probe.action, probe, data?.probe.error),
  ]);
  const current = draft && data?.config.active?.revision === draft.revision;
  const verifying = data?.probe.action && (!probe || pending(probe.status));
  const applying = data?.activate.action && (!operation || pending(operation.status));

  function request(kind: 'probe' | 'activate') {
    if (!draft) return;
    const prior = kind === 'probe' ? data?.probe : data?.activate;
    if (!mutation.canStart(kind, prior?.action)) return;
    const action =
      prior?.action && !prior.value
        ? prior.action
        : kind === 'probe'
          ? beginBackupAction({ kind, revision: draft.revision })
          : probe
            ? beginBackupAction({ kind, revision: draft.revision, probeId: probe.operationId })
            : null;
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
      <h2>接続検証</h2>
      <BackupRefresh refresh={refresh} disabled={read.state === 'loading' || mutation.busy} />
      <BackupFeedback
        error={read.state === 'error' ? read.error : (mutation.error ?? data?.probe.error ?? data?.activate.error)}
        busy={read.state === 'loading' || mutation.busy}
        onReauthenticate={onReauthenticate}
      />
      {data &&
        (draft ? (
          <>
            <BackupDetails
              items={[
                ['設定案リビジョン', draft.revision],
                ['保存先', [draft.bucket, draft.prefix].join(' / ')],
                ['資格情報', draft.credentialConfigured ? '設定済み' : '未設定'],
                [
                  '接続検証',
                  probe
                    ? backupStateLabel(probe.status)
                    : data.probe.action?.resultId
                      ? '受付済み・結果未確認'
                      : verifying
                        ? '受付結果未確認'
                        : '未実施',
                ],
                ...(probe
                  ? ([
                      ['検証 ID', backupValue(probe.operationId)],
                      ['検証の観測日時', backupTime(probe.observedAt)],
                    ] as const)
                  : []),
                ...(probe?.reasonCode ? ([['検証の理由コード', backupValue(probe.reasonCode)]] as const) : []),
                [
                  '保持の要求値',
                  retentionLabel(draft.retentionRequest?.days, ' 日', '日数の指定なし') +
                    ' / ' +
                    retentionLabel(draft.retentionRequest?.generations, ' 世代', '世代数の指定なし'),
                ],
                ['バケットのバージョン管理（検証時）', protectionLabel(probe?.evidence?.bucketVersioning)],
                ['Object Lock（検証時）', protectionLabel(probe?.evidence?.objectLock)],
                ['既定の保持日数（検証時）', retentionLabel(probe?.evidence?.defaultRetentionDays, ' 日', '未観測')],
                ['現在の適用状態', current ? 'この設定を適用済み' : '現在は未適用'],
                ...(data.activate.action
                  ? ([
                      [
                        '前回の有効化要求',
                        operation
                          ? backupStateLabel(operation.status)
                          : data.activate.action.resultId
                            ? '受付済み・結果未確認'
                            : '受付結果未確認',
                      ],
                    ] as const)
                  : []),
                ...(operation ? ([['有効化の操作 ID', backupValue(operation.operationId)]] as const) : []),
                ...(operation?.reasonCode ? ([['有効化の理由コード', backupValue(operation.reasonCode)]] as const) : []),
              ]}
            />
            <p className={styles.hint}>この画面で確認するのは接続と設定の適用です。遠隔保全の照合結果は保全履歴で確認できます。</p>
            <div className="codexia-console__actions">
              <button
                type="button"
                onClick={() => request('probe')}
                disabled={!mutation.canStart('probe', data?.probe.action) || Boolean(probe && pending(probe.status)) || Boolean(applying)}
              >
                {verifying && !probe ? '同じ接続検証要求を再送' : '接続検証を要求'}
              </button>
              {!current && (probe?.status === 'PASSED' || (applying && !operation)) && (
                <form
                  aria-label="検証済み設定の有効化"
                  method="post"
                  action="/api/console/backups/config/activate"
                  onSubmit={event => {
                    event.preventDefault();
                    request('activate');
                  }}
                >
                  <label className={styles.check}>
                    <input className={styles.checkInput} type="checkbox" required /> この設定案を有効化する
                  </label>
                  <button
                    type="submit"
                    disabled={!mutation.canStart('activate', data?.activate.action) || Boolean(operation && pending(operation.status))}
                  >
                    {applying && !operation ? '再認証して同じ有効化要求を再送' : 'パスキーで再認証して有効化を要求'}
                  </button>
                </form>
              )}
            </div>
            {current && (
              <a className="codexia-console__link" href={href('/console/backups')}>
                保全状況へ戻る
              </a>
            )}
          </>
        ) : (
          <p>保存済みの設定案がありません。</p>
        ))}
      <p>
        <a className="codexia-console__link" href={href('/console/backups/destination')}>
          保存先設定を開く
        </a>
      </p>
    </>
  );
}
