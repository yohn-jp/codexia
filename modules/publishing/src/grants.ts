import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  parsePublishingShareGrantIndex,
  PUBLISHING_SHARE_GRANTS_KEY,
  type ModuleActionContext,
  type PublishingShareGrant as ShareGrant,
} from "@codexia/contracts";
import type { ShareScope } from "./project.js";

export type { PublishingShareGrant as ShareGrant } from "@codexia/contracts";
export const MAX_SHARE_EXPIRY_HOURS = 3650 * 24;

export interface SafeShareGrant {
  id: string;
  scope: ShareScope;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  grantVersion: number;
  revocationVersion: number;
}

export async function readShareGrants(context: ModuleActionContext): Promise<{ grants: ShareGrant[]; version: number | null }> {
  if (!context.readOwnModuleRecord) throw new Error("Publishing share record reads are unavailable");
  const record = await context.readOwnModuleRecord(PUBLISHING_SHARE_GRANTS_KEY);
  if (!record) return { grants: [], version: null };
  return { grants: parsePublishingShareGrantIndex(record.value).grants, version: record.version };
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function constantTimeHashMatches(expectedHash: string, actualHash: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(actualHash, "hex");
  return expected.length === 32 && actual.length === 32 && timingSafeEqual(expected, actual);
}

export function createShareGrant(input: {
  scope: ShareScope;
  label?: string;
  expiresInHours?: number;
  now?: Date;
}): { grant: ShareGrant; rawToken: string } {
  const hours = input.expiresInHours ?? 24;
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SHARE_EXPIRY_HOURS) {
    throw new Error(`expiresInHours must be positive and no greater than ${MAX_SHARE_EXPIRY_HOURS}`);
  }
  const now = input.now ?? new Date();
  const rawToken = `share_${randomBytes(32).toString("base64url")}`;
  const grant: ShareGrant = {
    version: 1,
    grantVersion: 1,
    revocationVersion: 0,
    id: randomUUID(),
    tokenHash: hashShareToken(rawToken),
    scope: { kind: input.scope.kind, id: input.scope.id },
    label: input.label?.trim().slice(0, 120) || "共有リンク",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString(),
  };
  return { grant, rawToken };
}

export function safeShareGrant(grant: ShareGrant): SafeShareGrant {
  return {
    id: grant.id,
    scope: { kind: grant.scope.kind, id: grant.scope.id },
    label: grant.label,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
    grantVersion: grant.grantVersion,
    revocationVersion: grant.revocationVersion,
  };
}

export function grantIsActive(grant: ShareGrant, now = Date.now()): boolean {
  const expiresAt = Date.parse(grant.expiresAt);
  return !grant.revokedAt && Number.isFinite(expiresAt) && expiresAt > now;
}
