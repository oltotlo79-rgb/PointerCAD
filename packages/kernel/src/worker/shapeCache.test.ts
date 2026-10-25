import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { makeBox, type OcctShapeHandle } from '../occt/makeBox.js';
import { SHAPE_CACHE_CAPACITY, createShapeCache } from './shapeCache.js';

/**
 * 解放が何回呼ばれたかを数えるだけの偽ハンドル。
 * キャッシュは形の中身を見ないので、順番と解放の規則は OCCT を読まずに検査できる。
 */
interface FakeHandle {
  readonly name: string;
  /** delete() が呼ばれた回数。 */
  readonly deleteCalls: () => number;
  delete(): void;
}

function fakeHandle(name: string): FakeHandle {
  let calls = 0;
  return {
    name,
    deleteCalls: () => calls,
    delete(): void {
      calls += 1;
    },
  };
}

describe('形状キャッシュ(鍵つき・容量上限つきの LRU)', () => {
  it('貸した旧形の復帰・解放・全消去の後も保持数と容量判定が一致する', () => {
    const cache = createShapeCache<FakeHandle>(3);
    const a = fakeHandle('a'), b = fakeHandle('b'), c = fakeHandle('c');
    cache.set('a', a);
    const token = cache.acquire(['a']);
    cache.set('a', b);
    cache.set('a', c);
    cache.set('a', a);
    expect(cache.stats()).toMatchObject({ shapeCount: 3, protectedOverBudget: 0 });
    const disposable = fakeHandle('evicted');
    cache.set('evicted', disposable);
    expect(disposable.deleteCalls()).toBe(1);
    cache.release(token);
    expect([a.deleteCalls(), b.deleteCalls(), c.deleteCalls()]).toEqual([0, 1, 1]);
    cache.set('second', fakeHandle('second'));
    cache.set('third', fakeHandle('third'));
    expect(cache.size).toBe(3);
    cache.clear();
    for (let index = 0; index < 3; index++) cache.set(String(index), fakeHandle(String(index)));
    expect(cache.stats()).toMatchObject({ size: 3, shapeCount: 3, protectedOverBudget: 0 });
    cache.clear();
  });

  it('set した形を同じ鍵で取り出せる', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    cache.set('a', a);

    expect(cache.get('a')).toBe(a);
    expect(cache.has('a')).toBe(true);
    expect(cache.size).toBe(1);
    expect(a.deleteCalls()).toBe(0);
  });

  it('知らない鍵は取り出せない', () => {
    const cache = createShapeCache<FakeHandle>();

    expect(cache.get('none')).toBeUndefined();
    expect(cache.has('none')).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('同じ鍵へ別の形を入れると、古い形だけを 1 回解放する', () => {
    const cache = createShapeCache<FakeHandle>();
    const old = fakeHandle('old');
    const fresh = fakeHandle('fresh');
    cache.set('a', old);
    cache.set('a', fresh);

    expect(old.deleteCalls()).toBe(1);
    expect(fresh.deleteCalls()).toBe(0);
    expect(cache.get('a')).toBe(fresh);
    expect(cache.size).toBe(1);
  });

  it('同じ鍵へ同じ形を入れ直しても解放しない', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    cache.set('a', a);
    cache.set('a', a);

    expect(a.deleteCalls()).toBe(0);
    expect(cache.get('a')).toBe(a);
    expect(cache.size).toBe(1);
  });

  it('delete(鍵) は形を 1 回解放して true を返し、知らない鍵では false を返す', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    cache.set('a', a);

    expect(cache.delete('a')).toBe(true);
    expect(a.deleteCalls()).toBe(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.delete('a')).toBe(false);
    expect(a.deleteCalls()).toBe(1);
  });

  it('容量を超えると、最も古く使われた形から追い出して解放する', () => {
    const cache = createShapeCache<FakeHandle>(3);
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    const c = fakeHandle('c');
    const d = fakeHandle('d');
    cache.set('a', a);
    cache.set('b', b);
    cache.set('c', c);
    cache.set('d', d);

    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(false);
    expect(a.deleteCalls()).toBe(1);
    expect(b.deleteCalls()).toBe(0);
    expect(cache.get('b')).toBe(b);
    expect(cache.get('c')).toBe(c);
    expect(cache.get('d')).toBe(d);
    expect(cache.stats().evictions).toBe(1);
  });

  it('get で取り出した形は新しい扱いになり、追い出されにくい', () => {
    const cache = createShapeCache<FakeHandle>(3);
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    const c = fakeHandle('c');
    const d = fakeHandle('d');
    cache.set('a', a);
    cache.set('b', b);
    cache.set('c', c);
    expect(cache.get('a')).toBe(a);
    cache.set('d', d);

    // a は直前に使ったので残り、次に古い b が追い出される。
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(a.deleteCalls()).toBe(0);
    expect(b.deleteCalls()).toBe(1);
  });

  it('has は最近使ったことにしない', () => {
    const cache = createShapeCache<FakeHandle>(2);
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    const c = fakeHandle('c');
    cache.set('a', a);
    cache.set('b', b);
    expect(cache.has('a')).toBe(true);
    cache.set('c', c);

    expect(cache.has('a')).toBe(false);
    expect(a.deleteCalls()).toBe(1);
  });

  it('retain は渡した鍵以外を解放し、解放した件数を返す', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    const c = fakeHandle('c');
    cache.set('a', a);
    cache.set('b', b);
    cache.set('c', c);

    expect(cache.retain(['a', 'c'])).toBe(1);
    expect(cache.size).toBe(2);
    expect(b.deleteCalls()).toBe(1);
    expect(a.deleteCalls()).toBe(0);
    expect(c.deleteCalls()).toBe(0);
  });

  it('retain の後も、残した鍵はそのまま取り出せる', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    cache.set('a', a);
    cache.set('b', b);
    cache.retain(['a']);

    expect(cache.get('a')).toBe(a);
    expect(cache.has('b')).toBe(false);
  });

  it('retain に持っていない鍵が混じっていても無視する', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    cache.set('a', a);
    cache.set('b', b);

    expect(cache.retain(['a', 'まだ作っていない鍵'])).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.has('a')).toBe(true);
  });

  it('retain に空を渡すと全部解放する', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    cache.set('a', a);
    cache.set('b', b);

    expect(cache.retain([])).toBe(2);
    expect(cache.size).toBe(0);
    expect(a.deleteCalls()).toBe(1);
    expect(b.deleteCalls()).toBe(1);
  });

  it('clear は入れた件数だけ解放して空にする', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    cache.set('a', a);
    cache.set('b', b);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(a.deleteCalls()).toBe(1);
    expect(b.deleteCalls()).toBe(1);
  });

  it('2 回目の clear では解放しない(二重に解放しない)', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    cache.set('a', a);
    cache.clear();
    cache.clear();

    expect(a.deleteCalls()).toBe(1);
  });

  it('統計は件数・追い出し回数・解放した延べ件数を返す', () => {
    const cache = createShapeCache<FakeHandle>(2);
    // 既存3欄の期待値はそのまま固定し、追加の診断欄は使用中保護の検査で確かめる。
    const legacyStats = () => {
      const { size, evictions, released } = cache.stats();
      return { size, evictions, released };
    };
    cache.set('a', fakeHandle('a'));
    cache.set('b', fakeHandle('b'));
    expect(legacyStats()).toEqual({ size: 2, evictions: 0, released: 0 });

    // 容量 2 に 3 件目を入れると、最も古い a を追い出す。
    cache.set('c', fakeHandle('c'));
    expect(legacyStats()).toEqual({ size: 2, evictions: 1, released: 1 });

    // 上書きは解放だが追い出しではない。
    cache.set('b', fakeHandle('b2'));
    expect(legacyStats()).toEqual({ size: 2, evictions: 1, released: 2 });

    cache.clear();
    expect(legacyStats()).toEqual({ size: 0, evictions: 1, released: 4 });
  });

  it('容量の既定は SHAPE_CACHE_CAPACITY 件で、超えた分だけ追い出す', () => {
    // 100 フィーチャーの部品(NFR-PF-3)と 200 段の Undo(FR-505)を一度に覚えられる大きさ。
    expect(SHAPE_CACHE_CAPACITY).toBe(256);
    const cache = createShapeCache<FakeHandle>();
    expect(cache.capacity).toBe(SHAPE_CACHE_CAPACITY);

    const handles = Array.from({ length: SHAPE_CACHE_CAPACITY }, (_unused, index) =>
      fakeHandle(`k${index}`),
    );
    for (const handle of handles) {
      cache.set(handle.name, handle);
    }
    expect(cache.size).toBe(SHAPE_CACHE_CAPACITY);
    expect(handles.filter((handle) => handle.deleteCalls() > 0)).toHaveLength(0);

    cache.set('extra', fakeHandle('extra'));
    expect(cache.size).toBe(SHAPE_CACHE_CAPACITY);
    expect(cache.has('k0')).toBe(false);
    expect(handles[0].deleteCalls()).toBe(1);
    expect(cache.has('k1')).toBe(true);
    expect(cache.stats().evictions).toBe(1);
  });

  it('容量に 1 未満や整数でない値を渡すと作れない', () => {
    expect(() => createShapeCache(0)).toThrow(/容量/);
    expect(() => createShapeCache(-1)).toThrow(/容量/);
    expect(() => createShapeCache(1.5)).toThrow(/容量/);
  });
});

describe('形状キャッシュの使用中保護', () => {
  it('古い鍵でも確保中は追い出さず、未確保の形をLRU順に解放する', () => {
    const cache = createShapeCache<FakeHandle>(2);
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    cache.set('a', a);
    cache.set('b', b);
    const token = cache.acquire(['a']);
    cache.set('c', fakeHandle('c'));
    expect(cache.has('a')).toBe(true);
    expect(a.deleteCalls()).toBe(0);
    expect(b.deleteCalls()).toBe(1);
    cache.release(token);
    cache.clear();
  });

  it('release後は元のLRU順で追い出される', () => {
    const cache = createShapeCache<FakeHandle>(2);
    const a = fakeHandle('a');
    cache.set('a', a);
    cache.set('b', fakeHandle('b'));
    const token = cache.acquire(['a']);
    cache.release(token);
    cache.set('c', fakeHandle('c'));
    expect(cache.has('a')).toBe(false);
    expect(a.deleteCalls()).toBe(1);
    cache.clear();
  });

  it('重複する鍵と複数tokenを参照カウントし、確保鍵数が0→2→1→0に戻る', () => {
    const cache = createShapeCache<FakeHandle>(1);
    expect(cache.stats().protectedKeyCount).toBe(0);
    const first = cache.acquire(['a', 'a', 'b']);
    const second = cache.acquire(['a']);
    expect(cache.stats().protectedKeyCount).toBe(2);
    cache.set('a', fakeHandle('a'));
    cache.set('b', fakeHandle('b'));
    cache.release(first);
    expect(cache.stats().protectedKeyCount).toBe(1);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    cache.release(second);
    expect(cache.stats().protectedKeyCount).toBe(0);
    cache.clear();
  });

  it('保護対象だけで容量を超えると超過を許して診断し、release時に予算へ戻す', () => {
    const cache = createShapeCache<FakeHandle>(1);
    const token = cache.acquire(['a', 'b']);
    cache.set('a', fakeHandle('a'));
    cache.set('b', fakeHandle('b'));
    expect(cache.stats()).toMatchObject({ size: 2, shapeCount: 2, protectedKeyCount: 2, protectedOverBudget: 1, evictions: 0, diagnostics: ['保護対象だけで予算超過'] });
    cache.set('c', fakeHandle('c'));
    expect(cache.has('c')).toBe(false);
    expect(cache.size).toBe(2);
    cache.release(token);
    expect(cache.stats()).toMatchObject({ size: 1, protectedKeyCount: 0, protectedOverBudget: 0, diagnostics: [] });
    cache.clear();
  });

  it('retainとdeleteは確保中の形を解放せず、確保を外した後は解放できる', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    cache.set('a', a);
    cache.set('b', fakeHandle('b'));
    const token = cache.acquire(['a']);
    expect(cache.retain([])).toBe(1);
    expect(cache.delete('a')).toBe(false);
    expect(a.deleteCalls()).toBe(0);
    cache.release(token);
    expect(cache.delete('a')).toBe(true);
    expect(a.deleteCalls()).toBe(1);
  });

  it('clearは全形と確保を解放して診断し、古いtokenが新しい確保に影響しない', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    cache.set('a', a);
    const old = cache.acquire(['a']);
    cache.clear();
    expect(a.deleteCalls()).toBe(1);
    expect(cache.stats()).toMatchObject({ shapeCount: 0, protectedKeyCount: 0, clearWithActiveTokensCount: 1, diagnostics: ['確保が残った状態で clear が呼ばれました'] });
    const fresh = cache.acquire(['a']);
    cache.release(old);
    expect(cache.stats().protectedKeyCount).toBe(1);
    cache.release(fresh);
    cache.clear();
    expect(cache.stats().clearWithActiveTokensCount).toBe(1);
    expect(a.deleteCalls()).toBe(1);
  });

  it('二重releaseと別のキャッシュのtokenは他の確保を外さない', () => {
    const cache = createShapeCache<FakeHandle>();
    const other = createShapeCache<FakeHandle>();
    const first = cache.acquire(['a']);
    const second = cache.acquire(['a']);
    const foreign = other.acquire(['a']);
    cache.release(first);
    cache.release(first);
    cache.release(foreign);
    expect(cache.stats().protectedKeyCount).toBe(1);
    cache.release(second);
    expect(cache.stats().protectedKeyCount).toBe(0);
    other.release(foreign);
  });

  it('初回空・保護鍵だけ・retired形の計測能力を0 bytesと区別する', () => {
    const unmeasured = createShapeCache<FakeHandle>(2);
    const measured = createShapeCache<FakeHandle>(2, () => 12);
    expect(unmeasured.stats()).toMatchObject({ shapeCount: 0, meshBytes: 0,
      meshBytesMeasured: false });
    expect(measured.stats()).toMatchObject({ shapeCount: 0, meshBytes: 0,
      meshBytesMeasured: true });

    const reserved = unmeasured.acquire(['future']);
    expect(unmeasured.stats()).toMatchObject({ shapeCount: 0, protectedKeyCount: 1,
      meshBytes: 0, meshBytesMeasured: false });
    unmeasured.release(reserved);

    unmeasured.set('a', fakeHandle('old'));
    const held = unmeasured.acquire(['a']);
    unmeasured.set('a', fakeHandle('new'));
    expect(unmeasured.stats()).toMatchObject({ size: 1, shapeCount: 2,
      meshBytes: 0, meshBytesMeasured: false });
    unmeasured.release(held);
    unmeasured.clear();
    measured.clear();
  });

  it('保護中の上書きは貸した旧形も保持し、最後のreleaseで一度だけ解放する', () => {
    const cache = createShapeCache<FakeHandle>(2, () => 12);
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    cache.set('a', a);
    const token = cache.acquire(['a']);
    cache.set('a', b);
    expect(a.deleteCalls()).toBe(0);
    expect(cache.stats()).toMatchObject({ size: 1, shapeCount: 2, meshBytes: 24,
      meshBytesMeasured: true });
    cache.release(token);
    expect(a.deleteCalls()).toBe(1);
    expect(cache.stats()).toMatchObject({ shapeCount: 1, meshBytes: 12 });
    cache.clear();
    expect(a.deleteCalls()).toBe(1);
    expect(b.deleteCalls()).toBe(1);
    expect(cache.stats().meshBytes).toBe(0);
  });

  it('保護中に旧形を現行へ戻してclearしても同じ実体を二重解放しない', () => {
    const cache = createShapeCache<FakeHandle>();
    const a = fakeHandle('a');
    const b = fakeHandle('b');
    cache.set('a', a);
    const token = cache.acquire(['a']);
    cache.set('a', b);
    cache.set('a', a);
    cache.clear();
    cache.release(token);
    expect(a.deleteCalls()).toBe(1);
    expect(b.deleteCalls()).toBe(1);
  });

  it('鍵の列挙が途中で失敗したacquireは確保を残さない', () => {
    const cache = createShapeCache<FakeHandle>();
    function* keys(): Generator<string> {
      yield 'a';
      throw new Error('列挙失敗');
    }
    expect(() => cache.acquire(keys())).toThrow('列挙失敗');
    expect(cache.stats().protectedKeyCount).toBe(0);
  });

  it('measured empty is known zero, but an absent callback remains unknown', () => {
    const measured = createShapeCache<FakeHandle>(3, () => 7);
    const absent = createShapeCache<FakeHandle>(3);
    expect(measured.stats().meshByteCounts).toEqual({ status: 'known', activeBytes: 0,
      retiredBytes: 0, protectedBytes: 0, totalBytes: 0 });
    expect(absent.stats().meshByteCounts).toEqual({ status: 'unknown', reason: 'callback-missing' });
  });

  it('active, retired, and protected ownership use independent byte totals', () => {
    const sizes = new Map([['old', 11], ['new', 13], ['hidden', 17]]);
    const cache = createShapeCache<FakeHandle>(4, entry => sizes.get(entry.name) ?? Number.NaN);
    const old = fakeHandle('old');
    cache.set('a', old);
    const held = cache.acquire(['a']);
    cache.set('a', fakeHandle('new'));
    cache.set('b', fakeHandle('hidden'));
    expect(cache.stats().meshByteCounts).toEqual({ status: 'known', activeBytes: 30,
      retiredBytes: 11, protectedBytes: 24, totalBytes: 41 });
    expect(old.deleteCalls()).toBe(0);
    cache.release(held);
    expect(old.deleteCalls()).toBe(1);
    expect(cache.stats().meshByteCounts).toEqual({ status: 'known', activeBytes: 30,
      retiredBytes: 0, protectedBytes: 0, totalBytes: 30 });
    cache.clear();
  });

  it('bad, throwing, and overflowing callbacks cannot become known bytes', () => {
    const cache = createShapeCache<FakeHandle>(3, entry => {
      if (entry.name === 'throw') throw new Error('measurement unavailable');
      if (entry.name === 'huge') return Number.MAX_SAFE_INTEGER;
      if (entry.name === 'bad') return -1;
      return 1;
    });
    cache.set('a', fakeHandle('bad'));
    expect(cache.stats().meshByteCounts).toEqual({ status: 'unknown', reason: 'invalid-byte-count' });
    cache.delete('a');
    cache.set('a', fakeHandle('throw'));
    expect(cache.stats().meshByteCounts).toEqual({ status: 'unknown', reason: 'callback-error' });
    cache.delete('a');
    cache.set('a', fakeHandle('huge'));
    cache.set('b', fakeHandle('one'));
    expect(cache.stats().meshByteCounts).toEqual({ status: 'unknown', reason: 'overflow' });
    cache.clear();
  });
});

describe('explicit mesh backing buffer ownership', () => {
  interface BufferHandle extends FakeHandle {
    readonly views: readonly Float32Array[];
  }

  function bufferHandle(name: string, views: readonly Float32Array[]): BufferHandle {
    return { ...fakeHandle(name), views };
  }

  function bufferCache(capacity = 4) {
    return createShapeCache<BufferHandle>(capacity,
      entry => entry.views.reduce((bytes, view) => bytes + view.byteLength, 0),
      entry => entry.views.map(view => view.buffer));
  }

  it('a 12-byte subarray retains its entire 1 MiB backing buffer', () => {
    const backing = new ArrayBuffer(1024 * 1024);
    const positions = new Float32Array(backing, 128, 3);
    const cache = bufferCache();
    cache.set('body', bufferHandle('body', [positions]));
    expect(positions.byteLength).toBe(12);
    expect(cache.stats()).toMatchObject({ meshBytes: 12, meshBytesMeasured: true,
      meshBackingBytesMeasured: true });
    expect(cache.stats().meshByteCounts).toEqual({ status: 'known', activeBytes: 1048576,
      retiredBytes: 0, protectedBytes: 0, totalBytes: 1048576 });
    expect(cache.meshBufferSnapshot?.()).toEqual({ status: 'known', active: [backing],
      retired: [], protected: [] });
    cache.clear();
  });

  it('aliases in separate views and bodies count once without changing the legacy scalar', () => {
    const backing = new ArrayBuffer(64);
    const first = new Float32Array(backing, 0, 3);
    const second = new Float32Array(backing, 16, 4);
    const cache = bufferCache();
    cache.set('a', bufferHandle('a', [first, first]));
    cache.set('b', bufferHandle('b', [second]));
    const token = cache.acquire(['b']);
    expect(cache.stats().meshBytes).toBe(40);
    expect(cache.stats().meshByteCounts).toEqual({ status: 'known', activeBytes: 64,
      retiredBytes: 0, protectedBytes: 64, totalBytes: 64 });
    cache.release(token);
    expect(cache.stats().meshByteCounts).toEqual({ status: 'known', activeBytes: 64,
      retiredBytes: 0, protectedBytes: 0, totalBytes: 64 });
    cache.clear();
  });

  it('retired aliases are exclusive of active buffers and protection is a subset', () => {
    const shared = new ArrayBuffer(64);
    const oldOnly = new ArrayBuffer(20);
    const newOnly = new ArrayBuffer(12);
    const cache = bufferCache();
    const old = bufferHandle('old', [new Float32Array(shared, 0, 1), new Float32Array(oldOnly)]);
    cache.set('body', old);
    const token = cache.acquire(['body']);
    cache.set('body', bufferHandle('new', [new Float32Array(shared, 16, 1), new Float32Array(newOnly)]));
    expect(cache.stats().meshBytes).toBe(40);
    expect(cache.stats().meshByteCounts).toEqual({ status: 'known', activeBytes: 76,
      retiredBytes: 20, protectedBytes: 96, totalBytes: 96 });
    expect(old.deleteCalls()).toBe(0);
    cache.release(token);
    expect(old.deleteCalls()).toBe(1);
    expect(cache.stats().meshByteCounts).toEqual({ status: 'known', activeBytes: 76,
      retiredBytes: 0, protectedBytes: 0, totalBytes: 76 });
    cache.clear();
  });

  it('numeric-only compatibility does not claim physical ownership, and measured empty differs from absent', () => {
    const numeric = createShapeCache<FakeHandle>(2, () => 7);
    numeric.set('a', fakeHandle('a'));
    expect(numeric.stats()).toMatchObject({ meshBytes: 7, meshBackingBytesMeasured: false,
      meshByteCounts: { status: 'known', activeBytes: 7, retiredBytes: 0, protectedBytes: 0, totalBytes: 7 } });
    expect(numeric.meshBufferSnapshot?.()).toEqual({ status: 'unknown', reason: 'callback-missing' });
    const absent = createShapeCache<FakeHandle>(2);
    expect(absent.stats().meshByteCounts).toEqual({ status: 'unknown', reason: 'callback-missing' });
    const emptyBuffer = new ArrayBuffer(0);
    const empty = createShapeCache<FakeHandle>(2, undefined, () => [emptyBuffer]);
    empty.set('empty', fakeHandle('empty'));
    expect(empty.stats()).toMatchObject({ meshBytesMeasured: true, meshBackingBytesMeasured: true });
    expect(empty.stats().meshByteCounts).toEqual({ status: 'known', activeBytes: 0,
      retiredBytes: 0, protectedBytes: 0, totalBytes: 0 });
    numeric.clear();
    empty.clear();
  });

  it('shared, detached, and throwing collectors remain unknown', () => {
    const shared = createShapeCache<FakeHandle>(2, undefined, () => [new SharedArrayBuffer(16)]);
    shared.set('a', fakeHandle('a'));
    expect(shared.stats().meshByteCounts).toEqual({ status: 'unknown', reason: 'invalid-byte-count' });
    const detached = new ArrayBuffer(16);
    structuredClone(detached, { transfer: [detached] });
    const invalid = createShapeCache<FakeHandle>(2, undefined, () => [detached]);
    invalid.set('a', fakeHandle('a'));
    expect(invalid.stats().meshByteCounts).toEqual({ status: 'unknown', reason: 'invalid-byte-count' });
    const throwing = createShapeCache<FakeHandle>(2, undefined, () => { throw new Error('unavailable'); });
    throwing.set('a', fakeHandle('a'));
    expect(throwing.stats().meshByteCounts).toEqual({ status: 'unknown', reason: 'callback-error' });
    shared.clear();
    invalid.clear();
    throwing.clear();
  });

  it('an explicit buffer collector cannot hide a failed legacy numeric measurement', () => {
    const cache = createShapeCache<FakeHandle>(2, () => -1, () => [new ArrayBuffer(16)]);
    cache.set('a', fakeHandle('a'));
    expect(cache.stats().meshByteCounts).toEqual({ status: 'unknown', reason: 'invalid-byte-count' });
    cache.clear();
  });
});

describe('形状キャッシュに実物の OCCT の形を預ける', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('預けた形をそのまま取り出して使える', () => {
    const cache = createShapeCache<OcctShapeHandle>(2);
    cache.set('box', makeBox(oc, { dx: 10, dy: 20, dz: 30 }));
    try {
      const cached = cache.get('box');
      expect(cached).toBeDefined();
      expect(cached?.shape.IsNull()).toBe(false);
    } finally {
      cache.clear();
    }
  });

  it('追い出された形は取り出せず、OCCT 側でも使えなくなる', () => {
    const cache = createShapeCache<OcctShapeHandle>(1);
    const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    cache.set('box', box);
    expect(box.shape.IsNull()).toBe(false);

    // 容量 1 なので、次の形を入れた時点で box は解放される。
    cache.set('other', makeBox(oc, { dx: 1, dy: 1, dz: 1 }));
    try {
      expect(cache.get('box')).toBeUndefined();
      expect(cache.has('box')).toBe(false);
      // 解放済みの実体は embind が拒む(二重解放や参照の持ち越しを検出できる)。
      expect(() => box.shape.IsNull()).toThrow();
    } finally {
      cache.clear();
    }
  });
});
