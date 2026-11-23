import assert from "node:assert/strict";
import test from "node:test";
import { assertOpenApiContract, toFastifyRoutes } from "../src/fastify-schema.mjs";

const operation = (overrides = {}) => ({
  operationId: "sample_operation",
  "x-codexia-contract-status": "complete",
  responses: { "200": { description: "ok" } },
  ...overrides,
});

test("OpenAPI validation rejects duplicate method/path pairs, even with method casing differences", () => {
  const contract = {
    openapi: "3.1.0", info: { title: "Duplicate fixture", version: "1.0.0" },
    paths: { "/duplicate": { get: operation(), GET: operation({ operationId: "sample_operation_upper" }) } },
  };
  assert.throws(() => assertOpenApiContract(contract), /duplicate method\/path operation GET \/duplicate/u);
});

test("OpenAPI validation rejects malformed request and component schemas", () => {
  const invalidRequest = {
    openapi: "3.1.0", info: { title: "Invalid request fixture", version: "1.0.0" },
    paths: { "/example": { post: operation({
      requestBody: { content: { "application/json": { schema: { type: "not-a-json-schema-type" } } } },
    }) } },
  };
  assert.throws(() => assertOpenApiContract(invalidRequest), /invalid JSON Schema type/u);

  const invalidComponent = {
    openapi: "3.1.0", info: { title: "Invalid component fixture", version: "1.0.0" },
    paths: { "/example": { get: operation() } },
    components: { schemas: { Invalid: { required: "field" } } },
  };
  assert.throws(() => assertOpenApiContract(invalidComponent), /invalid JSON Schema required list/u);
});

test("OpenAPI validation rejects missing path parameters, duplicate parameters, and invalid response headers", () => {
  const missingPathParameter = {
    openapi: "3.1.0", info: { title: "Missing path parameter", version: "1.0.0" },
    paths: { "/resources/{resourceId}": { get: operation() } },
  };
  assert.throws(() => assertOpenApiContract(missingPathParameter), /missing path parameter resourceId/u);

  const duplicateParameter = {
    openapi: "3.1.0", info: { title: "Duplicate parameter", version: "1.0.0" },
    paths: { "/resources": { get: operation({ parameters: [
      { name: "limit", in: "query", schema: { type: "integer" } },
      { name: "LIMIT", in: "query", schema: { type: "integer" } },
    ] }) } },
  };
  assert.throws(() => assertOpenApiContract(duplicateParameter), /duplicate parameter LIMIT \(query\)/u);

  const invalidHeader = {
    openapi: "3.1.0", info: { title: "Invalid header", version: "1.0.0" },
    paths: { "/resources": { get: operation({ responses: {
      "200": { description: "ok", headers: { "X-Result": { schema: { type: 22 } } } },
    } }) } },
  };
  assert.throws(() => toFastifyRoutes(invalidHeader), /invalid JSON Schema type/u);
});

test("OpenAPI validation rejects parameter and response-header content that Fastify conversion would drop", () => {
  const parameterContent = {
    openapi: "3.1.0", info: { title: "Parameter content fixture", version: "1.0.0" },
    paths: { "/resources": { get: operation({ parameters: [{
      name: "filter", in: "query", content: { "application/json": { schema: { type: "object" } } },
    }] }) } },
  };
  assert.throws(() => toFastifyRoutes(parameterContent), /parameter content cannot be translated/u);

  const responseHeaderContent = {
    openapi: "3.1.0", info: { title: "Response header content fixture", version: "1.0.0" },
    paths: { "/resources": { get: operation({ responses: {
      "200": { description: "ok", headers: {
        "X-Result": { content: { "application/json": { schema: { type: "object" } } } },
      } },
    } }) } },
  };
  assert.throws(() => toFastifyRoutes(responseHeaderContent), /response header content cannot be translated/u);
});

test("OpenAPI validation rejects unresolved security requirements and response schemas", () => {
  const invalidSecurity = {
    openapi: "3.1.0", info: { title: "Invalid security fixture", version: "1.0.0" },
    paths: { "/example": { get: operation({ security: [{ missingBearer: [] }] }) } },
  };
  assert.throws(() => assertOpenApiContract(invalidSecurity), /invalid security scheme missingBearer/u);

  const invalidApiKey = {
    openapi: "3.1.0", info: { title: "Invalid API key fixture", version: "1.0.0" },
    paths: { "/example": { get: operation() } },
    components: { securitySchemes: { CookieAuth: { type: "apiKey", in: "cookie" } } },
  };
  assert.throws(() => assertOpenApiContract(invalidApiKey), /invalid apiKey security scheme CookieAuth/u);

  const invalidHttpScheme = {
    openapi: "3.1.0", info: { title: "Invalid HTTP security fixture", version: "1.0.0" },
    paths: { "/example": { get: operation() } },
    components: { securitySchemes: { BearerAuth: { type: "http" } } },
  };
  assert.throws(() => assertOpenApiContract(invalidHttpScheme), /invalid HTTP security scheme BearerAuth/u);

  const invalidResponse = {
    openapi: "3.1.0", info: { title: "Invalid response fixture", version: "1.0.0" },
    paths: { "/example": { get: operation({ responses: {
      "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } },
    } }) } },
    components: { schemas: {} },
  };
  assert.throws(() => assertOpenApiContract(invalidResponse), /unresolved OpenAPI schema reference/u);
});
