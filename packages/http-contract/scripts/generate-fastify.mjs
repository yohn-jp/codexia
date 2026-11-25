import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { toFastifyRoutes } from "../src/fastify-schema.mjs";

const openapi = new URL("../openapi/codexia.openapi.yaml", import.meta.url);
const output = new URL("../../api/src/generated/http-contract.json", import.meta.url);
const { schemas, routes } = toFastifyRoutes(parse(readFileSync(openapi, "utf8")));
const lines = (items) => items.map((item) => `    ${JSON.stringify(item)}`).join(",\n");
const generated = `{\n  "schemas": [\n${lines(schemas)}\n  ],\n  "routes": [\n${lines(routes)}\n  ]\n}\n`;

if (process.argv.includes("--check")) {
  assert.equal(readFileSync(output, "utf8"), generated, "Fastify contract artifact differs from OpenAPI; run pnpm --filter @codexia/http-contract generate");
} else {
  writeFileSync(output, generated);
}
