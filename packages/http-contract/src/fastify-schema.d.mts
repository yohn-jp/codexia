export type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT" | "TRACE";

export interface FastifyContractRoute {
  method: HttpMethod;
  url: string;
  operationId: string;
  contractStatus: "complete" | "incomplete" | "target" | "external";
  requestContentTypes: string[];
  contentTypes: Record<string, string[]>;
  schema: Record<string, unknown>;
}

export interface FastifyContractComponent {
  $id: string;
  [keyword: string]: unknown;
}

export interface OpenApiContractOptions {
  requiredOperations?: string[];
}

export function assertOpenApiContract(
  openapi: unknown,
  options?: OpenApiContractOptions,
): Array<{ method: HttpMethod; path: string; operation: Record<string, unknown> }>;

export function toFastifyRoutes(
  openapi: unknown,
  options?: OpenApiContractOptions,
): { schemas: FastifyContractComponent[]; routes: FastifyContractRoute[] };
