const HTTP_METHODS = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace']);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function operationsOf(openapi) {
  const operations = [];
  for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
    if (!isRecord(pathItem)) fail(`OpenAPI path ${path} is not an object`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!isRecord(operation)) fail(`OpenAPI operation ${method.toUpperCase()} ${path} is not an object`);
      operations.push({ method: method.toUpperCase(), path, operation });
    }
  }
  return operations;
}

/** Validate source-of-truth metadata before generating any runtime-facing schemas. */
export function assertOpenApiContract(openapi, { requiredOperations = [] } = {}) {
  if (!isRecord(openapi) || openapi.openapi !== '3.1.0') fail('HTTP contract must be OpenAPI 3.1.0');
  if (!isRecord(openapi.info) || typeof openapi.info.version !== 'string') fail('HTTP contract is missing its version identity');
  if (!isRecord(openapi.paths)) fail('HTTP contract has no paths map');

  const operations = operationsOf(openapi);
  const ids = new Set();
  const routeKeys = new Set();
  const components = openapi.components?.schemas ?? {};
  if (!isRecord(components)) fail('OpenAPI components.schemas must be an object');
  const securitySchemes = openapi.components?.securitySchemes ?? {};
  if (!isRecord(securitySchemes)) fail('OpenAPI components.securitySchemes must be an object');
  for (const [name, scheme] of Object.entries(securitySchemes)) {
    if (!isRecord(scheme)) fail(`invalid security scheme ${name}`);
    if (scheme.type === 'apiKey') {
      if (!['header', 'query', 'cookie'].includes(scheme.in) || typeof scheme.name !== 'string' || !scheme.name.trim()) {
        fail(`invalid apiKey security scheme ${name}`);
      }
    } else if (scheme.type === 'http') {
      if (typeof scheme.scheme !== 'string' || !scheme.scheme.trim()) fail(`invalid HTTP security scheme ${name}`);
    } else if (scheme.type === 'oauth2') {
      if (!isRecord(scheme.flows)) fail(`invalid OAuth2 security scheme ${name}`);
    } else if (scheme.type === 'openIdConnect') {
      if (typeof scheme.openIdConnectUrl !== 'string' || !scheme.openIdConnectUrl.trim())
        fail(`invalid OpenID Connect security scheme ${name}`);
    } else if (scheme.type !== 'mutualTLS') {
      fail(`unsupported security scheme type on ${name}`);
    }
  }
  const componentNames = new Set(Object.keys(components));
  for (const [name, schema] of Object.entries(components)) mapSchema(schema, `components.schemas.${name}`, componentNames);
  for (const { method, path, operation } of operations) {
    const routeKey = `${method} ${path}`;
    if (routeKeys.has(routeKey)) fail(`duplicate method/path operation ${routeKey}`);
    routeKeys.add(routeKey);
    if (typeof operation.operationId !== 'string' || !operation.operationId.trim()) {
      fail(`missing operationId on ${method} ${path}`);
    }
    if (ids.has(operation.operationId)) fail(`duplicate operationId ${operation.operationId}`);
    ids.add(operation.operationId);
    if (!isRecord(operation.responses) || Object.keys(operation.responses).length === 0) {
      fail(`missing responses on ${method} ${path}`);
    }
    const pathLevelParameters = openapi.paths[path].parameters ?? [];
    const operationParameters = operation.parameters ?? [];
    if (!Array.isArray(pathLevelParameters) || !Array.isArray(operationParameters)) fail(`invalid parameters on ${method} ${path}`);
    const parameters = [...pathLevelParameters, ...operationParameters];
    const parameterKeys = new Set();
    for (const parameter of parameters) {
      if (!isRecord(parameter) || typeof parameter.name !== 'string' || !['path', 'query', 'header', 'cookie'].includes(parameter.in)) {
        fail(`invalid parameter on ${method} ${path}`);
      }
      const key = `${parameter.in}:${parameter.name.toLowerCase()}`;
      if (parameterKeys.has(key)) fail(`duplicate parameter ${parameter.name} (${parameter.in}) on ${method} ${path}`);
      parameterKeys.add(key);
      if (parameter.in === 'path' && parameter.required !== true)
        fail(`path parameter ${parameter.name} must be required on ${method} ${path}`);
      if (parameter.content !== undefined) fail(`parameter content cannot be translated by Fastify route schemas on ${method} ${path}`);
      if (parameter.schema === undefined) fail(`parameter ${parameter.name} is missing a supported schema on ${method} ${path}`);
      mapSchema(parameter.schema, `${method} ${path}.parameters.${parameter.name}`, componentNames);
    }
    const pathParameters = new Set(parameters.filter(({ in: location }) => location === 'path').map(({ name }) => name));
    for (const [, parameter] of [...path.matchAll(/\{([^{}]+)\}/gu)]) {
      if (!pathParameters.has(parameter)) fail(`missing path parameter ${parameter} on ${method} ${path}`);
    }
    for (const [statusCode, response] of Object.entries(operation.responses)) {
      if (!isRecord(response) || typeof response.description !== 'string')
        fail(`response ${statusCode} is missing description on ${method} ${path}`);
      for (const [mediaType, media] of Object.entries(response.content ?? {})) {
        if (!isRecord(media) || !('schema' in media)) fail(`response ${statusCode} ${mediaType} is missing schema on ${method} ${path}`);
        mapSchema(media.schema, `${method} ${path}.responses.${statusCode}.${mediaType}`, componentNames);
      }
      for (const [headerName, header] of Object.entries(response.headers ?? {})) {
        if (!isRecord(header)) fail(`invalid response header ${headerName} on ${method} ${path}`);
        if (header.content !== undefined)
          fail(`response header content cannot be translated by Fastify route schemas on ${method} ${path}`);
        if (header.schema === undefined) fail(`response header ${headerName} is missing a supported schema on ${method} ${path}`);
        mapSchema(header.schema, `${method} ${path}.responses.${statusCode}.headers.${headerName}`, componentNames);
      }
    }
    if (operation.requestBody !== undefined) {
      const body = operation.requestBody;
      if (!isRecord(body) || !isRecord(body.content) || Object.keys(body.content).length === 0)
        fail(`invalid requestBody on ${method} ${path}`);
      for (const [mediaType, media] of Object.entries(body.content)) {
        if (!isRecord(media) || !('schema' in media)) fail(`requestBody ${mediaType} is missing schema on ${method} ${path}`);
        mapSchema(media.schema, `${method} ${path}.requestBody.${mediaType}`, componentNames);
      }
    }
    const security = operation.security ?? openapi.security;
    if (security !== undefined) {
      if (!Array.isArray(security) || security.some(requirement => !isRecord(requirement)))
        fail(`invalid security requirements on ${method} ${path}`);
      for (const requirement of security) {
        for (const [scheme, scopes] of Object.entries(requirement)) {
          if (!Object.hasOwn(securitySchemes, scheme) || !Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')) {
            fail(`invalid security scheme ${scheme} on ${method} ${path}`);
          }
        }
      }
    }
    const status = operation['x-codexia-contract-status'] ?? openapi['x-codexia-contract-status'];
    if (!['complete', 'incomplete', 'target', 'external'].includes(status)) {
      fail(`missing or invalid x-codexia-contract-status on ${method} ${path}`);
    }
  }

  const available = new Set(operations.map(({ method, path }) => `${method} ${path}`));
  for (const required of requiredOperations) {
    if (!available.has(required)) fail(`missing required operation ${required}`);
  }
  return operations;
}

function fastifyPath(openApiPath) {
  return openApiPath.replace(/\{([^{}]+)\}/gu, (_match, name) => `:${name}`);
}

function collisionKey(method, path) {
  return `${method} ${path.replace(/:[^/]+/gu, ':')}`;
}

function componentRef(name) {
  return `urn:codexia:http-contract:${encodeURIComponent(name)}`;
}

const COMPOSITION_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'not', '$ref']);

function isClosedSchemaMarker(value) {
  return value === false || (isRecord(value) && isRecord(value.not) && Object.keys(value.not).length === 0);
}

function mapSchema(value, location, componentNames) {
  // The open export handler sends an already completed binary stream with a
  // verified length. Its media type is an OpenAPI annotation for consumers.
  if (
    location === 'GET /api/v1/persistence/projects/{projectId}/open-export.responses.200.application/zip' &&
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    value.contentMediaType === 'application/zip'
  )
    return {};
  if (typeof value === 'boolean') return value;
  if (!isRecord(value)) fail(`invalid JSON Schema at ${location}`);
  const validTypes = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (
      types.length === 0 ||
      types.some(type => typeof type !== 'string' || !validTypes.has(type)) ||
      new Set(types).size !== types.length
    ) {
      fail(`invalid JSON Schema type at ${location}`);
    }
  }
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) ||
      value.required.some(name => typeof name !== 'string') ||
      new Set(value.required).size !== value.required.length)
  ) {
    fail(`invalid JSON Schema required list at ${location}`);
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) fail(`invalid JSON Schema enum at ${location}`);
  if (value.format !== undefined && typeof value.format !== 'string') fail(`invalid JSON Schema format at ${location}`);
  if ('$ref' in value && typeof value.$ref !== 'string') fail(`invalid JSON Schema reference at ${location}`);
  if (typeof value.$ref === 'string') {
    const match = /^#\/components\/schemas\/([^/]+)$/u.exec(value.$ref);
    if (!match) fail(`unsupported OpenAPI reference ${value.$ref} at ${location}`);
    const name = decodeURIComponent(match[1]);
    if (!componentNames.has(name)) fail(`unresolved OpenAPI schema reference ${value.$ref} at ${location}`);
    const remainder = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref'));
    if (Object.keys(remainder).length) fail(`OpenAPI reference siblings are not supported at ${location}`);
    return { $ref: componentRef(name) };
  }
  if ('discriminator' in value)
    fail(`OpenAPI discriminator cannot be translated to Fastify/Ajv without changing schema semantics at ${location}`);
  if ('unevaluatedProperties' in value) {
    const hasComposition = [...COMPOSITION_KEYS].some(key => key in value);
    if (!isClosedSchemaMarker(value.unevaluatedProperties) || hasComposition) {
      fail(`unevaluatedProperties cannot be translated without changing schema semantics at ${location}`);
    }
  }
  if ('nullable' in value && typeof value.nullable === 'boolean') {
    const { nullable, ...schema } = value;
    if (!nullable) return mapSchema(schema, location, componentNames);
    return { anyOf: [mapSchema(schema, location, componentNames), { type: 'null' }] };
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'unevaluatedProperties') {
      output.additionalProperties = false;
    } else if (key === '$schema') {
      if (item !== 'https://json-schema.org/draft/2020-12/schema' && item !== 'https://json-schema.org/draft/2019-09/schema') {
        fail(`unsupported JSON Schema dialect at ${location}`);
      }
      // Fastify/Ajv uses its registered draft-07 schema dialect.
    } else if (['properties', 'patternProperties', '$defs', 'definitions'].includes(key)) {
      const mapped = {};
      for (const [childKey, child] of Object.entries(item ?? {}))
        mapped[childKey] = mapSchema(child, `${location}.${key}.${childKey}`, componentNames);
      output[key === '$defs' ? 'definitions' : key] = mapped;
    } else if (key === 'items' || key === 'additionalProperties' || key === 'not') {
      output[key] = mapSchema(item, `${location}.${key}`, componentNames);
    } else if (['allOf', 'anyOf', 'oneOf'].includes(key)) {
      if (!Array.isArray(item)) fail(`invalid ${key} at ${location}`);
      output[key] = item.map((child, index) => mapSchema(child, `${location}.${key}[${index}]`, componentNames));
    } else if (key === 'nullable') {
      // Handled above.
    } else if (key === 'contentMediaType' || key === 'contentEncoding') {
      fail(`OpenAPI 3.1 ${key} cannot be enforced by Fastify/Ajv at ${location}`);
    } else if (key.startsWith('x-')) {
      // Vendor extensions describe the contract but are not Ajv validation keywords.
    } else {
      output[key] = item;
    }
  }
  return output;
}

function objectParameters(parameters, location, componentNames) {
  const properties = {};
  const required = [];
  for (const parameter of parameters) {
    const name = location.endsWith('.headers') ? parameter.name.toLowerCase() : parameter.name;
    properties[name] = mapSchema(parameter.schema ?? {}, `${location}.${parameter.name}`, componentNames);
    if (parameter.required) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    ...(location.endsWith('.headers') ? {} : { additionalProperties: false }),
  };
}

function contentSchemas(contents, location, componentNames) {
  const schemas = {};
  for (const [contentType, entry] of Object.entries(contents ?? {})) {
    if (!isRecord(entry) || !('schema' in entry)) continue;
    schemas[contentType] = mapSchema(entry.schema, `${location}.${contentType}`, componentNames);
  }
  return schemas;
}

function fastifyContentSchema(schemas, location) {
  const entries = Object.entries(schemas);
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0][1];
  for (const [mediaType] of entries) {
    if (!/^[a-z0-9][a-z0-9!#$%&'+.^_`|~-]*\/[a-z0-9][a-z0-9!#$%&'+.^_`|~-]*$/u.test(mediaType)) {
      fail(`Fastify media-type dispatch requires a canonical concrete content type at ${location}: ${mediaType}`);
    }
  }
  return {
    content: Object.fromEntries(entries.map(([mediaType, schema]) => [mediaType, { schema }])),
  };
}

/** Convert OpenAPI 3.1 to Fastify's Ajv/response-schema dialect. */
export function toFastifyRoutes(openapi, options = {}) {
  const operations = assertOpenApiContract(openapi, options);
  const components = openapi.components?.schemas ?? {};
  const componentNames = new Set(Object.keys(components));
  const schemas = Object.entries(components).map(([name, schema]) => ({
    $id: componentRef(name),
    ...mapSchema(schema, `components.schemas.${name}`, componentNames),
  }));
  const routeKeys = new Map();
  const routes = operations.map(({ method, path, operation }) => {
    const url = fastifyPath(path);
    const key = collisionKey(method, url);
    const prior = routeKeys.get(key);
    if (prior) fail(`Fastify route collision between ${prior.method} ${prior.path} and ${method} ${path}`);
    routeKeys.set(key, { method, path });

    const parameters = [...(openapi.paths[path].parameters ?? []), ...(operation.parameters ?? [])];
    const schema = {};
    const pathParameters = parameters.filter(({ in: location }) => location === 'path');
    const queryParameters = parameters.filter(({ in: location }) => location === 'query');
    const headerParameters = parameters.filter(({ in: location }) => location === 'header');
    if (pathParameters.length) schema.params = objectParameters(pathParameters, `${method} ${path}.params`, componentNames);
    if (queryParameters.length) schema.querystring = objectParameters(queryParameters, `${method} ${path}.query`, componentNames);
    if (headerParameters.length) schema.headers = objectParameters(headerParameters, `${method} ${path}.headers`, componentNames);

    const requestContentTypes = Object.keys(operation.requestBody?.content ?? {});
    const requestBodySchemas = contentSchemas(operation.requestBody?.content, `${method} ${path}.requestBody`, componentNames);
    // Fastify skips body validation for parsed media types absent from a content map.
    if (requestContentTypes.length > 1) {
      fail(`${method} ${path}: multiple request media types require explicit content-type admission`);
    }
    const [bodySchema] = Object.values(requestBodySchemas);
    if (bodySchema !== undefined) schema.body = bodySchema;

    const responseContentTypes = {};
    const responseHeaders = {};
    if (operation.responses) {
      schema.response = {};
      for (const [status, response] of Object.entries(operation.responses)) {
        const types = Object.keys(response?.content ?? {});
        responseContentTypes[status] = types;
        responseHeaders[status] = Object.fromEntries(
          Object.entries(response?.headers ?? {}).map(([name, header]) => [
            name.toLowerCase(),
            {
              required: Boolean(header.required),
              schema: mapSchema(header.schema ?? {}, `${method} ${path}.responses.${status}.headers.${name}`, componentNames),
            },
          ]),
        );
        const responseSchemas = contentSchemas(response?.content, `${method} ${path}.responses.${status}`, componentNames);
        const responseSchema = fastifyContentSchema(responseSchemas, `${method} ${path}.responses.${status}`);
        if (responseSchema !== undefined) schema.response[status] = responseSchema;
      }
    }
    return {
      method,
      url,
      operationId: operation.operationId,
      contractStatus: operation['x-codexia-contract-status'] ?? openapi['x-codexia-contract-status'],
      requestContentTypes,
      contentTypes: responseContentTypes,
      responseHeaders,
      schema,
    };
  });
  return { schemas, routes };
}
