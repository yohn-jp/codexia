import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  RecentActivityInput as ContractRecentActivityInput,
  RecentActivityItem as ContractRecentActivityItem,
} from '@codexia/contracts';

export type { RecentActivityDeviceType, RecentActivityDeviceType as RecentActivityDevice } from '@codexia/contracts';
export type RecentActivityInput = ContractRecentActivityInput;
export type RecentActivityItem = ContractRecentActivityItem;

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_STATE_ENTRIES = 20_000;
const ITEM_FIELDS = new Set(['sceneId', 'sentenceOffset', 'pageIndex', 'deviceType', 'updatedAt']);
const INPUT_FIELDS = new Set(['sceneId', 'sentenceOffset', 'pageIndex', 'deviceType']);
const STATE_FIELDS = new Set(['version', 'entries', 'legacySources']);
const ENTRY_FIELDS = new Set(['key', 'ownerKey', 'projectId', 'items']);

interface StoredEntry {
  key: string;
  ownerKey: string;
  projectId: string;
  items: RecentActivityItem[];
}

interface StoredState {
  version: 1;
  entries: StoredEntry[];
  legacySources: string[];
}

// Keep admission metadata separate from the legacy v1 cursor file so that
// older backends can still read the history during independent replacement.
interface WriterOrder {
  sequence: number;
  pageSequence: number;
}
interface DeviceOrder {
  lastWriter: string | null;
  itemHash: string | null;
  writers: Record<string, WriterOrder>;
}
type OrderState = Record<string, DeviceOrder>;
interface RecentActivityOrder {
  writer: string;
  sequence: number;
}

export class RecentActivityStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RecentActivityStoreError';
  }
}

const queues = new Map<string, Promise<void>>();

/** Host-owned recent editor/reader cursors. Construction performs no filesystem access. */
export class RecentActivityStore {
  private readonly root: string;
  private readonly directory: string;
  private readonly filePath: string;
  private readonly orderPath: string;

  constructor(usageDirectory: string) {
    if (typeof usageDirectory !== 'string' || !usageDirectory.trim()) {
      throw new RecentActivityStoreError('recent_activity_path_invalid', 'A host history directory is required');
    }
    this.root = resolve(usageDirectory);
    this.directory = join(this.root, 'recent-activity');
    this.filePath = join(this.directory, 'recent-activity-state.json');
    this.orderPath = join(this.directory, 'recent-activity-order.json');
  }

  async list(ownerScope: string, projectId: string): Promise<RecentActivityItem[]> {
    const ownerKey = hash(validateOwnerScope(ownerScope));
    const identity = normalizeProjectId(projectId);
    const key = partitionKey(ownerKey, identity);
    const state = await this.readState();
    const entry = state.entries.find(candidate => candidate.key === key);
    if (!entry) return [];
    assertEntryScope(entry, ownerKey, identity);
    return entry.items.map(item => ({ ...item })).sort(newestFirst);
  }

  async upsert(
    ownerScope: string,
    projectId: string,
    input: RecentActivityInput,
    order?: RecentActivityOrder,
  ): Promise<RecentActivityItem[]> {
    const owner = validateOwnerScope(ownerScope);
    const ownerKey = hash(owner);
    const identity = normalizeProjectId(projectId);
    const normalizedInput = normalizeInput(input);
    if (
      order &&
      (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(order.writer) ||
        !Number.isSafeInteger(order.sequence) ||
        order.sequence < 1)
    )
      invalidRecord('Recent activity order is invalid');
    return exclusive(this.filePath, async () => {
      const state = await this.readState();
      const key = partitionKey(ownerKey, identity);
      let entry = state.entries.find(candidate => candidate.key === key);
      if (entry) {
        assertEntryScope(entry, ownerKey, identity);
        entry.projectId = identity;
      } else {
        entry = { key, ownerKey, projectId: identity, items: [] };
        state.entries.push(entry);
      }
      const existing = entry.items.find(item => item.deviceType === normalizedInput.deviceType);
      const ordering = await this.readOrderState();
      const deviceKey = hash(`${key}\\0${normalizedInput.deviceType}`);
      const writerKey = order ? hash(order.writer) : undefined;
      const deviceOrder = ordering[deviceKey];
      const previous = writerKey ? deviceOrder?.writers[writerKey] : undefined;
      const result = () => entry.items.map(candidate => ({ ...candidate })).sort(newestFirst);
      if (order && writerKey && previous && order.sequence <= previous.sequence) {
        // An older reading report can still supply the page omitted by a
        // newer writing report. Never change the newer cursor or timestamp,
        // and never apply the old page over another writer's current record.
        if (
          order.sequence < previous.sequence &&
          order.sequence > previous.pageSequence &&
          normalizedInput.pageIndex !== undefined &&
          existing &&
          existing.sceneId === normalizedInput.sceneId &&
          deviceOrder?.lastWriter === writerKey &&
          deviceOrder.itemHash === hash(JSON.stringify(existing))
        ) {
          existing.pageIndex = normalizedInput.pageIndex;
          previous.pageSequence = order.sequence;
          deviceOrder.itemHash = hash(JSON.stringify(existing));
          const orderBytes = this.serialize(ordering);
          await this.persist(state);
          await this.persistBytes(this.orderPath, orderBytes);
        }
        return result();
      }
      const item: RecentActivityItem = {
        sceneId: normalizedInput.sceneId,
        sentenceOffset: normalizedInput.sentenceOffset,
        pageIndex:
          normalizedInput.pageIndex !== undefined
            ? normalizedInput.pageIndex
            : existing?.sceneId === normalizedInput.sceneId
              ? existing.pageIndex
              : null,
        deviceType: normalizedInput.deviceType,
        updatedAt: new Date().toISOString(),
      };
      entry.items = entry.items.filter(candidate => candidate.deviceType !== item.deviceType);
      entry.items.push(item);
      let orderBytes: string | undefined;
      if (order && writerKey) {
        const device = deviceOrder ?? { lastWriter: null, itemHash: null, writers: {} };
        // A document transition closes the previous visit. A report newer
        // than that visit may still supply an omitted page for this one.
        device.writers[writerKey] = {
          sequence: order.sequence,
          pageSequence:
            normalizedInput.pageIndex !== undefined
              ? order.sequence
              : existing && existing.sceneId !== normalizedInput.sceneId
                ? (previous?.sequence ?? 0)
                : (previous?.pageSequence ?? 0),
        };
        device.lastWriter = writerKey;
        device.itemHash = hash(JSON.stringify(item));
        ordering[deviceKey] = device;
        orderBytes = this.serialize(ordering);
      } else if (deviceOrder?.lastWriter) {
        // Legacy clients remain accepted; their writes invalidate stale-page
        // merging from a prior ordered writer, but not its sequence fence.
        deviceOrder.lastWriter = null;
        deviceOrder.itemHash = null;
        orderBytes = this.serialize(ordering);
      }
      await this.persist(state);
      // A successful response certifies both the cursor and its admission
      // fence. The same exclusive lock spans both atomic file replacements.
      if (orderBytes !== undefined) await this.persistBytes(this.orderPath, orderBytes);
      return result();
    });
  }

  private async readState(): Promise<StoredState> {
    try {
      await assertPrivateDirectory(this.root);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return emptyState();
      throw error;
    }
    try {
      await assertPrivateDirectory(this.directory);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return emptyState();
      throw error;
    }
    const bytes = await readStateFile(this.filePath);
    if (!bytes) return emptyState();
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new RecentActivityStoreError('recent_activity_state_corrupt', 'Recent activity history is not valid JSON');
    }
    return normalizeState(decoded);
  }

  private async readOrderState(): Promise<OrderState> {
    const bytes = await readStateFile(this.orderPath);
    if (!bytes) return {};
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      corruptState();
    }
    if (!isRecord(value)) corruptState();
    const state: OrderState = {};
    const digest = (key: unknown): key is string => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key);
    const sequence = (number: unknown): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
    for (const [key, raw] of Object.entries(value)) {
      if (
        !digest(key) ||
        !isRecord(raw) ||
        !hasOnlyKeys(raw, new Set(['lastWriter', 'itemHash', 'writers'])) ||
        !isRecord(raw.writers) ||
        (raw.lastWriter !== null && !digest(raw.lastWriter)) ||
        (raw.itemHash !== null && !digest(raw.itemHash))
      )
        corruptState();
      const writers: Record<string, WriterOrder> = {};
      for (const [writer, entry] of Object.entries(raw.writers)) {
        if (
          !digest(writer) ||
          !isRecord(entry) ||
          !hasOnlyKeys(entry, new Set(['sequence', 'pageSequence'])) ||
          !sequence(entry.sequence) ||
          entry.sequence < 1 ||
          !sequence(entry.pageSequence) ||
          entry.pageSequence > entry.sequence
        )
          corruptState();
        writers[writer] = { sequence: entry.sequence, pageSequence: entry.pageSequence };
      }
      if ((raw.lastWriter === null) !== (raw.itemHash === null) || (raw.lastWriter !== null && !writers[raw.lastWriter])) corruptState();
      state[key] = { lastWriter: raw.lastWriter, itemHash: raw.itemHash, writers };
    }
    return state;
  }

  private serialize(value: unknown): string {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      throw new RecentActivityStoreError('recent_activity_history_full', 'Recent activity history exceeds its storage limit');
    }
    return serialized;
  }

  private async persist(state: StoredState): Promise<void> {
    await this.persistBytes(this.filePath, this.serialize(state));
  }

  private async persistBytes(path: string, serialized: string): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(this.directory);
    await syncDirectory(this.root);
    const temporary = join(this.directory, `.tmp-${randomBytes(16).toString('hex')}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      await syncDirectory(this.directory);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function normalizeInput(value: unknown): RecentActivityInput {
  if (!isRecord(value) || !hasOnlyKeys(value, INPUT_FIELDS)) invalidRecord('Recent activity input is invalid');
  const sceneId = boundedText(value.sceneId, 1, 512, 'scene ID');
  const sentenceOffset = value.sentenceOffset;
  if (sentenceOffset !== null && !Number.isSafeInteger(sentenceOffset)) invalidRecord('Recent activity sentence offset is invalid');
  if (value.deviceType !== 'desktop' && value.deviceType !== 'mobile') invalidRecord('Recent activity device type is invalid');
  if (
    value.pageIndex !== undefined &&
    value.pageIndex !== null &&
    (!Number.isSafeInteger(value.pageIndex) || (value.pageIndex as number) < 0)
  ) {
    invalidRecord('Recent activity page index is invalid');
  }
  return {
    sceneId,
    sentenceOffset: sentenceOffset as number | null,
    ...(value.pageIndex === undefined ? {} : { pageIndex: value.pageIndex as number | null }),
    deviceType: value.deviceType,
  };
}

function normalizeStoredItem(value: unknown): RecentActivityItem {
  if (!isRecord(value) || !hasOnlyKeys(value, ITEM_FIELDS)) invalidRecord('Stored recent activity item is invalid');
  const input = normalizeInput({
    sceneId: value.sceneId,
    sentenceOffset: value.sentenceOffset,
    ...(value.pageIndex === undefined ? {} : { pageIndex: value.pageIndex }),
    deviceType: value.deviceType,
  });
  if (typeof value.updatedAt !== 'string' || !value.updatedAt.trim()) invalidRecord('Stored recent activity timestamp is invalid');
  const updatedAt = timestamp(value.updatedAt);
  return {
    sceneId: input.sceneId,
    sentenceOffset: input.sentenceOffset,
    pageIndex: input.pageIndex ?? null,
    deviceType: input.deviceType,
    updatedAt,
  };
}

function normalizeState(value: unknown): StoredState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, STATE_FIELDS) ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_STATE_ENTRIES ||
    !Array.isArray(value.legacySources)
  ) {
    throw new RecentActivityStoreError('recent_activity_state_corrupt', 'Recent activity history contains invalid metadata');
  }
  const entries = value.entries.map((raw): StoredEntry => {
    if (
      !isRecord(raw) ||
      !hasOnlyKeys(raw, ENTRY_FIELDS) ||
      typeof raw.key !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(raw.key) ||
      typeof raw.ownerKey !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(raw.ownerKey) ||
      !isProjectId(raw.projectId) ||
      !Array.isArray(raw.items) ||
      raw.items.length > 2
    )
      corruptState();
    const repository = normalizeProjectId(raw.projectId);
    const items = raw.items.map(normalizeStoredItem);
    if (new Set(items.map(({ deviceType }) => deviceType)).size !== items.length || raw.key !== partitionKey(raw.ownerKey, repository))
      corruptState();
    return { key: raw.key, ownerKey: raw.ownerKey, projectId: repository, items };
  });
  if (new Set(entries.map(({ key }) => key)).size !== entries.length) corruptState();
  const legacySources = value.legacySources.map(source => {
    if (typeof source !== 'string' || !/^[a-f0-9]{64}$/u.test(source)) corruptState();
    return source;
  });
  if (new Set(legacySources).size !== legacySources.length) corruptState();
  return { version: 1, entries, legacySources };
}

function assertEntryScope(entry: StoredEntry, ownerKey: string, projectId: string): void {
  if (
    entry.ownerKey !== ownerKey ||
    partitionKey(entry.ownerKey, entry.projectId) !== entry.key ||
    partitionKey(ownerKey, projectId) !== entry.key
  ) {
    throw new RecentActivityStoreError(
      'recent_activity_identity_conflict',
      'Recent activity belongs to a different owner or project identity',
    );
  }
}

function normalizeProjectId(value: unknown): string {
  if (!isProjectId(value)) invalidRecord('Project identity is invalid');
  return value;
}

function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/u.test(value);
}

function validateOwnerScope(value: unknown): string {
  return boundedText(value, 1, 256, 'owner scope');
}

function partitionKey(ownerKey: string, projectId: string): string {
  return hash(`${ownerKey}\0postgres-project\0${projectId}`);
}

function newestFirst(left: RecentActivityItem, right: RecentActivityItem): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.deviceType.localeCompare(right.deviceType);
}

function emptyState(): StoredState {
  return { version: 1, entries: [], legacySources: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.has(key));
}

function boundedText(value: unknown, min: number, max: number, field: string): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || hasControlCharacter(value)) {
    invalidRecord(`Recent activity ${field} is invalid`);
  }
  return value as string;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    invalidRecord('Recent activity timestamp is invalid');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalidRecord('Recent activity timestamp is invalid');
  return parsed.toISOString();
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function invalidRecord(message = 'Recent activity metadata is invalid'): never {
  throw new RecentActivityStoreError('recent_activity_record_invalid', message);
}

function corruptState(): never {
  throw new RecentActivityStoreError('recent_activity_state_corrupt', 'Recent activity history contains invalid metadata');
}

async function exclusive<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolveQueue => {
    release = resolveQueue;
  });
  queues.set(path, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queues.get(path) === current) queues.delete(path);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RecentActivityStoreError('recent_activity_path_invalid', 'Recent activity history must use real directories');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new RecentActivityStoreError('recent_activity_path_permissions', 'Recent activity history directories must be private');
  }
}

async function readStateFile(path: string): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_STATE_BYTES || (info.mode & 0o077) !== 0) {
      throw new RecentActivityStoreError(
        'recent_activity_state_corrupt',
        'Recent activity file must be private, regular, and within its size limit',
      );
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof RecentActivityStoreError) throw error;
    if (isCode(error, 'ENOENT')) return undefined;
    throw new RecentActivityStoreError('recent_activity_state_corrupt', 'Recent activity file cannot be read safely');
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
