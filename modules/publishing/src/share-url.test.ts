import assert from "node:assert/strict";
import test from "node:test";
import { publicReaderOrigin, publicReaderUrl } from "./share-url.js";

test("native publishing uses the configured HTTPS reader origin instead of the WebView or API origin", () => {
  const origin = publicReaderOrigin({
    native: true,
    configuredReaderOrigin: "https://reader.example.test",
    currentOrigin: "capacitor://localhost",
  });
  assert.equal(origin, "https://reader.example.test");
  assert.equal(publicReaderUrl(origin!, "project/one", "share_secret"),
    "https://reader.example.test/r/publishing/project%2Fone/share_secret");
});

test("native publishing has no share URL when the public reader origin is missing or invalid", () => {
  assert.equal(publicReaderOrigin({ native: true, configuredReaderOrigin: null, currentOrigin: "capacitor://localhost" }), null);
  assert.equal(publicReaderOrigin({ native: true, configuredReaderOrigin: "https://reader.example.test/path", currentOrigin: "capacitor://localhost" }), null);
});

test("web publishing keeps its same-origin reader link", () => {
  const origin = publicReaderOrigin({ native: false, configuredReaderOrigin: null, currentOrigin: "https://codexia.example.test" });
  assert.equal(origin, "https://codexia.example.test");
  assert.equal(publicReaderUrl(origin!, "project-1", "share_token"),
    "https://codexia.example.test/r/publishing/project-1/share_token");
});
