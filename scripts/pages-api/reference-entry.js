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
    #scalar-api-reference .scalar-api-reference,
    #scalar-api-reference .dark-mode {
      --scalar-color-3: #a0a0a0;
      --scalar-sidebar-search-color: #a0a0a0;
      --scalar-color-red: #ff7373;
    }
    /* Keep long operation paths and code examples inside the Pages viewport. */
    #scalar-api-reference,
    #scalar-api-reference .references-layout,
    #scalar-api-reference .references-content,
    #scalar-api-reference .scalar-api-reference,
    #scalar-api-reference .t-doc,
    #scalar-api-reference .t-doc__header,
    #scalar-api-reference .t-doc__content {
      min-inline-size: 0;
      max-inline-size: 100%;
    }
    #scalar-api-reference .t-doc__header > header > .flex-1.whitespace-nowrap {
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #scalar-api-reference pre {
      max-inline-size: 100%;
      overflow-x: auto;
    }
  `,
});
