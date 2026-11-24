import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These are the operations currently integrated with the Desktop client.
// Keep provisional and incomplete operations behind their existing API guards.
export const operationIds = ['persistence_document_anchors_post', 'persistence_documents_get', 'persistence_status_get'];

export function httpClientConfig(input, outputDirectory) {
  return {
    input: {
      target: input,
      filters: { operationIds },
    },
    output: {
      client: 'fetch',
      urlEncodeParameters: true,
      target: path.join(outputDirectory, 'client.ts'),
      schemas: { type: 'zod', path: path.join(outputDirectory, 'schemas') },
      operationManifest: { types: false },
      override: {
        mutator: {
          path: fileURLToPath(new URL('./src/generated-http-fetch.ts', import.meta.url)),
          name: 'generatedHttpFetch',
        },
        fetch: { includeHttpResponseReturnType: false, runtimeValidation: true },
        includeSchemaInArguments: true,
        zod: { version: 4 },
      },
    },
  };
}
