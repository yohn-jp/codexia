import { useActorRef, useSelector } from '@xstate/react';
import { useEffect, useId, useMemo, useState } from 'react';
import { authClient } from '../auth-client';
import { checkOwnerSession } from '../console/console-session';
import {
  fetchOwnerIdentity,
  type OwnerConsent,
  type OwnerIdentity,
  OwnerSecurityRequestError,
  revokeOwnerConsent,
} from './owner-security-client';
import './identity-management.css';
import { createOwnerGrantRevocationMachine } from './owner-grant-revocation-machine';

type IdentityState = { status: 'loading' | 'unavailable' } | { status: 'ready'; identity: OwnerIdentity };
type AuthResult<T> = { data?: T | null; error?: unknown };
type SessionPayload = { session?: { token?: string | null } | null };

function responseData<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object') throw new Error('Better Auth response is unavailable');
  const result = value as AuthResult<T>;
  if (result.error) throw result.error;
  if (!('data' in result)) throw new Error('Better Auth response is unavailable');
  return result.data ?? null;
}

async function ownerSessionToken(): Promise<string | null> {
  if ((await checkOwnerSession()) !== 'owner') return null;
  const result = responseData<SessionPayload>(await authClient.getSession());
  return result?.session?.token ?? null;
}

async function requireFreshOwnerPasskey(): Promise<void> {
  const previousToken = await ownerSessionToken();
  if (!previousToken) throw new Error('OWNER_SESSION_REQUIRED');
  const result = responseData<SessionPayload>(await authClient.signIn.passkey());
  const nextToken = await ownerSessionToken();
  if (!nextToken || nextToken === previousToken || nextToken !== result?.session?.token) {
    throw new Error('OWNER_SECURITY_REAUTH_REQUIRED');
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日時不明';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof OwnerSecurityRequestError) return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error) return error.message;
  return undefined;
}

function errorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code?.includes('REAUTH') || code?.includes('FRESH')) return '操作前に新しいパスキー認証が必要です。もう一度お試しください。';
  if (code === 'OWNER_SECURITY_CONSENT_CHANGED') return '同意の内容が更新されています。一覧を再取得しました。';
  if (code === 'OWNER_SECURITY_OWNER_REQUIRED' || code === 'OWNER_SESSION_REQUIRED') return '所有者としてサインインし直してください。';
  return 'OAuth grantを取り消せませんでした。一覧を確認してから再試行してください。';
}

export function OwnerIdentityPanel({ headingLevel = 3 }: { oidcConfigured?: boolean; headingLevel?: 2 | 3 }) {
  const id = useId();
  const [state, setState] = useState<IdentityState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  const loadIdentity = async (signal?: AbortSignal): Promise<OwnerIdentity | null> => {
    try {
      const deadline = AbortSignal.timeout(5_000);
      const identity = await fetchOwnerIdentity(fetch, signal ? AbortSignal.any([signal, deadline]) : deadline);
      if (signal?.aborted) return null;
      setState({ status: 'ready', identity });
      return identity;
    } catch {
      if (signal?.aborted) return null;
      setState({ status: 'unavailable' });
      return null;
    }
  };

  const revocationMachine = useMemo(
    () =>
      createOwnerGrantRevocationMachine({
        reauthenticate: () => requireFreshOwnerPasskey(),
        revoke: consent => revokeOwnerConsent(consent),
        reload: async consent => {
          const identity = await loadIdentity();
          if (!identity) return { status: 'unavailable' as const };
          return { status: identity.consents.some(row => row.id === consent.id) ? ('present' as const) : ('absent' as const) };
        },
      }),
    [],
  );
  const revocationActor = useActorRef(revocationMachine);
  const revocation = useSelector(revocationActor, snapshot => snapshot);
  const activeGrantId = revocation.context.grant?.id ?? null;
  const revocationBusy = (['reauthenticating', 'revoking', 'reloading'] as const).some(stateName => revocation.matches(stateName));

  useEffect(() => {
    if (revocation.matches('confirmed')) {
      setMessage('同意と発行済みOAuth grantを取り消しました。');
      setConfirmingId(null);
    } else if (revocation.matches('confirmedListUnavailable')) {
      setMessage('撤回はサーバーで確認されましたが、最新一覧を取得できませんでした。ページを再読み込みしてください。');
      setConfirmingId(null);
    } else if (revocation.matches('unknown')) {
      setMessage('操作結果を確認できませんでした。再取得した一覧を確認し、残っていれば再試行してください。');
      setConfirmingId(null);
    } else if (revocation.matches('cancelled')) {
      setMessage('パスキー認証はキャンセルされました。同意は取り消していません。');
      setConfirmingId(null);
    } else if (revocation.matches('failed')) {
      setMessage(errorMessage(revocation.context.error));
      setConfirmingId(null);
    } else if (revocation.matches('failedListUnavailable')) {
      setMessage(`${errorMessage(revocation.context.error)} 最新一覧も取得できませんでした。ページを再読み込みしてください。`);
      setConfirmingId(null);
    }
  }, [revocation]);

  useEffect(() => {
    const controller = new AbortController();
    void loadIdentity(controller.signal);
    return () => controller.abort();
  }, [attempt]);

  function withdraw(consent: OwnerConsent) {
    if (revocationBusy) return;
    setMessage('');
    revocationActor.send({ type: 'WITHDRAW', grant: consent });
  }

  const providerStatus = state.status === 'ready' ? state.identity.provider.status : null;
  const clients = state.status === 'ready' ? new Map(state.identity.clients.map(client => [client.clientId, client])) : new Map();

  return (
    <>
      <section className="identity-management__section" aria-labelledby={`${id}-oidc`}>
        <Heading id={`${id}-oidc`}>外部IDプロバイダー</Heading>
        {state.status === 'loading' && (
          <p className="identity-management__intro" role="status">
            設定状態を確認しています。
          </p>
        )}
        {state.status === 'unavailable' && (
          <p className="identity-management__intro" role="alert">
            設定状態を確認できませんでした。
          </p>
        )}
        {providerStatus === 'operator-configured-unverified' && (
          <p className="identity-management__intro">運用者による設定があります。所有者との連携はこの画面では未確認です。</p>
        )}
        {providerStatus === 'not-configured' && <p className="identity-management__intro">外部IDプロバイダーは未設定です。</p>}
      </section>
      <section className="identity-management__section" aria-labelledby={`${id}-consents`}>
        <Heading id={`${id}-consents`}>アプリに保存した同意</Heading>
        {state.status === 'loading' && (
          <p className="identity-management__hint" role="status">
            同意を読み込んでいます。
          </p>
        )}
        {state.status === 'unavailable' && (
          <>
            <p className="identity-management__error" role="alert">
              同意を読み込めませんでした。
            </p>
            <button
              className="identity-management__secondary"
              type="button"
              onClick={() => {
                setState({ status: 'loading' });
                setAttempt(value => value + 1);
              }}
            >
              同意を再読み込み
            </button>
          </>
        )}
        {state.status === 'ready' &&
          (state.identity.consents.length > 0 ? (
            <ul className="identity-management__list" aria-label="保存したアプリ同意">
              {state.identity.consents.map(consent => {
                const client = clients.get(consent.clientId);
                const confirming = confirmingId === consent.id;
                const busy = revocationBusy && activeGrantId === consent.id;
                return (
                  <li className="identity-management__list-item" key={consent.id}>
                    <div className="identity-management__item-main">
                      <h4>{client?.name ?? consent.clientId}</h4>
                      <p className="identity-management__meta">{consent.clientId}</p>
                      <p className="identity-management__meta">{consent.scopes.length ? consent.scopes.join('、') : 'スコープなし'}</p>
                      <p className="identity-management__meta">更新: {formatDate(consent.updatedAt)}</p>
                      {client?.disabled && <p className="identity-management__meta">このアプリは現在無効です。</p>}
                    </div>
                    {confirming ? (
                      <div className="identity-management__item-actions">
                        <p className="identity-management__hint">
                          パスキーで再認証した後、このアプリの同意と既発行のアクセス・更新トークンを取り消します。
                        </p>
                        <button className="identity-management__danger" type="button" disabled={busy} onClick={() => withdraw(consent)}>
                          {busy ? '再認証・取り消し中…' : 'パスキーで認証して取り消す'}
                        </button>
                        <button
                          className="identity-management__secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmingId(null)}
                        >
                          戻る
                        </button>
                      </div>
                    ) : (
                      <button
                        className="identity-management__secondary"
                        type="button"
                        disabled={revocationBusy}
                        onClick={() => {
                          setMessage('');
                          setConfirmingId(consent.id);
                        }}
                      >
                        同意を取り消す
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="identity-management__empty">保存したアプリ同意はありません。</p>
          ))}
        {message && (
          <p className="identity-management__intro" role="status">
            {message}
          </p>
        )}
      </section>
    </>
  );
}
