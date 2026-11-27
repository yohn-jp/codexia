import { fileURLToPath } from "node:url";
import { buildViews } from "../../app/scripts/build-views.mjs";

// Only the disposable browser fixture invokes this entrypoint.
buildViews({
  viteConfig: fileURLToPath(new URL("./prepared-author.vite.config.mjs", import.meta.url)),
  prepared: process.argv.includes("--prepared"),
});
