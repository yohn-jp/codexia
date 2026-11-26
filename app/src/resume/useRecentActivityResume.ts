import type { RecentActivityDeviceType, RecentActivityInput, RecentActivityItem } from '@codexia/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  loadWritingResume,
  type RecentActivityIdentity,
  type RecentActivityProjectIdentity,
  recentActivityIdentityKey,
  saveReadingPage,
  saveWritingResume,
  type WritingResumePosition,
} from './continueCandidates';

const LOCAL_DEBOUNCE_MS = 400;
const SERVER_DEBOUNCE_MS = 2_000;
const REFRESH_INTERVAL_MS = 15_000;

// One writer identity and sequence for this document, even if a shell remounts.
let activityWriter: string | undefined;
let activitySequence = 0;

interface Binding extends RecentActivityIdentity {
  identityKey: string;
  projectIdentityKey: string;
}

interface PendingLocal {
  binding?: Binding;
  writing?: WritingResumePosition;
  reading?: { sceneId: string; pageIndex: number };
}

interface PendingServer {
  binding: Binding;
  input: RecentActivityInput;
}

export interface RecentActivityResumeState {
  items: RecentActivityItem[];
  snapshotIdentityKey: string;
  itemsProjectIdentityKey: string;
  localWriting: WritingResumePosition | null;
  error: string;
  deviceType: RecentActivityDeviceType;
  onWritingPosition: (sceneId: string, cursorSentenceIndex: number | null, scrollTop: number) => void;
  onReadingPage: (sceneId: string, pageIndex: number) => void;
  flush: (keepalive?: boolean) => void;
}

function deviceTypeForViewport(): RecentActivityDeviceType {
  return window.matchMedia('(max-width: 760px)').matches ? 'mobile' : 'desktop';
}

/**
 * Cross-device cursor/page sync. Local resume remains separate from the
 * IndexedDB manuscript journal and only numeric positions are sent remotely.
 */
export function useRecentActivityResume({
  binding,
  enabled,
}: {
  binding: Omit<Binding, 'identityKey' | 'projectIdentityKey'> | null;
  enabled: boolean;
}): RecentActivityResumeState {
  const projectIdentity: RecentActivityProjectIdentity | null = binding
    ? {
        authorScope: binding.authorScope,
        projectScopeKey: binding.projectScopeKey,
        projectId: binding.projectId,
      }
    : null;
  const projectIdentityKey = projectIdentity ? recentActivityIdentityKey(projectIdentity) : '';
  const identityKey = binding ? recentActivityIdentityKey(binding) : '';
  const bindingRef = useRef<Binding | null>(null);
  // Keep one binding per visit. Returning to the same identity after a
  // switch must not revive responses from the earlier visit.
  if (!binding || !enabled) bindingRef.current = null;
  else if (bindingRef.current?.identityKey !== identityKey) {
    bindingRef.current = { ...binding, identityKey, projectIdentityKey };
  }
  const currentBinding = bindingRef.current;
  const [deviceType, setDeviceType] = useState<RecentActivityDeviceType>(deviceTypeForViewport);
  const [items, setItems] = useState<RecentActivityItem[]>([]);
  const [snapshotIdentityKey, setSnapshotIdentityKey] = useState('');
  const [itemsProjectIdentityKey, setItemsProjectIdentityKey] = useState('');
  const [localWriting, setLocalWriting] = useState<WritingResumePosition | null>(null);
  const [error, setError] = useState('');
  const pendingLocalRef = useRef<PendingLocal>({});
  const pendingServerRef = useRef<PendingServer | null>(null);
  const localTimerRef = useRef<number | null>(null);
  const serverTimerRef = useRef<number | null>(null);
  const lastWritingRef = useRef<{ bindingKey: string; position: WritingResumePosition } | null>(null);
  const latestWriteVersionRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const localFlushRef = useRef<() => void>(() => undefined);
  const serverFlushRef = useRef<(keepalive?: boolean) => void>(() => undefined);

  localFlushRef.current = () => {
    if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current);
    localTimerRef.current = null;
    const pending = pendingLocalRef.current;
    pendingLocalRef.current = {};
    const captured = pending.binding;
    if (!captured) return;
    if (pending.writing) {
      saveWritingResume(captured.authorScope, captured.projectScopeKey, pending.writing);
      lastWritingRef.current = { bindingKey: captured.projectIdentityKey, position: pending.writing };
      if (bindingRef.current?.projectIdentityKey === captured.projectIdentityKey) setLocalWriting(pending.writing);
    }
    if (pending.reading)
      saveReadingPage(captured.authorScope, captured.projectScopeKey, pending.reading.sceneId, pending.reading.pageIndex);
  };

  serverFlushRef.current = (keepalive = false) => {
    if (serverTimerRef.current !== null) window.clearTimeout(serverTimerRef.current);
    serverTimerRef.current = null;
    const pending = pendingServerRef.current;
    pendingServerRef.current = null;
    if (!pending) return;
    if (bindingRef.current?.authorScope !== pending.binding.authorScope) return;
    const version = ++latestWriteVersionRef.current;
    // Dispatch immediately, including on pagehide. The server rejects older
    // reports from this writer, so a delayed PUT cannot rewind the cursor.
    activityWriter ??= crypto.randomUUID();
    const order = `${activityWriter}:${++activitySequence}`;
    void api
      .putRecentActivity(pending.binding.projectId, pending.input, { keepalive, order })
      .then(response => {
        const active = bindingRef.current;
        if (version === latestWriteVersionRef.current && active === pending.binding) {
          setItems(response.items);
          setSnapshotIdentityKey(active.identityKey);
          setItemsProjectIdentityKey(active.projectIdentityKey);
          setError('');
        }
      })
      .catch((caught: unknown) => {
        if (version === latestWriteVersionRef.current && bindingRef.current === pending.binding) {
          setError(caught instanceof Error ? caught.message : '再開位置を同期できませんでした。');
        }
      });
  };

  const flush = useCallback((keepalive = false) => {
    localFlushRef.current();
    serverFlushRef.current(keepalive);
  }, []);

  useEffect(() => {
    if (!currentBinding) {
      setItems([]);
      setSnapshotIdentityKey('');
      setItemsProjectIdentityKey('');
      setLocalWriting(null);
      setError('');
      return;
    }
    const captured = currentBinding;
    const controller = new AbortController();
    let alive = true;
    setItems([]);
    setSnapshotIdentityKey(captured.identityKey);
    setItemsProjectIdentityKey(captured.projectIdentityKey);
    const local = loadWritingResume(captured.authorScope, captured.projectScopeKey);
    lastWritingRef.current = local ? { bindingKey: captured.projectIdentityKey, position: local } : null;
    setLocalWriting(local);

    let refreshTimer: number | null = null;
    let pageHidden = false;
    const stopRefreshTimer = () => {
      if (refreshTimer !== null) window.clearInterval(refreshTimer);
      refreshTimer = null;
    };
    const startRefreshTimer = () => {
      if (refreshTimer === null && document.visibilityState === 'visible') {
        refreshTimer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
      }
    };

    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      const sequence = ++refreshSequenceRef.current;
      const startedAt = latestWriteVersionRef.current;
      try {
        const response = await api.recentActivity(captured.projectId, controller.signal);
        if (
          alive &&
          !controller.signal.aborted &&
          sequence === refreshSequenceRef.current &&
          startedAt === latestWriteVersionRef.current &&
          bindingRef.current === captured
        ) {
          setItems(response.items);
          setSnapshotIdentityKey(captured.identityKey);
          setItemsProjectIdentityKey(captured.projectIdentityKey);
          setError('');
        }
      } catch (caught) {
        if (!alive || controller.signal.aborted) return;
        if (bindingRef.current === captured) {
          setError(caught instanceof Error ? caught.message : '再開位置を読み込めませんでした。');
        }
      }
    };
    if (document.visibilityState === 'visible') void refresh();
    startRefreshTimer();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        startRefreshTimer();
      } else {
        refreshSequenceRef.current += 1;
        stopRefreshTimer();
        flush(true);
      }
    };
    const onPageHide = () => {
      pageHidden = true;
      flush(true);
    };
    const onPageShow = () => {
      if (!pageHidden) return;
      pageHidden = false;
      if (document.visibilityState === 'visible') {
        void refresh();
        startRefreshTimer();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onPageHide);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      alive = false;
      controller.abort();
      stopRefreshTimer();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onPageHide);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      flush(true);
    };
  }, [currentBinding, flush]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setDeviceType(media.matches ? 'mobile' : 'desktop');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const onWritingPosition = useCallback(
    (sceneId: string, cursorSentenceIndex: number | null, scrollTop: number) => {
      const active = bindingRef.current;
      if (!active || !enabled || active.viewTarget !== 'writing' || sceneId !== active.documentId) return;
      const position: WritingResumePosition = { sceneId, cursorSentenceIndex, scrollTop: Math.max(0, scrollTop) };
      lastWritingRef.current = { bindingKey: active.projectIdentityKey, position };
      if (pendingLocalRef.current.binding && pendingLocalRef.current.binding.identityKey !== active.identityKey) localFlushRef.current();
      pendingLocalRef.current = { ...pendingLocalRef.current, binding: active, writing: position };
      if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current);
      localTimerRef.current = window.setTimeout(() => localFlushRef.current(), LOCAL_DEBOUNCE_MS);
      const input: RecentActivityInput = { sceneId, sentenceOffset: cursorSentenceIndex, deviceType };
      pendingServerRef.current = { binding: active, input };
      if (serverTimerRef.current !== null) window.clearTimeout(serverTimerRef.current);
      serverTimerRef.current = window.setTimeout(() => serverFlushRef.current(), SERVER_DEBOUNCE_MS);
    },
    [enabled, deviceType],
  );

  const onReadingPage = useCallback(
    (sceneId: string, pageIndex: number) => {
      const active = bindingRef.current;
      if (
        !active ||
        !enabled ||
        active.viewTarget !== 'reading' ||
        sceneId !== active.documentId ||
        !Number.isSafeInteger(pageIndex) ||
        pageIndex < 0
      )
        return;
      if (pendingLocalRef.current.binding && pendingLocalRef.current.binding.identityKey !== active.identityKey) localFlushRef.current();
      pendingLocalRef.current = { ...pendingLocalRef.current, binding: active, reading: { sceneId, pageIndex } };
      if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current);
      localTimerRef.current = window.setTimeout(() => localFlushRef.current(), LOCAL_DEBOUNCE_MS);
      const localWriting = lastWritingRef.current?.bindingKey === active.projectIdentityKey ? lastWritingRef.current.position : null;
      const serverWriting =
        itemsProjectIdentityKey === active.projectIdentityKey
          ? items.find(item => item.deviceType === deviceType && item.sceneId === sceneId)?.sentenceOffset
          : null;
      const writing = localWriting?.sceneId === sceneId ? localWriting.cursorSentenceIndex : (serverWriting ?? null);
      const input: RecentActivityInput = {
        sceneId,
        sentenceOffset: writing,
        pageIndex,
        deviceType,
      };
      pendingServerRef.current = { binding: active, input };
      if (serverTimerRef.current !== null) window.clearTimeout(serverTimerRef.current);
      serverTimerRef.current = window.setTimeout(() => serverFlushRef.current(), SERVER_DEBOUNCE_MS);
    },
    [enabled, items, itemsProjectIdentityKey, deviceType],
  );

  return { items, snapshotIdentityKey, itemsProjectIdentityKey, localWriting, error, onWritingPosition, onReadingPage, flush, deviceType };
}
