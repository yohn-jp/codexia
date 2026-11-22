import type { CoreStore, Project } from "../../packages/core/dist/index.js";

/** Typed subset of the disposable PostgreSQL fixture used by TypeScript module tests. */
export function postgresFixture(
  files?: Record<string, string>,
  title?: string,
): Promise<{
  store: CoreStore;
  project: Project;
  close(): Promise<void>;
}>;
