import { control, gap, records, sourceAt, sourceRef, transition } from './owner-source.mjs';

const launcher = 'app/src/launcher.tsx';
const login = 'app/src/OAuthLoginPage.tsx';
const consent = 'app/src/OAuthConsentPage.tsx';

function routeFor(source, name) {
  if (!source.exists(launcher)) return null;
  const text = source.read(launcher);
  const match = text.match(new RegExp('const ' + name + ' = window\\.location\\.pathname === "([^"]+)";'));
  if (!match) return null;
  return { route: match[1], location: source.location(launcher, match[0]) };
}

export function projectAuth(source) {
  const loginRoute = routeFor(source, 'isOAuthLogin');
  const consentRoute = routeFor(source, 'isOAuthConsent');
  const loginComponent = sourceAt(source, login, 'export function OAuthLoginPage()');
  const consentComponent = sourceAt(source, consent, 'export function OAuthConsentPage()');
  const screens = records(
    loginRoute && loginComponent && {
      id: 'AUTH-01', platform: 'auth', source: sourceRef(loginComponent), route: loginRoute.route,
      regions: [
        { id: 'login-content', role: 'content', label: 'サインイン案内', source: sourceRef(sourceAt(source, login, '<section className="pg-login"')) },
        { id: 'login-actions', role: 'actions', label: '登録済みのサインイン方法', source: sourceRef(sourceAt(source, login, 'onClick={() => void signInWithPasskey()}')) },
      ],
    },
    consentRoute && consentComponent && {
      id: 'AUTH-02', platform: 'auth', source: sourceRef(consentComponent), route: consentRoute.route,
      regions: [
        { id: 'consent-content', role: 'content', label: '要求されたclientとscope', source: sourceRef(sourceAt(source, consent, 'context.requestedScopes.map')) },
        { id: 'consent-actions', role: 'actions', label: '許可または拒否', source: sourceRef(sourceAt(source, consent, 'onClick={() => void decide(true)}')) },
      ],
    },
  );
  const controls = records(
    control(source, { id: 'AUTH-01.A', platform: 'auth', path: login, label: 'Passkeyでサインイン', handler: 'onClick={() => void signInWithPasskey()}', region: 'login-actions' }),
    control(source, { id: 'AUTH-01.B', platform: 'auth', path: login, label: 'IDプロバイダーでサインイン', handler: 'onClick={() => void signInWithProvider()}', region: 'login-actions' }),
    control(source, { id: 'AUTH-02.A', platform: 'auth', path: consent, label: '許可して続ける', handler: 'onClick={() => void decide(true)}', region: 'consent-actions' }),
    control(source, { id: 'AUTH-02.B', platform: 'auth', path: consent, label: '拒否して戻る', handler: 'onClick={() => void decide(false)}', region: 'consent-actions' }),
  );
  const transitions = records(
    transition({
      id: 'auth-session-consent-continuation', platform: 'auth', from: 'AUTH-01/ready', to: 'AUTH-02/ready',
      event: 'valid OAuth session', screen: 'AUTH-01', condition: 'session.data && validPrompt',
      location: sourceAt(source, login, 'window.location.replace(oauthConsentContinuationURL(window.location.search));'),
    }),
    transition({
      id: 'oauth-consent-client-continuation', platform: 'auth', from: 'AUTH-02/ready', to: 'registered-client-callback',
      event: 'decide', screen: 'AUTH-02', condition: 'sameOriginOAuthContinuation(result.url, window.location.origin, context?.redirectUri)',
      location: sourceAt(source, consent, 'window.location.assign(sameOriginOAuthContinuation(result.url, window.location.origin, context?.redirectUri));'),
    }),
  );
  const catalog = 'docs/design/SCREEN-CONTROL-CATALOG.md';
  const gaps = records(
    (!loginRoute || !loginComponent) && gap({ id: 'AUTH-01', platform: 'auth', status: 'unextracted', reason: 'The login route or rendered login component could not be located in canonical source.', location: sourceAt(source, catalog, '| AUTH-01 |') }),
    (!consentRoute || !consentComponent) && gap({ id: 'AUTH-02', platform: 'auth', status: 'unextracted', reason: 'The consent route or rendered consent component could not be located in canonical source.', location: sourceAt(source, catalog, '| AUTH-02 |') }),
  );
  return { screens, controls, transitions, gaps };
}
