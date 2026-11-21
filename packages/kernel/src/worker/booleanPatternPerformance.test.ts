import { expectWithinBudget } from '@pointercad/test-utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type { CurveSpec, RigidTransformSpec, SolidRecomputeResult, SolidStepRequest, SolidStepSpec } from '../types.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache, type ShapeCache } from './shapeCache.js';

/**
 * 並べる和・差(M-04 の計算部)の 1 段の所要(NFR-PF-2 / NFR-PF-3)。判定の境は expectWithinBudget の境(目標の 5 倍、
 * docs/requirements.md の時間だけの性能の検査の境)。
 *
 * - 典型の個数(円形 20 個・直線 5 個): 単一フィーチャーの改善目標 500 ms(solidPerformance.test.ts の
 *   SINGLE_FEATURE_LIMIT_MS と同じ値。境 2,500 ms)。
 * - 上限の個数(写し 99 個): 工具 99 個を組み合わせる重いブーリアンなので、solidPerformance.test.ts の
 *   「重いブーリアン連鎖」(箱 100 個を差で 99 段)と同じ目標 5,000 ms(FULL_RECOMPUTE_LIMIT_MS。境 25,000 ms)。
 *   根拠: 1 段で 99 個の工具を組み合わせる仕事は、あちらの 99 段と同じ量になる。新しい検査の区分の当て方で、
 *   今ある検査の目標や境を緩める物ではない(2026-11-19 統括の決定)。手元の実測は 3.2〜6.8 秒で、使う側には遅いので、
 *   速くする直しは別の行で追う(和の組み立て・形の正しさの確かめ・体積の重なり)。
 * 測るのは並べる段だけ: 前の段(板・ボス・最初の和)を先に同じキャッシュへ作っておき、測る依頼では全部当たる。
 * 手元の実測と境に対する余裕は、M-04 の計算部 kernel-3 の記録(担当フォルダーの kernel3/record.md)にある。
 */
const SINGLE_FEATURE_TARGET_MS = 500;
const HEAVY_BOOLEAN_TARGET_MS = 5000;
const RELATIVE = 1e-9;

function rectangleAt(x: number, y: number, z: number, width: number, depth: number): readonly CurveSpec[] {
  return [
    { kind: 'segment', from: [x, y, z], to: [x + width, y, z] },
    { kind: 'segment', from: [x + width, y, z], to: [x + width, y + depth, z] },
    { kind: 'segment', from: [x + width, y + depth, z], to: [x, y + depth, z] },
    { kind: 'segment', from: [x, y + depth, z], to: [x, y, z] },
  ];
}

function step(id: string, spec: SolidStepSpec, visible = false): SolidStepRequest {
  return { key: `key-${id}`, id, label: id, visible, step: spec };
}

function box(id: string, x: number, y: number, z: number, width: number, depth: number, height: number): SolidStepRequest {
  return step(id, { kind: 'extrude', profile: rectangleAt(x, y, z, width, depth), direction: [0, 0, 1], distance: height });
}

function combine(id: string, operation: 'union' | 'subtract', target: string, tool: string,
  transforms?: readonly RigidTransformSpec[]): SolidStepRequest {
  return step(id, { kind: 'boolean', operation, targetKey: `key-${target}`, toolKey: `key-${tool}`,
    ...(transforms === undefined ? {} : { transforms }) }, transforms !== undefined);
}

function translation(x: number, y: number): RigidTransformSpec {
  return { translation: [x, y, 0], rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 };
}

/** 板の中心(25, 25)を通る Z 軸まわりに、全周を count 等分した k 番目(k = 1..count-1)。 */
function circularCopies(count: number): readonly RigidTransformSpec[] {
  return Array.from({ length: count - 1 }, (_, index) => ({ translation: [0, 0, 0] as const, rotationOrigin: [25, 25, 0] as const,
    rotationAxis: [0, 0, 1] as const, rotationAngle: (2 * Math.PI * (index + 1)) / count }));
}

/** 10×10 の格子(間隔 4)のうち、もとの (0, 0) を除く 99 個。 */
function gridCopies(): readonly RigidTransformSpec[] {
  return Array.from({ length: 100 }, (_, index) => translation(4 * (index % 10), 4 * Math.floor(index / 10))).slice(1);
}

interface PatternCase {
  readonly label: string;
  /** 測らない前の段(板・工具・最初の和)。 */
  readonly prerequisites: readonly SolidStepRequest[];
  readonly pattern: SolidStepRequest;
  readonly volume: number;
  readonly targetMs: number;
}

const CASES: readonly PatternCase[] = [
  { label: '並べる和(円形 20 個、写し 19 個を 1 段で。板 50×50×10 にボス 2×2×3)',
    prerequisites: [box('plate', 0, 0, 0, 50, 50, 10), box('boss', 37, 24, 10, 2, 2, 3), combine('first', 'union', 'plate', 'boss')],
    pattern: combine('pattern', 'union', 'first', 'boss', circularCopies(20)), volume: 25_240, targetMs: SINGLE_FEATURE_TARGET_MS },
  { label: '並べる差(直線 5 個、写し 4 個を 1 段で。板 50×50×10 から深さ 3 の 2×2)',
    prerequisites: [box('plate', 0, 0, 0, 50, 50, 10), box('pocket', 5, 24, 7, 2, 2, 4), combine('first', 'subtract', 'plate', 'pocket')],
    pattern: combine('pattern', 'subtract', 'first', 'pocket', [8, 16, 24, 32].map(x => translation(x, 0))), volume: 24_940,
    targetMs: SINGLE_FEATURE_TARGET_MS },
  { label: '並べる和(格子 100 個、写し 99 個〔上限〕を 1 段で。板 50×50×10 にボス 1×1×2)',
    prerequisites: [box('plate', 0, 0, 0, 50, 50, 10), box('boss', 5, 5, 10, 1, 1, 2), combine('first', 'union', 'plate', 'boss')],
    pattern: combine('pattern', 'union', 'first', 'boss', gridCopies()), volume: 25_200, targetMs: HEAVY_BOOLEAN_TARGET_MS },
];

describe('並べる和・差の 1 段の所要(M-04 の計算部 kernel-3、NFR-PF-2)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  const openCaches: ShapeCache<CachedSolid>[] = [];

  beforeAll(async () => {
    oc = await loadOcctForNode();
    // 捨て計算: 押し出し・和・差・変換の複製(BRepBuilderAPI_Transform・BRepBuilderAPI_Copy)を初めて呼ぶ遅延を測定から外す
    // (solidPerformance.test.ts の捨て計算と同じ理由)。ここで作った形は測定に使わない。
    const warmUp = createShapeCache<CachedSolid>();
    try {
      const result = await recomputeSolids({ oc, cache: warmUp }, { generation: 0, steps: [box('warm-plate', 0, 0, 0, 20, 20, 5),
        box('warm-boss', 2, 2, 5, 2, 2, 2), combine('warm-first', 'union', 'warm-plate', 'warm-boss'),
        combine('warm-union', 'union', 'warm-first', 'warm-boss', [translation(6, 0)]),
        combine('warm-cut', 'subtract', 'warm-plate', 'warm-boss', [translation(0, 6)])] });
      expect(result.failures).toEqual([]);
    } finally {
      warmUp.clear();
    }
  });

  afterEach(() => {
    for (const cache of openCaches.splice(0)) cache.clear();
  });

  async function measurePattern(item: PatternCase): Promise<{ readonly result: SolidRecomputeResult; readonly elapsedMs: number }> {
    const cache = createShapeCache<CachedSolid>();
    openCaches.push(cache);
    const prepared = await recomputeSolids({ oc, cache }, { steps: item.prerequisites, generation: 1 });
    expect(prepared.failures).toEqual([]);
    const startedAt = performance.now();
    // 進捗と中止の口は渡さない(solidPerformance.test.ts の measure と同じ理由)。
    const result = await recomputeSolids({ oc, cache }, { steps: [...item.prerequisites, item.pattern], generation: 2 });
    return { result, elapsedMs: performance.now() - startedAt };
  }

  it.each(CASES)('$label', async (item) => {
    const { result, elapsedMs } = await measurePattern(item);
    console.log(`${item.label}: ${elapsedMs.toFixed(1)} ms / 改善目標 ${item.targetMs} ms`);
    expect(result.failures).toEqual([]);
    // 前の段は全部当たり、作ったのは並べる段だけ。
    expect(result.cacheHits).toBe(item.prerequisites.length);
    expect(result.bodies).toHaveLength(1);
    const [body] = result.bodies;
    expect(body === undefined ? Number.NaN : Math.abs(body.volume - item.volume) / item.volume).toBeLessThanOrEqual(RELATIVE);
    expectWithinBudget(elapsedMs, item.targetMs, item.label);
  });
});
