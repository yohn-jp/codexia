import { fileURLToPath } from "node:url";
import productConfig from "../../app/vite.config.ts";

const shell = process.env.CODEXIA_UI;
const prepared = shell === "desktop" || shell === "mobile";
// Keep the normal HTML and product source. A second entry shares the same
// Rollup module graph (including the actual in-memory API token singleton).
export default prepared ? {
  ...productConfig,
  build: {
    ...productConfig.build,
    rollupOptions: {
      ...productConfig.build.rollupOptions,
      input: {
        index: productConfig.build.rollupOptions.input,
        "prepared-author": fileURLToPath(new URL(`./prepared-${shell}-entry.mjs`, import.meta.url)),
      },
    },
  },
} : productConfig;
