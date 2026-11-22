import { useCallback, useEffect, useRef, useState } from "react";
import { api, setOAuthAccessToken, type PersistenceStatus } from "../api";
import { ApiError } from "../api-error";
import { beginOAuthAuthorization, completeOAuthAuthorization, webOAuthConfig, type OAuthWebConfig } from "../oauth";
import { authClient } from "../auth-client";
import { PersistenceWorkspace } from "./PersistenceWorkspace";
import { attemptNativeLogout } from "./nativeLogout";
import type { NativeSignOutResult } from "../../native/plugins/codexia-auth/src/index.mjs";

type EntryState = "checking" | "signed-out" | "database" | "failed";

export interface NativePersistenceAuth {
  signIn(): Promise<void>;
  signOut(): Promise<NativeSignOutResult>;
}

export function PersistenceEntry({ mode, nativeAuth }: { mode: "desktop" | "mobile"; nativeAuth?: NativePersistenceAuth | null }) {
  const nativeShell = nativeAuth !== undefined;
  const [state, setState] = useState<EntryState>("checking");
  const [accessMode, setAccessMode] = useState(false);
  const [hostedMode, setHostedMode] = useState(false);
  const [oauthConfig, setOAuthConfig] = useState<OAuthWebConfig | null>(null);
  const [authorScope, setAuthorScope] = useState("owner");
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
      if (nativeShell && error instanceof ApiError && error.code.startsWith("NATIVE_API_ORIGIN_")) {
        setState("signed-out");
        setMessage("iOS API接続先を確認してください。登録済みのHTTPS API originが必要です。");
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
        const config = nativeShell ? null : webOAuthConfig(mode);
        if (mounted) setOAuthConfig(config);
        if (config) {
          const authorization = await completeOAuthAuthorization(config);
          if (authorization) {
            setOAuthAccessToken(authorization.accessToken);
            window.history.replaceState(window.history.state, "", authorization.returnPath);
            window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
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
  }, [inspect, mode, nativeShell]);

  async function protectBeforeAuthTransition(action: string): Promise<boolean> {
    if (workspaceScopeRef.current === null) return true;
    try {
      if (protectionRef.current && await protectionRef.current()) return true;
    } catch {
      // An unavailable local journal must never permit an auth transition.
    }
    setMessage(`入力を保護できないため${action}を停止しました。接続と保存状態を確認してください。`);
    return false;
  }

  async function startOAuthSignIn(): Promise<void> {
    if (!oauthConfig || busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (!await protectBeforeAuthTransition("OAuth認証への移動")) {
        setBusy(false);
        return;
      }
      await beginOAuthAuthorization(oauthConfig);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "OAuth sign-in could not be started.");
      setBusy(false);
    }
  }

  async function completeNativeSignIn(): Promise<void> {
    if (!nativeAuth || busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (!await protectBeforeAuthTransition("ネイティブ認証への移動")) return;
      await nativeAuth.signIn();
      await inspect();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ネイティブ認証を完了できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  async function completeNativeLogout(): Promise<void> {
    if (!nativeAuth || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const outcome = await attemptNativeLogout({
        protectDraft: () => protectBeforeAuthTransition("ログアウト"),
        blockWorkspace: () => setSessionBlocked(true),
        signOut: nativeAuth.signOut,
      });
      if (outcome.kind === "draft-unprotected") return;
      if (outcome.kind === "complete") {
        workspaceScopeRef.current = null;
        setSessionBlocked(false);
        setState("signed-out");
        return;
      }
      if (outcome.kind === "revocation-unconfirmed") {
        workspaceScopeRef.current = null;
        setSessionBlocked(false);
        setState("signed-out");
      }
      setMessage(outcome.message);
    } finally {
      setBusy(false);
    }
  }

  async function completeWebOAuthLogout(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (!await protectBeforeAuthTransition("ログアウト")) return;
      setSessionBlocked(true);
      setOAuthAccessToken(null);
      const result = await authClient.signOut();
      if (result.error) throw new Error("サーバー側セッションの終了を確認できませんでした。");
      workspaceScopeRef.current = null;
      setSessionBlocked(false);
      setState("signed-out");
    } catch (error) {
      setMessage(`APIトークンはこの画面から削除しましたが、サーバー側セッションを終了できませんでした。${error instanceof Error ? ` ${error.message}` : ""}`);
    } finally {
      setBusy(false);
    }
  }

  async function completeHostedLogout(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (!await protectBeforeAuthTransition("ログアウト")) return;
      setSessionBlocked(true);
      await api.logoutHosted();
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

  async function completeAccessLogout(): Promise<void> {
    if (!await protectBeforeAuthTransition("ログアウト")) return;
    window.location.assign("/cdn-cgi/access/logout");
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
        if (nativeShell) { void completeNativeLogout(); return; }
        if (oauthConfig) { void completeWebOAuthLogout(); return; }
        if (accessMode && !hostedMode) { void completeAccessLogout(); return; }
        if (hostedMode) void completeHostedLogout();
      }} />
    </div>
    {sessionBlocked && <main className={`pg-entry pg-${mode}`}><section className="pg-login" aria-labelledby="pg-recheck-title">
      <h1 id="pg-recheck-title">認証・接続を再確認してください</h1>
      <p role="alert">{message}</p>
      <p>編集中の原稿は現在の画面に保持しています。認証と接続を確認するまで編集を停止します。</p>
      <button type="button" disabled={busy} onClick={() => void inspect()}>再試行</button>
      {oauthConfig && <button type="button" disabled={busy} onClick={() => void startOAuthSignIn()}>OAuthで再認証</button>}
      {nativeAuth && <button type="button" disabled={busy} onClick={() => void completeNativeSignIn()}>ネイティブ認証で再入場</button>}
      {nativeShell && nativeAuth && <button type="button" disabled={busy} onClick={() => void completeNativeLogout()}>ログアウトを再試行</button>}
      {!nativeShell && oauthConfig && <button type="button" disabled={busy} onClick={() => void completeWebOAuthLogout()}>ログアウトを再試行</button>}
      {!nativeShell && !oauthConfig && hostedMode && <button type="button" disabled={busy} onClick={() => void completeHostedLogout()}>ログアウトを再試行</button>}
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
  if (nativeShell) return <main className={`pg-entry pg-${mode}`}>
    <section className="pg-login" aria-labelledby="native-oauth-entry-title">
      <p className="eyebrow">Codexia · iOS</p>
      <h1 id="native-oauth-entry-title">作品を開く</h1>
      <p>{nativeAuth ? "APIへ接続するため、登録済みのネイティブクライアントでサインインしてください。" : "ネイティブ認証を利用できません。アプリの公開クライアント設定を確認してください。"}</p>
      {message && <p role="alert">{message}</p>}
      {nativeAuth && <button type="button" disabled={busy} onClick={() => void completeNativeSignIn()}>{busy ? "認証を開始しています…" : "ネイティブ認証でサインイン"}</button>}
      <a href="/">画面選択へ戻る</a>
    </section>
  </main>;
  return <main className={`pg-entry pg-${mode}`}>
    <section className="pg-login" aria-labelledby="pg-auth-configuration-title">
      <p className="eyebrow">Codexia · Database</p>
      <h1 id="pg-auth-configuration-title">サインインを利用できません</h1>
      <p>管理者に Web OAuth クライアントの設定を確認してください。</p>
      {message && <p role="alert">{message}</p>}
      <a href="/">画面選択へ戻る</a>
    </section>
  </main>;
}
