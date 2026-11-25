const DESKTOP_SCHEMA_EXTENSION = 'x-codexia-desktop-response-schema';

/** Apply typed actual-response schemas to Orval's in-memory view only. */
export default function transformDesktopResponses(document) {
  const projected = structuredClone(document);
  for (const [route, pathItem] of Object.entries(projected.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!operation || typeof operation !== 'object') continue;
      const reference = operation[DESKTOP_SCHEMA_EXTENSION];
      if (reference === undefined) continue;
      if (operation['x-codexia-contract-status'] !== 'incomplete') {
        throw new TypeError(`${DESKTOP_SCHEMA_EXTENSION} on ${method.toUpperCase()} ${route} is allowed only for an incomplete operation`);
      }
      if (typeof reference !== 'string' || !reference.startsWith('#/components/schemas/')) {
        throw new TypeError(`${DESKTOP_SCHEMA_EXTENSION} on ${method.toUpperCase()} ${route} must reference a TypeSpec schema component`);
      }
      const schemaName = reference.slice('#/components/schemas/'.length);
      if (!projected.components?.schemas?.[schemaName]) {
        throw new TypeError(`${DESKTOP_SCHEMA_EXTENSION} on ${method.toUpperCase()} ${route} refers to missing schema ${schemaName}`);
      }
      const content = operation.responses?.['200']?.content?.['application/json'];
      if (!content)
        throw new TypeError(`${DESKTOP_SCHEMA_EXTENSION} on ${method.toUpperCase()} ${route} requires an application/json 200 response`);
      content.schema = { $ref: reference };
    }
  }
  return projected;
}
