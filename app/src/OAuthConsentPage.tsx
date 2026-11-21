import { useEffect, useState } from "react";
import { canApproveOAuthConsent, loadOAuthConsentContext, sameOriginOAuthContinuation, submitOAuthConsent, type OAuthConsentContext } from "./oauth-consent";

const scopeDescriptions: Readonly<Record<string, string>> = {
  openid: "Codexiaアカウントでサインインします。",
  email: "アカウントのメールアドレスを確認します。",
  profile: "アカウントのプロフィールを確認します。",
  offline_access: "再認証なしで利用を継続する更新トークンの発行を許可します。",
  "codexia:api": "作品データへのアクセスを要求します。各操作はサーバー側の作者権限と対象データの認可に従います。",
  "mcp:read": "割り当てられた作品の参照だけを許可します。",
  "mcp:compute": "割り当てられた作品に対する解析・計算を許可します。",
  "mcp:propose": "割り当てられた作品に対する変更提案を許可します。承認・適用は許可しません。",
};

export function OAuthConsentPage() {
  const [context, setContext] = useState<OAuthConsentContext | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    void loadOAuthConsentContext().then((value) => {
      if (mounted) setContext(value);
    }).catch(() => {
      if (mounted) setMessage("認可内容を確認できません。サインインをやり直してください。");
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, []);

  async function decide(accept: boolean): Promise<void> {
    if (busy || (accept && (!context || !canApproveOAuthConsent(context)))) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await submitOAuthConsent(accept);
      window.location.assign(sameOriginOAuthContinuation(result.url, window.location.origin, context?.redirectUri));
    } catch {
      setMessage("認可を完了できませんでした。内容を保護したまま再試行してください。");
      setBusy(false);
    }
  }

  const approvable = context ? canApproveOAuthConsent(context) : false;
  return <main className="pg-entry pg-desktop">
    <section className="pg-login" aria-labelledby="oauth-consent-title">
      <p className="eyebrow">Codexia</p>
      <h1 id="oauth-consent-title">Codexia APIの利用を確認</h1>
      {loading ? <p role="status">認可内容を確認しています。</p> : context?.clientName && approvable ? <>
        <p><strong>{context.clientName}</strong> がCodexia APIへのアクセスを求めています。</p>
        <ul>
          {context.requestedScopes.map((scope) => <li key={scope}>{scope} — {scopeDescriptions[scope]}</li>)}
        </ul>
      </> : <p role="alert">登録済みクライアントまたは対応する権限を確認できません。許可は実行できません。</p>}
      {message && <p role="alert">{message}</p>}
      <button type="button" disabled={busy || loading || !approvable} onClick={() => void decide(true)}>{busy ? "処理しています…" : "許可して続ける"}</button>
      <button type="button" disabled={busy || loading} onClick={() => void decide(false)}>拒否して戻る</button>
    </section>
  </main>;
}
