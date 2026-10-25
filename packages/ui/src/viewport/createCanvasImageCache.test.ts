import { createEmptyPartDocument, UNDO_LIMIT } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSketchCanvas, type DecodedCanvasImage } from '../file/canvasFile.js';
import { activePartDocument } from '../store/documentKind.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createCanvasImageCache } from './createCanvasImageCache.js';
import { createViewportCleanupQueue } from './viewportLifetime.js';

beforeEach(resetTestStore);
afterEach(() => { vi.useRealTimers(); });
it('returns a failed late bitmap through the application scheduler after one disposal', async () => {
  vi.useFakeTimers();
  let resolve: (image: DecodedCanvasImage) => void = () => { throw new Error('decode missing'); };
  let fail = true;
  const close = vi.fn(() => { if (fail) throw new Error('bitmap return'); });
  const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1);
  const cache = createCanvasImageCache({
    readSource: () => ({ documentId: 'doc', canvases: [{ imageId: 'image' }], images: new Map([['image', bytes]]), retries: new Map() }),
    decode: () => new Promise<DecodedCanvasImage>(done => { resolve = done; }),
    publish: vi.fn(), setLoad: vi.fn(), reportInvalid: vi.fn(),
  });
  const queue = createViewportCleanupQueue((retry, delay) => {
    const timer = setTimeout(retry, delay); return () => { clearTimeout(timer); };
  });
  queue.whenAvailable('bitmap-owner', () => undefined);
  cache.sync(); cache.dispose();
  queue.retain('bitmap-owner', {
    retry: () => { cache.dispose(); return !cache.cleanupPending(); },
    read: () => ({ viewportOwnerId: 'bitmap-owner', pendingCount: 1, errors: ['bitmap return pending'],
      hostDisplayCopyBytes: 0, hostGpuAttributeBytes: 0, unknown: ['decodedBitmap'], observationActive: true }),
  });
  resolve({ width: 1, height: 1, close }); await Promise.resolve(); await Promise.resolve();
  expect(close).toHaveBeenCalledTimes(1); expect(queue.pendingCount).toBe(1);
  vi.advanceTimersByTime(250);
  expect(close).toHaveBeenCalledTimes(2); expect(queue.pendingCount).toBe(1);
  fail = false; vi.advanceTimersByTime(500);
  expect(close).toHaveBeenCalledTimes(3); expect(queue.ownerCount).toBe(0);
  expect(queue.pendingCount).toBe(0); expect(vi.getTimerCount()).toBe(0);
  cache.dispose(); expect(close).toHaveBeenCalledTimes(3);
});
it('retains failed late image returns without rejecting the decode promise', async () => {
  let resolve!: (image: DecodedCanvasImage) => void;
  let failClose = true;
  const close = vi.fn(() => { if (failClose) throw new Error('image return'); });
  const settled = vi.fn();
  const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1);
  const cache = createCanvasImageCache({
    readSource: () => ({ documentId: 'doc', canvases: [{ imageId: 'image' }], images: new Map([['image', bytes]]), retries: new Map() }),
    decode: () => new Promise<DecodedCanvasImage>(done => { resolve = done; }),
    publish: vi.fn(), setLoad: vi.fn(), reportInvalid: vi.fn(), onCleanupSettled: settled,
  });
  cache.sync(); cache.dispose();
  expect(cache.cleanupPending()).toBe(true);
  resolve({ width: 1, height: 1, close });
  await Promise.resolve(); await Promise.resolve();
  expect(close).toHaveBeenCalledTimes(1); expect(cache.cleanupPending()).toBe(true);
  expect(settled).not.toHaveBeenCalled();
  failClose = false; cache.dispose();
  expect(cache.cleanupPending()).toBe(false); expect(close).toHaveBeenCalledTimes(2);
  cache.sync(); cache.dispose();
  expect(settled).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(2);
});

it('attempts every image and load return even when independent owners throw', async () => {
  const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1);
  let fail = true;
  const firstClose = vi.fn(() => { if (fail) throw new Error('first image'); });
  const secondClose = vi.fn();
  const loads = vi.fn((id: string, _owner: unknown, load: unknown) => {
    if (id === 'a' && load === null && fail) throw new Error('load owner');
  });
  const cache = createCanvasImageCache({
    readSource: () => ({ documentId: 'doc', canvases: [{ imageId: 'a' }, { imageId: 'b' }],
      images: new Map([['a', bytes], ['b', bytes]]), retries: new Map() }),
    decode: vi.fn().mockResolvedValueOnce({ width: 1, height: 1, close: firstClose })
      .mockResolvedValueOnce({ width: 1, height: 1, close: secondClose }),
    publish: vi.fn(), setLoad: loads, reportInvalid: vi.fn(),
  });
  cache.sync(); await Promise.resolve();
  cache.dispose();
  expect(firstClose).toHaveBeenCalledTimes(1); expect(secondClose).toHaveBeenCalledTimes(1);
  expect(loads.mock.calls.filter(call => call[2] === null)).toHaveLength(2);
  expect(cache.cleanupPending()).toBe(true);
  fail = false; cache.dispose(); cache.dispose();
  expect(firstClose).toHaveBeenCalledTimes(2); expect(secondClose).toHaveBeenCalledTimes(1);
  expect(loads.mock.calls.filter(call => call[2] === null)).toHaveLength(3);
  expect(cache.cleanupPending()).toBe(false);
});
const bytesA = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1);
const bytesB = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2);
const legacyId = 'canvas-1';

function openPart(name: string, bytes: Uint8Array): void {
  const canvas = newSketchCanvas([], 'xy', name, { width: 100, height: 100 }, legacyId);
  // partFile の実順序。旧ファイル同士が同じ画像番号を持つケース。
  useAppStore.getState().setCanvasImages(new Map([[legacyId, bytes]]));
  useAppStore.getState().applyDocument({ ...createEmptyPartDocument(), name, canvases: [canvas] },
    { replacesDocument: true });
}

function harness(options: {
  readonly autoSync?: boolean;
  readonly readFails?: () => boolean;
  readonly releaseFails?: () => boolean;
} = {}) {
  const requests: { bytes: Uint8Array; resolve: (image: DecodedCanvasImage) => void; reject: () => void }[] = [];
  let shown: ReadonlyMap<string, DecodedCanvasImage> = new Map();
  const publish = vi.fn((images: ReadonlyMap<string, DecodedCanvasImage>) => { shown = images; });
  const cache = createCanvasImageCache({
    readSource: () => {
      if (options.readFails?.()) throw new Error('source unavailable');
      const state = useAppStore.getState();
      return { documentId: state.activeDocumentId, canvases: activePartDocument(state)?.canvases ?? [],
        images: state.canvases, retries: state.canvasImageRetries };
    },
    decode: (bytes) => new Promise<DecodedCanvasImage>((resolve, reject) => {
      requests.push({ bytes, resolve, reject: () => { reject(new Error('Invalid image')); } });
    }),
    publish,
    setLoad: (id, owner, load) => {
      if (load === null && options.releaseFails?.()) throw new Error('load return');
      useAppStore.getState().setCanvasImageLoad(id, owner, load);
    },
    reportInvalid: (message) => { useAppStore.getState().setCanvasMessage(message); },
  });
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (options.autoSync === false) return;
    if (next.document !== previous.document || next.canvases !== previous.canvases
      || next.canvasImageRetries !== previous.canvasImageRetries
      || next.activeDocumentId !== previous.activeDocumentId || next.assembly !== previous.assembly
      || next.drawing !== previous.drawing) cache.sync();
  });
  return { cache, requests, publish, shown: () => shown, dispose: () => { unsubscribe(); cache.dispose(); } };
}

function image(width: number) { return { width, height: 50, close: vi.fn() }; }

it.each(['before disposal', 'after disposal'] as const)(
  'returns every decoded image exactly once across 100 cache lifetimes completing %s', async completion => {
    openPart('A', bytesA);
    const images: ReturnType<typeof image>[] = [];
    type PendingLifetime = { h: ReturnType<typeof harness>; decoded: ReturnType<typeof image> };
    let previous: PendingLifetime | null = null;
    async function settleDisposed(entry: PendingLifetime): Promise<void> {
      const state = useAppStore.getState();
      const shown = entry.h.shown();
      const publications = entry.h.publish.mock.calls.length;
      expect(entry.h.cache.cleanupPending()).toBe(true);
      entry.h.requests[0].resolve(entry.decoded);
      await Promise.resolve(); await Promise.resolve();
      expect(entry.decoded.close).toHaveBeenCalledTimes(1);
      expect(entry.h.cache.cleanupPending()).toBe(false);
      expect(entry.h.shown()).toBe(shown);
      expect(entry.h.publish).toHaveBeenCalledTimes(publications);
      // Includes the next lifetime's same-ID loading owner, when present.
      expect(useAppStore.getState()).toBe(state);
      entry.h.cache.sync(); entry.h.cache.clear(); entry.h.dispose();
      expect(entry.h.requests).toHaveLength(1);
      expect(entry.decoded.close).toHaveBeenCalledTimes(1);
      expect(entry.h.publish).toHaveBeenCalledTimes(publications);
      expect(useAppStore.getState()).toBe(state);
    }
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const h = harness({ autoSync: false });
      const decoded = image(100 + cycle);
      images.push(decoded);
      try {
        h.cache.sync();
        expect(h.requests).toHaveLength(1);
        expect(useAppStore.getState().canvasImageLoads.get(legacyId)?.status).toBe('loading');
        if (previous !== null) { await settleDisposed(previous); previous = null; }
        if (completion === 'before disposal') {
          h.requests[0].resolve(decoded);
          await Promise.resolve(); await Promise.resolve();
          expect(h.shown().get(legacyId)).toBe(decoded);
          expect(useAppStore.getState().canvasImageLoads.get(legacyId)?.status).toBe('ready');
          expect(useAppStore.getState().canvasPixelSizes.get(legacyId)).toEqual({ width: 100 + cycle, height: 50 });
          expect(decoded.close).not.toHaveBeenCalled();
        }
      } finally { h.dispose(); }
      expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
      expect(useAppStore.getState().canvasPixelSizes.size).toBe(0);
      const publications = h.publish.mock.calls.length;
      const shown = h.shown();
      h.cache.sync(); h.cache.clear(); h.dispose();
      expect(h.requests).toHaveLength(1);
      expect(h.publish).toHaveBeenCalledTimes(publications);
      expect(h.shown()).toBe(shown);
      expect(h.cache.cleanupPending()).toBe(completion === 'after disposal');
      if (completion === 'after disposal') {
        expect(decoded.close).not.toHaveBeenCalled();
        previous = { h, decoded };
      } else expect(decoded.close).toHaveBeenCalledTimes(1);
    }
    if (previous !== null) await settleDisposed(previous);
    expect(images).toHaveLength(100);
    expect(images.reduce((count, decoded) => count + decoded.close.mock.calls.length, 0)).toBe(100);
    for (const decoded of images) expect(decoded.close).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
    expect(useAppStore.getState().canvasPixelSizes.size).toBe(0);
  },
);

describe.each(['resolve', 'reject'] as const)('completion before the next sync: %s', ending => {
  it.each(['document', 'bytes', 'removed', 'retry'] as const)('releases a stale %s owner immediately', async changed => {
    openPart('A', bytesA);
    const h = harness({ autoSync: false }); h.cache.sync();
    const owner = useAppStore.getState().canvasImageLoads.get(legacyId);
    expect(owner?.status).toBe('loading');
    const state = useAppStore.getState();
    if (changed === 'document') useAppStore.setState({ activeDocumentId: 'other-document' });
    else if (changed === 'bytes') useAppStore.setState({ canvases: new Map([[legacyId, bytesB]]) });
    else if (changed === 'removed') useAppStore.setState({ document: { ...state.document, canvases: [] } });
    else useAppStore.setState({ canvasImageRetries: new Map([[legacyId, 1]]) });
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)).toBe(owner);
    const before = useAppStore.getState(), stale = image(100);
    if (ending === 'resolve') h.requests[0].resolve(stale); else h.requests[0].reject();
    await Promise.resolve(); await Promise.resolve();
    // No sync/dispose between completion and the observation: the discarded owner must return now.
    expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
    expect(useAppStore.getState().canvasPixelSizes.size).toBe(0);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(h.shown().size).toBe(0); expect(h.requests).toHaveLength(1);
    expect(h.cache.cleanupPending()).toBe(false);
    h.dispose(); h.cache.dispose();
    expect(stale.close).toHaveBeenCalledTimes(ending === 'resolve' ? 1 : 0);
  });

  it('returns the loading owner when reading the current source throws', async () => {
    openPart('A', bytesA);
    let fail = false;
    const h = harness({ autoSync: false, readFails: () => fail }); h.cache.sync();
    fail = true;
    const stale = image(100);
    if (ending === 'resolve') h.requests[0].resolve(stale); else h.requests[0].reject();
    await Promise.resolve(); await Promise.resolve();
    expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
    expect(h.shown().size).toBe(0); expect(h.cache.cleanupPending()).toBe(false);
    h.dispose(); h.cache.dispose();
    expect(stale.close).toHaveBeenCalledTimes(ending === 'resolve' ? 1 : 0);
  });

  it('retries only the old load return without erasing a newer same-ID request', async () => {
    openPart('A', bytesA);
    let fail = true;
    const h = harness({ autoSync: false, releaseFails: () => fail }); h.cache.sync();
    const old = useAppStore.getState().canvasImageLoads.get(legacyId);
    useAppStore.setState({ canvases: new Map([[legacyId, bytesB]]) });
    const stale = image(100);
    if (ending === 'resolve') h.requests[0].resolve(stale); else h.requests[0].reject();
    await Promise.resolve(); await Promise.resolve();
    expect(h.cache.cleanupPending()).toBe(true);
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)).toBe(old);
    h.cache.sync();
    const current = useAppStore.getState().canvasImageLoads.get(legacyId);
    expect(current?.status).toBe('loading'); expect(current?.bytes).toBe(bytesB);
    expect(current?.request).not.toBe(old?.request); expect(h.requests).toHaveLength(2);
    fail = false; h.cache.sync();
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)).toBe(current);
    const decoded = image(200); h.requests[1].resolve(decoded); await Promise.resolve();
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)?.status).toBe('ready');
    expect(h.shown().get(legacyId)).toBe(decoded);
    h.dispose(); h.cache.dispose();
    expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
    expect(h.cache.cleanupPending()).toBe(false);
    expect(decoded.close).toHaveBeenCalledTimes(1);
    expect(stale.close).toHaveBeenCalledTimes(ending === 'resolve' ? 1 : 0);
  });
});

it.each(['setLoad', 'publish'] as const)('retains a decoded image for cleanup after %s throws', async callback => {
  const decoded = image(100);
  let fail = false;
  const setLoad = vi.fn((_id: string, _owner: unknown, load: unknown) => {
    if (fail && callback === 'setLoad' && load !== null) throw new Error('load callback');
  });
  const publish = vi.fn(() => { if (fail && callback === 'publish') throw new Error('publish callback'); });
  let resolve: (value: DecodedCanvasImage) => void = () => { throw new Error('decode missing'); };
  const cache = createCanvasImageCache({
    readSource: () => ({ documentId: 'doc', canvases: [{ imageId: 'image' }],
      images: new Map([['image', bytesA]]), retries: new Map() }),
    decode: () => new Promise<DecodedCanvasImage>(done => { resolve = done; }),
    setLoad, publish, reportInvalid: vi.fn(),
  });
  cache.sync(); fail = true; resolve(decoded);
  await Promise.resolve(); await Promise.resolve();
  expect(decoded.close).not.toHaveBeenCalled();
  cache.dispose(); cache.dispose();
  expect(decoded.close).toHaveBeenCalledTimes(1);
  expect(setLoad.mock.calls.filter(call => call[2] === null)).toHaveLength(1);
  expect(cache.cleanupPending()).toBe(false);
});

describe('下絵キャッシュの文書と非同期画像の寿命', () => {
  it.each(['resolve', 'reject'] as const)('履歴から回収した画像の遅い %s を採用せず履歴・計算を変えない', async ending => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync();
    const store = useAppStore.getState();
    store.removeCanvas(legacyId);
    for (let edit = 0; edit < UNDO_LIMIT; edit += 1) {
      store.applyDocument({ ...useAppStore.getState().document, name: `empty-${edit}` });
    }
    expect(useAppStore.getState().canvases.size).toBe(0);
    const before = useAppStore.getState(), late = image(100);
    if (ending === 'resolve') h.requests[0].resolve(late); else h.requests[0].reject();
    await Promise.resolve(); h.cache.sync(); h.dispose(); h.cache.dispose();
    const after = useAppStore.getState();
    expect(h.requests).toHaveLength(1); expect(h.shown().size).toBe(0);
    expect(after.canvasImageLoads.size).toBe(0); expect(after.canvasPixelSizes.size).toBe(0);
    expect(after.undoStack).toBe(before.undoStack); expect(after.document).toBe(before.document);
    expect(after.isComputing).toBe(before.isComputing); expect(after.canvasMessage).toBe(before.canvasMessage);
    expect(late.close).toHaveBeenCalledTimes(ending === 'resolve' ? 1 : 0);
  });

  it('表示済みの画像を削除して履歴から回収してもcloseは1回だけ', async () => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync();
    const decoded = image(100); h.requests[0].resolve(decoded); await Promise.resolve();
    const store = useAppStore.getState(); store.removeCanvas(legacyId);
    expect(decoded.close).toHaveBeenCalledTimes(1);
    for (let edit = 0; edit < UNDO_LIMIT; edit += 1) {
      store.applyDocument({ ...useAppStore.getState().document, name: `empty-${edit}` });
    }
    expect(useAppStore.getState().canvases.size).toBe(0);
    h.cache.sync(); h.dispose(); h.cache.dispose();
    expect(decoded.close).toHaveBeenCalledTimes(1); expect(h.shown().size).toBe(0);
  });

  it('復号失敗を通常の編集・表示切替で自動反復しない', async () => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync();
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)?.status).toBe('loading');
    h.requests[0].reject(); await Promise.resolve();
    useAppStore.getState().setCanvasVisible(legacyId, false);
    useAppStore.getState().setCanvasVisible(legacyId, true);
    h.cache.sync();
    expect(h.requests).toHaveLength(1);
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)?.status).toBe('failed');
    h.dispose();
  });
  it('既存の同じIDを持つ文書を A→B→A と開いて各画像と画素寸法だけを採用する', async () => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync();
    const a = image(100); h.requests[0].resolve(a); await Promise.resolve();
    expect(h.shown().get(legacyId)).toBe(a);
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)).toMatchObject({ status: 'ready', bytes: bytesA });
    openPart('B', bytesB);
    expect(h.shown().size).toBe(0);
    expect(a.close).toHaveBeenCalledTimes(1);
    // 添付の更新と文書差替えそれぞれの要求があっても、最後の要求だけが有効。
    const obsolete = image(999);
    h.requests[1].resolve(obsolete);
    const b = image(200); h.requests.at(-1)?.resolve(b); await Promise.resolve();
    expect(obsolete.close).toHaveBeenCalledTimes(1);
    expect(h.shown().get(legacyId)).toBe(b);
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)).toMatchObject({ status: 'ready', bytes: bytesB });
    expect(useAppStore.getState().canvasPixelSizes.get(legacyId)?.width).toBe(200);
    openPart('A', bytesA);
    const beforeLast = image(998); h.requests.at(-2)?.resolve(beforeLast);
    const nextA = image(100); h.requests.at(-1)?.resolve(nextA); await Promise.resolve();
    expect(h.shown().get(legacyId)).toBe(nextA);
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)).toMatchObject({ status: 'ready', bytes: bytesA });
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(beforeLast.close).toHaveBeenCalledTimes(1);
    h.dispose(); h.cache.dispose();
    expect(nextA.close).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('古い要求の %s が差替え後の pending を消さない', async (ending) => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync();
    useAppStore.getState().setCanvasImages(new Map([[legacyId, bytesB]]));
    expect(h.requests).toHaveLength(2);
    const stale = image(100);
    if (ending === 'resolve') h.requests[0].resolve(stale); else h.requests[0].reject();
    await Promise.resolve(); h.cache.sync();
    expect(h.requests).toHaveLength(2);
    expect(h.shown().size).toBe(0);
    expect(useAppStore.getState().canvasPixelSizes.size).toBe(0);
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)?.status).toBe('loading');
    const current = image(200); h.requests[1].resolve(current); await Promise.resolve();
    expect(h.shown().get(legacyId)).toBe(current);
    expect(stale.close).toHaveBeenCalledTimes(ending === 'resolve' ? 1 : 0);
    h.dispose(); expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('復号中に削除した画像を表示せず、Undo で新しい要求を始める', async () => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync();
    useAppStore.getState().removeCanvas('canvas-1');
    const stale = image(100); h.requests[0].resolve(stale); await Promise.resolve();
    expect(h.shown().size).toBe(0);
    expect(useAppStore.getState().canvasPixelSizes.size).toBe(0);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
    useAppStore.getState().undo(); expect(h.requests).toHaveLength(2);
    const current = image(100); h.requests[1].resolve(current); await Promise.resolve();
    expect(h.shown().get(legacyId)).toBe(current);
    h.dispose(); expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('同じバイト列の別オブジェクトへの差替えも復号し直す', async () => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync();
    const first = image(100); h.requests[0].resolve(first); await Promise.resolve();
    useAppStore.getState().setCanvasImages(new Map([[legacyId, bytesA.slice()]]));
    expect(h.shown().size).toBe(0); expect(h.requests).toHaveLength(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    const replacement = image(101); h.requests[1].resolve(replacement); await Promise.resolve();
    expect(useAppStore.getState().canvasPixelSizes.get(legacyId)?.width).toBe(101);
    h.dispose(); expect(replacement.close).toHaveBeenCalledTimes(1);
  });

  it('clear で要求を失効させ、同じ文書・バイト列へ戻っても古い完了を使わない', async () => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync(); h.cache.clear(); h.cache.sync();
    expect(h.requests).toHaveLength(2);
    const stale = image(100); h.requests[0].resolve(stale); await Promise.resolve();
    h.cache.sync(); expect(h.requests).toHaveLength(2);
    const current = image(200); h.requests[1].resolve(current); await Promise.resolve();
    h.cache.clear(); h.cache.clear();
    expect(h.shown().size).toBe(0);
    expect(useAppStore.getState().canvasPixelSizes.size).toBe(0);
    expect(stale.close).toHaveBeenCalledTimes(1); expect(current.close).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it.each(['resolve', 'reject'] as const)('破棄後の %s を採用せず、再同期や繰り返す破棄でも資源を二重解放しない', async (ending) => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync(); h.dispose();
    const late = image(100);
    if (ending === 'resolve') h.requests[0].resolve(late); else h.requests[0].reject();
    await Promise.resolve();
    h.cache.sync(); h.cache.clear(); h.cache.dispose();
    expect(h.requests).toHaveLength(1); expect(late.close).toHaveBeenCalledTimes(ending === 'resolve' ? 1 : 0);
    expect(h.shown().size).toBe(0); expect(useAppStore.getState().canvasPixelSizes.size).toBe(0);
    expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
  });

  it('表示切替・Undo・Redoは使用可能の画像を保持し、復号や解放を繰り返さない', async () => {
    openPart('A', bytesA);
    const h = harness(); h.cache.sync();
    const current = image(100); h.requests[0].resolve(current); await Promise.resolve();
    const load = useAppStore.getState().canvasImageLoads.get(legacyId);
    useAppStore.getState().setCanvasVisible(legacyId, false);
    useAppStore.getState().undo(); useAppStore.getState().redo();
    useAppStore.getState().setCanvasVisible(legacyId, true);
    expect(h.requests).toHaveLength(1); expect(current.close).toHaveBeenCalledTimes(0);
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)).toBe(load);
    h.dispose(); expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('同じ文書の同じバイト列を入れ直しても使用可能の状態と寸法を失わない', async () => {
    openPart('A', bytesA); const h = harness(); h.cache.sync();
    const current = image(100); h.requests[0].resolve(current); await Promise.resolve();
    const before = useAppStore.getState();
    before.setCanvasImages(new Map([[legacyId, bytesA]]));
    expect(h.requests).toHaveLength(1); expect(h.shown().get(legacyId)).toBe(current);
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)).toBe(before.canvasImageLoads.get(legacyId));
    expect(useAppStore.getState().canvasPixelSizes.get(legacyId)).toEqual({ width: 100, height: 50 });
    h.dispose(); expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('同じ文書・バイト列でも旧キャッシュの破棄は新しい要求の状態を消さない', async () => {
    openPart('A', bytesA); const old = harness(); old.cache.sync();
    const current = harness(); current.cache.sync();
    const loading = useAppStore.getState().canvasImageLoads.get(legacyId);
    old.dispose(); old.requests[0].reject(); await Promise.resolve();
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)).toBe(loading);
    const decoded = image(100); current.requests[0].resolve(decoded); await Promise.resolve();
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)?.status).toBe('ready');
    current.dispose(); expect(decoded.close).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().canvasImageLoads.size).toBe(0);
  });

  it('不正な画像は復号せず、復号失敗後は明示的に再試行できる', async () => {
    openPart('invalid', Uint8Array.of(1));
    const h = harness(); h.cache.sync();
    expect(h.requests).toHaveLength(0); expect(useAppStore.getState().canvasMessage).not.toBeNull();
    useAppStore.getState().setCanvasImages(new Map([[legacyId, bytesA]]));
    h.requests[0].reject(); await Promise.resolve(); h.cache.sync();
    expect(h.requests).toHaveLength(1);
    const before = useAppStore.getState();
    expect(before.canvasImageLoads.get(legacyId)?.status).toBe('failed');
    before.retryCanvasImage(legacyId);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(h.requests).toHaveLength(2);
    const current = image(100); h.requests[1].resolve(current); await Promise.resolve();
    expect(useAppStore.getState().canvasImageLoads.get(legacyId)?.status).toBe('ready');
    h.cache.sync(); expect(h.requests).toHaveLength(2); h.dispose();
    expect(current.close).toHaveBeenCalledTimes(1);
  });
});
