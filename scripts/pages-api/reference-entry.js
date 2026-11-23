import { createApiReference } from '@scalar/api-reference';
import '@scalar/api-reference/style.css';

createApiReference('#scalar-api-reference', {
  url: './codexia.openapi.yaml',
  layout: 'modern',
  showSidebar: true,
  hideTestRequestButton: true,
  hideClientButton: true,
  showDeveloperTools: 'never',
  persistAuth: false,
  showExtensions: true,
  servers: [],
  agent: { disabled: true },
  authentication: { allowedSecuritySchemes: [] },
  customCss: `
    :root {
      --scalar-font: ui-sans-serif, system-ui, sans-serif;
      --scalar-font-code: ui-monospace, monospace;
    }
    /* Scalar's documentation layout must shrink inside the Pages viewport.
       Keep long examples horizontally scrollable within their own panels. */
    #scalar-api-reference {
      display: block;
      inline-size: 100%;
      min-inline-size: 0;
      max-inline-size: 100%;
    }
    #scalar-api-reference .references-layout,
    #scalar-api-reference .references-content,
    #scalar-api-reference .t-doc,
    #scalar-api-reference .t-doc__header,
    #scalar-api-reference .t-doc__content,
    #scalar-api-reference .scalar-api-reference {
      min-inline-size: 0;
      max-inline-size: 100%;
    }
    #scalar-api-reference .t-doc__header > header {
      min-inline-size: 0;
      max-inline-size: 100%;
    }
    #scalar-api-reference pre,
    #scalar-api-reference .scalar-code-block {
      max-inline-size: 100%;
      overflow-x: auto;
    }
    /* Keep the sticky mobile endpoint label within the Pages container. */
    #scalar-api-reference .t-doc__header > header > .flex-1.whitespace-nowrap {
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `,
});
