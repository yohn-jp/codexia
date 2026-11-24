/// <reference types="vite/client" />

import '../../styles.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { createNativeApiTransport, createNativeAuth } from '../../native/plugins/codexia-auth/src/index.mjs';
import { nativeApiOrigin, nativeOAuthConfig, nativeReaderOrigin } from '../../native/plugins/codexia-auth/src/native-config.mjs';
import { configureNativeApiSession } from '../api';
import { installNativeSelectCspCompatibility } from '../browser/nativeSelect';
import { PersistenceEntry } from '../persistence/PersistenceEntry';
import { PersistenceWorkspace } from '../persistence/PersistenceWorkspace';
import { applyThemeMode, loadThemeMode } from '../theme';

declare global {
  interface Window {
    __CODEXIA_NATIVE_CONFIG__?: { publicReaderOrigin: string | null };
  }
}

const nativeEnv = import.meta.env as Record<string, string | undefined>;
const apiOrigin = nativeApiOrigin(nativeEnv);
const publicReaderOrigin = nativeReaderOrigin(nativeEnv);
const oauthConfig = nativeOAuthConfig(nativeEnv);
const nativeAuthClient = oauthConfig ? createNativeAuth(oauthConfig) : null;
const nativeApiTransport = apiOrigin ? createNativeApiTransport(apiOrigin) : null;

window.__CODEXIA_NATIVE_CONFIG__ = Object.freeze({ publicReaderOrigin });

configureNativeApiSession({
  apiOrigin,
  accessTokenFor: requestUrl => nativeAuthClient?.accessTokenFor(requestUrl) ?? Promise.resolve(null),
  fetchRequest:
    nativeAuthClient?.fetchRequest ??
    nativeApiTransport ??
    (async () => {
      throw new Error('Native HTTPS API origin is not configured.');
    }),
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root');
const theme = loadThemeMode();
applyThemeMode(theme);
installNativeSelectCspCompatibility(document);
const nativeAuth = nativeAuthClient
  ? {
      signIn: async () => {
        await nativeAuthClient.signIn();
      },
      signOut: async () => nativeAuthClient.signOut(),
    }
  : null;
createRoot(root).render(
  <BrowserRouter>
    <PersistenceEntry mode="mobile" nativeAuth={nativeAuth} eagerWorkspace={PersistenceWorkspace} />
  </BrowserRouter>,
);
