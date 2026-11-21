import { useState } from "react";
import { authClient } from "./auth-client";
import { continueOAuthLogin, hasSignedOAuthPrompt } from "./oauth-login";

export function OAuthLoginPage() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const validPrompt = hasSignedOAuthPrompt(window.location.search);

  async function signIn(): Promise<void> {
    if (busy || !validPrompt) return;
    setBusy(true);
    setMessage("");
    try {
      await continueOAuthLogin(authClient);
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
      <button type="button" disabled={busy || !validPrompt} onClick={() => void signIn()}>
        {busy ? "認証を開始しています…" : "登録済みアカウントで続ける"}
      </button>
      <a href="/">画面選択へ戻る</a>
    </section>
  </main>;
}
