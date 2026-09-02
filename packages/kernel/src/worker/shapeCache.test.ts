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
    cache.set('a', fakeHandle('a'));
    cache.set('b', fakeHandle('b'));
    expect(cache.stats()).toEqual({ size: 2, evictions: 0, released: 0 });

    // 容量 2 に 3 件目を入れると、最も古い a を追い出す。
    cache.set('c', fakeHandle('c'));
    expect(cache.stats()).toEqual({ size: 2, evictions: 1, released: 1 });

    // 上書きは解放だが追い出しではない。
    cache.set('b', fakeHandle('b2'));
    expect(cache.stats()).toEqual({ size: 2, evictions: 1, released: 2 });

    cache.clear();
    expect(cache.stats()).toEqual({ size: 0, evictions: 1, released: 4 });
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
