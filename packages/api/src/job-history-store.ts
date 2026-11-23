import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionResult, ModuleId } from "@codexia/contracts";
import type { WorkerJobLifecycleSnapshot } from "@codexia/module-runtime";

const MAX_RETAINED_JOBS = 500;
const MAX_RETAINED_INBOX = 200;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const JOB_STATUSES = new Set(["queued", "running", "done", "error"]);
const MODULES = new Set(["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp"]);
const PUBLIC_JOB_FIELDS = new Set(["id", "type", "status", "progress", "result", "error", "errorCode", "retryable", "createdAt", "updatedAt", "finishedAt"]);
const INBOX_FIELDS = new Set(["id", "kind", "jobId", "jobType", "title", "body", "status", "read", "userId", "projectKey", "createdAt"]);

/** Minimal internal metadata emitted by the runtime; request and result data never enter host history. */
export type WorkerJobLifecycle = WorkerJobLifecycleSnapshot;

export type PublicJobStatus = "queued" | "running" | "done" | "error";

export interface PublicJob {
  id: string;
  type: string;
  status: PublicJobStatus;
  progress: number | null;
  result: unknown | null;
  error: string | null;
  errorCode?: string;
  retryable?: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type JobEvent = JobStatusEvent | JobProgressEvent;

export interface JobStatusEvent {
  type: "job-status";
  jobId: string;
  jobType: string;
  status: PublicJobStatus;
  progress: number | null;
  error?: string;
  at: string;
}

export interface JobProgressEvent {
  type: "job-progress";
  jobId: string;
  jobType: string;
  status: PublicJobStatus;
  progress: number;
  at: string;
}

export interface InboxItem {
  id: string;
  kind: "job-complete";
  jobId: string;
  jobType: string;
  title: string;
  body: string;
  status: "done" | "error";
  read: boolean;
  userId: string | null;
  projectKey: string;
  createdAt: string;
}

interface StoredJob {
  kind: "worker" | "domain" | "legacy";
  ownerKey: string;
  projectKey: string;
  job: PublicJob;
}

interface PersistedState {
  version: 3;
  jobs: StoredJob[];
  inbox: InboxItem[];
  legacySources: string[];
}

export class JobHistoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JobHistoryError";
  }
}

interface JobHistoryPaths {
  root: string;
  directory: string;
  filePath: string;
}

function jobHistoryPaths(usageDirectory: string): JobHistoryPaths {
  if (typeof usageDirectory !== "string" || !usageDirectory.trim()) {
    throw new JobHistoryError("job_history_path_invalid", "A host history directory is required");
  }
  const root = resolve(usageDirectory);
  const directory = join(root, "jobs");
  return { root, directory, filePath: join(directory, "jobs-state.json") };
}

/** Durable owner-host history for real module-runtime jobs. Construction performs no I/O. */
export class JobHistoryStore {
  private readonly paths: JobHistoryPaths;
  private loaded = false;
  private state: PersistedState = { version: 3, jobs: [], inbox: [], legacySources: [] };
  private serial = Promise.resolve();

  constructor(usageDirectory: string) {
    this.paths = jobHistoryPaths(usageDirectory);
  }

  async record(lifecycle: WorkerJobLifecycle): Promise<JobEvent> {
    return this.exclusive(async () => {
      await this.load();
      const normalized = normalizeLifecycle(lifecycle);
      const ownerKey = hash("owner");
      const projectKey = projectKeyFor(normalized.projectId);
      const job = publicJob(normalized);
      const index = this.state.jobs.findIndex((entry) => entry.job.id === job.id);
      const current = index < 0 ? undefined : this.state.jobs[index];
      if (current && current.kind !== "worker") {
        throw new JobHistoryError("job_identity_conflict", "A worker lifecycle ID cannot replace a different host job record");
      }
      if (current && (current.ownerKey !== ownerKey || current.projectKey !== projectKey || current.job.type !== job.type)) {
        throw new JobHistoryError("job_identity_conflict", "A worker job ID was reused for another owner, project, or task");
      }
      if (current && isFinalStatus(current.job.status)) {
        if (JSON.stringify(current.job) !== JSON.stringify(job)) {
          throw new JobHistoryError("job_lifecycle_conflict", "A terminal worker job lifecycle cannot be changed");
        }
        return jobEvent(current.job);
      }
      if (current && !canAdvance(current.job.status, job.status)) {
        throw new JobHistoryError("job_lifecycle_conflict", "Worker job lifecycle moved backwards");
      }
      if (current && Date.parse(job.updatedAt) < Date.parse(current.job.updatedAt)) {
        throw new JobHistoryError("job_lifecycle_conflict", "Worker job lifecycle timestamp moved backwards");
      }
      const next = cloneState(this.state);
      const nextIndex = next.jobs.findIndex((entry) => entry.job.id === job.id);
      if (nextIndex >= 0 && nextIndex < next.jobs.length) next.jobs[nextIndex] = { kind: current?.kind ?? "worker", ownerKey, projectKey, job };
      else next.jobs.push({ kind: "worker", ownerKey, projectKey, job });
      pruneJobs(next.jobs);
      if (next.jobs.length > MAX_RETAINED_JOBS) throw new JobHistoryError("job_history_full", "Host job history cannot retain another active worker job");
      if (isTerminal(normalized.state) && current?.job.finishedAt == null) addInboxItem(next, job, ownerKey, projectKey);
      await this.persist(next);
      this.state = next;
      return jobEvent(job);
    });
  }

  /** Register a source domain task before invoking its action. No action input is retained. */
  async beginDomainJob(input: { id: string; type: string; projectId: string }): Promise<JobEvent> {
    return this.exclusive(async () => {
      await this.load();
      const id = boundedText(input.id, 1, 128, /^[A-Za-z0-9_-]+$/u, "job ID");
      const type = boundedText(input.type, 1, 64, /^[a-z][a-z0-9-]*$/u, "domain job type");
      if (!isProjectId(input.projectId)) throw new JobHistoryError("job_identity_invalid", "Domain job project identity is invalid");
      const ownerKey = hash("owner");
      const projectKey = projectKeyFor(input.projectId);
      const existing = this.state.jobs.find((entry) => entry.job.id === id);
      if (existing) {
        if (existing.kind !== "domain" || existing.ownerKey !== ownerKey || existing.projectKey !== projectKey || existing.job.type !== type) {
          throw new JobHistoryError("job_identity_conflict", "A domain job ID was reused for another owner, project, or task");
        }
        return jobEvent(existing.job);
      }
      const now = new Date().toISOString();
      const job: PublicJob = {
        id, type, status: "queued", progress: 0, result: null, error: null,
        createdAt: now, updatedAt: now, finishedAt: null,
      };
      const next = cloneState(this.state);
      next.jobs.push({ kind: "domain", ownerKey, projectKey, job });
      pruneJobs(next.jobs);
      if (next.jobs.length > MAX_RETAINED_JOBS) throw new JobHistoryError("job_history_full", "Host job history cannot retain another domain job");
      const domainReservations = next.jobs.filter((entry) => entry.kind === "domain" && !isFinalStatus(entry.job.status)).length;
      if (Buffer.byteLength(JSON.stringify(next), "utf8") + domainReservations * (MAX_RESULT_BYTES + 4096) > MAX_STATE_BYTES) {
        throw new JobHistoryError("job_history_full", "Host job history has no reserved space for another domain result");
      }
      await this.persist(next);
      this.state = next;
      return jobEvent(job);
    });
  }

  async markDomainJobRunning(id: string): Promise<JobEvent> {
    return this.exclusive(async () => {
      await this.load();
      const current = this.state.jobs.find((entry) => entry.job.id === id);
      if (!current || current.kind !== "domain") throw new JobHistoryError("job_not_found", "Domain job was not registered");
      if (current.job.status === "running") return jobEvent(current.job);
      if (current.job.status !== "queued") throw new JobHistoryError("job_lifecycle_conflict", "A finished domain job cannot start again");
      const next = cloneState(this.state);
      const record = next.jobs.find((entry) => entry.job.id === id)!;
      const now = nextTimestamp(record.job.updatedAt);
      record.job.status = "running";
      record.job.updatedAt = now;
      const event = jobEvent(record.job);
      await this.persist(next);
      this.state = next;
      return event;
    });
  }

  /** Store the source-compatible 0..1 progress hint and return its SSE event. */
  async reportDomainJobProgress(id: string, progress: number): Promise<JobProgressEvent | null> {
    return this.exclusive(async () => {
      await this.load();
      if (!Number.isFinite(progress)) throw new JobHistoryError("job_progress_invalid", "Job progress must be a finite number");
      const current = this.state.jobs.find((entry) => entry.job.id === id);
      if (!current || current.kind !== "domain") throw new JobHistoryError("job_not_found", "Domain job was not registered");
      if (current.job.status !== "running") throw new JobHistoryError("job_lifecycle_conflict", "Only a running domain job can report progress");

      const boundedProgress = Math.max(0, Math.min(1, progress));
      if (current.job.progress === boundedProgress) return null;
      const next = cloneState(this.state);
      const record = next.jobs.find((entry) => entry.job.id === id)!;
      record.job.progress = boundedProgress;
      record.job.updatedAt = nextTimestamp(record.job.updatedAt);
      const event: JobProgressEvent = {
        type: "job-progress", jobId: record.job.id, jobType: record.job.type, status: record.job.status,
        progress: boundedProgress, at: record.job.updatedAt,
      };
      await this.persist(next);
      this.state = next;
      return event;
    });
  }

  /** Retain the exact final ActionResult data or machine error for an owner-visible domain job. */
  async finishDomainJob(id: string, result: ActionResult): Promise<JobEvent> {
    return this.exclusive(async () => {
      await this.load();
      const current = this.state.jobs.find((entry) => entry.job.id === id);
      if (!current || current.kind !== "domain") throw new JobHistoryError("job_not_found", "Domain job was not registered");
      if (isFinalStatus(current.job.status)) {
        const expected = domainResultJob(current.job, result);
        if (JSON.stringify(expected) !== JSON.stringify(current.job)) throw new JobHistoryError("job_lifecycle_conflict", "A terminal domain job result cannot be changed");
        return jobEvent(current.job);
      }
      if (current.job.status !== "queued" && current.job.status !== "running") throw new JobHistoryError("job_lifecycle_conflict", "Domain job state cannot finish");
      const next = cloneState(this.state);
      const record = next.jobs.find((entry) => entry.job.id === id)!;
      const completed = domainResultJob(record.job, result);
      completed.updatedAt = nextTimestamp(record.job.updatedAt);
      completed.finishedAt = completed.updatedAt;
      record.job = completed;
      if (record.job.status === "done" || record.job.status === "error") addInboxItem(next, record.job, record.ownerKey, record.projectKey);
      const event = jobEvent(record.job);
      await this.persist(next);
      this.state = next;
      return event;
    });
  }

  async listJobs(): Promise<PublicJob[]> {
    return this.exclusive(async () => {
      await this.load();
      return this.state.jobs.map(({ job }) => clonePublicJob(job)).sort(newestFirst);
    });
  }

  async getJob(id: string): Promise<PublicJob | undefined> {
    return this.exclusive(async () => {
      await this.load();
      const record = this.state.jobs.find((entry) => entry.job.id === id);
      return record ? clonePublicJob(record.job) : undefined;
    });
  }

  async listInbox(options: { unreadOnly?: boolean } = {}): Promise<{ items: InboxItem[]; unreadCount: number }> {
    return this.exclusive(async () => {
      await this.load();
      const items = this.state.inbox.filter((item) => !options.unreadOnly || !item.read)
        .map((item) => ({ ...item })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const unreadCount = this.state.inbox.reduce((count, item) => count + Number(!item.read), 0);
      return { items, unreadCount };
    });
  }

  async markInboxRead(id: string): Promise<InboxItem | undefined> {
    return this.exclusive(async () => {
      await this.load();
      const index = this.state.inbox.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const next = cloneState(this.state);
      const item = next.inbox[index]!;
      item.read = true;
      await this.persist(next);
      this.state = next;
      return { ...item };
    });
  }

  async markAllInboxRead(): Promise<number> {
    return this.exclusive(async () => {
      await this.load();
      const next = cloneState(this.state);
      let marked = 0;
      for (const item of next.inbox) {
        if (!item.read) { item.read = true; marked += 1; }
      }
      if (marked > 0) {
        await this.persist(next);
        this.state = next;
      }
      return marked;
    });
  }

  /** Wait for callbacks already accepted by the store. */
  async flush(): Promise<void> {
    await this.serial;
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const decoded = await readInstalledState(this.paths);
    if (decoded !== undefined) {
      const recovered = normalizeState(decoded);
      if (orphanRunningJobs(recovered)) await this.persist(recovered);
      this.state = recovered;
    }
    this.loaded = true;
  }

  private async persist(next: PersistedState): Promise<void> {
    await writeInstalledState(this.paths, serializeState(next));
  }
}

/** Readiness check for the installed format. Runtime recovery is deferred to the live store. */
export async function assertCurrentJobHistory(usageDirectory: string): Promise<void> {
  const state = await readInstalledState(jobHistoryPaths(usageDirectory));
  if (state !== undefined) normalizeState(state);
}

export type JobHistoryMaintenanceReport =
  | { status: "ready"; version: 3 | null; migrated: boolean }
  | { status: "maintenance_required"; version: 1 | 2; migrated: false };

/** Convert installed job history while the API is stopped. This never resumes or marks jobs. */
export async function maintainJobHistory(usageDirectory: string, mode: "check" | "apply"): Promise<JobHistoryMaintenanceReport> {
  const paths = jobHistoryPaths(usageDirectory);
  const state = await readInstalledState(paths);
  if (state === undefined) return { status: "ready", version: null, migrated: false };
  if (!isRecord(state)) historyCorrupt();
  const { version } = state;
  if (version !== 1 && version !== 2) {
    normalizeState(state);
    return { status: "ready", version: 3, migrated: false };
  }
  if (!hasOnlyKeys(state, new Set(["version", "jobs", "inbox", "legacySources"])) || !Array.isArray(state.jobs) ||
      state.jobs.length > MAX_RETAINED_JOBS) historyCorrupt();
  const jobs = state.jobs.map((entry: unknown) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, new Set(["ownerKey", "projectKey", "job"]))) historyCorrupt();
    return { kind: "worker", ...entry };
  });
  const migrated = {
    version: 3, jobs, inbox: state.inbox,
    legacySources: version === 1 && !Object.hasOwn(state, "legacySources") ? [] : state.legacySources,
  };
  normalizeState(migrated);
  const serialized = serializeState(migrated);
  if (mode === "check") return { status: "maintenance_required", version, migrated: false };
  await writeInstalledState(paths, serialized);
  return { status: "ready", version: 3, migrated: true };
}

async function readInstalledState({ root, directory, filePath }: JobHistoryPaths): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertPrivateDirectory(root);
    await assertPrivateDirectory(directory);
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_STATE_BYTES || (info.mode & 0o077) !== 0) historyCorrupt();
    const bytes = await handle.readFile();
    if (bytes.length > MAX_STATE_BYTES) historyCorrupt();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    if (error instanceof JobHistoryError) throw error;
    throw new JobHistoryError("job_history_corrupt", "Host job history cannot be read safely");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function serializeState(state: unknown): string {
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new JobHistoryError("job_history_full", "Host job history exceeds its storage limit");
  }
  return serialized;
}

async function writeInstalledState({ root, directory, filePath }: JobHistoryPaths, serialized: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directory);
  await syncDirectory(root);
  const temporary = join(directory, `.tmp-${randomBytes(16).toString("hex")}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await rename(temporary, filePath);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      throw new JobHistoryError("job_history_write_failed", "Host job history could not be atomically replaced");
    }
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function normalizeLifecycle(value: unknown): WorkerJobLifecycle & { projectId: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["jobId", "module", "task", "snapshot", "state", "createdAt", "updatedAt", "startedAt", "finishedAt", "errorCode"]))) {
    throw new JobHistoryError("job_event_invalid", "Worker lifecycle metadata is invalid");
  }
  const jobId = boundedText(value.jobId, 1, 128, /^[A-Za-z0-9_-]+$/u, "job ID");
  const module = boundedText(value.module, 1, 32, /^[a-z][a-z0-9-]*$/u, "module") as ModuleId;
  if (!MODULES.has(module)) throw new JobHistoryError("job_event_invalid", "Worker module is invalid");
  const task = boundedText(value.task, 1, 128, /^[A-Za-z0-9._:-]+$/u, "task");
  const snapshot = value.snapshot;
  if (!isRecord(snapshot) || !isProjectId(snapshot.projectId) || !Number.isSafeInteger(snapshot.projectVersion) || (snapshot.projectVersion as number) < 0) throw new JobHistoryError("job_event_invalid", "Worker snapshot identity is invalid");
  const projectId = snapshot.projectId;
  if (value.state !== "queued" && value.state !== "running" && value.state !== "succeeded" && value.state !== "failed" && value.state !== "cancelled") {
    throw new JobHistoryError("job_event_invalid", "Worker state is invalid");
  }
  const createdAt = timestamp(value.createdAt, "createdAt");
  const updatedAt = timestamp(value.updatedAt, "updatedAt");
  const startedAt = value.startedAt === null ? null : timestamp(value.startedAt, "startedAt");
  const finishedAt = value.finishedAt === null ? null : timestamp(value.finishedAt, "finishedAt");
  const errorCode = value.errorCode === undefined ? undefined : boundedText(value.errorCode, 1, 128, /^[A-Za-z0-9_.-]+$/u, "error code");
  const normalizedSnapshot = snapshot as unknown as WorkerJobLifecycle["snapshot"];
  return {
    jobId, module, task, snapshot: normalizedSnapshot, state: value.state, createdAt, updatedAt, startedAt, finishedAt,
    ...(errorCode ? { errorCode } : {}), projectId,
  };
}

function publicJob(event: ReturnType<typeof normalizeLifecycle>): PublicJob {
  const status: PublicJobStatus = event.state === "succeeded" ? "done" : event.state === "failed" || event.state === "cancelled" ? "error" : event.state;
  const terminal = isTerminal(event.state);
  return {
    id: event.jobId,
    type: `${event.module}.${event.task}`,
    status,
    progress: null,
    result: null,
    error: status === "error" ? event.errorCode ?? (event.state === "cancelled" ? "job_cancelled" : "job_failed") : null,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    finishedAt: terminal ? event.finishedAt ?? event.updatedAt : null,
  };
}

function domainResultJob(current: PublicJob, result: ActionResult): PublicJob {
  const next: PublicJob = { ...current };
  delete next.errorCode;
  delete next.retryable;
  if (result.ok) {
    next.status = "done";
    next.progress = 1;
    next.result = boundedJson(result.data);
    next.error = null;
    return next;
  }
  next.status = "error";
  next.result = null;
  next.error = boundedString(result.error.message, 0, 16_384, "domain job error");
  next.errorCode = boundedText(result.error.code, 1, 128, /^[A-Za-z0-9_.-]+$/u, "domain job error code");
  next.retryable = result.error.retryable;
  return next;
}

function jobEvent(job: PublicJob): JobStatusEvent {
  return {
    type: "job-status", jobId: job.id, jobType: job.type, status: job.status, progress: job.progress,
    ...(job.error ? { error: job.error } : {}), at: job.updatedAt,
  };
}

function addInboxItem(state: PersistedState, job: PublicJob, ownerKey: string, projectKey: string): void {
  if (job.status !== "done" && job.status !== "error") return;
  state.inbox = state.inbox.filter((item) => item.read || item.jobType !== job.type || item.projectKey !== projectKey);
  const createdAt = job.finishedAt ?? job.updatedAt;
  const id = `job-${hash(`${ownerKey}\0${projectKey}\0${job.id}`).slice(0, 40)}`;
  const failure = job.status === "error";
  state.inbox.unshift({
    id, kind: "job-complete", jobId: job.id, jobType: job.type,
    title: `${job.type} ${failure ? "failed" : "completed"}`,
    body: failure ? `The job failed (${job.error ?? "job_failed"}).` : "The job completed.",
    status: job.status, read: false, userId: "owner", projectKey, createdAt,
  });
  if (state.inbox.length > MAX_RETAINED_INBOX) state.inbox.length = MAX_RETAINED_INBOX;
}

function pruneJobs(jobs: StoredJob[]): void {
  const overflow = jobs.length - MAX_RETAINED_JOBS;
  if (overflow <= 0) return;
  const finished = jobs.filter(({ job }) => job.status === "done" || job.status === "error")
    .sort((left, right) => (left.job.finishedAt ?? "").localeCompare(right.job.finishedAt ?? ""));
  const remove = new Set(finished.slice(0, overflow).map(({ job }) => job.id));
  for (let index = jobs.length - 1; index >= 0; index--) if (remove.has(jobs[index]!.job.id)) jobs.splice(index, 1);
}

function normalizeState(value: unknown): PersistedState {
  if (isRecord(value) && (value.version === 1 || value.version === 2)) {
    const tool = fileURLToPath(new URL("./maintain-job-history.js", import.meta.url));
    throw new JobHistoryError("job_history_maintenance_required",
      `Host job history requires offline maintenance. Stop the API and run node ${tool} --check with CODEXIA_USAGE_DIR set.`);
  }
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["version", "jobs", "inbox", "legacySources"])) ||
      value.version !== 3 || !Array.isArray(value.jobs) || !Array.isArray(value.inbox) ||
      value.jobs.length > MAX_RETAINED_JOBS || value.inbox.length > MAX_RETAINED_INBOX ||
      !Array.isArray(value.legacySources)) historyCorrupt();
  const jobs: StoredJob[] = value.jobs.map((entry) => {
    const fields = new Set(["kind", "ownerKey", "projectKey", "job"]);
    if (!isRecord(entry) || !hasOnlyKeys(entry, fields) ||
        typeof entry.ownerKey !== "string" || !/^[a-f0-9]{64}$/u.test(entry.ownerKey) ||
        typeof entry.projectKey !== "string" || !/^[a-f0-9]{64}$/u.test(entry.projectKey) || !isRecord(entry.job) ||
        !hasOnlyKeys(entry.job, PUBLIC_JOB_FIELDS)) historyCorrupt();
    const kind = entry.kind;
    if (kind !== "worker" && kind !== "domain" && kind !== "legacy") historyCorrupt();
    const job = normalizePublicJob(entry.job);
    return { kind, ownerKey: entry.ownerKey, projectKey: entry.projectKey, job };
  });
  const ids = new Set<string>();
  for (const record of jobs) {
    if (ids.has(record.job.id)) historyCorrupt();
    ids.add(record.job.id);
  }
  const inbox = value.inbox.map((entry) => normalizeInboxItem(entry));
  if (new Set(inbox.map(({ id }) => id)).size !== inbox.length) historyCorrupt();
  const legacySources = value.legacySources.map((source: unknown) => {
    if (typeof source !== "string" || !/^[a-f0-9]{64}$/u.test(source)) historyCorrupt();
    return source;
  });
  if (new Set(legacySources).size !== legacySources.length) historyCorrupt();
  return { version: 3, jobs, inbox, legacySources };
}

function normalizePublicJob(value: Record<string, unknown>): PublicJob {
  if (typeof value.status !== "string" || !JOB_STATUSES.has(value.status) ||
      (value.progress !== null && (typeof value.progress !== "number" || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1)) ||
      (value.error !== null && (typeof value.error !== "string" || value.error.length > 16_384)) ||
      (value.errorCode !== undefined && (typeof value.errorCode !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/u.test(value.errorCode))) ||
      (value.retryable !== undefined && typeof value.retryable !== "boolean")) historyCorrupt();
  const status = value.status as PublicJobStatus;
  if ((status === "done" || status === "error") !== (value.finishedAt !== null)) historyCorrupt();
  return {
    id: boundedText(value.id, 1, 128, /^[A-Za-z0-9_-]+$/u, "job ID"),
    type: boundedText(value.type, 1, 160, /^[A-Za-z0-9._:-]+$/u, "job type"),
    status,
    progress: value.progress as number | null,
    result: boundedJson(value.result),
    error: value.error as string | null,
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
    ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
    finishedAt: value.finishedAt === null ? null : timestamp(value.finishedAt, "finishedAt"),
  };
}

function normalizeInboxItem(value: unknown): InboxItem {
  if (!isRecord(value) || !hasOnlyKeys(value, INBOX_FIELDS) || value.kind !== "job-complete" ||
      (value.status !== "done" && value.status !== "error") || typeof value.read !== "boolean" ||
      (value.userId !== null && value.userId !== "owner") || typeof value.projectKey !== "string" || !/^[a-f0-9]{64}$/u.test(value.projectKey)) historyCorrupt();
  const status = value.status;
  const jobType = boundedText(value.jobType, 1, 160, /^[A-Za-z0-9._:-]+$/u, "job type");
  return {
    id: boundedText(value.id, 1, 64, /^[A-Za-z0-9_-]+$/u, "inbox ID"),
    kind: "job-complete",
    jobId: boundedText(value.jobId, 1, 128, /^[A-Za-z0-9_-]+$/u, "job ID"),
    jobType,
    title: boundedText(value.title, 1, 4_096, /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/u, "inbox title"),
    body: boundedText(value.body, 0, 16_384, /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/u, "inbox body"),
    status,
    read: value.read,
    userId: value.userId as string | null,
    projectKey: value.projectKey,
    createdAt: timestamp(value.createdAt, "inbox createdAt"),
  };
}

function cloneState(state: PersistedState): PersistedState {
  return {
    version: 3, jobs: state.jobs.map((entry) => ({ ...entry, job: { ...entry.job } })),
    inbox: state.inbox.map((item) => ({ ...item })), legacySources: state.legacySources.slice(),
  };
}

function clonePublicJob(job: PublicJob): PublicJob {
  return normalizePublicJob(job as unknown as Record<string, unknown>);
}

function newestFirst(left: PublicJob, right: PublicJob): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function isFinalStatus(status: PublicJobStatus): boolean {
  return status === "done" || status === "error";
}

function canAdvance(current: PublicJobStatus, next: PublicJobStatus): boolean {
  if (current === next) return true;
  if (current === "queued") return next === "running" || next === "done" || next === "error";
  if (current === "running") return next === "done" || next === "error";
  return false;
}

function orphanRunningJobs(state: PersistedState): boolean {
  let changed = false;
  for (const record of state.jobs) {
    // Imported source rows retain their exact source status; no old task is replayed here.
    if (record.kind === "legacy") continue;
    if (record.job.status !== "queued" && record.job.status !== "running") continue;
    const now = nextTimestamp(record.job.updatedAt);
    record.job.status = "error";
    record.job.error = "worker_interrupted";
    record.job.errorCode = "worker_interrupted";
    record.job.retryable = true;
    record.job.updatedAt = now;
    record.job.finishedAt = now;
    changed = true;
  }
  return changed;
}

function isTerminal(state: WorkerJobLifecycle["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new JobHistoryError("job_event_invalid", `Job ${field} timestamp is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new JobHistoryError("job_event_invalid", `Job ${field} timestamp is invalid`);
  return parsed.toISOString();
}

function nextTimestamp(previous: string): string {
  const now = Date.now();
  const prior = Date.parse(previous);
  return new Date(Math.max(now, Number.isFinite(prior) ? prior + 1 : now)).toISOString();
}

function boundedText(value: unknown, min: number, max: number, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max || !pattern.test(value)) {
    throw new JobHistoryError("job_event_invalid", `Job ${field} is invalid`);
  }
  return value;
}

function boundedString(value: unknown, min: number, max: number, field: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new JobHistoryError("legacy_job_invalid", `Legacy ${field} is invalid`);
  }
  return value;
}

function boundedJson(value: unknown): unknown {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { historyCorrupt(); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) historyCorrupt();
  try { return JSON.parse(encoded) as unknown; }
  catch { historyCorrupt(); }
}

function isProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value);
}

function projectKeyFor(projectId: string): string {
  return hash(`postgres-project\0${projectId}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && fields.has(key));
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function historyCorrupt(): never {
  throw new JobHistoryError("job_history_corrupt", "Host job history contains invalid metadata");
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new JobHistoryError("job_history_path_invalid", "Host job history must use real directories");
  if ((info.mode & 0o077) !== 0) throw new JobHistoryError("job_history_path_permissions", "Host job history directories must be private");
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
