import { start } from "@codexia/api";

try {
  let server;
  let shutdownRequested = false;
  let shutdownStarted = false;

  const shutdown = () => {
    shutdownRequested = true;
    if (!server || shutdownStarted) return;
    shutdownStarted = true;
    server.close((error) => {
      if (error) {
        console.error("Codexia shutdown failed");
        process.exitCode = 1;
      } else {
        console.info("Codexia shutdown complete");
      }
    });
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server = await start();
  if (shutdownRequested) shutdown();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Codexia failed to start");
  process.exitCode = 1;
}
