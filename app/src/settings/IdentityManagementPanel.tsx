import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { authClient } from "../auth-client";
import "./identity-management.css";

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
  | { status: "checking" }
  | { status: "hidden" }
  | { status: "unavailable"; reason: "client" | "session" }
  | { status: "ready"; currentSessionToken: string };

function authData<T>(result: unknown, fallback: string): T | null {
  if (!result || typeof result !== "object") throw new Error(fallback);
  const response = result as AuthClientResult<T>;
  if (response.error) throw response.error;
  if (!("data" in response)) throw new Error(fallback);
  return response.data ?? null;
}

function authSuccess(result: unknown, fallback: string): unknown {
  if (!result || typeof result !== "object") throw new Error(fallback);
  const response = result as AuthClientResult<unknown>;
  if (response.error) throw response.error;
  if (!("data" in response)) throw new Error(fallback);
  return response.data;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (!error || typeof error !== "object") return String(error ?? "");
  const record = error as { code?: unknown; message?: unknown; name?: unknown };
  return [record.code, record.name, record.message].filter((part) => typeof part === "string").join(" ");
}

function securityErrorMessage(error: unknown, fallback: string): string {
  const details = errorText(error).toLowerCase();
  if (/fresh|reauth|re-auth|session.*expired|expired.*session/.test(details)) {
    return "認証の有効期限が切れているか、再認証が必要です。サインインし直してから再試行してください。";
  }
  if (/last.{0,30}(passkey|credential|method)|passkey.{0,30}last/.test(details)) {
    return "最後のパスキーは削除できません。別のパスキーを追加してから再試行してください。";
  }
  if (/notallowederror|user cancelled|user canceled|cancelled by user|canceled by user/.test(details)) {
    return "パスキー登録はキャンセルされました。必要な場合はもう一度お試しください。";
  }
  if (/invalidstateerror|already exists|already registered/.test(details)) {
    return "この認証器には登録済みのパスキーがあります。既存の一覧を確認してください。";
  }
  if (/securityerror|rp.?id|secure context|origin/.test(details)) {
    return "この接続ではパスキーを登録できません。安全な接続を確認してから再試行してください。";
  }
  return fallback;
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "日時不明";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "日時不明";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function supportsPasskeyRegistration(): boolean {
  return typeof window !== "undefined" &&
    window.isSecureContext &&
    "PublicKeyCredential" in window &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.credentials) &&
    typeof navigator.credentials.create === "function";
}

async function hasPasskeyAuthRuntime(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/codexia/auth-methods", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return false;
    const methods = body as { passkey?: unknown; upstreamOidc?: unknown };
    return methods.passkey === true && typeof methods.upstreamOidc === "boolean";
  } catch {
    return false;
  }
}

export function IdentityManagementPanel({ placement, hosted }: { placement: "desktop" | "mobile"; hosted?: boolean }) {
  const [access, setAccess] = useState<OwnerAccess>({ status: "checking" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([]);
  const [sessions, setSessions] = useState<BetterAuthSession[]>([]);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [busyPasskeyId, setBusyPasskeyId] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [revokingOtherSessions, setRevokingOtherSessions] = useState(false);
  const [passkeyError, setPasskeyError] = useState("");
  const [passkeyMessage, setPasskeyMessage] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [sessionMessage, setSessionMessage] = useState("");
  const panelId = useId();

  useEffect(() => {
    let active = true;
    if (hosted === true) {
      setAccess({ status: "hidden" });
      return () => { active = false; };
    }
    void (async () => {
      // This endpoint exists only in the Better Auth runtime. Check it before
      // the broader API session route so token-mode shells incur no owner lookup.
      if (!await hasPasskeyAuthRuntime()) {
        if (active) setAccess({ status: "hidden" });
        return;
      }
      let apiSession: Awaited<ReturnType<typeof api.session>>;
      try {
        apiSession = await api.session();
      } catch {
        if (active) setAccess({ status: "hidden" });
        return;
      }
      if (apiSession.authenticated !== true || apiSession.authorScope !== "owner") {
        if (active) setAccess({ status: "hidden" });
        return;
      }
      try {
        const clientReady = Boolean(
          passkeyClient &&
          typeof passkeyClient.listUserPasskeys === "function" &&
          typeof passkeyClient.addPasskey === "function" &&
          typeof passkeyClient.updatePasskey === "function" &&
          typeof passkeyClient.deletePasskey === "function" &&
          typeof authClient.listSessions === "function" &&
          typeof authClient.revokeSession === "function" &&
          typeof authClient.revokeOtherSessions === "function" &&
          typeof authClient.getSession === "function",
        );
        if (!clientReady) {
          if (active) setAccess({ status: "unavailable", reason: "client" });
          return;
        }
        const current = authData<BetterAuthSessionPayload>(await authClient.getSession(), "Better Auth session is unavailable");
        const token = current?.session?.token;
        if (!token) {
          if (active) setAccess({ status: "unavailable", reason: "session" });
          return;
        }
        if (active) setAccess({ status: "ready", currentSessionToken: token });
      } catch {
        if (active) setAccess({ status: "unavailable", reason: "session" });
      }
    })();
    return () => { active = false; };
  }, [hosted]);

  const loadPasskeys = useCallback(async (): Promise<boolean> => {
    setPasskeyLoading(true);
    setPasskeyError("");
    try {
      const rows = authData<PasskeyRecord[]>(await passkeyClient?.listUserPasskeys(), "Passkey list is unavailable");
      if (!Array.isArray(rows)) throw new Error("Passkey list is unavailable");
      setPasskeys(rows);
      return true;
    } catch (error) {
      setPasskeys([]);
      setPasskeyError(securityErrorMessage(error, "パスキーの一覧を読み込めませんでした。再読み込みしてもう一度お試しください。"));
      return false;
    } finally {
      setPasskeyLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async (): Promise<boolean> => {
    setSessionLoading(true);
    setSessionError("");
    try {
      const rows = authData<BetterAuthSession[]>(await authClient.listSessions(), "Session list is unavailable");
      if (!Array.isArray(rows)) throw new Error("Session list is unavailable");
      setSessions(rows);
      return true;
    } catch (error) {
      setSessions([]);
      setSessionError(securityErrorMessage(error, "セッションを読み込めませんでした。再認証が必要な場合は、サインインし直してから再試行してください。"));
      return false;
    } finally {
      setSessionLoading(false);
    }
  }, []);

  const panelVisible = access.status === "ready" && (placement === "mobile" || dialogOpen);
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
    setPasskeyError("");
    setPasskeyMessage("");
    try {
      const name = newPasskeyName.trim();
      authSuccess(await passkeyClient?.addPasskey(name ? { name } : {}), "Passkey registration failed");
      setNewPasskeyName("");
      const refreshed = await loadPasskeys();
      setPasskeyMessage(refreshed ? "パスキーを追加しました。" : "追加は完了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。");
    } catch (error) {
      setPasskeyError(securityErrorMessage(error, "パスキーを追加できませんでした。再認証が必要な場合は、サインインし直してから再試行してください。"));
    } finally {
      setAddingPasskey(false);
    }
  };

  const renamePasskey = async (id: string, name: string): Promise<boolean> => {
    setBusyPasskeyId(id);
    setPasskeyError("");
    setPasskeyMessage("");
    try {
      authSuccess(await passkeyClient?.updatePasskey({ id, name }), "Passkey update failed");
      const refreshed = await loadPasskeys();
      setPasskeyMessage(refreshed ? "パスキー名を変更しました。" : "名前の変更は完了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。");
      return true;
    } catch (error) {
      setPasskeyError(securityErrorMessage(error, "パスキー名を変更できませんでした。再認証が必要な場合は、サインインし直してから再試行してください。"));
      return false;
    } finally {
      setBusyPasskeyId(null);
    }
  };

  const deletePasskey = async (id: string): Promise<boolean> => {
    if (passkeys.length <= 1) {
      setPasskeyError("最後のパスキーは削除できません。別のパスキーを追加してから再試行してください。");
      return false;
    }
    setBusyPasskeyId(id);
    setPasskeyError("");
    setPasskeyMessage("");
    try {
      authSuccess(await passkeyClient?.deletePasskey({ id }), "Passkey deletion failed");
      const refreshed = await loadPasskeys();
      setPasskeyMessage(refreshed ? "パスキーを削除しました。" : "削除は完了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。");
      return true;
    } catch (error) {
      setPasskeyError(securityErrorMessage(error, "パスキーを削除できませんでした。再認証が必要な場合は、サインインし直してから再試行してください。"));
      return false;
    } finally {
      setBusyPasskeyId(null);
    }
  };

  const revokeSession = async (session: BetterAuthSession): Promise<boolean> => {
    if (access.status !== "ready" || session.token === access.currentSessionToken) return false;
    setBusySessionId(session.id);
    setSessionError("");
    setSessionMessage("");
    try {
      const result = authData<{ status: boolean }>(await authClient.revokeSession({ token: session.token }), "Session revocation failed");
      if (!result?.status) throw new Error("Session revocation failed");
      const refreshed = await loadSessions();
      setSessionMessage(refreshed ? "セッションを終了しました。" : "セッションは終了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。");
      return true;
    } catch (error) {
      setSessionError(securityErrorMessage(error, "セッションを終了できませんでした。再認証が必要な場合は、サインインし直してから再試行してください。"));
      return false;
    } finally {
      setBusySessionId(null);
    }
  };

  const revokeOtherSessions = async () => {
    setRevokingOtherSessions(true);
    setSessionError("");
    setSessionMessage("");
    try {
      const result = authData<{ status: boolean }>(await authClient.revokeOtherSessions(), "Session revocation failed");
      if (!result?.status) throw new Error("Session revocation failed");
      const refreshed = await loadSessions();
      setSessionMessage(refreshed ? "現在の端末以外のセッションを終了しました。" : "他のセッションは終了しましたが、一覧を更新できませんでした。ページを再読み込みしてください。");
    } catch (error) {
      setSessionError(securityErrorMessage(error, "他のセッションを終了できませんでした。再認証が必要な場合は、サインインし直してから再試行してください。"));
    } finally {
      setRevokingOtherSessions(false);
    }
  };

  const openDialog = () => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    setDialogOpen(true);
  };

  if (access.status === "checking" || access.status === "hidden") return null;
  if (access.status === "unavailable") {
    const unavailableMessage = access.reason === "session"
      ? "認証セッションを確認できません。サインインし直したあと、もう一度この画面を開いてください。"
      : "認証管理機能を利用できません。時間をおいてからページを再読み込みしてください。";
    return placement === "desktop"
      ? <p className="identity-management__unavailable-inline" role="status">{unavailableMessage}</p>
      : <section className="identity-management identity-management__unavailable" aria-labelledby={`${panelId}-unavailable`}>
          <h2 id={`${panelId}-unavailable`}>認証とセキュリティ</h2>
          <p>{unavailableMessage}</p>
        </section>;
  }

  const currentSessionListed = sessions.some((session) => session.token === access.currentSessionToken);
  const otherSessions = sessions.filter((session) => session.token !== access.currentSessionToken);

  const content = (
    <div className="identity-management__content">
      <section className="identity-management__section" aria-labelledby={`${panelId}-passkeys`}>
        <h3 id={`${panelId}-passkeys`}>パスキー</h3>
        <p className="identity-management__intro">登録した認証器を管理します。名前と登録日が表示されます。削除と名前の変更には最近の再認証が必要です。</p>
        <div className="identity-management__add-form">
          <h4 id={`${panelId}-add-passkey-title`}>パスキーを追加</h4>
          {passkeySupported ? (
            <form className="identity-management__add-form-fields" aria-labelledby={`${panelId}-add-passkey-title`} onSubmit={(event) => void addPasskey(event)}>
              <label htmlFor={`${panelId}-new-passkey-name`}>名前（任意）</label>
              <div className="identity-management__form-row">
                <input
                  id={`${panelId}-new-passkey-name`}
                  name="passkeyName"
                  type="text"
                  autoComplete="off"
                  maxLength={80}
                  disabled={addingPasskey || busyPasskeyId !== null}
                  value={newPasskeyName}
                  onChange={(event) => setNewPasskeyName(event.target.value)}
                  aria-describedby={`${panelId}-passkey-name-help`}
                />
                <button className="identity-management__primary" type="submit" disabled={addingPasskey || busyPasskeyId !== null || capabilityLoading}>
                  {addingPasskey ? "認証器を確認中…" : "パスキーを追加"}
                </button>
              </div>
              <p id={`${panelId}-passkey-name-help`} className="identity-management__hint">例：MacBook Pro、セキュリティキー</p>
            </form>
          ) : null}
          {capabilityLoading ? <p className="identity-management__hint" role="status">このブラウザーの対応状況を確認しています。</p> : null}
          {!capabilityLoading && !passkeySupported ? <p className="identity-management__hint">パスキー登録には、安全な接続とWebAuthn対応ブラウザーが必要です。</p> : null}
        </div>
        {passkeyError ? <p className="identity-management__error" role="alert">{passkeyError}</p> : null}
        {passkeyMessage ? <p className="identity-management__message" role="status">{passkeyMessage}</p> : null}
        {passkeyLoading ? (
          <div className="identity-management__loading" role="status" aria-label="パスキーを読み込んでいます">
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </div>
        ) : passkeyError && passkeys.length === 0 ? null : passkeys.length === 0 ? (
          <p className="identity-management__empty">登録済みのパスキーはありません。追加すると、次回からパスキーでサインインできます。</p>
        ) : (
          <ul className="identity-management__list" aria-label="登録済みのパスキー">
            {passkeys.map((passkey) => (
              <PasskeyRow
                key={passkey.id}
                passkey={passkey}
                canDelete={passkeys.length > 1}
                disabled={busyPasskeyId !== null || addingPasskey}
                onRename={renamePasskey}
                onDelete={deletePasskey}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="identity-management__section" aria-labelledby={`${panelId}-sessions`}>
        <h3 id={`${panelId}-sessions`}>セッション</h3>
        <p className="identity-management__intro">サインイン中のブラウザーや端末を確認して、不要なセッションを終了できます。</p>
        {sessionError ? <p className="identity-management__error" role="alert">{sessionError}</p> : null}
        {sessionMessage ? <p className="identity-management__message" role="status">{sessionMessage}</p> : null}
        {sessionLoading ? (
          <div className="identity-management__loading" role="status" aria-label="セッションを読み込んでいます">
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </div>
        ) : sessionError && sessions.length === 0 ? null : sessions.length === 0 ? (
          <p className="identity-management__empty">有効なセッションはありません。</p>
        ) : (
          <>
            {!currentSessionListed ? <p className="identity-management__hint">現在のセッションを判定できないため、個別の終了操作を無効にしています。</p> : null}
            {otherSessions.length > 0 ? (
              <button
                className="identity-management__secondary"
                type="button"
                disabled={revokingOtherSessions || busySessionId !== null}
                onClick={() => void revokeOtherSessions()}
              >
                {revokingOtherSessions ? "終了しています…" : "他のすべてのセッションを終了"}
              </button>
            ) : null}
            <ul className="identity-management__list" aria-label="有効なセッション">
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  current={session.token === access.currentSessionToken}
                  currentSessionKnown={currentSessionListed}
                  disabled={busySessionId !== null || revokingOtherSessions}
                  busy={busySessionId === session.id}
                  onRevoke={revokeSession}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="identity-management__section" aria-labelledby={`${panelId}-staged`}>
        <h3 id={`${panelId}-staged`}>外部IDプロバイダーとアプリ同意</h3>
        <p className="identity-management__intro">この画面からの追加・変更・取り消しはまだ利用できません。</p>
      </section>
    </div>
  );

  if (placement === "mobile") {
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
  const [name, setName] = useState(passkey.name ?? "");
  const rowId = useId();
  const displayName = passkey.name?.trim() || "名前未設定のパスキー";
  const deviceLabel = passkey.deviceType === "multiDevice"
    ? "複数端末で利用できる認証器"
    : passkey.deviceType === "singleDevice"
      ? "単一デバイス型認証器"
      : "認証器の種類は不明";
  const backupLabel = passkey.backedUp === true ? "バックアップ済み" : passkey.backedUp === false ? "バックアップなし" : "バックアップ状態は不明";

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("passkeyName");
    const nextName = name.trim();
    if (!nextName) {
      if (input instanceof HTMLInputElement) {
        input.setCustomValidity("名前を入力してください。");
        input.reportValidity();
      }
      return;
    }
    if (input instanceof HTMLInputElement) input.setCustomValidity("");
    if (await onRename(passkey.id, nextName)) setEditing(false);
  };

  const confirmDelete = async () => {
    if (!canDelete) return;
    if (await onDelete(passkey.id)) setConfirmingDelete(false);
  };

  useEffect(() => {
    if (!canDelete) setConfirmingDelete(false);
  }, [canDelete]);

  return (
    <li className="identity-management__list-item">
      <div className="identity-management__item-main">
        <h4>{displayName}</h4>
        <p className="identity-management__meta">{deviceLabel} · {backupLabel}</p>
        {passkey.createdAt ? <p className="identity-management__meta">登録日：{formatDate(passkey.createdAt)}</p> : null}
      </div>
      {!editing && !confirmingDelete ? (
        <div className="identity-management__actions">
          <button className="identity-management__secondary" type="button" disabled={disabled} aria-label={`${displayName}の名前を変更`} onClick={() => setEditing(true)}>
            名前を変更
          </button>
          <button className="identity-management__danger-quiet" type="button" disabled={disabled || !canDelete} aria-label={`${displayName}を削除`} onClick={() => setConfirmingDelete(true)}>
            削除
          </button>
        </div>
      ) : null}
      {!canDelete && !editing && !confirmingDelete ? <p className="identity-management__hint">最後のパスキーは削除できません。別のパスキーを追加してから削除してください。</p> : null}
      {editing ? (
        <form className="identity-management__inline-form" aria-labelledby={`${rowId}-rename-title`} onSubmit={(event) => void submitRename(event)}>
          <h5 id={`${rowId}-rename-title`}>パスキー名を変更</h5>
          <label htmlFor={`${rowId}-name`}>新しい名前</label>
          <input id={`${rowId}-name`} name="passkeyName" type="text" maxLength={80} required autoFocus value={name} onChange={(event) => { setName(event.target.value); event.currentTarget.setCustomValidity(""); }} />
          <div className="identity-management__actions">
            <button className="identity-management__primary" type="submit" disabled={disabled}>保存</button>
            <button className="identity-management__secondary" type="button" disabled={disabled} onClick={() => { setName(passkey.name ?? ""); setEditing(false); }}>キャンセル</button>
          </div>
        </form>
      ) : null}
      {confirmingDelete && canDelete ? (
        <div className="identity-management__inline-confirm" role="group" aria-labelledby={`${rowId}-delete-title`}>
          <p id={`${rowId}-delete-title`}>{displayName}を削除しますか？</p>
          <div className="identity-management__actions">
            <button className="identity-management__secondary" type="button" disabled={disabled} onClick={() => setConfirmingDelete(false)}>キャンセル</button>
          <button className="identity-management__danger" type="button" disabled={disabled || !canDelete} onClick={() => void confirmDelete()}>
              {disabled ? "削除しています…" : "削除する"}
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
        <h4>{current ? "この端末" : "セッション"}</h4>
        {session.userAgent ? <p className="identity-management__meta identity-management__user-agent">{session.userAgent}</p> : <p className="identity-management__meta">デバイス情報はありません</p>}
        {session.createdAt ? <p className="identity-management__meta">開始：{formatDate(session.createdAt)}</p> : null}
        {session.updatedAt ? <p className="identity-management__meta">最終更新：{formatDate(session.updatedAt)}</p> : null}
        {session.expiresAt ? <p className="identity-management__meta">有効期限：{formatDate(session.expiresAt)}</p> : null}
      </div>
      {canRevoke && !confirming ? (
        <div className="identity-management__actions">
          <button className="identity-management__danger-quiet" type="button" disabled={disabled} aria-label={`セッションを終了: ${session.userAgent ?? formatDate(session.updatedAt ?? session.createdAt)}`} onClick={() => setConfirming(true)}>
            セッションを終了
          </button>
        </div>
      ) : null}
      {canRevoke && confirming ? (
        <div className="identity-management__inline-confirm" role="group" aria-labelledby={`${rowId}-revoke-title`}>
          <p id={`${rowId}-revoke-title`}>このセッションを終了しますか？</p>
          <div className="identity-management__actions">
            <button className="identity-management__secondary" type="button" disabled={disabled} onClick={() => setConfirming(false)}>キャンセル</button>
            <button className="identity-management__danger" type="button" disabled={disabled} onClick={() => void confirm()}>{busy ? "終了しています…" : "終了する"}</button>
          </div>
        </div>
      ) : null}
      {current ? <p className="identity-management__current-label">現在の端末</p> : null}
    </li>
  );
}
