import { mergeConfig, type Plugin } from "vite";
import baseConfig from "./vite.config.ts";

const nativeMobileEntry: Plugin = {
  name: "codexia-native-mobile-entry",
  transformIndexHtml: {
    order: "pre",
    handler: (html) => html.replace("/src/entries/mobile.tsx", "/src/entries/mobile-native.tsx"),
  },
};

export default mergeConfig(baseConfig, {
  base: "./",
  plugins: [nativeMobileEntry],
  build: { outDir: "dist/ios-web", emptyOutDir: true },
});
