import assert from "node:assert/strict";
import { test } from "node:test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

test("browser API lifetime excludes departed documents while allowing keepalive writes and restored documents", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browser = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const { api, DocumentDepartureError } = await import("./api.js");
  const isDeparture = (error: unknown) => error instanceof DocumentDepartureError && error.name === "AbortError";
  const projectPagePath = "/api/v1/persistence/projects?limit=100";
  const page = { projects: [], nextCursor: null };
  const requests: Array<{ path: string; keepalive: boolean }> = [];
  let projectPageResponse: () => Response | Promise<Response> = () => Response.json(page);
  let jobStreamResponse: () => Promise<Response>;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push({ path, keepalive: init?.keepalive === true });
    if (path === projectPagePath) return projectPageResponse();
    if (path === "/api/jobs/events") return jobStreamResponse();
    assert.equal(path, "/api/projects/project-1/recent-activity");
    return Response.json({ items: [{ sceneId: "scene-1", sentenceOffset: null, deviceType: "mobile", updatedAt: "2026-01-01T00:00:00.000Z" }] });
  });

  const cancelDeparture = (event: Event) => event.preventDefault();
  browser.addEventListener("beforeunload", cancelDeparture);
  browser.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  await Promise.resolve();
  assert.deepEqual(await api.persistenceProjectPage(100), page);
  browser.removeEventListener("beforeunload", cancelDeparture);

  const initial = deferred<Response>();
  projectPageResponse = () => initial.promise;
  const initialRead = api.persistenceProjectPage(100);
  browser.dispatchEvent(new Event("pageshow"));
  initial.resolve(Response.json(page));
  assert.deepEqual(await initialRead, page);

  const previousDocument = deferred<Response>();
  projectPageResponse = () => previousDocument.promise;
  const previousRead = api.persistenceProjectPage(100);
  browser.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  await Promise.resolve();
  const requestsBeforeBlockedRead = requests.length;
  await assert.rejects(api.persistenceProjectPage(100), isDeparture);
  assert.equal(requests.length, requestsBeforeBlockedRead);
  await api.putRecentActivity("project-1", { sceneId: "scene-1", sentenceOffset: null, deviceType: "mobile" }, { keepalive: true });
  assert.deepEqual(requests.at(-1), { path: "/api/projects/project-1/recent-activity", keepalive: true });
  browser.dispatchEvent(new Event("pageshow"));
  projectPageResponse = () => Response.json(page);
  assert.deepEqual(await api.persistenceProjectPage(100), page);
  previousDocument.resolve(Response.json(page));
  await assert.rejects(previousRead, isDeparture);

  browser.dispatchEvent(new Event("pagehide"));
  const requestsBeforeHide = requests.length;
  await assert.rejects(api.persistenceProjectPage(100), isDeparture);
  assert.equal(requests.length, requestsBeforeHide);
  browser.dispatchEvent(new Event("pageshow"));

  const bodyReadStarted = deferred<void>();
  const heldBody = deferred<unknown>();
  projectPageResponse = () => {
    const response = Response.json(page);
    Object.defineProperty(response, "json", { value: () => {
      bodyReadStarted.resolve();
      return heldBody.promise;
    } });
    return response;
  };
  const bodyRead = api.persistenceProjectPage(100);
  await bodyReadStarted.promise;
  browser.dispatchEvent(new Event("pagehide"));
  browser.dispatchEvent(new Event("pageshow"));
  heldBody.reject(new TypeError("The browser canceled response body consumption."));
  await assert.rejects(bodyRead, isDeparture);

  const disconnected = new TypeError("The active network request failed.");
  projectPageResponse = () => { throw disconnected; };
  await assert.rejects(api.persistenceProjectPage(100), error => error === disconnected);

  const pendingStream = deferred<Response>();
  jobStreamResponse = () => pendingStream.promise;
  const eventStream = api.jobEventStream(new AbortController().signal);
  browser.dispatchEvent(new Event("pagehide"));
  browser.dispatchEvent(new Event("pageshow"));
  pendingStream.reject(new TypeError("The browser canceled the stream handshake."));
  await assert.rejects(eventStream, isDeparture);
});
