import { resolve } from "node:path";
import { startBetterAuthFixture } from "./better-auth-server.js";

const databaseUrl = process.env.CODEXIA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("CODEXIA_TEST_DATABASE_URL must name a disposable PostgreSQL test database");
const portText = process.env.CODEXIA_FIXTURE_API_PORT ?? "55407";
const apiPort = Number(portText);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65_535) {
  throw new Error("CODEXIA_FIXTURE_API_PORT must be a valid nonprivileged TCP port");
}

const fixture = await startBetterAuthFixture({
  databaseUrl,
  apiPort,
  staticDirectory: process.env.CODEXIA_FIXTURE_STATIC_DIR ?? resolve(process.cwd(), "app/dist"),
});
process.stdout.write(`${JSON.stringify({
  apiOrigin: fixture.apiOrigin,
  issuer: fixture.issuer,
  audience: fixture.audience,
  idpIssuer: fixture.idpIssuer,
  webClientId: fixture.webClientId,
  ownerSubject: fixture.ownerSubject,
})}\n`);

await new Promise<void>((resolveDone) => {
  process.once("SIGINT", resolveDone);
  process.once("SIGTERM", resolveDone);
});
await fixture.close();
