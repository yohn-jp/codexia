import { useEffect, useId, useState } from "react";
import { fetchAuthMethodAvailability } from "../oauth-login";
import { fetchOwnerConsents, type OwnerConsent } from "./owner-security-client";
import "./identity-management.css";

type ConsentState = { status: "loading" | "unavailable" } | { status: "ready"; consents: OwnerConsent[] };

export function OwnerIdentityPanel({ oidcConfigured, headingLevel = 3 }: { oidcConfigured?: boolean; headingLevel?: 2 | 3 }) {
  const id = useId();
  const [state, setState] = useState<ConsentState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [discoveredOidc, setDiscoveredOidc] = useState<boolean | "unavailable" | null>(null);
  const provider = oidcConfigured ?? discoveredOidc;
  const Heading = headingLevel === 2 ? "h2" : "h3";

  useEffect(() => {
    if (oidcConfigured !== undefined) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    void fetchAuthMethodAvailability((url, init) => fetch(url, { ...init, signal, redirect: "error" })).then(({ upstreamOidc }) => {
      if (!controller.signal.aborted) setDiscoveredOidc(upstreamOidc);
    }, () => {
      if (!controller.signal.aborted) setDiscoveredOidc("unavailable");
    });
    return () => controller.abort();
  }, [oidcConfigured]);

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
      <Heading id={`${id}-oidc`}>外部IDプロバイダー</Heading>
      {provider === null && <p className="identity-management__intro" role="status">設定状態を確認しています。</p>}
      {provider === "unavailable" && <p className="identity-management__intro" role="alert">設定状態を確認できませんでした。</p>}
      {typeof provider === "boolean" && <p className="identity-management__intro">{provider
        ? "運用者による設定があります。所有者との連携はこの画面では未確認です。"
        : "外部IDプロバイダーは未設定です。"}</p>}
    </section>
    <section className="identity-management__section" aria-labelledby={`${id}-consents`}>
      <Heading id={`${id}-consents`}>アプリに保存した同意</Heading>
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
