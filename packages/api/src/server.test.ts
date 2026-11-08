import assert from "node:assert/strict";
import { test } from "node:test";
import type { Persistence } from "@codexia/persistence-contracts";
import { createServer, start } from "./server.js";
const token = "test-owner-token-longer-than-thirty-two-characters";
test("PostgreSQL admission preserves sessions, CSRF, bearer read-only and retired-route denial", async t => {
  const persistence = { checkHealth: async () => undefined } as unknown as Persistence;
  const server = createServer({ persistence, authToken: token });
  await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/session`)).status, 401);
  assert.equal((await fetch(`${base}/api/login`, { method: "POST", headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).status, 403);
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: `${cookie}; ${cookie}` } })).status, 401);
  for (const path of ["/api/projects", "/api/modules", "/api/platform/v1/status", "/api/actions"]) {
    assert.equal((await fetch(base + path, { headers: { Cookie: cookie } })).status, 404);
  }
  assert.equal((await fetch(`${base}/r/story/123/public`)).status, 404);
  const bearer = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/api/v1/persistence/status`, { headers: bearer })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/persistence/projects`, { method: "POST", headers: { ...bearer, Origin: base, "Content-Type": "application/json" }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/logout`, { method: "POST", headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/logout`, { method: "POST", headers: { Cookie: cookie, Origin: base } })).status, 200);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status, 401);
});
test("startup rejects a missing PostgreSQL database without a Git fallback", async () => {
  const previous = process.env.CODEXIA_DATABASE_URL;
  delete process.env.CODEXIA_DATABASE_URL;
  try { await assert.rejects(start(), /CODEXIA_DATABASE_URL is required/); }
  finally { if (previous !== undefined) process.env.CODEXIA_DATABASE_URL = previous; }
});
