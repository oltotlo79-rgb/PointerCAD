import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type {
  CurveSpec,
  SolidProgress,
  SolidRecomputeRequest,
  SolidStepRequest,
} from '../types.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache, type ShapeCache } from './shapeCache.js';

/** 原点を角とする長方形の閉ループ(z = 0 の XY 面)。押し出すと直方体になる。 */
function rectangle(width: number, depth: number): readonly CurveSpec[] {
  return [
    { kind: 'segment', from: [0, 0, 0], to: [width, 0, 0] },
    { kind: 'segment', from: [width, 0, 0], to: [width, depth, 0] },
    { kind: 'segment', from: [width, depth, 0], to: [0, depth, 0] },
    { kind: 'segment', from: [0, depth, 0], to: [0, 0, 0] },
  ];
}

/** 押し出しの段を 1 つ作る。距離は mm、向きは +Z。 */
function extrudeStep(
  id: string,
  key: string,
  width: number,
  depth: number,
  distance: number,
  visible = true,
): SolidStepRequest {
  return {
    key,
    id,
    label: id,
    visible,
    step: {
      kind: 'extrude',
      profile: rectangle(width, depth),
      direction: [0, 0, 1],
      distance,
    },
  };
}

/** ブーリアンの段を 1 つ作る。 */
function booleanStep(
  id: string,
  key: string,
  operation: 'union' | 'subtract' | 'intersect',
  targetKey: string,
  toolKey: string,
): SolidStepRequest {
  return {
    key,
    id,
    label: id,
    visible: true,
    step: { kind: 'boolean', operation, targetKey, toolKey },
  };
}

function request(steps: readonly SolidStepRequest[]): SolidRecomputeRequest {
  return { steps, generation: 1 };
}

/** 40 × 30 を 10 押し出した体積。40·30·10 = 12000 mm³(手計算)。 */
const EXTRUDE_VOLUME = 12000;
/** 20 × 20 を 5 押し出した体積。20·20·5 = 2000 mm³(手計算)。 */
const SECOND_VOLUME = 2000;
/** 20 × 20 を 20 押し出した体積。20³ = 8000 mm³(手計算)。 */
const BIG_VOLUME = 8000;
/** 10 × 10 を 10 押し出した体積。10³ = 1000 mm³(手計算)。 */
const SMALL_VOLUME = 1000;
/** 小さい箱は大きい箱にすっかり含まれるので、差は 8000 − 1000 = 7000 mm³。 */
const SUBTRACT_VOLUME = BIG_VOLUME - SMALL_VOLUME;

/** 検査用のキャッシュ。本物を包んで「作り直した段の数」を数える。 */
interface TestCache {
  readonly cache: ShapeCache<CachedSolid>;
  /**
   * set が呼ばれた回数 = OCCT で作り直した段の数。
   * メソッドではなく関数の値として宣言する(取り出して使うため。unbound-method 対策)。
   */
  readonly built: () => number;
}

const openCaches: ShapeCache<CachedSolid>[] = [];

function newCache(): TestCache {
  const inner = createShapeCache<CachedSolid>();
  let built = 0;
  const cache: ShapeCache<CachedSolid> = {
    get: (key) => inner.get(key),
    set: (key, entry) => {
      built += 1;
      inner.set(key, entry);
    },
    has: (key) => inner.has(key),
    delete: (key) => inner.delete(key),
    retain: (liveKeys) => inner.retain(liveKeys),
    clear: () => {
      inner.clear();
    },
    get size(): number {
      return inner.size;
    },
    get capacity(): number {
      return inner.capacity;
    },
    stats: () => inner.stats(),
  };
  openCaches.push(cache);
  return { cache, built: () => built };
}

describe('履歴の再計算(recomputeSolids)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  // OCCT の形は JavaScript の回収の対象外なので、検査ごとに預けたものを手放す。
  afterEach(() => {
    for (const cache of openCaches.splice(0)) {
      cache.clear();
    }
  });

  it('1 段の押し出しから体積 12000 mm³ のボディを 1 つ返す', async () => {
    const { cache, built } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]),
    );

    expect(result.failures).toEqual([]);
    expect(result.cancelled).toBe(false);
    expect(result.cacheHits).toBe(0);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('extrude-1');
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    expect(result.bodies[0].faceCount).toBe(6);
    expect(result.bodies[0].edgeCount).toBe(12);
    // Comlink 越しに渡せる型(TypedArray と純データ)だけを使っている。
    expect(result.bodies[0].positions).toBeInstanceOf(Float32Array);
    expect(result.bodies[0].indices).toBeInstanceOf(Uint32Array);
    expect(result.bodies[0].edgePositions).toBeInstanceOf(Float32Array);
    expect(built()).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('押し出しを 2 段続けると、履歴の順にボディが 2 つ並ぶ', async () => {
    const { cache, built } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-b', 20, 20, 5),
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.cacheHits).toBe(0);
    expect(result.bodies.map((body) => body.id)).toEqual(['extrude-1', 'extrude-2']);
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    expect(result.bodies[1].volume).toBeCloseTo(SECOND_VOLUME, 6);
    expect(built()).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('同じ依頼をもう一度渡すと、1 段も作り直さずにキャッシュから返す(NFR-PF-3)', async () => {
    const { cache, built } = newCache();
    const steps = [
      extrudeStep('extrude-1', 'key-a', 40, 30, 10),
      extrudeStep('extrude-2', 'key-b', 20, 20, 5),
    ];

    const first = await recomputeSolids({ oc, cache }, request(steps));
    expect(first.cacheHits).toBe(0);
    expect(built()).toBe(2);

    const second = await recomputeSolids({ oc, cache }, request(steps));
    expect(second.cacheHits).toBe(2);
    // 作り直しが起きていないこと。件数も増えない。
    expect(built()).toBe(2);
    expect(cache.size).toBe(2);
    expect(cache.stats().released).toBe(0);
    expect(second.bodies.map((body) => body.id)).toEqual(['extrude-1', 'extrude-2']);
    expect(second.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    expect(second.bodies[1].volume).toBeCloseTo(SECOND_VOLUME, 6);
  });

  it('鍵が同じで id が違う段には、キャッシュのメッシュを id だけ差し替えて返す', async () => {
    const { cache, built } = newCache();
    await recomputeSolids({ oc, cache }, request([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]));

    const result = await recomputeSolids(
      { oc, cache },
      request([extrudeStep('extrude-9', 'key-a', 40, 30, 10)]),
    );

    expect(result.cacheHits).toBe(1);
    expect(built()).toBe(1);
    expect(result.bodies[0].id).toBe('extrude-9');
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
  });

  it('押し出し 2 段と差で、消費された 2 つは返さず 7000 mm³ のボディだけを返す', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-big', 20, 20, 20, false),
        extrudeStep('extrude-2', 'key-small', 10, 10, 10, false),
        booleanStep('boolean-1', 'key-cut', 'subtract', 'key-big', 'key-small'),
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('boolean-1');
    expect(result.bodies[0].volume).toBeCloseTo(SUBTRACT_VOLUME, 6);
    // 消費された 2 つも次の再計算のためにキャッシュには残る。
    expect(cache.size).toBe(3);
  });

  it('作れない段があっても、後ろの段は計算する(FR-504)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-bad', 20, 20, 0),
        extrudeStep('extrude-3', 'key-c', 20, 20, 5),
      ]),
    );

    expect(result.failures).toEqual([
      { id: 'extrude-2', message: '押し出す長さは 0 より大きい数にしてください。' },
    ]);
    expect(result.bodies.map((body) => body.id)).toEqual(['extrude-1', 'extrude-3']);
    expect(result.bodies[1].volume).toBeCloseTo(SECOND_VOLUME, 6);
    expect(result.cancelled).toBe(false);
    // 失敗した段はキャッシュに入らない。
    expect(cache.has('key-bad')).toBe(false);
    expect(cache.size).toBe(2);
  });

  it('作れなかった段を入力にする段も、上流の名前を添えた理由で失敗して続く(FR-504)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('押し出し1', 'key-bad', 20, 20, 0),
        extrudeStep('押し出し2', 'key-small', 10, 10, 10, false),
        booleanStep('組み合わせ1', 'key-cut', 'subtract', 'key-bad', 'key-small'),
        extrudeStep('押し出し3', 'key-c', 20, 20, 5),
      ]),
    );

    expect(result.failures).toEqual([
      { id: '押し出し1', message: '押し出す長さは 0 より大きい数にしてください。' },
      {
        id: '組み合わせ1',
        message: 'もとになる立体「押し出し1」を作れなかったため、この立体も作れませんでした。',
      },
    ]);
    // 巻き添えにならない段は最後まで計算される。
    expect(result.bodies.map((body) => body.id)).toEqual(['押し出し3']);
    expect(result.cancelled).toBe(false);
  });

  it('どこにも無い鍵を指すブーリアンは、もとになる立体が無いと断る', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-big', 20, 20, 20, false),
        booleanStep('boolean-1', 'key-cut', 'subtract', 'key-big', 'key-nowhere'),
      ]),
    );

    expect(result.failures).toEqual([
      { id: 'boolean-1', message: 'もとになる立体が見つかりませんでした。' },
    ]);
    expect(result.bodies).toEqual([]);
  });

  it('段ごとに進捗を 1 回ずつ知らせる(NFR-PF-4)', async () => {
    const { cache } = newCache();
    const progress: SolidProgress[] = [];
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-b', 20, 20, 5),
        extrudeStep('extrude-3', 'key-bad', 20, 20, 0),
      ]),
      {},
      (value) => {
        progress.push(value);
      },
      () => false,
    );

    // 失敗する段も含めて、段の数だけ知らせる。
    expect(progress).toEqual([
      { stepId: 'extrude-1', index: 0, total: 3, label: 'extrude-1' },
      { stepId: 'extrude-2', index: 1, total: 3, label: 'extrude-2' },
      { stepId: 'extrude-3', index: 2, total: 3, label: 'extrude-3' },
    ]);
    expect(result.cancelled).toBe(false);
    expect(result.bodies).toHaveLength(2);
  });

  it('2 段目の前で中止すると、1 段目までを返して中止の印を立てる(NFR-PF-4)', async () => {
    const { cache } = newCache();
    const progress: SolidProgress[] = [];
    let asked = 0;
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-b', 20, 20, 5),
        extrudeStep('extrude-3', 'key-c', 10, 10, 10),
      ]),
      {},
      (value) => {
        progress.push(value);
      },
      () => {
        asked += 1;
        return true;
      },
    );

    expect(result.cancelled).toBe(true);
    expect(result.bodies.map((body) => body.id)).toEqual(['extrude-1']);
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    expect(result.failures).toEqual([]);
    // 尋ねるのは段と段の間だけ。1 段目は必ず計算する。
    expect(asked).toBe(1);
    expect(progress).toHaveLength(1);
    expect(cache.size).toBe(1);
  });

  it('中止の口が Promise を返しても受け取れる(Comlink 越しの形)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-b', 20, 20, 5),
      ]),
      {},
      undefined,
      () => Promise.resolve(true),
    );

    expect(result.cancelled).toBe(true);
    expect(result.bodies).toHaveLength(1);
  });

  it('段が 1 つも無い依頼は、何もせずに空の結果を返す', async () => {
    const { cache, built } = newCache();
    const result = await recomputeSolids({ oc, cache }, request([]));

    expect(result).toEqual({ bodies: [], failures: [], cacheHits: 0, cancelled: false });
    expect(built()).toBe(0);
  });

  it('再計算のたびにキャッシュを掃除しない(Undo で作り直さないため。統括判断)', async () => {
    const { cache } = newCache();
    await recomputeSolids({ oc, cache }, request([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]));

    // 前の段を含まない依頼を流しても、前の鍵は残っている(retain を呼ばない)。
    await recomputeSolids({ oc, cache }, request([extrudeStep('extrude-2', 'key-b', 20, 20, 5)]));

    expect(cache.has('key-a')).toBe(true);
    expect(cache.has('key-b')).toBe(true);
    expect(cache.size).toBe(2);
  });
});
