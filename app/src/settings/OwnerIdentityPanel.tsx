import { useEffect, useId, useState } from "react";
import { fetchOwnerConsents, type OwnerConsent } from "./owner-security-client";
import "./identity-management.css";

type ConsentState = { status: "loading" | "unavailable" } | { status: "ready"; consents: OwnerConsent[] };

export function OwnerIdentityPanel({ oidcConfigured }: { oidcConfigured: boolean }) {
  const id = useId();
  const [state, setState] = useState<ConsentState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    void fetchOwnerConsents(fetch, signal).then((consents) => {
      if (!controller.signal.aborted) setState({ status: "ready", consents });
    }, () => {
      if (!controller.signal.aborted) setState({ status: "unavailable" });
    });
    return () => controller.abort();
  }, [attempt]);

  return <>
    <section className="identity-management__section" aria-labelledby={`${id}-oidc`}>
      <h3 id={`${id}-oidc`}>外部IDプロバイダー</h3>
      <p className="identity-management__intro">{oidcConfigured
        ? "運用者による設定があります。所有者との連携はこの画面では未確認です。"
        : "外部IDプロバイダーは未設定です。"}</p>
    </section>
    <section className="identity-management__section" aria-labelledby={`${id}-consents`}>
      <h3 id={`${id}-consents`}>アプリに保存した同意</h3>
      {state.status === "loading" && <p className="identity-management__hint" role="status">同意を読み込んでいます。</p>}
      {state.status === "unavailable" && <>
        <p className="identity-management__error" role="alert">同意を読み込めませんでした。</p>
        <button className="identity-management__secondary" type="button" onClick={() => {
          setState({ status: "loading" });
          setAttempt((value) => value + 1);
        }}>同意を再読み込み</button>
      </>}
      {state.status === "ready" && (state.consents.length > 0
        ? <ul className="identity-management__list" aria-label="保存したアプリ同意">
          {state.consents.map(({ id, clientId, scopes }) => <li className="identity-management__list-item" key={id}>
            <div className="identity-management__item-main">
              <h4>{clientId}</h4>
              <p className="identity-management__meta">{scopes.length ? scopes.join("、") : "スコープなし"}</p>
            </div>
          </li>)}
        </ul>
        : <p className="identity-management__empty">保存したアプリ同意はありません。</p>)}
    </section>
  </>;
}
