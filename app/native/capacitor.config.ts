import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "jp.yohn.codexia",
  appName: "Codexia",
  webDir: "../dist/ios-web",
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
  },
};

export default config;
