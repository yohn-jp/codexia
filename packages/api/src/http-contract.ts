import AjvCompiler from "@fastify/ajv-compiler";
import type { FastifySchema, FastifyServerOptions, HTTPMethods } from "fastify";
import generated from "./generated/http-contract.json" with { type: "json" };

interface ContractRoute {
  method: HTTPMethods;
  url: string;
  operationId: string;
  contractStatus: "complete" | "incomplete" | "target" | "external";
  requestContentTypes: string[];
  contentTypes: Record<string, string[]>;
  schema: FastifySchema;
}

export const httpContract = generated as unknown as {
  schemas: { $id: string; [key: string]: unknown }[];
  routes: ContractRoute[];
};

// HTTP query values arrive as strings. JSON payloads retain the types the caller sent.
export const httpContractSchemaController: FastifyServerOptions["schemaController"] = {
  compilersFactory: {
    buildValidator(externalSchemas) {
      const build = AjvCompiler();
      const options = { removeAdditional: false, useDefaults: false };
      const validateWire = build(externalSchemas, { customOptions: { ...options, coerceTypes: false } });
      const validateQuery = build(externalSchemas, { customOptions: { ...options, coerceTypes: true } });
      return (route) => (route.httpPart === "querystring" ? validateQuery : validateWire)(route);
    },
  },
};
