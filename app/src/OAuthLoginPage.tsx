import { useEffect, useState } from "react";
import { authClient } from "./auth-client";
import { continueOAuthLogin, hasSignedOAuthPrompt, oauthConsentContinuationURL } from "./oauth-login";

export function OAuthLoginPage() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const session = authClient.useSession();
  const validPrompt = hasSignedOAuthPrompt(window.location.search);

  useEffect(() => {
    if (!session.data || !validPrompt) return;
    window.location.replace(oauthConsentContinuationURL(window.location.search));
  }, [session.data, validPrompt]);

  async function signIn(): Promise<void> {
    if (busy || !validPrompt) return;
    setBusy(true);
    setMessage("");
    try {
      await continueOAuthLogin(authClient, window.location.search);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "サインインを開始できませんでした。");
      setBusy(false);
    }
  }

  return <main className="pg-entry pg-desktop">
    <section className="pg-login" aria-labelledby="oauth-login-title">
      <p className="eyebrow">Codexia</p>
      <h1 id="oauth-login-title">Codexiaへサインイン</h1>
      {validPrompt
        ? <p>サインイン後、要求されたCodexia APIアクセスの確認へ進みます。</p>
        : <p role="alert">認証リクエストを確認できません。Codexiaからサインインをやり直してください。</p>}
      {message && <p role="alert">{message}</p>}
      {session.isPending
        ? <p role="status">サインイン状態を確認しています…</p>
        : session.data
          ? <p role="status">認証後のアクセス確認へ進んでいます…</p>
          : <button type="button" disabled={busy || !validPrompt} onClick={() => void signIn()}>
            {busy ? "認証を開始しています…" : "登録済みアカウントで続ける"}
          </button>}
      <a href="/">画面選択へ戻る</a>
    </section>
  </main>;
}
