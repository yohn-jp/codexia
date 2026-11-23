const HANDOFF_PREFIX = "codexia.console.return.v1:";
const HANDOFF_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ConsoleReturnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeAuthorPath(path: string): string | null {
  if (!path.startsWith("/desktop/") && path !== "/desktop") return null;
  if (path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) return null;
  let url: URL;
  try { url = new URL(path, "https://codexia.invalid"); }
  catch { return null; }
  if (url.origin !== "https://codexia.invalid" || url.username || url.password ||
      (url.pathname !== "/desktop" && !url.pathname.startsWith("/desktop/"))) return null;
  for (const key of ["code", "state", "iss", "error", "error_description", "access_token", "refresh_token", "id_token"]) {
    url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Saves only a same-tab Desktop return path and hands the console an opaque reference. */
export function createConsoleReturnLocation(
  currentPath: string,
  storage: ConsoleReturnStorage,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const target = safeAuthorPath(currentPath);
  if (!target) throw new Error("A safe Desktop return location is unavailable.");
  const id = createId();
  if (!HANDOFF_ID.test(id)) throw new Error("A console return reference could not be created.");
  storage.setItem(`${HANDOFF_PREFIX}${id}`, target);
  return `/console?return=${encodeURIComponent(id)}`;
}

/** Resolves the opaque one-tab handoff without accepting a URL from the query string. */
export function resolveConsoleReturnLocation(
  search: string,
  storage: ConsoleReturnStorage,
): { readonly target: string; readonly id: string | null } {
  const params = new URLSearchParams(search);
  const values = params.getAll("return");
  if (values.length !== 1 || !HANDOFF_ID.test(values[0] ?? "")) return { target: "/desktop/", id: null };
  const id = values[0]!;
  const stored = storage.getItem(`${HANDOFF_PREFIX}${id}`);
  const target = stored ? safeAuthorPath(stored) : null;
  if (!target) return { target: "/desktop/", id };
  return { target, id };
}

/** Removes the handoff before navigating back to the saved authoring route. */
export function consumeConsoleReturnLocation(
  search: string,
  storage: ConsoleReturnStorage,
): string {
  const resolved = resolveConsoleReturnLocation(search, storage);
  if (resolved.id) storage.removeItem(`${HANDOFF_PREFIX}${resolved.id}`);
  return resolved.target;
}
