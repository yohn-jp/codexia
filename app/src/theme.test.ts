import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { loadThemeMode, persistThemeMode } from "./theme";

function browserTheme(t: TestContext) {
  const storage = new Map<string, string>();
  const html = new Map<string, string>();
  let prefersLight = false;
  for (const [name, value] of Object.entries({
    window: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      matchMedia: (query: string) => ({ matches: query === "(prefers-color-scheme: light)" && prefersLight }),
    },
    document: {
      documentElement: {
        setAttribute: (key: string, value: string) => html.set(key, value),
      },
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return { storage, html, preferLight: (value: boolean) => { prefersLight = value; } };
}

test("stored appearance choices survive startup and override the system preference", t => {
  const browser = browserTheme(t);
  // Existing saved key, preserved by docs/design/VISUAL-SYSTEM.sdoc.
  for (const [stored, prefersLight] of [["paper", false], ["light", false], ["dark", true]] as const) {
    browser.storage.set("arcadia-theme-mode", stored);
    browser.preferLight(prefersLight);
    assert.equal(loadThemeMode(), stored);
  }
});

test("missing or unrecognized appearance choices follow the system preference", t => {
  const browser = browserTheme(t);
  assert.equal(loadThemeMode(), "dark");
  browser.preferLight(true);
  assert.equal(loadThemeMode(), "light");
  for (const invalid of ["system", "other"]) {
    browser.storage.set("arcadia-theme-mode", invalid);
    assert.equal(loadThemeMode(), "light");
  }
});

test("applying an appearance updates the page and survives reload", t => {
  const browser = browserTheme(t);
  persistThemeMode("paper");
  assert.equal(browser.html.get("data-zp-theme"), "paper");
  browser.preferLight(true);
  assert.equal(loadThemeMode(), "paper");
});
