import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = resolve(appRoot, "..");
const ui = process.env.CODEXIA_UI ?? process.env.SCRIPTORIUM_UI ?? "launcher";
if (!["launcher", "desktop", "mobile"].includes(ui)) throw new Error("Invalid CODEXIA_UI");
const uiDirectory = ui === "launcher" ? "" : ui;

export default defineConfig({
  root: appRoot,
  plugins: [react(), {
    name: "codexia-ui-entry",
    transformIndexHtml: {
      order: "pre",
      handler: (html: string) => ui === "launcher" ? html : html.replace("/src/launcher.tsx", `/src/entries/${ui}.tsx`),
    },
  }],
  base: uiDirectory ? `/${uiDirectory}/` : "/",
  build: {
    outDir: resolve(appRoot, "dist", uiDirectory),
    emptyOutDir: true,
    manifest: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(appRoot, "index.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (asset) => asset.name?.endsWith(".css") ? "assets/styles-[hash][extname]" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
