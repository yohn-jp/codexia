import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { RecentActivityStore } from './recent-activity-store.js';

const repository = 'project-one';

describe('RecentActivityStore', () => {
  it('keeps per-device cursors private, owner/repository scoped, and durable across store instances', async t => {
    const root = await mkdtemp(resolve(tmpdir(), 'codexia-recent-activity-'));
    const usageDirectory = resolve(root, 'host-history');
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = new RecentActivityStore(usageDirectory);
    await assert.rejects(
      lstat(usageDirectory),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      'construction must not create storage',
    );
    assert.deepEqual(await first.list('owner', repository), []);
    await assert.rejects(
      lstat(usageDirectory),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      'empty reads must not create storage',
    );

    await first.upsert('owner', repository, { sceneId: 'scene-one', sentenceOffset: 2, pageIndex: 8, deviceType: 'desktop' });
    const sameDocument = await first.upsert('owner', repository, { sceneId: 'scene-one', sentenceOffset: null, deviceType: 'desktop' });
    assert.equal(
      sameDocument.find(item => item.deviceType === 'desktop')?.pageIndex,
      8,
      'omitted pageIndex keeps the existing document value',
    );
    const nextDocument = await first.upsert('owner', repository, { sceneId: 'scene-two', sentenceOffset: null, deviceType: 'desktop' });
    assert.equal(
      nextDocument.find(item => item.deviceType === 'desktop')?.pageIndex,
      null,
      'a different document does not inherit the page',
    );
    await first.upsert('owner', repository, { sceneId: 'scene-two', sentenceOffset: null, pageIndex: 4, deviceType: 'desktop' });
    const clearedPage = await first.upsert('owner', repository, {
      sceneId: 'scene-two',
      sentenceOffset: null,
      pageIndex: null,
      deviceType: 'desktop',
    });
    assert.equal(clearedPage.find(item => item.deviceType === 'desktop')?.pageIndex, null, 'explicit null clears the page');
    await first.upsert('owner', repository, { sceneId: 'scene-mobile', sentenceOffset: 0, pageIndex: 1, deviceType: 'mobile' });

    const statePath = resolve(usageDirectory, 'recent-activity', 'recent-activity-state.json');
    const installed = JSON.parse(await readFile(statePath, 'utf8'));
    const sources = ['a'.repeat(64)];
    await writeFile(statePath, JSON.stringify({ ...installed, legacySources: sources }));
    const restarted = new RecentActivityStore(usageDirectory);
    assert.equal((await restarted.list('owner', repository)).length, 2);
    assert.deepEqual(await restarted.list('another-owner', repository), []);
    assert.deepEqual(await restarted.list('owner', 'project-two'), []);
    assert.equal((await lstat(resolve(usageDirectory, 'recent-activity'))).mode & 0o777, 0o700);
    await restarted.upsert('owner', repository, { sceneId: 'next', sentenceOffset: 3, deviceType: 'desktop' });
    const state = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assert.equal((await state.stat()).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await state.readFile('utf8')).legacySources, sources);
    } finally {
      await state.close();
    }
  });

  it('rejects a new partition at the entry limit without corrupting readable cursors', async t => {
    const root = await mkdtemp(resolve(tmpdir(), 'codexia-recent-limit-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const history = resolve(root, 'history');
    const store = new RecentActivityStore(history);
    const input = { sceneId: 'scene-one', sentenceOffset: 1, deviceType: 'desktop' as const };
    await store.upsert('owner', repository, input);
    const statePath = resolve(history, 'recent-activity', 'recent-activity-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const ownerKey = state.entries[0].ownerKey;
    for (let i = 1; i < 20_000; i++) {
      const projectId = `limit-${i}`;
      const key = createHash('sha256').update(`${ownerKey}\0postgres-project\0${projectId}`).digest('hex');
      state.entries.push({ key, ownerKey, projectId, items: [] });
    }
    await writeFile(statePath, JSON.stringify(state));
    const before = await readFile(statePath);
    await assert.rejects(store.upsert('owner', 'overflow', input), { code: 'recent_activity_history_full' });
    assert.deepEqual(await readFile(statePath), before);
    const restarted = new RecentActivityStore(history);
    assert.equal((await restarted.list('owner', repository))[0]?.sentenceOffset, 1);
    await restarted.upsert('owner', repository, { ...input, sentenceOffset: 2 });
    assert.equal((await restarted.list('owner', repository))[0]?.sentenceOffset, 2);
  });

  it('fences reordered reports across store instances while merging only the omitted reading page', async t => {
    const root = await mkdtemp(resolve(tmpdir(), 'codexia-recent-order-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const history = resolve(root, 'history');
    const writer = '12345678-1234-4234-8234-123456789abc';
    const otherWriter = '87654321-1234-4234-8234-123456789abc';
    const first = new RecentActivityStore(history);
    const put = (store: RecentActivityStore, sequence: number, sentenceOffset: number, pageIndex?: number) =>
      store.upsert(
        'owner',
        repository,
        { sceneId: 'scene-one', sentenceOffset, deviceType: 'desktop', ...(pageIndex === undefined ? {} : { pageIndex }) },
        { writer, sequence },
      );
    await put(first, 3, 30);
    const restarted = new RecentActivityStore(history);
    const current = (await restarted.list('owner', repository))[0]!;
    assert.equal(current.sentenceOffset, 30);
    const stale = (await put(restarted, 1, 10))[0]!;
    assert.deepEqual(stale, current);
    const olderPage = (await put(restarted, 2, 20, 7))[0]!;
    assert.equal(olderPage.sentenceOffset, 30);
    assert.equal(olderPage.pageIndex, 7);
    assert.equal(olderPage.updatedAt, current.updatedAt);
    assert.deepEqual((await put(restarted, 1, 10, 2))[0], olderPage);
    await put(restarted, 5, 50, 9);
    assert.equal((await put(restarted, 4, 40, 8))[0]?.pageIndex, 9);
    await put(restarted, 7, 70);
    await restarted.upsert(
      'owner',
      repository,
      { sceneId: 'other', sentenceOffset: 80, pageIndex: 12, deviceType: 'desktop' },
      { writer: otherWriter, sequence: 1 },
    );
    assert.equal((await put(restarted, 6, 60, 1))[0]?.pageIndex, 12);
    await put(restarted, 9, 90);
    await restarted.upsert('owner', repository, { sceneId: 'legacy', sentenceOffset: 100, pageIndex: 14, deviceType: 'desktop' });
    assert.equal((await put(restarted, 8, 80, 1))[0]?.pageIndex, 14);
    await restarted.upsert(
      'another-owner',
      repository,
      { sceneId: 'other-owner', sentenceOffset: 1, deviceType: 'desktop' },
      { writer, sequence: 1 },
    );
    await restarted.upsert(
      'owner',
      'other-project',
      { sceneId: 'other-project', sentenceOffset: 1, deviceType: 'desktop' },
      { writer, sequence: 1 },
    );
    await restarted.upsert('owner', repository, { sceneId: 'mobile', sentenceOffset: 1, deviceType: 'mobile' }, { writer, sequence: 1 });
    assert.equal((await restarted.list('another-owner', repository))[0]?.sceneId, 'other-owner');
    assert.equal((await restarted.list('owner', 'other-project'))[0]?.sceneId, 'other-project');
    assert.equal((await restarted.list('owner', repository)).find(item => item.deviceType === 'mobile')?.sceneId, 'mobile');
    assert.equal((await lstat(resolve(history, 'recent-activity', 'recent-activity-order.json'))).mode & 0o777, 0o600);
    const legacyFile = JSON.parse(await readFile(resolve(history, 'recent-activity', 'recent-activity-state.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(legacyFile).sort(), ['entries', 'legacySources', 'version']);
  });

  it('does not merge a delayed reading page into a newer document', async t => {
    const root = await mkdtemp(resolve(tmpdir(), 'codexia-recent-identity-order-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new RecentActivityStore(resolve(root, 'history'));
    const writer = '12345678-1234-4234-8234-123456789abc';

    await store.upsert('owner', repository, { sceneId: 'scene-two', sentenceOffset: 20, deviceType: 'desktop' }, { writer, sequence: 2 });
    const delayedReading = await store.upsert(
      'owner',
      repository,
      { sceneId: 'scene-one', sentenceOffset: 10, pageIndex: 8, deviceType: 'desktop' },
      { writer, sequence: 1 },
    );

    const latest = delayedReading.find(item => item.deviceType === 'desktop');
    assert.equal(latest?.sceneId, 'scene-two');
    assert.equal(latest?.sentenceOffset, 20);
    assert.equal(latest?.pageIndex, null);
  });

  it('does not restore a delayed page from a previous visit to the same document', async t => {
    const root = await mkdtemp(resolve(tmpdir(), 'codexia-recent-return-order-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const history = resolve(root, 'history');
    const writer = '12345678-1234-4234-8234-123456789abc';

    const put = (store: RecentActivityStore, sceneId: string, sequence: number, pageIndex?: number) =>
      store.upsert(
        'owner',
        repository,
        { sceneId, sentenceOffset: sequence, deviceType: 'desktop', ...(pageIndex === undefined ? {} : { pageIndex }) },
        { writer, sequence },
      );

    const store = new RecentActivityStore(history);
    await put(store, 'scene-one', 1);
    await put(store, 'scene-two', 3);
    await put(store, 'scene-one', 5);
    const restarted = new RecentActivityStore(history);
    assert.equal((await put(restarted, 'scene-one', 2, 8))[0]?.pageIndex, null);
    assert.equal((await put(restarted, 'scene-one', 4, 4))[0]?.pageIndex, 4);
    assert.equal((await restarted.list('owner', repository))[0]?.sentenceOffset, 5);
  });
});
