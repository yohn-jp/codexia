import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const appPackage = new URL("../../../app/package.json", import.meta.url);
const appRoot = fileURLToPath(new URL("../../../app/", import.meta.url));
const requireFromApp = createRequire(appPackage);
const react = requireFromApp("@vitejs/plugin-react").default;
const { vanillaExtractPlugin } = requireFromApp("@vanilla-extract/vite-plugin");
const fixtureRoot = fileURLToPath(new URL("./", import.meta.url));

export default {
  root: fixtureRoot,
  plugins: [vanillaExtractPlugin(), react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react$/, replacement: resolve(appRoot, "node_modules/react/index.js") },
      { find: /^react\/(.*)$/, replacement: resolve(appRoot, "node_modules/react/$1") },
      { find: /^react-dom$/, replacement: resolve(appRoot, "node_modules/react-dom/index.js") },
      { find: /^react-dom\/client$/, replacement: resolve(appRoot, "node_modules/react-dom/client.js") },
    ],
  },
};
