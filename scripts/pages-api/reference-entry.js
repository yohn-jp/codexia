import { createApiReference } from '@scalar/api-reference';
import '@scalar/api-reference/style.css';

createApiReference('#scalar-api-reference', {
  url: './codexia.openapi.yaml',
  layout: 'modern',
  showSidebar: true,
  // The development portal uses a fixed dark surface; Scalar owns its internal palette.
  darkMode: true,
  forceDarkModeState: 'dark',
  hideDarkModeToggle: true,
  hideTestRequestButton: true,
  hideClientButton: true,
  documentDownloadType: 'none',
  showDeveloperTools: 'never',
  persistAuth: false,
  showExtensions: true,
  servers: [],
  agent: { disabled: true },
  authentication: { allowedSecuritySchemes: [] },
  // Raise native secondary/danger tokens to AA contrast on Scalar's dark surfaces.
  customCss: `
    #scalar-api-reference .dark-mode {
      --scalar-color-3: #a0a0a0;
      --scalar-color-red: #ff7373;
    }
  `,
});
