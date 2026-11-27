import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { project } from './owner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function sourceWith(overrides = new Map()) {
  const absolute = (path) => resolve(root, path);
  const source = {
    exists(path) { return overrides.has(path) || statExists(absolute(path)); },
    read(path) {
      if (overrides.has(path)) return overrides.get(path);
      return readFileSync(absolute(path), 'utf8');
    },
    list(directory) {
      const result = [];
      const visit = (path) => {
        for (const name of readdirSync(absolute(path))) {
          const child = path + '/' + name;
          const stat = statSync(absolute(child));
          if (stat.isSymbolicLink()) throw new Error('Unexpected symlink: ' + child);
          if (stat.isDirectory()) visit(child);
          else result.push(child);
        }
      };
      visit(directory);
      return result.sort();
    },
    location(path, needle) {
      const text = this.read(path);
      const offset = text.indexOf(needle);
      if (offset < 0) return null;
      return { path, line: text.slice(0, offset).split('\n').length, symbol: needle };
    },
  };
  return source;
}

function statExists(path) {
  try { statSync(path); return true; } catch { return false; }
}

const withFileEdit = (path, edit) => {
  const overrides = new Map([[path, edit(readFileSync(resolve(root, path), 'utf8'))]]);
  return sourceWith(overrides);
};

function removeConsoleSection(text, route) {
  const quotedRoute = route.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const changed = text.replace(new RegExp(`^\\s*\\{\\s*path:\\s*(['"])${quotedRoute}\\1,[^\\n]*\\n`, 'mu'), '');
  assert.notEqual(changed, text, `Expected the ${route} section declaration to be removed`);
  return changed;
}

function removeConsoleRoute(text, route, value) {
  const quotedRoute = route.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const quotedValue = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const changed = text.replace(new RegExp(`^\\s*(['"])${quotedRoute}\\1:\\s*(['"])${quotedValue}\\2,?\\s*\\n`, 'mu'), '');
  assert.notEqual(changed, text, `Expected the ${route} route entry to be removed`);
  return changed;
}

test('owner projection points to canonical screens, controls, and static source transitions', () => {
  const projection = project(sourceWith());
  const screenIds = new Set(projection.screens.map(({ id }) => id));
  const controlIds = projection.controls.map(({ id }) => id);
  const consoleHome = projection.screens.find(({ id }) => id === 'CON-00');
  assert.ok(screenIds.has('AUTH-01') && screenIds.has('AUTH-02'));
  assert.ok(screenIds.has('CON-00') && screenIds.has('CON-01') && screenIds.has('CON-03'));
  assert.ok(screenIds.has('CON-10') && screenIds.has('CON-11') && screenIds.has('CON-20') && screenIds.has('CON-21'));
  assert.ok(screenIds.has('CON-30') && screenIds.has('PUB-01'));
  assert.equal(controlIds.filter((id) => id === 'CON-00.A').length, 1);
  assert.ok(controlIds.includes('AUTH-01.A') && controlIds.includes('AUTH-02.A'));
  assert.ok(controlIds.includes('CON-00.B') && controlIds.includes('CON-10.A') && controlIds.includes('CON-11.A'));
  assert.ok(controlIds.includes('CON-01.A') && controlIds.includes('CON-02.A') && controlIds.includes('CON-03.A'));
  assert.ok(consoleHome?.regions.some(({ id, role, label, source }) =>
    id === 'console-settings' && role === 'navigation' && label === '設定項目' &&
    source?.path === 'app/src/console/ConsoleEntry.tsx' &&
    /<nav\b(?=[^>]*\baria-label=(['"])設定項目\1)[^>]*>/u.test(source.symbol)),
  'The home settings cards must be sourced from their labeled navigation landmark');
  assert.ok(projection.controls.filter(({ id }) => ['CON-00.A', 'CON-00.B'].includes(id))
    .every(({ region }) => region === 'console-settings'),
  'The home settings links must belong to the labeled settings navigation landmark');
  assert.ok(controlIds.includes('PUB-01.A'));
  assert.ok(projection.transitions.length > 0);
  assert.ok(projection.transitions.every(({ method, source }) => method === 'static' && source.line > 0 && source.path));
  assert.ok(!screenIds.has('CON-31') && !screenIds.has('CON-32') && !screenIds.has('CON-33') && !screenIds.has('CON-34'));
  assert.deepEqual(projection.gaps.filter(({ id }) => ['CON-31', 'CON-32', 'CON-33', 'CON-34'].includes(id)).map(({ status }) => status),
    ['unimplemented', 'unimplemented', 'unimplemented', 'unimplemented']);
});

test('removing the canonical OAuth route changes regenerated projection and records the missing route', () => {
  const path = 'edge/frontend/static/_redirects';
  const changed = withFileEdit(path, (text) => {
    const withoutLogin = text.replace(/^\/oauth\/login \/oauth\/oauth-login\.html 200\r?\n/mu, '');
    assert.notEqual(withoutLogin, text, 'Expected the dedicated OAuth login rewrite to be removed');
    return withoutLogin;
  });
  const projection = project(changed);
  assert.ok(!projection.screens.some(({ id }) => id === 'AUTH-01'));
  assert.ok(projection.gaps.some(({ id, status }) => id === 'AUTH-01' && status === 'unextracted'));
  assert.ok(!projection.controls.some(({ id }) => id.startsWith('AUTH-01.')));
  assert.ok(!projection.transitions.some(({ id }) => id === 'auth-session-consent-continuation'));
});

test('changing the canonical login control handler removes that observed control', () => {
  const path = 'app/src/OAuthLoginPage.tsx';
  const changed = withFileEdit(path, (text) => text.replace('onClick={() => void signInWithPasskey()}', 'onClick={() => void beginPasskeySignIn()}'));
  const projection = project(changed);
  assert.ok(project(sourceWith()).controls.some(({ id }) => id === 'AUTH-01.A'));
  assert.ok(!projection.controls.some(({ id }) => id === 'AUTH-01.A'));
  assert.ok(!projection.transitions.some(({ id }) => id === 'auth-session-consent-continuation'));
});

test('removing setup Passkey action keeps the independently sourced profile screen, but removes dependent control and edge', () => {
  const path = 'app/src/console/ConsoleSetup.tsx';
  const changed = withFileEdit(path, (text) => text.replace('onClick={createPasskey}', 'onClick={beginPasskeyCreation}'));
  const projection = project(changed);
  assert.ok(projection.screens.some(({ id, source }) => id === 'CON-02' && source.path === path));
  assert.ok(!projection.controls.some(({ id }) => id === 'CON-02.A'));
  assert.ok(!projection.transitions.some(({ id }) => id === 'setup-owner-enrolled'));
});

test('initial public metadata expiry transitions from loading, before content exists', () => {
  const edge = project(sourceWith()).transitions.find(({ id }) => id === 'public-share-expired');
  assert.equal(edge.from, 'PUB-01/loading');
  assert.equal(edge.to, 'PUB-01/unavailable');
});

test('removing a console section target removes its navigation transition and grouped control', () => {
  const path = 'app/src/console/ConsoleEntry.tsx';
  const changed = withFileEdit(path, (text) => removeConsoleSection(text, '/console/security'));
  const projection = project(changed);
  assert.ok(project(sourceWith()).controls.some(({ id }) => id === 'CON-00.A'));
  assert.ok(!projection.controls.some(({ id }) => id === 'CON-00.A'));
  assert.ok(project(sourceWith()).transitions.some(({ id }) => id === 'console-route-console-to-console-security'));
  assert.ok(!projection.transitions.some(({ id }) => id === 'console-route-console-to-console-security'));
});

test('removing the identity section declaration removes the grouped navigation record', () => {
  const path = 'app/src/console/ConsoleEntry.tsx';
  const changed = withFileEdit(path, (text) => removeConsoleSection(text, '/console/identity'));
  const projection = project(changed);
  assert.ok(project(sourceWith()).transitions.some(({ id }) => id === 'console-route-console-to-console-identity'));
  assert.ok(!projection.transitions.some(({ id }) => id === 'console-route-console-to-console-identity'));
  assert.ok(!projection.controls.some(({ id }) => id === 'CON-00.A'));
});

test('removing the backup section declaration removes its navigation transition and control', () => {
  const path = 'app/src/console/ConsoleEntry.tsx';
  const changed = withFileEdit(path, (text) => removeConsoleSection(text, '/console/backups'));
  const projection = project(changed);
  assert.ok(project(sourceWith()).transitions.some(({ id }) => id === 'console-route-console-to-console-backups'));
  assert.ok(!projection.transitions.some(({ id }) => id === 'console-route-console-to-console-backups'));
  assert.ok(!projection.controls.some(({ id }) => id === 'CON-00.B'));
});

test('deleting the canonical route entry removes its route transition even while the JSX href binding remains', () => {
  const path = 'app/src/console/ConsoleEntry.tsx';
  const changed = withFileEdit(path, (text) => removeConsoleRoute(text, '/console/backups', 'backups'));
  const projection = project(changed);
  assert.ok(project(sourceWith()).transitions.some(({ id }) => id === 'console-route-console-to-console-backups'));
  assert.ok(!projection.transitions.some(({ id }) => id === 'console-route-console-to-console-backups'));
});

test('detaching the canonical reader theme callback removes its control and transition', () => {
  const path = 'app/src/contributions/PublicModuleView.tsx';
  const changed = withFileEdit(path, (text) => text.replace('onChange={onThemeChange}', 'onChange={() => undefined}'));
  const projection = project(changed);
  assert.ok(!projection.controls.some(({ id }) => id === 'PUB-01.A'));
  assert.ok(!projection.transitions.some(({ id }) => id === 'public-theme-local-change'));
});
