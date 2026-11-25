import { fileURLToPath } from "node:url";
import productConfig from "../../app/vite.config.ts";

const shell = process.env.CODEXIA_UI;
const prepared = shell === "desktop";
const normalize = path => path.replaceAll("\\", "/");
const runtime = normalize(fileURLToPath(new URL("./prepared-author-runtime.mjs", import.meta.url)));
const entry = normalize(fileURLToPath(new URL(`../../app/src/entries/${shell}.tsx`, import.meta.url)));

// Instrument the exact entry only inside the isolated fixture build. The
// production HTML, routing, CSP, and canonical product modules remain intact.
// No Playwright route interception, extra entry request or cache disablement.
export default prepared ? {
  ...productConfig,
  plugins: [
    ...productConfig.plugins,
    {
      name: "codexia-fixture-prepared-author",
      enforce: "pre",
      transform(code, id) {
        if (normalize(id) !== entry) return;
        return {
          code: `import { prepareAuthorRuntime } from ${JSON.stringify(runtime)};\nawait prepareAuthorRuntime();\n${code}`,
          map: null,
        };
      },
    },
  ],
} : productConfig;
