import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { defineConfig, type Plugin } from 'vite';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = resolve(appRoot, '..');
const profile = process.env.CODEXIA_PROFILE ?? 'core';
if (!/^[a-z][a-z0-9-]{0,31}$/u.test(profile)) {
  throw new Error('CODEXIA_PROFILE must be a valid profile name');
}
const browserModuleProfilePath = process.env.CODEXIA_BROWSER_MODULE_PROFILE_PATH;
const generatedBrowserModules = browserModuleProfilePath
  ? resolve(browserModuleProfilePath)
  : resolve(workspaceRoot, 'profiles', profile, 'generated', 'browser.mjs');

const ui = process.env.CODEXIA_UI ?? 'launcher';
if (!['launcher', 'desktop', 'mobile', 'oauth', 'owner-setup'].includes(ui)) throw new Error('Invalid CODEXIA_UI');
const uiDirectory = ui === 'launcher' ? '' : ui === 'owner-setup' ? 'console/setup' : ui;

// OAuth browser fixture assets must not overwrite app/dist while other shards
// serve the canonical non-OAuth shells from the same CI checkout.
const isolatedBuildRoot = process.env.CODEXIA_VITE_BUILD_OUTPUT_ROOT;
if (isolatedBuildRoot && !isAbsolute(isolatedBuildRoot)) {
  throw new Error('CODEXIA_VITE_BUILD_OUTPUT_ROOT must be an absolute directory');
}
const buildRoot = isolatedBuildRoot ?? resolve(appRoot, 'dist');
const oauthSourceFiles = new Set(
  [
    'OAuthConsentPage.tsx',
    'OAuthLoginPage.tsx',
    'auth-client.ts',
    'oauth-consent.ts',
    'oauth-login.ts',
    'oauth.css.ts',
    'oauth.css.ts.vanilla.css',
    'theme.ts',
    'oauth-theme.css.ts',
    'oauth-theme.css.ts.vanilla.css',
    'theme-tokens.ts',
    'entries/oauth-consent.tsx',
    'entries/oauth-login.tsx',
  ].map(file => resolve(appRoot, 'src', file)),
);

function oauthSourceBoundary(): Plugin {
  const sourceRoot = resolve(appRoot, 'src');
  return {
    name: 'codexia-oauth-source-boundary',
    apply: 'build',
    generateBundle(_options, bundle) {
      const unexpected = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) {
          const path = resolve(id.split('?', 1)[0] ?? id);
          if (path.startsWith(`${sourceRoot}${sep}`) && !oauthSourceFiles.has(path)) {
            unexpected.add(relative(appRoot, path));
          }
        }
      }
      if (unexpected.size) {
        throw new Error(`OAuth entry imports non-OAuth application modules: ${[...unexpected].sort().join(', ')}`);
      }
    },
  };
}

export default defineConfig({
  root: appRoot,
  publicDir: ui === 'oauth' || ui === 'owner-setup' ? false : resolve(appRoot, 'public'),
  plugins: [
    vanillaExtractPlugin(),
    react(),
    {
      name: 'codexia-ui-entry',
      transformIndexHtml: {
        order: 'pre',
        handler: (html: string) => (ui === 'launcher' ? html : html.replace('/src/launcher.tsx', `/src/entries/${ui}.tsx`)),
      },
    },
    ...(ui === 'oauth' ? [oauthSourceBoundary()] : []),
  ],
  base: uiDirectory ? `/${uiDirectory}/` : '/',
  resolve: {
    alias: [
      {
        find: /^(?:\.\/|\.\.\/)+generated\/browser-modules$/u,
        replacement: generatedBrowserModules,
      },
    ],
  },
  build: {
    outDir: resolve(buildRoot, uiDirectory),
    emptyOutDir: true,
    manifest: true,
    cssCodeSplit: false,
    rollupOptions: {
      input:
        ui === 'owner-setup'
          ? resolve(appRoot, 'owner-setup.html')
          : ui === 'oauth'
            ? {
                login: resolve(appRoot, 'oauth-login.html'),
                consent: resolve(appRoot, 'oauth-consent.html'),
              }
            : resolve(appRoot, 'index.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: asset => (asset.name?.endsWith('.css') ? 'assets/styles-[hash][extname]' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
});
