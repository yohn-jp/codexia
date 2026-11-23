import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifySchema } from "fastify";
import { parse } from "yaml";
import { test } from "node:test";
import { toFastifyRoutes } from "../src/fastify-schema.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openapi = parse(readFileSync(path.join(packageRoot, "openapi", "codexia.openapi.yaml"), "utf8"));
const { routes, schemas } = toFastifyRoutes(openapi);

test("generated Fastify schemas validate project creation and preserve actual persistence errors and headers", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  for (const schema of schemas) app.addSchema(schema);

  let createHandlerCalls = 0;
  const createProject = routes.find(({ method, url }) => method === "POST" && url === "/api/v1/persistence/projects");
  const persistenceStatus = routes.find(({ method, url }) => method === "GET" && url === "/api/v1/persistence/status");
  const importRoute = routes.find(({ method, url }) => method === "POST" && url === "/api/v1/persistence/import");
  assert.ok(createProject);
  assert.ok(persistenceStatus);
  assert.ok(importRoute);

  // Register all routes before the first inject; Fastify freezes route setup
  // once the instance starts processing requests.
  app.route({
    method: createProject.method,
    url: createProject.url,
    schema: createProject.schema as FastifySchema,
    handler: async (_request, reply) => {
      createHandlerCalls++;
      return reply.code(201).send({ project: {
        id: "project-1",
        title: "A title",
        settings: {},
        version: 1,
        createdAt: "2026-11-23T00:00:00Z",
        updatedAt: "2026-11-23T00:00:00Z",
      } });
    },
  });
  app.route({
    method: persistenceStatus.method,
    url: persistenceStatus.url,
    schema: persistenceStatus.schema as FastifySchema,
    handler: async (_request, reply) => reply.code(503).send({
      error: "PostgreSQL persistence is not ready",
      code: "PERSISTENCE_UNAVAILABLE",
    }),
  });
  app.route({
    method: importRoute.method,
    url: importRoute.url,
    schema: importRoute.schema as FastifySchema,
    handler: async (request, reply) => reply.code(201).send({
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      idempotencyKey: request.headers["idempotency-key"],
    }),
  });

  const missingTitle = await app.inject({ method: "POST", url: "/api/v1/persistence/projects", payload: {} });
  assert.equal(missingTitle.statusCode, 400);
  assert.equal(createHandlerCalls, 0, "the generated schema must reject a missing title before dispatch");
  for (const title of ["   ", "x".repeat(257)]) {
    const invalidTitle = await app.inject({ method: "POST", url: "/api/v1/persistence/projects", payload: { title } });
    assert.equal(invalidTitle.statusCode, 400, invalidTitle.payload);
    assert.equal(createHandlerCalls, 0, "the generated schema must reject titles outside the runtime constraints");
  }

  const validProject = await app.inject({
    method: "POST",
    url: "/api/v1/persistence/projects",
    payload: { title: "A title" },
  });
  assert.equal(validProject.statusCode, 201, validProject.payload);
  assert.equal(validProject.json().project.title, "A title");

  const unavailable = await app.inject({ method: "GET", url: "/api/v1/persistence/status" });
  assert.equal(unavailable.statusCode, 503, unavailable.payload);
  assert.deepEqual(unavailable.json(), {
    error: "PostgreSQL persistence is not ready",
    code: "PERSISTENCE_UNAVAILABLE",
  });

  const imported = await app.inject({
    method: "POST",
    url: "/api/v1/persistence/import",
    headers: {
      authorization: "Bearer owner-token",
      "idempotency-key": "import-1",
      "content-type": "application/json",
    },
    payload: {},
  });
  assert.equal(imported.statusCode, 201, imported.payload);
  assert.deepEqual(imported.json(), {
    authorization: "Bearer owner-token",
    contentType: "application/json",
    idempotencyKey: "import-1",
  });
});
