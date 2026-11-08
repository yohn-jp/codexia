import { resolve } from "node:path";
import { createPostgresPersistence, migratePostgresDatabase } from "@codexia/persistence-postgres";
import { createServer } from "../../packages/api/src/server.js";

async function main(): Promise<void> {
  const url = process.env.CODEXIA_E2E_DATABASE_URL;
  if (!url) throw new Error("A disposable CODEXIA_E2E_DATABASE_URL is required");
  await migratePostgresDatabase(url);
  const persistence = createPostgresPersistence(url);
  try {
    const server = createServer({
      persistence,
      authToken: process.env.CODEXIA_E2E_AUTH_TOKEN!,
      staticDir: resolve("app/dist"),
    });
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(Number(process.env.CODEXIA_E2E_PORT ?? 4173), "127.0.0.1", () => {
        server.off("error", reject);
        done();
      });
    });
    const stop = () => {
      server.close(() => { void persistence.close(); });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch (error) {
    await persistence.close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
