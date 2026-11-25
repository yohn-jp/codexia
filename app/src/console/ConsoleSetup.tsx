import { useEffect, useRef, useState, type FormEvent } from "react";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { buttonRecipe } from "../components/button.css";

const quietButtonClass = `quiet-button ${buttonRecipe({ tone: "quiet" })}`;

const API = "/api/auth/codexia/setup";
const FETCH_OPTIONS = { credentials: "same-origin", cache: "no-store", redirect: "error" } as const;
const TRANSACTION_HEADER = "x-codexia-setup-transaction";

type Status =
  | { state: "setup-pending" | "waiting" | "expired" | "blocked" | "active" }
  | { state: "owner-enrolled"; clientsReady: boolean; sessionConfirmed?: boolean };
type Step = "key" | "profile" | "passkey";

class SetupError extends Error {
  constructor(readonly status: number) { super("Owner setup request failed"); }
}

async function getStatus(signal?: AbortSignal): Promise<Status> {
  const response = await fetch(API + "/status", {
    ...FETCH_OPTIONS, ...(signal ? { signal } : {}), headers: { accept: "application/json" },
  });
  if (!response.ok) throw new SetupError(response.status);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("state" in body)) throw new SetupError(503);
  switch (body.state) {
    case "setup-pending":
    case "waiting":
    case "expired":
    case "blocked":
    case "active":
      return { state: body.state };
    case "owner-enrolled":
      if ("clientsReady" in body && typeof body.clientsReady === "boolean") {
        return { state: body.state, clientsReady: body.clientsReady };
      }
  }
  throw new SetupError(503);
}

async function post(path: string, body: unknown, transaction?: string): Promise<Response> {
  return fetch(API + path, {
    ...FETCH_OPTIONS,
    method: "POST",
    headers: {
      accept: "application/json", "content-type": "application/json",
      ...(transaction ? { [TRANSACTION_HEADER]: transaction } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function exchange(path: string, body: unknown, transaction?: string): Promise<string> {
  const response = await post(path, body, transaction);
  if (!response.ok) throw new SetupError(response.status);
  const data: unknown = await response.json();
  if (data && typeof data === "object" && "transaction" in data && typeof data.transaction === "string") {
    return data.transaction;
  }
  throw new SetupError(503);
}

export function ConsoleSetup({ consoleUrl }: { readonly consoleUrl: string }) {
  const [status, setStatus] = useState<Status | "checking" | "unavailable">("checking");
  const [step, setStep] = useState<Step>("key");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [keyError, setKeyError] = useState(false);
  const [busy, setBusy] = useState(false);
  const transaction = useRef<string>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useRef(false);
  const webAuthnSupported = window.isSecureContext && typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials?.create === "function";

  useEffect(() => {
    const abort = new AbortController();
    void getStatus(abort.signal).then(setStatus, () => {
      if (!abort.signal.aborted) setStatus("unavailable");
    });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (step !== "key") heading.current?.focus();
  }, [step]);

  function clearTransaction() {
    transaction.current = undefined;
    setStep("key");
    setName("");
    setEmail("");
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    try {
      const state = await getStatus();
      setStatus(state);
      const token = transaction.current;
      if (state.state === "owner-enrolled" && token) {
        try {
          const result = await post("/complete", {}, token);
          if (result.ok) {
            const data: { clientsReady?: boolean; sessionConfirmed?: boolean } = await result.json();
            setStatus({ ...state, clientsReady: data.clientsReady === true, sessionConfirmed: data.sessionConfirmed === true });
          } else if (!state.clientsReady) {
            setMessage("登録は完了しています。クライアントの準備状況を構築担当者に確認してください。");
          }
        } catch {
          if (!state.clientsReady) setMessage("登録は完了しています。クライアントの準備状況をもう一度確認してください。");
        }
      }
      return state.state;
    } catch {
      setStatus("unavailable");
      return "unavailable";
    }
  }

  function submitKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const key = new FormData(form).get("setup-key");
    if (typeof key !== "string") return;
    // Keep the raw key only for the immediate request. Never retain it in React state.
    form.reset();
    void run(async () => {
      setKeyError(false);
      try {
        transaction.current = await exchange("/authorize", { key: key.trim() });
        setStep("profile");
      } catch (error) {
        if (error instanceof SetupError && (error.status === 400 || error.status === 403)) {
          setKeyError(true);
          setMessage("キーが無効、失効済み、または期限切れです。キーを確認し、必要なら構築担当者に再発行を依頼してください。");
        } else if (error instanceof SetupError && error.status === 429) {
          setMessage("続けて試行したため、一時的に制限しています。1分待って再試行してください。");
        } else setMessage("キーを確認できませんでした。接続を確認して再試行してください。");
      }
    });
  }

  function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = transaction.current;
    if (!token) return;
    void run(async () => {
      try {
        transaction.current = await exchange("/profile", { name, email }, token);
        setStep("passkey");
      } catch (error) {
        if (error instanceof SetupError && error.status === 400) {
          setMessage("表示名と連絡先メールアドレスを確認してください。");
        } else if (error instanceof SetupError && (error.status === 403 || error.status === 409)) {
          const state = await refresh();
          if (state === "setup-pending") {
            transaction.current = undefined;
            setStep("key");
            setMessage("登録の確認期限を過ぎました。初期登録キーをもう一度入力してください。");
          }
        } else setMessage("プロフィールを確認できませんでした。接続を確認して再試行してください。");
      }
    });
  }

  function createPasskey() {
    const token = transaction.current;
    if (!token || !webAuthnSupported) return;
    void run(async () => {
      let code: string | undefined;
      try {
        const setupAuth = createAuthClient({
          basePath: "/api/auth",
          fetchOptions: { ...FETCH_OPTIONS, headers: { [TRANSACTION_HEADER]: token }, retry: 0 },
          plugins: [passkeyClient()],
        });
        const response = await setupAuth.passkey.addPasskey({ createSession: true });
        code = response.error && "code" in response.error ? response.error.code : undefined;
      } catch {
        // A network failure can occur after PostgreSQL commits enrollment.
      }
      const state = await refresh();
      if (state !== "setup-pending") return;
      if (code === "REGISTRATION_CANCELLED" || code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY") {
        setMessage("Passkeyの作成がキャンセルされたか、時間内に完了しませんでした。もう一度お試しください。");
      } else if (code === "ERROR_INVALID_DOMAIN" || code === "ERROR_INVALID_RP_ID") {
        setMessage("このURLではPasskeyを作成できません。構築担当者へ連絡してください。");
      } else if (code === "SETUP_CEREMONY_UNAVAILABLE") {
        setMessage("登録を再開するには、初期登録キーをもう一度入力してください。");
        transaction.current = undefined;
        setStep("key");
      } else {
        setMessage("Passkeyの登録を確認できませんでした。端末の本人確認を確認して再試行してください。");
      }
    });
  }

  const current = typeof status === "string" ? status : status.state;
  const headingText = current === "setup-pending" && step === "profile" ? "所有者プロフィール" :
    current === "setup-pending" && step === "passkey" ? "Passkeyを作成" : "初回所有者登録";

  return <section className="codexia-console__panel codexia-setup" aria-labelledby="console-title" aria-busy={busy}>
    <h1 id="console-title" ref={heading} tabIndex={-1}>{headingText}</h1>
    {current === "checking" && <p role="status">登録状況を確認しています。</p>}
    {current === "unavailable" && <p role="status">登録状況を確認できません。接続を確認して再試行してください。</p>}
    {current === "waiting" && <p role="status">初回登録を準備しています。構築担当者からキーを受け取ったら更新してください。</p>}
    {current === "blocked" && <p role="status">この環境では初回登録を開始できません。復旧状況を構築担当者に確認してください。</p>}
    {current === "expired" && <p role="status">初期登録キーの有効期限が切れました。構築担当者に再発行を依頼してください。</p>}
    {current === "active" && <p role="status">初回登録は完了しています。管理コンソールでPasskeyを使ってサインインできます。</p>}
    {typeof status !== "string" && status.state === "owner-enrolled" && <>
      <p role="status">{status.clientsReady
        ? "PasskeyとOAuthクライアントの準備が完了しました。構築担当者が公開を承認するまでお待ちください。"
        : "所有者のPasskeyを登録しました。Web・iOS・API認証に必要なクライアントの準備状況を確認してください。"}</p>
      {status.sessionConfirmed && <p>このブラウザーで登録完了を確認しました。</p>}
    </>}
    {current === "setup-pending" && step === "key" && <>
      <p>初期登録キーと、画面ロックやセキュリティキーで本人確認できる端末をご用意ください。</p>
      {!webAuthnSupported && <p role="status">このブラウザーではPasskeyを作成できません。対応ブラウザーまたは別の端末で開いてください。</p>}
      <form className="codexia-setup__form" onSubmit={submitKey} autoComplete="off">
        <label htmlFor="setup-key">初期登録キー</label>
        <input id="setup-key" name="setup-key" type="password" disabled={busy || !webAuthnSupported}
          aria-describedby="setup-key-note" aria-invalid={keyError || undefined} required
          autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={43}
          onChange={() => { setKeyError(false); setMessage(""); }}/>
        <small id="setup-key-note">構築担当者から受け取ったキーを貼り付けてください。有効期限は発行から24時間です。</small>
        <button type="submit" className="primary-button" disabled={busy || !webAuthnSupported}>キーを確認</button>
      </form>
    </>}
    {current === "setup-pending" && step === "profile" && <>
      <p>管理コンソールで使用する表示名と連絡先メールアドレスを入力します。</p>
      <form className="codexia-setup__form" onSubmit={submitProfile}>
        <label htmlFor="setup-name">表示名</label>
        <input id="setup-name" autoComplete="name" required maxLength={120} disabled={busy}
          value={name} onChange={(event) => setName(event.target.value)}/>
        <label htmlFor="setup-email">連絡先メールアドレス</label>
        <input id="setup-email" type="email" autoComplete="email" required maxLength={254} disabled={busy}
          value={email} onChange={(event) => setEmail(event.target.value)}/>
        <div className="codexia-console__actions">
          <button type="submit" className="primary-button" disabled={busy}>次へ</button>
          <button type="button" className={quietButtonClass} disabled={busy} onClick={clearTransaction}>キー入力へ戻る</button>
        </div>
      </form>
    </>}
    {current === "setup-pending" && step === "passkey" && <>
      <p>{name} さんのPasskeyを登録します。ボタンを押し、ブラウザーの案内に沿って本人確認を行ってください。</p>
      <div className="codexia-console__actions">
        <button type="button" className="primary-button" disabled={busy} onClick={createPasskey}>Passkeyを作成</button>
        <button type="button" className={quietButtonClass} disabled={busy} onClick={clearTransaction}>キー入力へ戻る</button>
      </div>
    </>}
    {message && <p className="codexia-setup__error" role="alert">{message}</p>}
    {current !== "setup-pending" && current !== "checking" && <div className="codexia-console__actions">
      {current !== "active" && <button type="button" className={quietButtonClass} disabled={busy}
        onClick={() => { void run(async () => { await refresh(); }); }}>登録状況を更新</button>}
      {(current === "active" || current === "blocked") && <a href={consoleUrl} className="codexia-console__link">管理コンソールへ</a>}
    </div>}
  </section>;
}
