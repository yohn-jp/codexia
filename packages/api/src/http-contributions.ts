import type { HttpContributionDescriptor, ModuleManifest } from "@codexia/contracts";

export interface FastifyHttpContributionRoute {
  moduleId: string;
  contributionId: string;
  method: HttpContributionDescriptor["methods"][number];
  url: string;
  /** The contribution's relative template, including any path parameters. */
  relativePath: string;
  access: HttpContributionDescriptor["access"];
  effect: HttpContributionDescriptor["effect"];
}

const METHODS = new Set(["GET", "HEAD", "POST", "DELETE"]);
const ID = /^[A-Za-z0-9._:-]{1,128}$/u;

function assertDescriptor(moduleId: string, descriptor: HttpContributionDescriptor): void {
  if (!descriptor || typeof descriptor !== "object" || !ID.test(descriptor.id) ||
      typeof descriptor.path !== "string" || descriptor.path.length === 0 || descriptor.path.length > 512 ||
      descriptor.path.startsWith("/") || /[\\\x00-\x20?#%]/u.test(descriptor.path) ||
      descriptor.path.split("/").some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._:-]+$/u.test(part)) ||
      !Array.isArray(descriptor.methods) || descriptor.methods.length === 0 ||
      descriptor.methods.some((method) => !METHODS.has(method)) || new Set(descriptor.methods).size !== descriptor.methods.length ||
      !["owner", "public"].includes(descriptor.access) || !["read", "compute", "propose"].includes(descriptor.effect) ||
      (descriptor.access === "public" && descriptor.effect !== "read") ||
      (descriptor.effect === "compute" && descriptor.methods.some((method) => method === "GET" || method === "HEAD"))) {
    throw new Error(`Invalid HTTP contribution descriptor in manifest for ${moduleId}`);
  }
}

/** Derive host-owned Fastify registrations from trusted, generated module manifests. */
export function deriveModuleHttpRoutes(
  manifests: readonly Pick<ModuleManifest, "id" | "http">[],
): FastifyHttpContributionRoute[] {
  const routes: FastifyHttpContributionRoute[] = [];
  const ids = new Set<string>();
  const registrations = new Set<string>();
  for (const manifest of manifests) {
    for (const descriptor of manifest.http ?? []) {
      assertDescriptor(manifest.id, descriptor);
      const key = `${manifest.id}:${descriptor.id}`;
      if (ids.has(key)) throw new Error(`Duplicate HTTP contribution ${key}`);
      ids.add(key);
      const url = `${descriptor.access === "owner" ? "/api/projects" : "/api/public/projects"}/:projectId/modules/${manifest.id}/${descriptor.path}`;
      const routeShape = url.split("/").map((part) => part.startsWith(":") ? ":PARAM" : part).join("/");
      for (const method of descriptor.methods) {
        const registration = `${method} ${routeShape}`;
        if (registrations.has(registration)) throw new Error(`Duplicate Fastify HTTP contribution route ${registration}`);
        registrations.add(registration);
        routes.push({ moduleId: manifest.id, contributionId: descriptor.id, method, url, relativePath: descriptor.path,
          access: descriptor.access, effect: descriptor.effect });
      }
    }
  }
  return routes;
}
