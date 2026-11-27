import { useCallback, useEffect, useRef, useState } from 'react';
import { authClient } from '../auth-client';
import { type AuthMethodAvailability, fetchAuthMethodAvailability } from '../oauth-login';
import { IdentityManagementPanel } from '../settings/IdentityManagementPanel';
import { OwnerIdentityPanel } from '../settings/OwnerIdentityPanel';
import { BackupConsole } from './BackupConsole';
import { ConsoleSetup } from './ConsoleSetup';
import { consumeConsoleReturnLocation, resolveConsoleReturnLocation } from './console-return';
import { checkOwnerSession, type OwnerSessionState } from './console-session';
import './console.css';

const SECTIONS = [
  { path: '/console/security', title: 'セキュリティ', description: 'Passkeyとセッションを管理します。' },
  { path: '/console/identity', title: '連携ID', description: '外部IDプロバイダーとアプリのアクセスを確認します。' },
  { path: '/console/backups', title: 'バックアップ', description: '保管先と保全状況を確認します。' },
] as const;

type ConsoleRoute = 'home' | 'setup' | 'security' | 'identity' | 'backups' | 'not-found';
type ConsoleAccess = OwnerSessionState | 'checking';

const ROUTES: Record<string, ConsoleRoute> = {
  '/console': 'home',
  '/console/setup': 'setup',
  '/console/security': 'security',
  '/console/identity': 'identity',
  '/console/backups': 'backups',
  '/console/backups/destination': 'backups',
  '/console/backups/verification': 'backups',
  '/console/backups/history': 'backups',
  '/console/backups/recovery': 'backups',
};

function routeFor(pathname: string): ConsoleRoute {
  return ROUTES[pathname.replace(/\/$/u, '') || '/console'] ?? 'not-found';
}

function routeTitle(route: ConsoleRoute): string {
  if (route === 'home') return '管理コンソール';
  if (route === 'security') return 'セキュリティ';
  if (route === 'identity') return '連携ID';
  if (route === 'backups') return 'バックアップ';
  if (route === 'setup') return '初回所有者登録';
  return 'ページが見つかりません';
}

function hasAuthError(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && 'error' in result && (result as { error?: unknown }).error);
}

/** Keep the validated same-tab handoff while navigating among console pages. */
function consoleHref(path: string): string {
  try {
    const { id } = resolveConsoleReturnLocation(window.location.search, window.sessionStorage);
    return id ? `${path}?return=${encodeURIComponent(id)}` : path;
  } catch {
    return path;
  }
}

export function ConsoleEntry() {
  const route = routeFor(window.location.pathname);
  const [access, setAccess] = useState<ConsoleAccess>(route === 'setup' || route === 'not-found' ? 'unavailable' : 'checking');
  const [methods, setMethods] = useState<AuthMethodAvailability | null>(null);
  const [methodsFailed, setMethodsFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const requestSequence = useRef(0);
  const inspect = useCallback(async (): Promise<OwnerSessionState> => {
    const sequence = ++requestSequence.current;
    setAccess('checking');
    setMessage('');
    const result = await checkOwnerSession();
    if (sequence !== requestSequence.current) return result;
    setMethods(null);
    setMethodsFailed(false);
    setAccess(result);
    if (result === 'unauthorized' || (result === 'owner' && route === 'identity')) {
      try {
        const availability = await fetchAuthMethodAvailability((url, init) =>
          fetch(url, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.timeout(5_000),
          }),
        );
        if (sequence === requestSequence.current) setMethods(availability);
      } catch {
        if (sequence === requestSequence.current) setMethodsFailed(true);
      }
    }
    return result;
  }, [route]);

  useEffect(() => {
    if (route === 'setup' || route === 'not-found') return;
    void inspect();
    return () => {
      requestSequence.current += 1;
    };
  }, [inspect, route]);

  async function signInWithPasskey(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await authClient.signIn.passkey();
      if (hasAuthError(result)) throw new Error('Passkeyでサインインできませんでした。');
      const status = await inspect();
      if (status === 'forbidden') setMessage('このアカウントには管理コンソールの権限がありません。');
      else if (status === 'unavailable') setMessage('認証状態を確認できません。接続を確認して再試行してください。');
      else if (status === 'unauthorized') setMessage('サインインを確認できません。もう一度お試しください。');
    } catch {
      setMessage('Passkeyでサインインできませんでした。キャンセルした場合は、そのまま再試行できます。');
    } finally {
      setBusy(false);
    }
  }

  async function signInWithProvider(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const callbackURL = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const result = await authClient.signIn.social({ provider: 'workspace-oidc', callbackURL });
      if (hasAuthError(result)) throw new Error('IDプロバイダーでのサインインを開始できませんでした。');
      const status = await inspect();
      if (status === 'forbidden') setMessage('このアカウントには管理コンソールの権限がありません。');
      else if (status === 'unavailable') setMessage('認証状態を確認できません。接続を確認して再試行してください。');
    } catch {
      setMessage('IDプロバイダーでのサインインを開始できませんでした。再試行してください。');
    } finally {
      setBusy(false);
    }
  }

  function returnToAuthoring(): void {
    try {
      const target = consumeConsoleReturnLocation(window.location.search, window.sessionStorage);
      window.location.assign(target);
    } catch {
      setMessage('執筆画面への戻り先を確認できませんでした。ブラウザーの戻る操作をお試しください。');
    }
  }

  if (route === 'setup')
    return (
      <main className="codexia-console" aria-labelledby="console-title">
        <div className="codexia-console__wrap">
          <header className="codexia-console__masthead">
            <a className="codexia-console__brand" href="/desktop/" aria-label="Codexiaへ戻る">
              Codexia<span aria-hidden="true">.</span>
            </a>
            <button className="codexia-console__return quiet-button" type="button" onClick={returnToAuthoring}>
              執筆画面へ戻る
            </button>
          </header>
          <ConsoleSetup consoleUrl={consoleHref('/console')} />
        </div>
      </main>
    );

  if (route === 'not-found')
    return (
      <main className="codexia-console" aria-labelledby="console-title">
        <div className="codexia-console__wrap">
          <header className="codexia-console__masthead">
            <a className="codexia-console__brand" href="/desktop/">
              Codexia<span aria-hidden="true">.</span>
            </a>
          </header>
          <section className="codexia-console__panel">
            <p className="codexia-console__eyebrow">404</p>
            <h1 id="console-title">{routeTitle(route)}</h1>
            <p role="status">指定された管理画面はありません。</p>
            <a className="codexia-console__link" href={consoleHref('/console')}>
              コンソールへ戻る
            </a>
          </section>
        </div>
      </main>
    );

  if (access === 'checking')
    return (
      <main className="codexia-console" aria-labelledby="console-title">
        <div className="codexia-console__wrap">
          <header className="codexia-console__masthead">
            <a className="codexia-console__brand" href="/desktop/">
              Codexia<span aria-hidden="true">.</span>
            </a>
          </header>
          <section className="codexia-console__panel">
            <p className="codexia-console__eyebrow">OWNER-SESSION</p>
            <h1 id="console-title">管理コンソール</h1>
            <p role="status" aria-live="polite">
              所有者の認証状態を確認しています。
            </p>
          </section>
        </div>
      </main>
    );

  if (access === 'unavailable')
    return (
      <main className="codexia-console" aria-labelledby="console-title">
        <div className="codexia-console__wrap">
          <header className="codexia-console__masthead">
            <a className="codexia-console__brand" href="/desktop/">
              Codexia<span aria-hidden="true">.</span>
            </a>
            <button className="codexia-console__return quiet-button" type="button" onClick={returnToAuthoring}>
              執筆画面へ戻る
            </button>
          </header>
          <section className="codexia-console__panel">
            <p className="codexia-console__eyebrow">接続を確認</p>
            <h1 id="console-title">管理コンソールを利用できません</h1>
            <p role="alert">所有者セッションを確認できません。APIの接続状態を確認して、もう一度お試しください。</p>
            <div className="codexia-console__actions">
              <button type="button" disabled={busy} onClick={() => void inspect()}>
                再試行
              </button>
              <button type="button" className="quiet-button" onClick={returnToAuthoring}>
                執筆画面へ戻る
              </button>
            </div>
          </section>
        </div>
      </main>
    );

  if (access === 'unauthorized')
    return (
      <main className="codexia-console" aria-labelledby="console-title">
        <div className="codexia-console__wrap">
          <header className="codexia-console__masthead">
            <a className="codexia-console__brand" href="/desktop/">
              Codexia<span aria-hidden="true">.</span>
            </a>
            <button className="codexia-console__return quiet-button" type="button" onClick={returnToAuthoring}>
              執筆画面へ戻る
            </button>
          </header>
          <section className="codexia-console__panel codexia-console__sign-in" aria-labelledby="console-title">
            <p className="codexia-console__eyebrow">OWNER-SESSION</p>
            <h1 id="console-title">所有者としてサインイン</h1>
            <p>管理画面へ入るには、登録済みのBetter Authセッションを確認します。作品用APIトークンは管理権限として使いません。</p>
            {message && (
              <p className="codexia-console__alert" role="alert">
                {message}
              </p>
            )}
            {methodsFailed ? (
              <>
                <p role="alert">サインイン方法を読み込めません。APIの接続を確認してください。</p>
                <button type="button" disabled={busy} onClick={() => void inspect()}>
                  再試行
                </button>
              </>
            ) : methods ? (
              <div className="codexia-console__actions">
                {methods.passkey && (
                  <button type="button" disabled={busy} onClick={() => void signInWithPasskey()}>
                    {busy ? '認証を確認しています…' : 'Passkeyでサインイン'}
                  </button>
                )}
                {methods.upstreamOidc && (
                  <button type="button" className="quiet-button" disabled={busy} onClick={() => void signInWithProvider()}>
                    IDプロバイダーでサインイン
                  </button>
                )}
              </div>
            ) : (
              <p role="status">サインイン方法を確認しています。</p>
            )}
          </section>
        </div>
      </main>
    );

  if (access === 'forbidden')
    return (
      <main className="codexia-console" aria-labelledby="console-title">
        <div className="codexia-console__wrap">
          <header className="codexia-console__masthead">
            <a className="codexia-console__brand" href="/desktop/">
              Codexia<span aria-hidden="true">.</span>
            </a>
            <button className="codexia-console__return quiet-button" type="button" onClick={returnToAuthoring}>
              執筆画面へ戻る
            </button>
          </header>
          <section className="codexia-console__panel">
            <p className="codexia-console__eyebrow">403 · FORBIDDEN</p>
            <h1 id="console-title">管理権限がありません</h1>
            <p role="alert">このセッションは管理コンソールの所有者として確認されませんでした。管理情報は表示していません。</p>
            <button type="button" className="quiet-button" onClick={returnToAuthoring}>
              執筆画面へ戻る
            </button>
          </section>
        </div>
      </main>
    );

  return (
    <main className="codexia-console" aria-labelledby="console-title">
      <div className="codexia-console__wrap">
        <header className="codexia-console__masthead">
          <a className="codexia-console__brand" href="/desktop/" aria-label="Codexiaへ戻る">
            Codexia<span aria-hidden="true">.</span>
          </a>
          <div className="codexia-console__masthead-actions">
            <span className="codexia-console__session" role="status">
              所有者セッションを確認済み
            </span>
            <button className="codexia-console__return quiet-button" type="button" onClick={returnToAuthoring}>
              執筆画面へ戻る
            </button>
          </div>
        </header>
        <div className="codexia-console__layout">
          <aside className="codexia-console__sidebar" aria-label="管理メニュー">
            <p className="codexia-console__eyebrow">OWNER CONSOLE</p>
            <nav aria-label="管理コンソール">
              <a href={consoleHref('/console')} aria-current={route === 'home' ? 'page' : undefined}>
                ホーム
              </a>
              {SECTIONS.map(section => (
                <a
                  key={section.path}
                  href={consoleHref(section.path)}
                  aria-current={route === section.path.slice('/console/'.length) ? 'page' : undefined}
                >
                  {section.title}
                </a>
              ))}
            </nav>
            <p className="codexia-console__sidebar-note">本人の認証と設定を行います。VMや本番環境の操作は提供しません。</p>
          </aside>
          <section className="codexia-console__content" aria-labelledby="console-title">
            <p className="codexia-console__eyebrow">CODEXIA · OWNER-SESSION</p>
            <h1 id="console-title">{routeTitle(route)}</h1>
            {message && (
              <p className="codexia-console__alert" role="alert">
                {message}
              </p>
            )}
            {route === 'home' ? (
              <>
                <p className="codexia-console__intro">本人の認証・連携先・バックアップの設定を管理します。</p>
                <nav className="codexia-console__cards" aria-label="設定項目">
                  {SECTIONS.map(section => (
                    <a className="codexia-console__card" key={section.path} href={consoleHref(section.path)}>
                      <span className="codexia-console__card-title">{section.title}</span>
                      <span>{section.description}</span>
                      <span className="codexia-console__card-action" aria-hidden="true">
                        開く →
                      </span>
                    </a>
                  ))}
                </nav>
              </>
            ) : route === 'security' ? (
              <IdentityManagementPanel placement="console" />
            ) : route === 'identity' ? (
              <div className="identity-management">
                {methodsFailed ? (
                  <>
                    <p role="alert">外部IDプロバイダーの設定を確認できませんでした。</p>
                    <button className="identity-management__secondary" type="button" onClick={() => void inspect()}>
                      再試行
                    </button>
                  </>
                ) : methods ? (
                  <OwnerIdentityPanel oidcConfigured={methods.upstreamOidc} headingLevel={2} />
                ) : (
                  <p>外部IDプロバイダーの設定を確認しています。</p>
                )}
              </div>
            ) : (
              <BackupConsole href={consoleHref} onReauthenticate={() => void inspect()} />
            )}
            <div className="codexia-console__auth-actions">
              <button type="button" disabled={busy} onClick={() => void inspect()}>
                セッションを再確認
              </button>
              <button type="button" className="quiet-button" onClick={returnToAuthoring}>
                執筆画面へ戻る
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
