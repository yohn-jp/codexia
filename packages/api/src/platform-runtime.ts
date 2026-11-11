import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PLATFORM_CONTRACT_VERSION = "scriptorium-platform/v1" as const;
export const RUNTIME_CONTROL_CONTRACT_VERSION = "praetorium-runtime-control/v1" as const;
export const RUNTIME_STATUS_PATH = "/api/platform/v1/status" as const;
export const RUNTIME_QUIESCE_PATH = "/api/platform/v1/quiesce" as const;
export const RUNTIME_RESUME_PATH = "/api/platform/v1/resume" as const;
export const RUNTIME_METADATA_PATH = "/api/platform/v1/metadata" as const;
export const HOSTED_ASSIGNMENT_PATH = "/run/scriptorium/runtime-assignment.json" as const;
export const HOSTED_RUNTIME_IDENTITY_PATH = "/run/scriptorium/runtime-identity.jwt" as const;
export const HOSTED_ACCESS_COOKIE = "__Host-praetorium_access" as const;
export const HOSTED_CSRF_COOKIE = "__Host-praetorium_csrf" as const;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PRODUCER_REVISION = /^[a-f0-9]{40}$/u;
const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const CONTROL_ACTIONS = new Set(["status", "quiesce", "resume"]);
export interface RuntimePolicy {
  issuer: string;
  jwksUrl: string;
  audience: string;
}

/** The producer's assignment shape mirrors Praetorium RuntimeAssignmentSchema. */
export interface RuntimeAssignment {
  contractVersion: typeof PLATFORM_CONTRACT_VERSION;
  instanceId: string;
  repositoryId: number;
  repositoryLocator: string;
  defaultBranchPolicy: string;
  runtimeEpoch: number;
  imageDigest: string;
  compositionManifestDigest: string;
  enabledModuleIds: string[];
  credentialBrokerLocator: string;
  controlServicePolicy: RuntimePolicy;
  grantPolicy: RuntimePolicy;
}

export interface QuiesceRequest {
  contractVersion: typeof PLATFORM_CONTRACT_VERSION;
  operationId: string;
  instanceId: string;
  runtimeEpoch: number;
  reason: string;
  deadline: string;
}

export interface RuntimeControlCredential {
  contractVersion: typeof RUNTIME_CONTROL_CONTRACT_VERSION;
  iss: string;
  sub: string;
  aud: string;
  instanceId: string;
  repositoryId: number;
  runtimeEpoch: number;
  operationId: string;
  action: "status" | "quiesce" | "resume";
  payloadDigest: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

export interface PersistenceObservation {
  state: "verified" | "unknown";
  provider: "postgres";
  projectVersion: number | null;
}

export interface RuntimeMetadata {
  contractVersion: typeof PLATFORM_CONTRACT_VERSION;
  producerRevision: string;
  listener: { port: number };
  paths: {
    liveness: string;
    readiness: string;
    metadata: typeof RUNTIME_METADATA_PATH;
    shutdown: typeof RUNTIME_QUIESCE_PATH;
    status: typeof RUNTIME_STATUS_PATH;
    quiesce: typeof RUNTIME_QUIESCE_PATH;
    resume: typeof RUNTIME_RESUME_PATH;
  };
  shutdownTimeoutSeconds: number;
}

export interface RuntimeStatus {
  contractVersion: "codexia-runtime-status/v2";
  instanceId: string;
  projectId: string;
  runtimeEpoch: number;
  imageDigest: string;
  compositionManifestDigest: string;
  enabledModuleIds: string[];
  ready: boolean;
  activity: { lastMeaningfulActivityAt: string | null; activeApiRequests: number; activeMcpRequests: number; activeMutations: number; activeJobs: number; restartableJobs: number };
  persistence: PersistenceObservation;
  observedAt: string;
}
export interface QuiesceResult {
  contractVersion: "codexia-runtime-status/v2";
  operationId: string;
  instanceId: string;
  projectId: string;
  runtimeEpoch: number;
  quiesceRevision: string | null;
  projectVersion: number | null;
  disposition: "safe" | "blocked" | "unknown";
  activeMutations: number;
  activeJobs: number;
  restartableJobs: number;
  reasonCodes: string[];
  observedAt: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function text(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parsePolicy(value: unknown): RuntimePolicy {
  if (!record(value) || !exactKeys(value, ["issuer", "jwksUrl", "audience"]) ||
      !isHttpsUrl(value.issuer) || !isHttpsUrl(value.jwksUrl) || !text(value.audience)) {
    throw new TypeError("runtime assignment authentication policy is invalid");
  }
  return { issuer: value.issuer, jwksUrl: value.jwksUrl, audience: value.audience };
}

function isRepositoryLocator(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.port === "" &&
      url.username === "" && url.password === "" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function parseRuntimeAssignment(value: unknown): RuntimeAssignment {
  if (!record(value) || !exactKeys(value, [
    "contractVersion", "instanceId", "repositoryId", "repositoryLocator", "defaultBranchPolicy",
    "runtimeEpoch", "imageDigest", "compositionManifestDigest", "enabledModuleIds",
    "credentialBrokerLocator", "controlServicePolicy", "grantPolicy",
  ]) || value.contractVersion !== PLATFORM_CONTRACT_VERSION || !text(value.instanceId) ||
      !positiveInteger(value.repositoryId) || !isRepositoryLocator(value.repositoryLocator) ||
      !text(value.defaultBranchPolicy) || !positiveInteger(value.runtimeEpoch) ||
      typeof value.imageDigest !== "string" || !DIGEST.test(value.imageDigest) ||
      typeof value.compositionManifestDigest !== "string" || !DIGEST.test(value.compositionManifestDigest) ||
      !Array.isArray(value.enabledModuleIds) || value.enabledModuleIds.length > 256 ||
      !value.enabledModuleIds.every((id) => typeof id === "string" && MODULE_ID.test(id)) ||
      new Set(value.enabledModuleIds).size !== value.enabledModuleIds.length ||
      !text(value.credentialBrokerLocator)) {
    throw new TypeError("runtime assignment is invalid");
  }
  return {
    contractVersion: PLATFORM_CONTRACT_VERSION,
    instanceId: value.instanceId,
    repositoryId: value.repositoryId,
    repositoryLocator: value.repositoryLocator,
    defaultBranchPolicy: value.defaultBranchPolicy,
    runtimeEpoch: value.runtimeEpoch,
    imageDigest: value.imageDigest,
    compositionManifestDigest: value.compositionManifestDigest,
    enabledModuleIds: [...value.enabledModuleIds] as string[],
    credentialBrokerLocator: value.credentialBrokerLocator,
    controlServicePolicy: parsePolicy(value.controlServicePolicy),
    grantPolicy: parsePolicy(value.grantPolicy),
  };
}

export async function readRuntimeAssignment(path: string): Promise<RuntimeAssignment> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new Error("hosted_runtime_assignment_unavailable");
  }
  if (Buffer.byteLength(content, "utf8") > 64 * 1024) throw new Error("hosted_runtime_assignment_invalid");
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error("hosted_runtime_assignment_invalid");
  }
  return parseRuntimeAssignment(value);
}

export function parseQuiesceRequest(value: unknown): QuiesceRequest {
  if (!record(value) || !exactKeys(value, ["contractVersion", "operationId", "instanceId", "runtimeEpoch", "reason", "deadline"]) ||
      value.contractVersion !== PLATFORM_CONTRACT_VERSION || !text(value.operationId) || !text(value.instanceId) ||
      !positiveInteger(value.runtimeEpoch) || !text(value.reason, 128) || typeof value.deadline !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value.deadline) ||
      !Number.isFinite(Date.parse(value.deadline))) {
    throw new TypeError("quiesce request is invalid");
  }
  return {
    contractVersion: PLATFORM_CONTRACT_VERSION,
    operationId: value.operationId,
    instanceId: value.instanceId,
    runtimeEpoch: value.runtimeEpoch,
    reason: value.reason,
    deadline: value.deadline,
  };
}

export function parseRuntimeControlCredential(value: unknown, expected: {
  issuer: string;
  audience: string;
  instanceId: string;
  repositoryId: number;
  runtimeEpoch: number;
  operationId: string;
  action: RuntimeControlCredential["action"];
  payloadDigest: string;
  nowSeconds: number;
}): RuntimeControlCredential {
  const keys = ["contractVersion", "iss", "sub", "aud", "instanceId", "repositoryId", "runtimeEpoch", "operationId", "action", "payloadDigest", "iat", "nbf", "exp", "jti"];
  if (!record(value) || !exactKeys(value, keys) || value.contractVersion !== RUNTIME_CONTROL_CONTRACT_VERSION ||
      !text(value.iss) || !text(value.sub, 128) || !text(value.aud, 512) || !text(value.instanceId, 128) ||
      !positiveInteger(value.repositoryId) || !positiveInteger(value.runtimeEpoch) || !text(value.operationId, 128) ||
      typeof value.action !== "string" || !CONTROL_ACTIONS.has(value.action) || typeof value.payloadDigest !== "string" || !DIGEST.test(value.payloadDigest) ||
      !Number.isSafeInteger(value.iat) || (value.iat as number) < 0 || !Number.isSafeInteger(value.nbf) || (value.nbf as number) < 0 ||
      !Number.isSafeInteger(value.exp) || (value.exp as number) <= 0 || !text(value.jti, 128) ||
      (value.exp as number) <= (value.iat as number) || (value.exp as number) - (value.iat as number) > 60 ||
      (value.nbf as number) < (value.iat as number) || (value.nbf as number) >= (value.exp as number) ||
      value.iss !== expected.issuer || value.aud !== expected.audience || value.instanceId !== expected.instanceId ||
      value.repositoryId !== expected.repositoryId || value.runtimeEpoch !== expected.runtimeEpoch ||
      value.operationId !== expected.operationId || value.action !== expected.action || value.payloadDigest !== expected.payloadDigest ||
      !Number.isSafeInteger(expected.nowSeconds) || expected.nowSeconds < 0 || (value.iat as number) > expected.nowSeconds ||
      (value.nbf as number) > expected.nowSeconds || (value.exp as number) <= expected.nowSeconds) {
    throw new TypeError("runtime control credential binding mismatch");
  }
  return value as unknown as RuntimeControlCredential;
}

export function sha256Digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function metadataForRuntime(input: { producerRevision: string; port: number; shutdownTimeoutSeconds: number }): RuntimeMetadata {
  if (!PRODUCER_REVISION.test(input.producerRevision) || !positiveInteger(input.port) || input.port > 65_535 ||
      !positiveInteger(input.shutdownTimeoutSeconds)) throw new TypeError("runtime metadata configuration is invalid");
  return {
    contractVersion: PLATFORM_CONTRACT_VERSION,
    producerRevision: input.producerRevision,
    listener: { port: input.port },
    paths: {
      liveness: "/health/live",
      readiness: "/health/ready",
      metadata: RUNTIME_METADATA_PATH,
      shutdown: RUNTIME_QUIESCE_PATH,
      status: RUNTIME_STATUS_PATH,
      quiesce: RUNTIME_QUIESCE_PATH,
      resume: RUNTIME_RESUME_PATH,
    },
    shutdownTimeoutSeconds: input.shutdownTimeoutSeconds,
  };
}
/** Observe only durable PostgreSQL state; failure never falls back to workspace files. */
export async function observePostgresPersistence(persistence: import("@codexia/persistence-contracts").Persistence, projectId: string): Promise<PersistenceObservation> {
  const unknown = { state: "unknown" as const, provider: "postgres" as const, projectVersion: null };
  try {
    if (!persistence.checkHealth) return unknown;
    await persistence.checkHealth();
    const project = await persistence.read((reader) => reader.getProject(projectId as import("@codexia/persistence-contracts").ProjectId));
    if (!project || project.id !== projectId || !Number.isSafeInteger(project.version) || project.version < 1) return unknown;
    return { state: "verified", provider: "postgres", projectVersion: project.version };
  } catch { return unknown; }
}
