import { randomUUID } from "node:crypto";
import { createServer as createControlServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentId } from "@codexia/persistence-contracts";
import type { ModuleId, ModuleManifest } from "@codexia/contracts";
import type { ModuleLoader, ModuleRuntimeOptions } from "@codexia/module-runtime";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import { createServer } from "../../packages/api/dist/server.js";
import { CoreStore } from "../../packages/core/dist/index.js";

function requiredSetting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Playwright must provide ${name}`);
  return value;
}

const stateDir = requiredSetting("CODEXIA_E2E_STATE_DIR");
const port = Number.parseInt(process.env.CODEXIA_E2E_PORT ?? "4173", 10);
const authToken = process.env.CODEXIA_E2E_AUTH_TOKEN ?? "";
const databaseUrl = requiredSetting("CODEXIA_E2E_DATABASE_URL");

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("CODEXIA_E2E_PORT must be a valid TCP port");
if (authToken.length < 32) throw new Error("CODEXIA_E2E_AUTH_TOKEN must contain at least 32 characters");

/** Seed only the disposable database explicitly supplied by the browser harness. */
async function createDatabaseFixture(): Promise<void> {
  const persistence = createPostgresPersistence(databaseUrl);
  try {
    await persistence.transaction(async (transaction) => {
      const project = await transaction.createProject({ title: process.env.CODEXIA_E2E_PROJECT_TITLE ?? "Acceptance manuscript" });
      const volume = await transaction.createDocument({ projectId: project.id, documentId: randomUUID() as DocumentId, kind: "volume", title: "Volume One", orderKey: "a", markdown: "", authorId: "owner", idempotencyKey: randomUUID() });
      const chapter = await transaction.createDocument({ projectId: project.id, parentId: volume.document.id, kind: "chapter", title: "Chapter One", orderKey: "a", markdown: "", authorId: "owner", idempotencyKey: randomUUID() });
      await transaction.createDocument({ projectId: project.id, parentId: chapter.document.id, kind: "scene", title: "Scene One", orderKey: "a", markdown: "# Scene One\n\nThe first line of the story.\nBeacon Quay appears in this scene.\n", authorId: "owner", idempotencyKey: randomUUID() });
      await transaction.createDocument({ projectId: project.id, parentId: chapter.document.id, kind: "scene", title: "Scene Two", orderKey: "b", markdown: "# Scene Two\n\nThe second line of the story.\nA submerged brass archive waits below Lantern Harbor.\n", authorId: "owner", idempotencyKey: randomUUID() });
    });
  } finally {
    await persistence.close();
  }
}

async function listen(server: Server, listenPort: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function startTestServer(): Promise<void> {
  await migratePostgresDatabase(databaseUrl);
  if (process.env.CODEXIA_E2E_EXTERNAL_DATABASE !== "1") await createDatabaseFixture();

  const profile = process.env.CODEXIA_PROFILE ?? "core";
  let runtimeOptions: ModuleRuntimeOptions | undefined;
  if (profile !== "core") {
    const generatedPath = resolve("profiles", profile, "generated", "server.mjs");
    const composition = await import(pathToFileURL(generatedPath).href) as {
      profile: string;
      moduleManifests: ModuleManifest[];
      moduleLoaders: Partial<Record<ModuleId, ModuleLoader>>;
      moduleDirectories: ModuleRuntimeOptions["moduleDirectories"];
      moduleWorkerEntries: ModuleRuntimeOptions["workerEntries"];
    };
    if (composition.profile !== profile) throw new Error(`Generated E2E module profile does not match ${profile}`);
    runtimeOptions = {
      manifests: composition.moduleManifests,
      enabled: composition.moduleManifests.map((manifest) => manifest.id),
      loaders: composition.moduleLoaders,
      moduleDirectories: composition.moduleDirectories,
      workerEntries: composition.moduleWorkerEntries,
      cacheDirectory: join(stateDir, "module-cache"),
    };
  }

  const startApi = async (): Promise<Server> => {
    const persistence = createPostgresPersistence(databaseUrl);
    const store = new CoreStore({ persistence });
    const server = createServer({
      store,
      authToken,
      staticDir: resolve("app/dist"),
      usageDirectory: join(stateDir, "host-history"),
      profile,
      persistence, closePersistenceOnShutdown: true,
      ...(runtimeOptions ? { runtimeOptions } : {}),
    });
    await listen(server, port);
    return server;
  };

  let apiServer = await startApi();
  let resetting = false;
  const controlServer = createControlServer((request, response) => {
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST" || (request.url !== "/__e2e/reset-core" && request.url !== "/__e2e/restart-api")) {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    if (resetting) {
      response.writeHead(409).end("Core reset is already in progress");
      return;
    }
    resetting = true;
    void (async () => {
      try {
        await close(apiServer);
        // PostgreSQL revisions remain authoritative across process and cache loss.
        await rm(join(stateDir, "module-cache"), { recursive: true, force: true });
        apiServer = await startApi();
        response.writeHead(204).end();
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          .end(error instanceof Error ? error.message : "Core reset failed");
      } finally {
        resetting = false;
      }
    })();
  });
  const controlPort = port + 1;
  if (!Number.isInteger(controlPort) || controlPort > 65_535) throw new Error("The E2E control port must be valid");
  await listen(controlServer, controlPort);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void close(controlServer);
    void close(apiServer).finally(() => {
      if (process.env.CODEXIA_E2E_TEMP_STATE_DIR === "1") {
        void rm(stateDir, { recursive: true, force: true });
      }
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void startTestServer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Codexia E2E test server failed");
  process.exitCode = 1;
});
