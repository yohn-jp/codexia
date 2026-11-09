import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./api.js";

test("concurrent expired Hosted requests share the rotating refresh exchange", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let projectRequests = 0;
  let refreshRequests = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: undefined } });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "codexia", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/_platform/refresh") {
      refreshRequests += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return Response.json({ refreshed: true });
    }
    if (path === "/api/v1/persistence/projects?limit=100") {
      projectRequests += 1;
      return projectRequests <= 2
        ? Response.json({ error: "expired", code: "UNAUTHORIZED" }, { status: 401 })
        : Response.json([]);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    const results = await Promise.all([api.persistenceProjects(), api.persistenceProjects()]);
    assert.deepEqual(results, [[], []]);
    assert.equal(refreshRequests, 1);
    assert.equal(projectRequests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("concurrent Hosted tabs serialize refresh-cookie rotation", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let projectRequests = 0;
  let refreshRequests = 0;
  let grantFresh = false;
  let lockTail = Promise.resolve();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, callback: () => Promise<Response>) => {
      const task = lockTail.then(callback, callback);
      lockTail = task.then(() => undefined, () => undefined);
      return task;
    } } },
  });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "codexia", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/_platform/refresh") {
      refreshRequests += 1;
      grantFresh = true;
      return Response.json({ refreshed: true });
    }
    if (path === "/api/v1/persistence/projects?limit=100") {
      projectRequests += 1;
      return !grantFresh
        ? Response.json({ error: "expired", code: "UNAUTHORIZED" }, { status: 401 })
        : Response.json([]);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    assert.deepEqual(await Promise.all([api.persistenceProjects(), api.persistenceProjects()]), [[], []]);
    assert.equal(refreshRequests, 1);
    assert.equal(projectRequests, 5);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("Hosted dependency authorization failures do not trigger browser grant refresh", async () => {
  const originalFetch = globalThis.fetch;
  let refreshRequests = 0;
  let redirectedToReauth = false;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { assign: (url: string) => { redirectedToReauth = url === "/_platform/reauth"; } } },
  });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "codexia", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/api/v1/persistence/projects/project-1") {
      return Response.json({ error: "Remote repository authorization failed", code: "REMOTE_AUTHORIZATION_FAILED" }, { status: 401 });
    }
    if (path === "/_platform/refresh") {
      refreshRequests += 1;
      return Response.json({ error: "Refresh grant unavailable" }, { status: 401 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    await assert.rejects(api.persistenceProject("project-1"), (error: unknown) =>
      error instanceof Error && error.message === "Remote repository authorization failed");
    assert.equal(refreshRequests, 0);
    assert.equal(redirectedToReauth, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("transient Hosted refresh failures preserve their error without reauthentication", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let redirectedToReauth = false;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { assign: (url: string) => { redirectedToReauth = url === "/_platform/reauth"; } } },
  });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "codexia", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/api/v1/persistence/projects?limit=100") return Response.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 });
    if (path === "/_platform/refresh") return Response.json({ error: "Gateway unavailable", code: "GATEWAY_UNAVAILABLE" }, { status: 503 });
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    await assert.rejects(api.persistenceProjects(), (error: unknown) =>
      error instanceof Error && "status" in error && error.status === 503 && error.message === "Gateway unavailable");
    assert.equal(redirectedToReauth, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Hosted mutation retries only after an explicit admission denial, never after response loss", async () => {
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let registrationRequests = 0;
  let refreshRequests = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: undefined } });
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/version") return Response.json({ name: "codexia", version: "0.1.0", hosted: true, profile: "hosted" });
    if (path === "/api/v1/persistence/projects") {
      registrationRequests += 1;
      return registrationRequests === 1
        ? Response.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 })
        : Response.json({ project: { id: "project-1", title: "Novel", settings: {}, version: 1, createdAt: "2026-11-09", updatedAt: "2026-11-09" } });
    }
    if (path === "/_platform/refresh") {
      refreshRequests += 1;
      return Response.json({ refreshed: true });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.version();
    assert.deepEqual(await api.createPersistenceProject({ title: "Novel" }), {
      project: { id: "project-1", title: "Novel", settings: {}, version: 1, createdAt: "2026-11-09", updatedAt: "2026-11-09" },
    });
    assert.equal(registrationRequests, 2);
    assert.equal(refreshRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }

  let lostResponseRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input) === "/api/inbox/read-all") {
      lostResponseRequests += 1;
      throw new TypeError("connection reset after request send");
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  try {
    await assert.rejects(api.markAllInboxRead(), /connection reset after request send/);
    assert.equal(lostResponseRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("module snapshot reads one PostgreSQL project revision", async () => {
  const originalFetch = globalThis.fetch;
  const snapshot = { projectId: "project-1", projectVersion: 12 };
  globalThis.fetch = async (input) => { assert.equal(String(input), "/api/projects/project-1/snapshot"); return Response.json({ snapshot, files: [] }); };
  try { assert.deepEqual((await api.moduleSnapshot("project-1")).snapshot, snapshot); } finally { globalThis.fetch = originalFetch; }
});

test("module invocations bind the exact PostgreSQL project revision", async () => {
  const originalFetch = globalThis.fetch;
  const snapshot = { projectId: "project-1", projectVersion: 12 };
  globalThis.fetch = async (_input, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)), { input: { query: "term" }, snapshot });
    return Response.json({ ok: true, snapshot, data: [] });
  };
  try {
    assert.deepEqual((await api.action("project-1", "search.query", { query: "term" }, undefined, snapshot)).snapshot, snapshot);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
