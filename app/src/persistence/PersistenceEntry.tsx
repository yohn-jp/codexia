import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, setOAuthAccessToken, type PersistenceStatus } from "../api";
import { ApiError } from "../api-error";
import { beginOAuthAuthorization, completeOAuthAuthorization, webOAuthConfig, type OAuthWebConfig } from "../oauth";
import { PersistenceWorkspace } from "./PersistenceWorkspace";

type EntryState = "checking" | "signed-out" | "database" | "failed";

export function PersistenceEntry({ mode }: { mode: "desktop" | "mobile" }) {
  const [state, setState] = useState<EntryState>("checking");
  const [accessMode, setAccessMode] = useState(false);
  const [hostedMode, setHostedMode] = useState(false);
  const [oauthConfig, setOAuthConfig] = useState<OAuthWebConfig | null>(null);
  const [authorScope, setAuthorScope] = useState("owner");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pageWasHiddenRef = useRef(false);
  const workspaceScopeRef = useRef<string | null>(null);
  const inspectSequenceRef = useRef(0);
  const protectionRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerProtection = useCallback((guard: (() => Promise<boolean>) | null) => { protectionRef.current = guard; }, []);
  const [sessionBlocked, setSessionBlocked] = useState(false);

  const inspect = useCallback(async () => {
    const sequence = ++inspectSequenceRef.current;
    if (workspaceScopeRef.current !== null) setSessionBlocked(true);
    setBusy(true);
    setMessage("");
    let versionChecked = false;
    try {
      const version = await api.version();
      if (sequence !== inspectSequenceRef.current) return;
      versionChecked = true;
      setHostedMode(version.hosted);
      setAccessMode(version.browserAuth === "cloudflare-access");
      const session = await api.session();
      if (version.browserAuth === "cloudflare-access" && session.authorScope !== "owner") {
        throw new Error("Cloudflare Accessの作者認証を確認できませんでした。");
      }
      const persistence: PersistenceStatus = await api.persistenceStatus();
      if (!persistence.available || persistence.provider !== "postgres") {
        throw new Error("PostgreSQL保存基盤が利用できません。Gitワークスペースへの切替は提供していません。");
      }
      if (session.permissions && !session.permissions.some((permission) => permission === "write" || permission === "maintain" || permission === "admin")) {
        throw new Error("このアカウントには原稿編集権限がありません。");
      }
      if (sequence !== inspectSequenceRef.current) return;
      const scope = session.authorScope || "owner";
      if (workspaceScopeRef.current !== null && workspaceScopeRef.current !== scope) throw new Error("認証された作者が変わりました。現在の下書きを保護してから再読み込みしてください。");
      workspaceScopeRef.current = scope;
      setAuthorScope(scope);
      setSessionBlocked(false);
      setState("database");
    } catch (error) {
      if (sequence !== inspectSequenceRef.current) return;
      if (workspaceScopeRef.current !== null) {
        // Do not destroy the current editor or expose it to a different author.
        setSessionBlocked(true);
        setMessage(error instanceof Error ? error.message : "認証またはPostgreSQL接続を確認できませんでした。");
        return;
      }
      if (versionChecked && error instanceof ApiError && error.status === 401) {
        setState("signed-out");
      } else {
        setState("failed");
        setMessage(error instanceof Error ? error.message : "Codexia APIに接続できませんでした。");
      }
    } finally {
      if (sequence === inspectSequenceRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const config = webOAuthConfig(mode);
        if (mounted) setOAuthConfig(config);
        if (config) {
          const accessToken = await completeOAuthAuthorization(config);
          if (accessToken) {
            setOAuthAccessToken(accessToken);
            // Remove the one-time authorization code from the address bar.
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
          }
        }
      } catch (error) {
        if (mounted) {
          setMessage(error instanceof Error ? error.message : "OAuth sign-in could not be completed.");
          setState("signed-out");
          return;
        }
      }
      if (mounted) void inspect();
    })();
    const hide = () => { pageWasHiddenRef.current = true; };
    const resume = (event: PageTransitionEvent) => {
      if (!pageWasHiddenRef.current && !event.persisted) return;
      pageWasHiddenRef.current = false;
      void inspect();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", resume);
    return () => { mounted = false; inspectSequenceRef.current += 1; window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", resume); };
  }, [inspect, mode]);

  async function startOAuthSignIn(): Promise<void> {
    if (!oauthConfig || busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (workspaceScopeRef.current !== null && (!protectionRef.current || !await protectionRef.current())) {
        setMessage("入力を保護できないためOAuth認証への移動を停止しました。接続と保存状態を確認してください。");
        setBusy(false);
        return;
      }
      await beginOAuthAuthorization(oauthConfig);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "OAuth sign-in could not be started.");
      setBusy(false);
    }
  }

  function completeOAuthLogout(): void {
    setOAuthAccessToken(null);
    workspaceScopeRef.current = null;
    setSessionBlocked(false);
    setState("signed-out");
  }

  async function signIn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api.login(token);
      setToken("");
      await inspect();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ログインできませんでした。");
    } finally {
      setBusy(false);
    }
  }

  async function completeLogout(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setSessionBlocked(true);
    setMessage("");
    try {
      if (workspaceScopeRef.current !== null && (!protectionRef.current || !await protectionRef.current())) {
        setMessage("入力を保護できないためログアウトを停止しました。接続と保存状態を確認してください。");
        return;
      }
      await api.logout();
      workspaceScopeRef.current = null;
      setSessionBlocked(false);
      setState("signed-out");
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      setMessage(`ログアウトの完了を確認できませんでした。原稿を保護したまま認証状態を再確認し、必要ならログアウトを再試行してください。${detail}`);
    } finally {
      setBusy(false);
    }
  }

  async function reenterHosted(): Promise<void> {
    if (!protectionRef.current || !await protectionRef.current()) {
      setMessage("入力を保護できないためHosted環境への移動を停止しました。接続を再確認してください。");
      return;
    }
    window.location.assign("/_platform/reauth");
  }

  if (state === "database") return <>
    <div inert={sessionBlocked} hidden={sessionBlocked} style={{ display: sessionBlocked ? "none" : "contents" }}>
      <PersistenceWorkspace mode={mode} hosted={hostedMode} authorScope={authorScope} sessionBlocked={sessionBlocked} registerProtection={registerProtection} onSignOut={() => {
        if (oauthConfig) { completeOAuthLogout(); return; }
        if (accessMode && !hostedMode) { window.location.assign("/cdn-cgi/access/logout"); return; }
        void completeLogout();
      }} />
    </div>
    {sessionBlocked && <main className={`pg-entry pg-${mode}`}><section className="pg-login" aria-labelledby="pg-recheck-title">
      <h1 id="pg-recheck-title">認証・接続を再確認してください</h1>
      <p role="alert">{message}</p>
      <p>編集中の原稿は現在の画面に保持しています。認証と接続を確認するまで編集を停止します。</p>
      <button type="button" disabled={busy} onClick={() => void inspect()}>再試行</button>
      {oauthConfig && <button type="button" disabled={busy} onClick={() => void startOAuthSignIn()}>OAuthで再認証</button>}
      {(!accessMode || hostedMode) && <button type="button" disabled={busy} onClick={() => void completeLogout()}>ログアウトを再試行</button>}
      {hostedMode && <button type="button" disabled={busy} onClick={() => void reenterHosted()}>Praetoriumから再入場</button>}
      <button type="button" disabled={busy} onClick={() => void (async () => {
        if (!protectionRef.current || !await protectionRef.current()) { setMessage("入力を保護できないため再読み込みを停止しました。接続を再確認してください。"); return; }
        window.location.reload();
      })()}>下書きを保護して再読み込み</button>
    </section></main>}
  </>;
  if (state === "checking") return <main className={`pg-entry pg-${mode}`}><p role="status">PostgreSQL保存基盤を確認しています。</p></main>;
  if (state === "failed") return <main className={`pg-entry pg-${mode}`}>
    <section className="pg-login" aria-labelledby="pg-entry-title">
      <p className="eyebrow">Codexia</p>
      <h1 id="pg-entry-title">PostgreSQLへ接続できません</h1>
      <p role="alert">{message}</p>
      <button type="button" disabled={busy} onClick={() => void inspect()}>再試行</button>
      <button type="button" disabled={busy} onClick={() => window.location.reload()}>ページを再読み込み</button>
      <a href="/">画面選択へ戻る</a>
    </section>
  </main>;
  if (hostedMode) return <main className={`pg-entry pg-${mode}`}>
    <section className="pg-login" aria-labelledby="pg-hosted-entry-title">
      <p className="eyebrow">Codexia · Hosted</p>
      <h1 id="pg-hosted-entry-title">Praetoriumから再入場してください</h1>
      <p>このHosted環境の認証はPraetorium Instance Accessが管理しています。GatewayからこのInstanceへ再入場してください。</p>
      <a href="/_platform/reauth">Praetoriumから再入場</a>
      <a href="/">画面選択へ戻る</a>
    </section>
  </main>;
  if (accessMode && !oauthConfig) return <main className={`pg-entry pg-${mode}`}>
    <section className="pg-login" aria-labelledby="pg-access-title">
      <p className="eyebrow">Codexia</p>
      <h1 id="pg-access-title">Cloudflare Accessで認証してください</h1>
      <p>認証が確認できませんでした。ページを再読み込みして認証を確認してください。</p>
      <button type="button" onClick={() => window.location.reload()}>再認証</button>
      <a href="/">画面選択へ戻る</a>
    </section>
  </main>;
  if (oauthConfig) return <main className={`pg-entry pg-${mode}`}>
    <section className="pg-login" aria-labelledby="pg-oauth-entry-title">
      <p className="eyebrow">Codexia</p>
      <h1 id="pg-oauth-entry-title">作品を開く</h1>
      <p>APIに接続するため、登録済みのOAuthクライアントでサインインしてください。APIアクセストークンはこの画面を閉じると破棄されます。</p>
      {message && <p role="alert">{message}</p>}
      <button type="button" disabled={busy} onClick={() => void startOAuthSignIn()}>{busy ? "認証を開始しています…" : "OAuthでサインイン"}</button>
      <a href="/">画面選択へ戻る</a>
    </section>
  </main>;
  return <main className={`pg-entry pg-${mode}`}>
    <form className="pg-login" onSubmit={(event) => void signIn(event)}>
      <p className="eyebrow">Codexia · Database</p>
      <h1>作品を開く</h1>
      <p>認証トークンはこのブラウザーに保存されません。</p>
      <label htmlFor="pg-access-token">アクセス・トークン</label>
      <input
        id="pg-access-token"
        type="password"
        autoComplete="current-password"
        required
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      {message && <p role="alert">{message}</p>}
      <button type="submit" disabled={busy || token.length < 32}>{busy ? "接続しています…" : "PostgreSQL作品を開く"}</button>
      <a href="/">画面選択へ戻る</a>
    </form>
  </main>;
}
