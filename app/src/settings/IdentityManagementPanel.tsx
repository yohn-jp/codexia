import { useActorRef, useSelector } from '@xstate/react';
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { authClient } from '../auth-client';
import { checkOwnerSession } from '../console/console-session';
import { fetchAuthMethodAvailability } from '../oauth-login';
import { OwnerIdentityPanel } from './OwnerIdentityPanel';
import { createOwnerPasskeyReauthMachine } from './owner-passkey-reauth-machine';
import { confirmAuthMutation, outcomeWasUnconfirmed } from './owner-security-client';
import './identity-management.css';

type AuthClientResult<T> = { data?: T | null; error?: unknown };

interface PasskeyRecord {
  id: string;
  name?: string | null;
  createdAt?: string | Date | null;
  deviceType?: string | null;
  backedUp?: boolean;
}

interface BetterAuthSession {
  id: string;
  token: string;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  expiresAt?: string | Date | null;
  userAgent?: string | null;
}

interface BetterAuthSessionPayload {
  session?: { token?: string | null } | null;
}

/**
 * The auth runtime phase wires passkeyClient() into the shared client. Keep this
 * view on that single Better Auth authority while its generated plugin types
 * arrive with the runtime change.
 */
interface BetterAuthPasskeyClient {
  listUserPasskeys(): Promise<AuthClientResult<PasskeyRecord[]>>;
  addPasskey(input: { name?: string }): Promise<AuthClientResult<unknown>>;
  updatePasskey(input: { id: string; name: string }): Promise<AuthClientResult<unknown>>;
  deletePasskey(input: { id: string }): Promise<AuthClientResult<unknown>>;
}

// Check the optional plugin surface before showing credential actions.
const passkeyClient = (authClient as typeof authClient & { passkey?: BetterAuthPasskeyClient }).passkey;

type OwnerAccess =
  | { status: 'checking' }
  | { status: 'hidden' }
  | { status: 'unavailable'; reason: 'client' | 'session' }
  | { status: 'ready'; currentSessionToken: string; oidcConfigured: boolean };

function authData<T>(result: unknown, fallback: string): T | null {
  if (!result || typeof result !== 'object') throw new Error(fallback);
  const response = result as AuthClientResult<T>;
  if (response.error) throw response.error;
  if (!('data' in response)) throw new Error(fallback);
  return response.data ?? null;
}

function passkeyId(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'id' in data && typeof data.id === 'string' && data.id) return data.id;
  return undefined;
}

function authStatusTrue(data: unknown): boolean {
  return Boolean(data && typeof data === 'object' && 'status' in data && data.status === true);
}

async function confirmOwnerSessionToken(): Promise<string | null> {
  if ((await checkOwnerSession()) !== 'owner') return null;
  const current = authData<BetterAuthSessionPayload>(await authClient.getSession(), 'Better Auth session is unavailable');
  return current?.session?.token ?? null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (!error || typeof error !== 'object') return String(error ?? '');
  const record = error as { code?: unknown; message?: unknown; name?: unknown };
  return [record.code, record.name, record.message].filter(part => typeof part === 'string').join(' ');
}

function securityErrorMessage(error: unknown, fallback: string): string {
  const details = errorText(error).toLowerCase();
  if (/fresh|reauth|re-auth|session.*expired|expired.*session/.test(details)) {
    return '認証の有効期限が切れているか、再認証が必要です。サインインし直してから再試行してください。';
  }
  if (/last.{0,30}(passkey|credential|method)|passkey.{0,30}last/.test(details)) {
    return '最後のパスキーは削除できません。別のパスキーを追加してから再試行してください。';
  }
  if (
    /notallowederror|ceremony_aborted|registration_cancelled|user cancelled|user canceled|cancelled by user|canceled by user/.test(details)
  ) {
    return 'パスキー登録はキャンセルされました。必要な場合はもう一度お試しください。';
  }
  if (/invalidstateerror|previously_registered|already exists|already registered/.test(details)) {
    return 'この認証器には登録済みのパスキーがあります。既存の一覧を確認してください。';
  }
  if (/securityerror|rp.?id|secure context|origin/.test(details)) {
    return 'この接続ではパスキーを登録できません。安全な接続を確認してから再試行してください。';
  }
  return fallback;
}

async function mutationErrorMessage(error: unknown, fallback: string, reload: () => Promise<boolean>): Promise<string> {
  if (!outcomeWasUnconfirmed(error)) return securityErrorMessage(error, fallback);
  const refreshed = await reload();
  return refreshed
    ? '操作の応答を確認できませんでした。再取得した一覧で状態を確認してください。'
    : '操作の応答を確認できず、一覧も取得できませんでした。再試行する前にページを再読み込みしてください。';
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '日時不明';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '日時不明';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function supportsPasskeyRegistration(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'PublicKeyCredential' in window &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.credentials) &&
    typeof navigator.credentials.create === 'function'
  );
}

async function readPasskeyAuthRuntime(): Promise<{ oidcConfigured: boolean } | null> {
  try {
    const methods = await fetchAuthMethodAvailability(fetch, AbortSignal.timeout(5_000));
    return { oidcConfigured: methods.upstreamOidc };
  } catch {
    return null;
  }
}

export function IdentityManagementPanel({ placement }: { placement: 'desktop' | 'mobile' | 'console' }) {
  const [access, setAccess] = useState<OwnerAccess>({ status: 'checking' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([]);
  const [sessions, setSessions] = useState<BetterAuthSession[]>([]);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [newPasskeyName, setNewPasskeyName] = useState('');
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [busyPasskeyId, setBusyPasskeyId] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [revokingOtherSessions, setRevokingOtherSessions] = useState(false);
  const [confirmingOtherSessions, setConfirmingOtherSessions] = useState(false);
  const [passkeyError, setPasskeyError] = useState('');
  const [passkeyMessage, setPasskeyMessage] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [sessionMessage, setSessionMessage] = useState('');
  const panelId = useId();
  const accessRef = useRef(access);
  useEffect(() => {
    accessRef.current = access;
  }, [access]);
  const reauthMachine = useMemo(
    () =>
      createOwnerPasskeyReauthMachine(async () => {
        const previousToken = accessRef.current.status === 'ready' ? accessRef.current.currentSessionToken : null;
        if (!previousToken) throw new Error('OWNER_SESSION_REQUIRED');
        try {
          const result = authData<BetterAuthSessionPayload>(await authClient.signIn.passkey(), 'Better Auth response is unavailable');
          const token = await confirmOwnerSessionToken();
          if (!token || token === previousToken || token !== result?.session?.token) {
            throw new TypeError('Better Auth did not confirm the new owner session');
          }
          setAccess(current => (current.status === 'ready' ? { ...current, currentSessionToken: token } : current));
        } catch (error) {
          const token = await confirmOwnerSessionToken().catch(() => null);
          if (!token) {
            setAccess({ status: 'unavailable', reason: 'session' });
          } else if (token !== previousToken) {
            setAccess(current => (current.status === 'ready' ? { ...current, currentSessionToken: token } : current));
            await loadSessions();
          }
          throw error;
        }
      }),
    [],
  );
  const reauthActor = useActorRef(reauthMachine);
  const reauthSnapshot = useSelector(reauthActor, snapshot => snapshot);
  const reauthenticating = reauthSnapshot.matches('authenticating');

  useEffect(() => {
    let active = true;
    void (async () => {
      // Check passkey capability before requesting the authenticated owner session.
      const runtime = await readPasskeyAuthRuntime();
      if (!runtime) {
        if (active) setAccess(placement === 'console' ? { status: 'unavailable', reason: 'client' } : { status: 'hidden' });
        return;
      }
      if (placement !== 'console') {
        try {
          const apiSession = await api.session();
          if (apiSession.authenticated !== true || apiSession.authorScope !== 'owner') {
            if (active) setAccess({ status: 'hidden' });
            return;
          }
        } catch {
          if (active) setAccess({ status: 'hidden' });
          return;
        }
      }
      try {
        const clientReady = Boolean(
          passkeyClient &&
            typeof passkeyClient.listUserPasskeys === 'function' &&
            typeof passkeyClient.addPasskey === 'function' &&
            typeof passkeyClient.updatePasskey === 'function' &&
            typeof passkeyClient.deletePasskey === 'function' &&
            typeof authClient.listSessions === 'function' &&
            typeof authClient.revokeSession === 'function' &&
            typeof authClient.revokeOtherSessions === 'function' &&
            typeof authClient.getSession === 'function',
        );
        if (!clientReady) {
          if (active) setAccess({ status: 'unavailable', reason: 'client' });
          return;
        }
        const token = await confirmOwnerSessionToken();
        if (!token) {
          if (active) setAccess({ status: 'unavailable', reason: 'session' });
          return;
        }
        if (active) setAccess({ status: 'ready', currentSessionToken: token, oidcConfigured: runtime.oidcConfigured });
      } catch {
        if (active) setAccess({ status: 'unavailable', reason: 'session' });
      }
    })();
    return () => {
      active = false;
    };
  }, [placement]);

  const loadPasskeys = useCallback(async (): Promise<boolean> => {
    setPasskeyLoading(true);
    setPasskeyError('');
    try {
      const rows = authData<PasskeyRecord[]>(await passkeyClient?.listUserPasskeys(), 'Passkey list is unavailable');
      if (!Array.isArray(rows)) throw new Error('Passkey list is unavailable');
      setPasskeys(rows);
      return true;
    } catch (error) {
      setPasskeys([]);
      setPasskeyError(securityErrorMessage(error, 'パスキーの一覧を読み込めませんでした。再読み込みしてもう一度お試しください。'));
      return false;
    } finally {
      setPasskeyLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async (): Promise<boolean> => {
    setSessionLoading(true);
    setSessionError('');
    try {
      const rows = authData<BetterAuthSession[]>(await authClient.listSessions(), 'Session list is unavailable');
      if (!Array.isArray(rows)) throw new Error('Session list is unavailable');
      setSessions(rows);
      return true;
    } catch (error) {
      setSessions([]);
      setSessionError(
        securityErrorMessage(error, 'セッションを読み込めませんでした。再認証が必要な場合は、サインインし直してから再試行してください。'),
      );
      return false;
    } finally {
      setSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    if (reauthSnapshot.matches('success')) {
      void loadSessions();
      setPasskeyError('');
      setPasskeyMessage('パスキーで再認証しました。');
    } else if (reauthSnapshot.matches('cancelled') || reauthSnapshot.matches('failed')) {
      const cancelled = reauthSnapshot.matches('cancelled');
      setPasskeyError(
        cancelled
          ? 'パスキー認証の完了を確認できませんでした。認証状態を再確認してください。'
          : securityErrorMessage(reauthSnapshot.context.error, 'パスキーでの再認証を確認できませんでした。'),
      );
    }
  }, [loadSessions, reauthSnapshot]);

  const panelVisible = access.status === 'ready' && (placement !== 'desktop' || dialogOpen);
  useEffect(() => {
    if (!panelVisible) return;
    setCapabilityLoading(true);
    setPasskeySupported(supportsPasskeyRegistration());
    setCapabilityLoading(false);
    void loadPasskeys();
    void loadSessions();
  }, [panelVisible, loadPasskeys, loadSessions]);

  const addPasskey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAddingPasskey(true);
    setPasskeyError('');
    setPasskeyMessage('');
    try {
      const name = newPasskeyName.trim();
      confirmAuthMutation(await passkeyClient?.addPasskey(name ? { name } : {}), data => Boolean(passkeyId(data)));
      setNewPasskeyName('');
      const refreshed = await loadPasskeys();
      setPasskeyMessage(
        refreshed ? 'パスキーを追加しました。' : '追加は完了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。',
      );
    } catch (error) {
      setPasskeyError(await mutationErrorMessage(error, 'パスキーを追加できませんでした。', loadPasskeys));
    } finally {
      setAddingPasskey(false);
    }
  };

  const renamePasskey = async (id: string, name: string): Promise<boolean> => {
    setBusyPasskeyId(id);
    setPasskeyError('');
    setPasskeyMessage('');
    try {
      confirmAuthMutation(await passkeyClient?.updatePasskey({ id, name }), data =>
        Boolean(data && typeof data === 'object' && 'passkey' in data && passkeyId(data.passkey) === id),
      );
      const refreshed = await loadPasskeys();
      setPasskeyMessage(
        refreshed
          ? 'パスキー名を変更しました。'
          : '名前の変更は完了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。',
      );
      return true;
    } catch (error) {
      setPasskeyError(await mutationErrorMessage(error, 'パスキー名を変更できませんでした。', loadPasskeys));
      return false;
    } finally {
      setBusyPasskeyId(null);
    }
  };

  const deletePasskey = async (id: string): Promise<boolean> => {
    if (passkeys.length <= 1) {
      setPasskeyError('最後のパスキーは削除できません。別のパスキーを追加してから再試行してください。');
      return false;
    }
    setBusyPasskeyId(id);
    setPasskeyError('');
    setPasskeyMessage('');
    try {
      confirmAuthMutation(await passkeyClient?.deletePasskey({ id }), authStatusTrue);
      const refreshed = await loadPasskeys();
      setPasskeyMessage(
        refreshed ? 'パスキーを削除しました。' : '削除は完了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。',
      );
      return true;
    } catch (error) {
      setPasskeyError(await mutationErrorMessage(error, 'パスキーを削除できませんでした。', loadPasskeys));
      return false;
    } finally {
      setBusyPasskeyId(null);
    }
  };

  const revokeSession = async (session: BetterAuthSession): Promise<boolean> => {
    if (access.status !== 'ready' || session.token === access.currentSessionToken) return false;
    setBusySessionId(session.id);
    setSessionError('');
    setSessionMessage('');
    try {
      confirmAuthMutation(await authClient.revokeSession({ token: session.token }), authStatusTrue);
      const refreshed = await loadSessions();
      setSessionMessage(
        refreshed
          ? 'セッションを終了しました。'
          : 'セッションは終了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。',
      );
      return true;
    } catch (error) {
      setSessionError(await mutationErrorMessage(error, 'セッションを終了できませんでした。', loadSessions));
      return false;
    } finally {
      setBusySessionId(null);
    }
  };

  const revokeOtherSessions = async () => {
    setRevokingOtherSessions(true);
    setSessionError('');
    setSessionMessage('');
    try {
      confirmAuthMutation(await authClient.revokeOtherSessions(), authStatusTrue);
      const refreshed = await loadSessions();
      setConfirmingOtherSessions(false);
      setSessionMessage(
        refreshed
          ? '現在の端末以外のセッションを終了しました。'
          : '他のセッションは終了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。',
      );
    } catch (error) {
      setSessionError(await mutationErrorMessage(error, '他のセッションを終了できませんでした。', loadSessions));
    } finally {
      setRevokingOtherSessions(false);
    }
  };

  const reauthenticateWithPasskey = async () => {
    if (access.status !== 'ready' || reauthenticating) return;
    setPasskeyError('');
    setPasskeyMessage('');
    reauthActor.send({ type: 'REAUTHENTICATE' });
  };

  const openDialog = () => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    setDialogOpen(true);
  };

  if (access.status === 'hidden') return null;
  if (access.status === 'checking') return placement === 'console' ? <p role="status">認証状態を確認しています。</p> : null;
  if (access.status === 'unavailable') {
    const unavailableMessage =
      access.reason === 'session'
        ? '認証セッションを確認できません。サインインし直したあと、もう一度この画面を開いてください。'
        : '認証管理機能を利用できません。時間をおいてからページを再読み込みしてください。';
    return placement === 'desktop' ? (
      <p className="identity-management__unavailable-inline" role="status">
        {unavailableMessage}
      </p>
    ) : (
      <section className="identity-management identity-management__unavailable" aria-labelledby={`${panelId}-unavailable`}>
        <h2 id={`${panelId}-unavailable`}>認証とセキュリティ</h2>
        <p>{unavailableMessage}</p>
      </section>
    );
  }

  const SectionHeading = placement === 'console' ? 'h2' : 'h3';
  const currentSessionListed = sessions.some(session => session.token === access.currentSessionToken);
  const otherSessions = sessions.filter(session => session.token !== access.currentSessionToken);

  const content = (
    <div className="identity-management__content">
      <section className="identity-management__section" aria-labelledby={`${panelId}-passkeys`}>
        <SectionHeading id={`${panelId}-passkeys`}>パスキー</SectionHeading>
        <p className="identity-management__intro">登録した認証器を管理します。追加・改名・削除には最近のサインインが必要です。</p>
        {placement === 'console' && passkeySupported && passkeys.length > 0 && (
          <button
            className="identity-management__secondary"
            type="button"
            disabled={reauthenticating || addingPasskey || busyPasskeyId !== null || busySessionId !== null || revokingOtherSessions}
            onClick={() => void reauthenticateWithPasskey()}
          >
            {reauthenticating ? '再認証しています…' : 'パスキーで再認証'}
          </button>
        )}
        <div className="identity-management__add-form">
          <h4 id={`${panelId}-add-passkey-title`}>パスキーを追加</h4>
          {passkeySupported ? (
            <form
              className="identity-management__add-form-fields"
              aria-labelledby={`${panelId}-add-passkey-title`}
              onSubmit={event => void addPasskey(event)}
            >
              <label htmlFor={`${panelId}-new-passkey-name`}>名前（任意）</label>
              <div className="identity-management__form-row">
                <input
                  id={`${panelId}-new-passkey-name`}
                  name="passkeyName"
                  type="text"
                  autoComplete="off"
                  maxLength={80}
                  disabled={reauthenticating || addingPasskey || busyPasskeyId !== null}
                  value={newPasskeyName}
                  onChange={event => setNewPasskeyName(event.target.value)}
                  aria-describedby={`${panelId}-passkey-name-help`}
                />
                <button
                  className="identity-management__primary"
                  type="submit"
                  disabled={reauthenticating || addingPasskey || busyPasskeyId !== null || capabilityLoading}
                >
                  {addingPasskey ? '認証器を確認中…' : 'パスキーを追加'}
                </button>
              </div>
              <p id={`${panelId}-passkey-name-help`} className="identity-management__hint">
                例：MacBook Pro、セキュリティキー
              </p>
            </form>
          ) : null}
          {capabilityLoading ? (
            <p className="identity-management__hint" role="status">
              このブラウザーの対応状況を確認しています。
            </p>
          ) : null}
          {!capabilityLoading && !passkeySupported ? (
            <p className="identity-management__hint">パスキー登録には、安全な接続とWebAuthn対応ブラウザーが必要です。</p>
          ) : null}
        </div>
        {passkeyError ? (
          <p className="identity-management__error" role="alert">
            {passkeyError}
          </p>
        ) : null}
        {passkeyMessage ? (
          <p className="identity-management__message" role="status">
            {passkeyMessage}
          </p>
        ) : null}
        {passkeyLoading ? (
          <div className="identity-management__loading" role="status" aria-label="パスキーを読み込んでいます">
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </div>
        ) : passkeyError && passkeys.length === 0 ? null : passkeys.length === 0 ? (
          <p className="identity-management__empty">登録済みのパスキーはありません。追加すると、次回からパスキーでサインインできます。</p>
        ) : (
          <ul className="identity-management__list" aria-label="登録済みのパスキー">
            {passkeys.map(passkey => (
              <PasskeyRow
                key={passkey.id}
                passkey={passkey}
                canDelete={passkeys.length > 1}
                disabled={reauthenticating || busyPasskeyId !== null || addingPasskey}
                onRename={renamePasskey}
                onDelete={deletePasskey}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="identity-management__section" aria-labelledby={`${panelId}-sessions`}>
        <SectionHeading id={`${panelId}-sessions`}>セッション</SectionHeading>
        <p className="identity-management__intro">サインイン中のブラウザーや端末を確認して、不要なセッションを終了できます。</p>
        {sessionError ? (
          <p className="identity-management__error" role="alert">
            {sessionError}
          </p>
        ) : null}
        {sessionMessage ? (
          <p className="identity-management__message" role="status">
            {sessionMessage}
          </p>
        ) : null}
        {sessionLoading ? (
          <div className="identity-management__loading" role="status" aria-label="セッションを読み込んでいます">
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </div>
        ) : sessionError && sessions.length === 0 ? null : sessions.length === 0 ? (
          <p className="identity-management__empty">有効なセッションはありません。</p>
        ) : (
          <>
            {!currentSessionListed ? (
              <p className="identity-management__hint">現在のセッションを判定できないため、個別の終了操作を無効にしています。</p>
            ) : null}
            {otherSessions.length > 0 &&
              (confirmingOtherSessions ? (
                // biome-ignore lint/a11y/useSemanticElements: This groups confirmation actions, not form fields.
                <div className="identity-management__inline-confirm" role="group" aria-labelledby={`${panelId}-revoke-other`}>
                  <p id={`${panelId}-revoke-other`}>現在のセッションを残して、ほかのセッションを終了しますか？</p>
                  <div className="identity-management__actions">
                    <button
                      className="identity-management__secondary"
                      type="button"
                      disabled={revokingOtherSessions}
                      onClick={() => setConfirmingOtherSessions(false)}
                    >
                      キャンセル
                    </button>
                    <button
                      className="identity-management__danger"
                      type="button"
                      disabled={reauthenticating || revokingOtherSessions || busySessionId !== null}
                      onClick={() => void revokeOtherSessions()}
                    >
                      {revokingOtherSessions ? '終了しています…' : '他のセッションを終了する'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="identity-management__secondary"
                  type="button"
                  disabled={reauthenticating || busySessionId !== null}
                  onClick={() => setConfirmingOtherSessions(true)}
                >
                  他のすべてのセッションを終了
                </button>
              ))}
            <ul className="identity-management__list" aria-label="有効なセッション">
              {sessions.map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  current={session.token === access.currentSessionToken}
                  currentSessionKnown={currentSessionListed}
                  disabled={reauthenticating || busySessionId !== null || revokingOtherSessions}
                  busy={busySessionId === session.id}
                  onRevoke={revokeSession}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      {placement !== 'console' && panelVisible && <OwnerIdentityPanel oidcConfigured={access.oidcConfigured} />}
    </div>
  );

  if (placement === 'console') return <div className="identity-management">{content}</div>;

  if (placement === 'mobile') {
    return (
      <section className="identity-management identity-management--mobile" aria-labelledby={`${panelId}-title`}>
        <h2 id={`${panelId}-title`}>認証とセキュリティ</h2>
        {content}
      </section>
    );
  }

  return (
    <div className="identity-management identity-management--desktop">
      <button className="identity-management__trigger" type="button" onClick={openDialog}>
        認証・セキュリティ
      </button>
      <dialog
        ref={dialogRef}
        className="identity-management__dialog"
        aria-labelledby={`${panelId}-title`}
        onClose={() => setDialogOpen(false)}
      >
        <div className="identity-management__dialog-header">
          <h2 id={`${panelId}-title`}>認証とセキュリティ</h2>
          {/* biome-ignore lint/a11y/noAutofocus: The user explicitly opened this modal dialog, so focus stays inside it. */}
          <button className="identity-management__secondary" type="button" autoFocus onClick={() => dialogRef.current?.close()}>
            閉じる
          </button>
        </div>
        {content}
      </dialog>
    </div>
  );
}

function PasskeyRow({
  passkey,
  canDelete,
  disabled,
  onRename,
  onDelete,
}: {
  passkey: PasskeyRecord;
  canDelete: boolean;
  disabled: boolean;
  onRename(id: string, name: string): Promise<boolean>;
  onDelete(id: string): Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(passkey.name ?? '');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const rowId = useId();
  const displayName = passkey.name?.trim() || '名前未設定のパスキー';
  const deviceLabel =
    passkey.deviceType === 'multiDevice'
      ? '複数端末で利用できる認証器'
      : passkey.deviceType === 'singleDevice'
        ? '単一デバイス型認証器'
        : '認証器の種類は不明';
  const backupLabel =
    passkey.backedUp === true ? 'バックアップ済み' : passkey.backedUp === false ? 'バックアップなし' : 'バックアップ状態は不明';

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem('passkeyName');
    const nextName = name.trim();
    if (!nextName) {
      if (input instanceof HTMLInputElement) {
        input.setCustomValidity('名前を入力してください。');
        input.reportValidity();
      }
      return;
    }
    if (input instanceof HTMLInputElement) input.setCustomValidity('');
    if (await onRename(passkey.id, nextName)) setEditing(false);
  };

  const confirmDelete = async () => {
    if (!canDelete) return;
    if (await onDelete(passkey.id)) setConfirmingDelete(false);
  };

  useEffect(() => {
    if (!canDelete) setConfirmingDelete(false);
  }, [canDelete]);

  useEffect(() => {
    if (editing) renameInputRef.current?.focus();
  }, [editing]);

  return (
    <li className="identity-management__list-item">
      <div className="identity-management__item-main">
        <h4>{displayName}</h4>
        <p className="identity-management__meta">
          {deviceLabel} · {backupLabel}
        </p>
        {passkey.createdAt ? <p className="identity-management__meta">登録日：{formatDate(passkey.createdAt)}</p> : null}
      </div>
      {!editing && !confirmingDelete ? (
        <div className="identity-management__actions">
          <button
            className="identity-management__secondary"
            type="button"
            disabled={disabled}
            aria-label={`${displayName}の名前を変更`}
            onClick={() => setEditing(true)}
          >
            名前を変更
          </button>
          <button
            className="identity-management__danger-quiet"
            type="button"
            disabled={disabled || !canDelete}
            aria-label={`${displayName}を削除`}
            onClick={() => setConfirmingDelete(true)}
          >
            削除
          </button>
        </div>
      ) : null}
      {!canDelete && !editing && !confirmingDelete ? (
        <p className="identity-management__hint">最後のパスキーは削除できません。別のパスキーを追加してから削除してください。</p>
      ) : null}
      {editing ? (
        <form
          className="identity-management__inline-form"
          aria-labelledby={`${rowId}-rename-title`}
          onSubmit={event => void submitRename(event)}
        >
          <h5 id={`${rowId}-rename-title`}>パスキー名を変更</h5>
          <label htmlFor={`${rowId}-name`}>新しい名前</label>
          <input
            ref={renameInputRef}
            id={`${rowId}-name`}
            name="passkeyName"
            type="text"
            maxLength={80}
            required
            value={name}
            onChange={event => {
              setName(event.target.value);
              event.currentTarget.setCustomValidity('');
            }}
          />
          <div className="identity-management__actions">
            <button className="identity-management__primary" type="submit" disabled={disabled}>
              保存
            </button>
            <button
              className="identity-management__secondary"
              type="button"
              disabled={disabled}
              onClick={() => {
                setName(passkey.name ?? '');
                setEditing(false);
              }}
            >
              キャンセル
            </button>
          </div>
        </form>
      ) : null}
      {confirmingDelete && canDelete ? (
        // biome-ignore lint/a11y/useSemanticElements: This groups confirmation actions, not form fields.
        <div className="identity-management__inline-confirm" role="group" aria-labelledby={`${rowId}-delete-title`}>
          <p id={`${rowId}-delete-title`}>{displayName}を削除しますか？</p>
          <div className="identity-management__actions">
            <button className="identity-management__secondary" type="button" disabled={disabled} onClick={() => setConfirmingDelete(false)}>
              キャンセル
            </button>
            <button
              className="identity-management__danger"
              type="button"
              disabled={disabled || !canDelete}
              onClick={() => void confirmDelete()}
            >
              {disabled ? '削除しています…' : '削除する'}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function SessionRow({
  session,
  current,
  currentSessionKnown,
  disabled,
  busy,
  onRevoke,
}: {
  session: BetterAuthSession;
  current: boolean;
  currentSessionKnown: boolean;
  disabled: boolean;
  busy: boolean;
  onRevoke(session: BetterAuthSession): Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const rowId = useId();
  const canRevoke = currentSessionKnown && !current;
  const confirm = async () => {
    if (await onRevoke(session)) setConfirming(false);
  };

  return (
    <li className="identity-management__list-item">
      <div className="identity-management__item-main">
        <h4>{current ? 'この端末' : 'セッション'}</h4>
        {session.userAgent ? (
          <p className="identity-management__meta identity-management__user-agent">{session.userAgent}</p>
        ) : (
          <p className="identity-management__meta">デバイス情報はありません</p>
        )}
        {session.createdAt ? <p className="identity-management__meta">開始：{formatDate(session.createdAt)}</p> : null}
        {session.updatedAt ? <p className="identity-management__meta">最終更新：{formatDate(session.updatedAt)}</p> : null}
        {session.expiresAt ? <p className="identity-management__meta">有効期限：{formatDate(session.expiresAt)}</p> : null}
      </div>
      {canRevoke && !confirming ? (
        <div className="identity-management__actions">
          <button
            className="identity-management__danger-quiet"
            type="button"
            disabled={disabled}
            aria-label={`セッションを終了: ${session.userAgent ?? formatDate(session.updatedAt ?? session.createdAt)}`}
            onClick={() => setConfirming(true)}
          >
            セッションを終了
          </button>
        </div>
      ) : null}
      {canRevoke && confirming ? (
        // biome-ignore lint/a11y/useSemanticElements: This groups confirmation actions, not form fields.
        <div className="identity-management__inline-confirm" role="group" aria-labelledby={`${rowId}-revoke-title`}>
          <p id={`${rowId}-revoke-title`}>このセッションを終了しますか？</p>
          <div className="identity-management__actions">
            <button className="identity-management__secondary" type="button" disabled={disabled} onClick={() => setConfirming(false)}>
              キャンセル
            </button>
            <button className="identity-management__danger" type="button" disabled={disabled} onClick={() => void confirm()}>
              {busy ? '終了しています…' : '終了する'}
            </button>
          </div>
        </div>
      ) : null}
      {current ? <p className="identity-management__current-label">現在の端末</p> : null}
    </li>
  );
}
