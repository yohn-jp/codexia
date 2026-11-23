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
  customCss: ':root{--scalar-font:ui-sans-serif,system-ui,sans-serif;--scalar-font-code:ui-monospace,monospace}',
});
