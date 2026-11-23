const HTTP_METHODS = new Set(["get", "head", "post", "put", "patch", "delete", "options", "trace"]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (!isRecord(openapi) || openapi.openapi !== "3.1.0") fail("HTTP contract must be OpenAPI 3.1.0");
  if (!isRecord(openapi.info) || typeof openapi.info.version !== "string") fail("HTTP contract is missing its version identity");
  if (!isRecord(openapi.paths)) fail("HTTP contract has no paths map");

  const operations = operationsOf(openapi);
  const ids = new Set();
  for (const { method, path, operation } of operations) {
    if (typeof operation.operationId !== "string" || !operation.operationId.trim()) {
      fail(`missing operationId on ${method} ${path}`);
    }
    if (ids.has(operation.operationId)) fail(`duplicate operationId ${operation.operationId}`);
    ids.add(operation.operationId);
    if (!isRecord(operation.responses) || Object.keys(operation.responses).length === 0) {
      fail(`missing responses on ${method} ${path}`);
    }
    const status = operation["x-codexia-contract-status"] ?? openapi["x-codexia-contract-status"];
    if (!["complete", "incomplete", "target", "external"].includes(status)) {
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
  return `${method} ${path.replace(/:[^/]+/gu, ":")}`;
}

function componentRef(name) {
  return `urn:codexia:http-contract:${encodeURIComponent(name)}`;
}

const COMPOSITION_KEYS = new Set(["allOf", "anyOf", "oneOf", "not", "$ref"]);

function isClosedSchemaMarker(value) {
  return value === false || (isRecord(value) && isRecord(value.not) && Object.keys(value.not).length === 0);
}

function mapSchema(value, location) {
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) fail(`invalid JSON Schema at ${location}`);
  if (typeof value.$ref === "string") {
    const match = /^#\/components\/schemas\/([^/]+)$/u.exec(value.$ref);
    if (!match) fail(`unsupported OpenAPI reference ${value.$ref} at ${location}`);
    const remainder = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
    if (Object.keys(remainder).length) fail(`OpenAPI reference siblings are not supported at ${location}`);
    return { $ref: componentRef(decodeURIComponent(match[1])) };
  }
  if ("discriminator" in value) fail(`OpenAPI discriminator cannot be translated to Fastify/Ajv without changing schema semantics at ${location}`);
  if ("unevaluatedProperties" in value) {
    const hasComposition = [...COMPOSITION_KEYS].some((key) => key in value);
    if (!isClosedSchemaMarker(value.unevaluatedProperties) || hasComposition) {
      fail(`unevaluatedProperties cannot be translated without changing schema semantics at ${location}`);
    }
  }
  if ("nullable" in value && typeof value.nullable === "boolean") {
    const { nullable, ...schema } = value;
    if (!nullable) return mapSchema(schema, location);
    return { anyOf: [mapSchema(schema, location), { type: "null" }] };
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "unevaluatedProperties") {
      output.additionalProperties = false;
    } else if (key === "$schema") {
      if (item !== "https://json-schema.org/draft/2020-12/schema" && item !== "https://json-schema.org/draft/2019-09/schema") {
        fail(`unsupported JSON Schema dialect at ${location}`);
      }
      // Fastify/Ajv uses its registered draft-07 schema dialect.
    } else if (["properties", "patternProperties", "$defs", "definitions"].includes(key)) {
      const mapped = {};
      for (const [childKey, child] of Object.entries(item ?? {})) mapped[childKey] = mapSchema(child, `${location}.${key}.${childKey}`);
      output[key === "$defs" ? "definitions" : key] = mapped;
    } else if (key === "items" || key === "additionalProperties" || key === "not") {
      output[key] = mapSchema(item, `${location}.${key}`);
    } else if (["allOf", "anyOf", "oneOf"].includes(key)) {
      if (!Array.isArray(item)) fail(`invalid ${key} at ${location}`);
      output[key] = item.map((child, index) => mapSchema(child, `${location}.${key}[${index}]`));
    } else if (key === "nullable") {
      // Handled above.
    } else if (key === "contentMediaType" || key === "contentEncoding") {
      fail(`OpenAPI 3.1 ${key} cannot be enforced by Fastify/Ajv at ${location}`);
    } else if (key.startsWith("x-")) {
      // Vendor extensions describe the contract but are not Ajv validation keywords.
    } else {
      output[key] = item;
    }
  }
  return output;
}

function objectParameters(parameters, location) {
  const properties = {};
  const required = [];
  for (const parameter of parameters) {
    const name = location.endsWith(".headers") ? parameter.name.toLowerCase() : parameter.name;
    properties[name] = mapSchema(parameter.schema ?? {}, `${location}.${parameter.name}`);
    if (parameter.required) required.push(name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function contentSchemas(contents, location) {
  const schemas = {};
  for (const [contentType, entry] of Object.entries(contents ?? {})) {
    if (!isRecord(entry) || !("schema" in entry)) continue;
    schemas[contentType] = mapSchema(entry.schema, `${location}.${contentType}`);
  }
  return schemas;
}

/** Convert OpenAPI 3.1 to Fastify's Ajv/response-schema dialect. */
export function toFastifyRoutes(openapi, options = {}) {
  const operations = assertOpenApiContract(openapi, options);
  const components = openapi.components?.schemas ?? {};
  const schemas = Object.entries(components).map(([name, schema]) => ({
    $id: componentRef(name),
    ...mapSchema(schema, `components.schemas.${name}`),
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
    const pathParameters = parameters.filter(({ in: location }) => location === "path");
    const queryParameters = parameters.filter(({ in: location }) => location === "query");
    const headerParameters = parameters.filter(({ in: location }) => location === "header");
    if (pathParameters.length) schema.params = objectParameters(pathParameters, `${method} ${path}.params`);
    if (queryParameters.length) schema.querystring = objectParameters(queryParameters, `${method} ${path}.query`);
    if (headerParameters.length) schema.headers = objectParameters(headerParameters, `${method} ${path}.headers`);

    const requestContentTypes = Object.keys(operation.requestBody?.content ?? {});
    const requestBodySchemas = contentSchemas(operation.requestBody?.content, `${method} ${path}.requestBody`);
    const requestSchemaEntries = Object.values(requestBodySchemas);
    if (requestSchemaEntries.length === 1) schema.body = requestSchemaEntries[0];
    else if (requestSchemaEntries.length > 1) schema.body = { oneOf: requestSchemaEntries };

    const responseContentTypes = {};
    if (operation.responses) {
      schema.response = {};
      for (const [status, response] of Object.entries(operation.responses)) {
        const types = Object.keys(response?.content ?? {});
        responseContentTypes[status] = types;
        const responseSchemas = contentSchemas(response?.content, `${method} ${path}.responses.${status}`);
        const entries = Object.values(responseSchemas);
        if (entries.length === 1) schema.response[status] = entries[0];
        else if (entries.length > 1) schema.response[status] = { oneOf: entries };
      }
    }
    return {
      method,
      url,
      operationId: operation.operationId,
      contractStatus: operation["x-codexia-contract-status"] ?? openapi["x-codexia-contract-status"],
      requestContentTypes,
      contentTypes: responseContentTypes,
      schema,
    };
  });
  return { schemas, routes };
}
