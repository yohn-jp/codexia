import type { ProjectPageCursor, ProjectId } from "@codexia/persistence-contracts";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Match the descending millisecond update time and ascending UUID PostgreSQL page order. */
export function compareProjectPageKeys(left: ProjectPageCursor, right: ProjectPageCursor): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? -1 : 1;
  return left.id < right.id ? -1 : Number(left.id > right.id);
}

export function encodeProjectPageCursor(cursor: ProjectPageCursor): string {
  return Buffer.from(JSON.stringify({ updatedAt: cursor.updatedAt, id: cursor.id }), "utf8").toString("base64url");
}

export function decodeProjectPageCursor(value: string | null): ProjectPageCursor | undefined {
  if (value === null) return undefined;
  if (value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid project cursor");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("Invalid project cursor");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Invalid project cursor"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid project cursor");
  const cursor = parsed as Record<string, unknown>;
  if (Object.keys(cursor).length !== 2 || !Object.hasOwn(cursor, "updatedAt") || !Object.hasOwn(cursor, "id") ||
      typeof cursor.updatedAt !== "string" || typeof cursor.id !== "string" || !PROJECT_ID.test(cursor.id)) {
    throw new Error("Invalid project cursor");
  }
  const time = Date.parse(cursor.updatedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== cursor.updatedAt) throw new Error("Invalid project cursor");
  return { updatedAt: cursor.updatedAt, id: cursor.id as ProjectId };
}
