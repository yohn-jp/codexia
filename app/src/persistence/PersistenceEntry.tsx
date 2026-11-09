import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type PersistenceStatus } from "../api";
import { ApiError } from "../api-error";
import { PersistenceWorkspace } from "./PersistenceWorkspace";

type EntryState = "checking" | "signed-out" | "database" | "failed";

export function PersistenceEntry({ mode }: { mode: "desktop" | "mobile" }) {
  const [state, setState] = useState<EntryState>("checking");
  const [authorScope, setAuthorScope] = useState("owner");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pageWasHiddenRef = useRef(false);

  const inspect = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      await api.version();
      const session = await api.session();
      const persistence: PersistenceStatus = await api.persistenceStatus();
      if (!persistence.available || persistence.provider !== "postgres") {
        throw new Error("PostgreSQL保存基盤が利用できません。Gitワークスペースへの切替は提供していません。");
      }
      if (session.permissions && !session.permissions.some((permission) => permission === "write" || permission === "maintain" || permission === "admin")) {
        throw new Error("このアカウントには原稿編集権限がありません。");
      }
      setAuthorScope(session.authorScope || "owner");
      setState("database");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState("signed-out");
      } else {
        setState("failed");
        setMessage(error instanceof Error ? error.message : "Codexia APIに接続できませんでした。");
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void inspect();
    const hide = () => { pageWasHiddenRef.current = true; };
    const resume = (event: PageTransitionEvent) => {
      if (!pageWasHiddenRef.current && !event.persisted) return;
      pageWasHiddenRef.current = false;
      void inspect();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", resume);
    return () => { window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", resume); };
  }, [inspect]);

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

  if (state === "database") return <PersistenceWorkspace mode={mode} authorScope={authorScope} onSignOut={() => {
    void api.logout().finally(() => setState("signed-out"));
  }} />;
  if (state === "checking") return <main className={`pg-entry pg-${mode}`}><p role="status">PostgreSQL保存基盤を確認しています。</p></main>;
  if (state === "failed") return <main className={`pg-entry pg-${mode}`}>
    <section className="pg-login" aria-labelledby="pg-entry-title">
      <p className="eyebrow">Codexia</p>
      <h1 id="pg-entry-title">PostgreSQLへ接続できません</h1>
      <p role="alert">{message}</p>
      <button type="button" disabled={busy} onClick={() => void inspect()}>再試行</button>
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
