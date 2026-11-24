import { control, gap, records, sourceAt, sourceRef, transition } from './owner-source.mjs';

const entry = 'app/src/console/ConsoleEntry.tsx';
const setup = 'app/src/console/ConsoleSetup.tsx';
const identity = 'app/src/settings/IdentityManagementPanel.tsx';
const identityView = 'app/src/settings/OwnerIdentityPanel.tsx';
const session = 'app/src/console/console-session.ts';
const consentClient = 'app/src/settings/owner-security-client.ts';
const catalog = 'docs/design/SCREEN-CONTROL-CATALOG.md';

function routeEntries(source) {
  if (!source.exists(entry)) return [];
  const text = source.read(entry);
  return [...text.matchAll(/^\s*("\/console[^"]*"):\s*"([a-z-]+)",?\s*$/gm)].map((match) => ({
    route: match[1].slice(1, -1), value: match[2], source: source.location(entry, match[0].trim()),
  }));
}

function screen(source, routes, id, path, componentNeedle, regions, route) {
  const routeSource = routes.find((item) => item.route === route)?.source;
  const componentSource = sourceAt(source, path, componentNeedle);
  if (!routeSource || !componentSource) return null;
  return { id, platform: 'console', source: sourceRef(componentSource), route, regions };
}

function combinedControl(source, { id, label, region, handlers, path = identity }) {
  const locations = handlers.map((needle) => sourceAt(source, path, needle));
  const labelLocation = sourceAt(source, path, label);
  if (!locations.every(Boolean) || !labelLocation) return null;
  return { id, platform: 'console', label, role: 'button', handler: handlers.join(' · '), region, source: sourceRef(locations[0]) };
}

function homeNavigation(source, route, target, label, canonicalControl, sectionNeedle) {
  const handler = sourceAt(source, entry, 'href={consoleHref(section.path)}');
  const section = sourceAt(source, entry, sectionNeedle);
  const id = canonicalControl;
  const controlRecord = handler && section ? {
    id, platform: 'console', source: sourceRef(handler), label, role: 'link', handler: sectionNeedle,
    region: 'console-navigation',
  } : null;
  const routeTarget = routeEntries(source).find((item) => item.route === target);
  const edge = routeTarget && handler && section && transition({
    id: 'console-route-' + route.slice(1).replaceAll('/', '-') + '-to-' + target.slice(1).replaceAll('/', '-'),
    platform: 'console', from: route === '/console' ? 'CON-00/ready' : 'CON-' + ({ '/console/security': '10', '/console/identity': '20', '/console/backups': '30' }[route] ?? '00') + '/ready',
    to: target === '/console' ? 'CON-00/ready' : 'CON-' + ({ '/console/security': '10', '/console/identity': '20', '/console/backups': '30' }[target] ?? '00') + '/ready',
    event: 'navigate ' + target, screen: route === '/console' ? 'CON-00' : ({ '/console/security': 'CON-10', '/console/identity': 'CON-20', '/console/backups': 'CON-30' }[route] ?? 'CON-00'),
    control: id, condition: 'href={consoleHref(section.path)}', location: handler,
  });
  return { control: controlRecord, transition: edge };
}

function homeSecurityControl(source, routes) {
  const path = '/console/security';
  const identityPath = '/console/identity';
  const sourceLink = sourceAt(source, entry, 'href={consoleHref(section.path)}');
  const security = sourceAt(source, entry, 'path: "/console/security", title: "セキュリティ"');
  const identitySource = sourceAt(source, entry, 'path: "/console/identity", title: "連携ID"');
  if (!sourceLink || !security || !identitySource
    || !routes.some((item) => item.route === path) || !routes.some((item) => item.route === identityPath)) return null;
  return {
    id: 'CON-00.A', platform: 'console', source: sourceRef(sourceLink),
    label: 'セキュリティ・連携IDを開く', role: 'link',
    handler: 'SECTIONS[' + path + ' · ' + identityPath + '] → href={consoleHref(section.path)}',
    region: 'console-navigation',
  };
}

export function projectConsole(source) {
  const routes = routeEntries(source);
  const routeLocation = (path) => routes.find((item) => item.route === path)?.source;
  const setupRoute = routeLocation('/console/setup');
  const securityRoute = routeLocation('/console/security');
  const identityRoute = routeLocation('/console/identity');
  const backupRoute = routeLocation('/console/backups');
  const setupAuthor = sourceAt(source, catalog, '| CON-01 |');
  const screens = records(
    screen(source, routes, 'CON-00', entry, 'route === "home" ? <>', [
      { id: 'console-navigation', role: 'navigation', label: '管理コンソール', source: sourceRef(sourceAt(source, entry, '<nav aria-label="管理コンソール">')) },
      { id: 'console-session-state', role: 'status', label: '所有者セッションの状態', source: sourceRef(sourceAt(source, entry, 'const [access, setAccess]')) },
    ], '/console'),
    setupRoute && sourceAt(source, setup, 'onSubmit={submitKey}') && {
      id: 'CON-01', platform: 'console', route: '/console/setup', source: sourceRef(sourceAt(source, setup, 'onSubmit={submitKey}')),
      regions: [
        { id: 'setup-key-form', role: 'form', label: '初期登録キー', source: sourceRef(sourceAt(source, setup, '初期登録キー')) },
        { id: 'setup-status', role: 'status', label: '初回登録状態', source: sourceRef(sourceAt(source, setup, 'current === "waiting"')) },
      ],
    },
    setupRoute && sourceAt(source, setup, 'onSubmit={submitProfile}') && {
      id: 'CON-02', platform: 'console', route: '/console/setup', source: sourceRef(sourceAt(source, setup, 'onSubmit={submitProfile}')),
      regions: [
        { id: 'setup-profile', role: 'form', label: '所有者プロフィール', source: sourceRef(sourceAt(source, setup, 'onSubmit={submitProfile}')) },
        ...(sourceAt(source, setup, 'onClick={createPasskey}') ? [{ id: 'setup-passkey', role: 'actions', label: 'Passkey登録' }] : []),
      ],
    },
    setupRoute && sourceAt(source, setup, 'status.state === "owner-enrolled"') && {
      id: 'CON-03', platform: 'console', route: '/console/setup', source: sourceRef(sourceAt(source, setup, 'status.state === "owner-enrolled"')),
      regions: [
        { id: 'setup-enrollment-status', role: 'status', label: 'owner登録とclient準備状態', source: sourceRef(sourceAt(source, setup, 'status.clientsReady')) },
        { id: 'setup-refresh', role: 'actions', label: '登録状況を更新', source: sourceRef(sourceAt(source, setup, 'onClick={() => { void run(async () => { await refresh(); }); }}')) },
      ],
    },
    screen(source, routes, 'CON-10', entry, '<IdentityManagementPanel placement="console" />', [
      { id: 'passkey-management', role: 'list', label: 'パスキー管理', source: sourceRef(sourceAt(source, identity, '>パスキー</SectionHeading>')) },
    ], '/console/security'),
    screen(source, routes, 'CON-11', identity, '>セッション</SectionHeading>', [
      { id: 'session-management', role: 'list', label: 'セッション一覧', source: sourceRef(sourceAt(source, identity, '>セッション</SectionHeading>')) },
    ], '/console/security'),
    screen(source, routes, 'CON-20', identityView, '>外部IDプロバイダー</Heading>', [
      { id: 'identity-provider-status', role: 'status', label: '運用者設定のOIDC状態', source: sourceRef(sourceAt(source, identityView, '運用者による設定があります。所有者との連携はこの画面では未確認です。')) },
    ], '/console/identity'),
    screen(source, routes, 'CON-21', identityView, '>アプリに保存した同意</Heading>', [
      { id: 'oauth-consent-list', role: 'list', label: '保存済みOAuth同意', source: sourceRef(sourceAt(source, identityView, 'fetchOwnerConsents(fetch, signal)')) },
    ], '/console/identity'),
    backupRoute && sourceAt(source, entry, 'バックアップの設定と履歴は、バックアップ実装後に確認できます。') && {
      id: 'CON-30', platform: 'console', route: '/console/backups', source: sourceRef(sourceAt(source, entry, 'バックアップの設定と履歴は、バックアップ実装後に確認できます。')),
      regions: [{ id: 'backup-unavailable', role: 'status', label: 'バックアップ機能未実装の案内', source: sourceRef(sourceAt(source, entry, 'ここからVM操作や復元は実行できません。')) }],
    },
  );

  const controls = records(
    homeSecurityControl(source, routes),
    homeNavigation(source, '/console', '/console/backups', 'バックアップ', 'CON-00.B', 'path: "/console/backups", title: "バックアップ"').control,
    control(source, { id: 'CON-01.A', platform: 'console', path: setup, label: 'キーを確認', handler: 'onSubmit={submitKey}', role: 'submit', region: 'setup-key-form' }),
    control(source, { id: 'CON-02.A', platform: 'console', path: setup, label: 'Passkeyを作成', handler: 'onClick={createPasskey}', region: 'setup-passkey' }),
    control(source, { id: 'CON-03.A', platform: 'console', path: setup, label: '登録状況を更新', handler: 'onClick={() => { void run(async () => { await refresh(); }); }}', region: 'setup-refresh' }),
    combinedControl(source, { id: 'CON-10.A', label: 'パスキーを追加', region: 'passkey-management', handlers: ['onSubmit={(event) => void addPasskey(event)}', 'onRename={renamePasskey}', 'onDelete={deletePasskey}'] }),
    combinedControl(source, { id: 'CON-11.A', label: '他のすべてのセッションを終了', region: 'session-management', handlers: ['onRevoke={revokeSession}', 'onClick={() => void revokeOtherSessions()}'] }),
  );

  const transitions = records(
    ...[
      ['/console/security', 'CON-00.A', 'CON-10', 'path: "/console/security", title: "セキュリティ"'],
      ['/console/identity', 'CON-00.A', 'CON-20', 'path: "/console/identity", title: "連携ID"'],
      ['/console/backups', 'CON-00.B', 'CON-30', 'path: "/console/backups", title: "バックアップ"'],
    ].map(([target, controlId, screenId, sectionNeedle]) => homeNavigation(source, '/console', target, '', controlId, sectionNeedle).transition),
    transition({ id: 'setup-key-authorized', platform: 'console', from: 'CON-01/key', to: 'CON-02/profile', event: 'submitKey', screen: 'CON-01', control: 'CON-01.A', condition: 'setStep("profile")', location: sourceAt(source, setup, 'setStep("profile");') }),
    transition({ id: 'setup-profile-confirmed', platform: 'console', from: 'CON-02/profile', to: 'CON-02/passkey', event: 'submitProfile', screen: 'CON-02', condition: 'setStep("passkey")', location: sourceAt(source, setup, 'setStep("passkey");') }),
    sourceAt(source, setup, 'onClick={createPasskey}') && transition({ id: 'setup-owner-enrolled', platform: 'console', from: 'CON-02/passkey', to: 'CON-03/owner-enrolled', event: 'refresh', screen: 'CON-02', control: 'CON-02.A', condition: 'state.state === "owner-enrolled" && token', location: sourceAt(source, setup, 'if (state.state === "owner-enrolled" && token) {') }),
    transition({ id: 'setup-profile-expired', platform: 'console', from: 'CON-02/profile', to: 'CON-01/key', event: 'submitProfile failure', screen: 'CON-02', condition: 'state === "setup-pending"', location: sourceAt(source, setup, 'setStep("key");') }),
    transition({ id: 'setup-active-console-link', platform: 'console', from: 'CON-03/active', to: 'CON-00/ready', event: 'open consoleUrl', screen: 'CON-03', condition: 'current === "active" || current === "blocked"', location: sourceAt(source, setup, '<a href={consoleUrl} className="codexia-console__link">管理コンソールへ</a>') }),
    ...[
      ['/console/security', 'CON-10', 'console-security-home'],
      ['/console/identity', 'CON-20', 'console-identity-home'],
      ['/console/backups', 'CON-30', 'console-backups-home'],
    ].map(([route, screenId, id]) => transition({ id, platform: 'console', from: screenId + '/ready', to: 'CON-00/ready', event: 'navigate /console', screen: screenId, condition: 'href={consoleHref("/console")}', location: sourceAt(source, entry, 'href={consoleHref("/console")}') })),
  );

  const backupRoutes = [
    ['CON-31', '/console/backups/destination'], ['CON-32', '/console/backups/verification'],
    ['CON-33', '/console/backups/history'], ['CON-34', '/console/backups/recovery'],
  ];
  const gaps = records(
    ...['CON-00', 'CON-01', 'CON-02', 'CON-03', 'CON-10', 'CON-11', 'CON-20', 'CON-21', 'CON-30']
      .filter((id) => !screens.some((item) => item.id === id))
      .map((id) => gap({ id, platform: 'console', status: 'unextracted', reason: 'The canonical route or source view for ' + id + ' could not be located; no implementation behavior is inferred.', location: sourceAt(source, catalog, '| ' + id + ' |') })),
    gap({ id: 'CON-20.A', platform: 'console', reason: 'OIDC registration, validation, owner-link and activation controls are not implemented in the current owner view.', location: sourceAt(source, catalog, '| CON-20.A |') }),
    gap({ id: 'CON-21.A', platform: 'console', reason: 'The current view lists stored consent only; grant revocation control is not implemented.', location: sourceAt(source, catalog, '| CON-21.A |') }),
    ...backupRoutes.map(([id, route]) => gap({ id, platform: 'console', reason: route + ' is currently routed to the generic backup placeholder; no distinct configuration, probe, history, or recovery screen is implemented.', location: routeLocation(route) ?? sourceAt(source, catalog, '| ' + id + ' |') })),
    gap({ id: 'CON-30.B', platform: 'console', reason: 'Manual backup request and durable run-receipt lookup are not implemented; the screen says backup is unavailable.', location: sourceAt(source, entry, 'バックアップの設定と履歴は、バックアップ実装後に確認できます。') }),
    gap({ id: 'CON-30.A', platform: 'console', reason: 'No backup status/configuration request is issued by the current console page.', location: sourceAt(source, entry, 'バックアップの設定と履歴は、バックアップ実装後に確認できます。') }),
  );
  return { screens, controls, transitions, gaps };
}
