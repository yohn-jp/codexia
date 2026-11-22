import assert from "node:assert/strict";
import test from "node:test";
import { resolveStandaloneAuthMode } from "./auth-mode.js";

test("Better Auth settings require an explicit Better Auth mode", () => {
  assert.throws(
    () => resolveStandaloneAuthMode(undefined, true),
    /CODEXIA_AUTH_MODE=better-auth is required/u,
  );
});

test("token mode refuses configured Better Auth inputs instead of falling back", () => {
  assert.throws(
    () => resolveStandaloneAuthMode("token", true),
    /refusing implicit token fallback/u,
  );
});

test("only the supported standalone modes are accepted", () => {
  assert.equal(resolveStandaloneAuthMode("token", false), "token");
  assert.equal(resolveStandaloneAuthMode("better-auth", true), "better-auth");
  assert.equal(resolveStandaloneAuthMode(undefined, false), "token");
  assert.throws(() => resolveStandaloneAuthMode("legacy", false), /must be token or better-auth/u);
  assert.throws(() => resolveStandaloneAuthMode("better-auth", false), /requires complete Better Auth settings/u);
});
