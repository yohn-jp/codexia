import type { ModuleRecordJsonObject, ModuleRecordJsonValue } from "./index.js";

export const PUBLISHING_SHARE_GRANTS_KEY = "share-grants";

type PublishingShareScope = ModuleRecordJsonObject & { kind: "project" | "volume" | "chapter" | "scene"; id: string };
export type PublishingShareGrant = ModuleRecordJsonObject & {
  version: 1;
  grantVersion: number;
  revocationVersion: number;
  id: string;
  tokenHash: string;
  scope: PublishingShareScope;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
};

type ShareGrantIndex = ModuleRecordJsonObject & { version: 1; grants: PublishingShareGrant[] };

function object(value: ModuleRecordJsonValue | undefined): value is ModuleRecordJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeExtensions(value: ModuleRecordJsonObject, knownKeys: readonly string[]): ModuleRecordJsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !knownKeys.includes(key) && !/owner|user|token|bearer|secret|credential|auth/i.test(key)));
}

function shareScope(value: ModuleRecordJsonValue | undefined, legacy: boolean): PublishingShareScope | undefined {
  if (object(value) && (value.kind === "project" || value.kind === "volume" || value.kind === "chapter" || value.kind === "scene") &&
      typeof value.id === "string" && value.id.trim()) {
    return { ...safeExtensions(value, ["kind", "id"]), kind: value.kind, id: value.id };
  }
  if (!legacy || typeof value !== "string") return undefined;
  if (!value.trim()) return { kind: "project", id: "*" };
  if (/^vol-.+/.test(value)) return { kind: "volume", id: value };
  if (/^ch-.+/.test(value)) return { kind: "chapter", id: value };
  if (/^sc-.+/.test(value)) return { kind: "scene", id: value };
  return undefined;
}

function shareGrant(value: ModuleRecordJsonValue, legacy: boolean, location: string): PublishingShareGrant {
  const scope = object(value) ? shareScope(value.scope, legacy) : undefined;
  if (!object(value) || !scope || typeof value.id !== "string" || !value.id ||
      typeof value.tokenHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.tokenHash) ||
      typeof value.label !== "string" || typeof value.createdAt !== "string" || typeof value.expiresAt !== "string") {
    throw new Error(`Invalid share grant descriptor ${location}`);
  }
  const grantVersion = typeof value.grantVersion === "number" && Number.isSafeInteger(value.grantVersion) && value.grantVersion > 0
    ? value.grantVersion : undefined;
  const revocationVersion = typeof value.revocationVersion === "number" && Number.isSafeInteger(value.revocationVersion) && value.revocationVersion >= 0
    ? value.revocationVersion : undefined;
  if (!legacy && (value.version !== 1 || grantVersion === undefined || revocationVersion === undefined ||
      (value.revokedAt !== undefined && typeof value.revokedAt !== "string") ||
      (value.lastUsedAt !== undefined && typeof value.lastUsedAt !== "string"))) {
    throw new Error(`Invalid share grant version or timestamps ${location}`);
  }
  return {
    ...safeExtensions(value, ["id", "version", "grantVersion", "revocationVersion", "tokenHash", "scope", "label", "createdAt", "expiresAt", "revokedAt", "lastUsedAt"]),
    version: 1,
    grantVersion: grantVersion ?? 1,
    revocationVersion: revocationVersion ?? 0,
    id: value.id,
    tokenHash: value.tokenHash.toLowerCase(),
    scope,
    label: value.label,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(typeof value.revokedAt === "string" ? { revokedAt: value.revokedAt } : {}),
    ...(typeof value.lastUsedAt === "string" ? { lastUsedAt: value.lastUsedAt } : {}),
  };
}

function shareIndex(grants: PublishingShareGrant[]): ShareGrantIndex {
  const seen = new Set<string>();
  for (const grant of grants) {
    if (seen.has(grant.id)) throw new Error("Duplicate share grant ID");
    seen.add(grant.id);
  }
  return { version: 1, grants };
}

export function parsePublishingShareGrantIndex(value: ModuleRecordJsonObject): ShareGrantIndex {
  if (value.version !== 1 || !Array.isArray(value.grants)) throw new Error("Invalid publishing share grant index");
  return shareIndex(value.grants.map((grant, index) => shareGrant(grant, false, `at index ${index}`)));
}

/** One-time conversion used by protected maintenance. Live readers only accept the canonical record. */
export function convertPublishingShareGrantJsonl(content: string): ShareGrantIndex {
  const grants: PublishingShareGrant[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: ModuleRecordJsonValue;
    try { parsed = JSON.parse(line); } catch { throw new Error(`Invalid share grant JSONL at line ${index + 1}`); }
    grants.push(shareGrant(parsed, true, `at line ${index + 1}`));
  }
  return shareIndex(grants);
}
