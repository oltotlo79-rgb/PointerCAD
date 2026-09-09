import { expectWithinBudget } from '@pointercad/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CurveSpec, HiddenLineMode, HiddenLineViewRequest, SolidStepRequest } from '../types.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { createKernelApi, type ManagedKernelApi } from './kernelApi.js';

const square: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [20, 0, 0] },
  { kind: 'segment', from: [20, 0, 0], to: [20, 20, 0] },
  { kind: 'segment', from: [20, 20, 0], to: [0, 20, 0] },
  { kind: 'segment', from: [0, 20, 0], to: [0, 0, 0] },
];

/** 既存NFR-PF-3と同じ100押し出し。全100ボディをHLRへ渡す。 */
function hundredFeatureSteps(): readonly SolidStepRequest[] {
  return Array.from({ length: 100 }, (_, index) => {
    const offsetX = (index % 10) * 30; const offsetY = Math.floor(index / 10) * 30;
    const profile: readonly CurveSpec[] = square.map((curve): CurveSpec => {
      if (curve.kind !== 'segment') return curve;
      return { ...curve, from: [curve.from[0] + offsetX, curve.from[1] + offsetY, curve.from[2]],
        to: [curve.to[0] + offsetX, curve.to[1] + offsetY, curve.to[2]] };
    });
    const key = `feature-${String(index + 1)}`;
    return { id: key, key, label: key, visible: true,
      step: { kind: 'extrude', profile, direction: [0, 0, 1], distance: 20 } };
  });
}

const view = (
  id: string,
  mode: HiddenLineMode,
  normal: readonly [number, number, number] = [0, 0, 1],
  xDir: readonly [number, number, number] = [1, 0, 0],
): HiddenLineViewRequest => ({ id, mode, origin: [0, 0, 0], normal, xDir, includeHidden: true });

describe.sequential('隠線処理の性能上限', () => {
  let api: ManagedKernelApi;
  const bodyIds = hundredFeatureSteps().map((step) => step.key);
  let polyMs = 0;

  beforeAll(async () => {
    api = createKernelApi(loadOcctForNode);
    const built = await api.recomputeSolids({ partId: 'hlr-performance', generation: 1, steps: hundredFeatureSteps() });
    expect(built.failures).toEqual([]);
    // WASM とメッシュを暖機し、計測に初回ロードを混ぜない。
    await api.hiddenLineViews({ bodyIds, views: [view('warm', 'poly')] });
  }, 30_000);

  afterAll(async () => { await api.releasePart('hlr-performance'); });

  it('近似HLR 1図を200ms以内で作る', async () => {
    const started = performance.now();
    const result = await api.hiddenLineViews({ bodyIds, views: [view('poly', 'poly')] });
    const elapsed = performance.now() - started;
    expect(result.failures).toEqual([]);
    expect(result.views[0]?.visible).toHaveLength(400);
    polyMs = elapsed;
    console.log(`[実測] 100押し出し・100ボディの近似HLR: ${elapsed.toFixed(2)}ms`);
    expectWithinBudget(elapsed, 200, '100フィーチャーの近似HLR 1図');
  });

  it('精密HLR 1図を2秒以内で作る', async () => {
    const started = performance.now();
    const result = await api.hiddenLineViews({ bodyIds, views: [view('precise', 'precise')] });
    const elapsed = performance.now() - started;
    expect(result.failures).toEqual([]);
    console.log(`[実測] 100押し出し・100ボディの精密HLR: ${elapsed.toFixed(2)}ms`);
    console.log(`[実測] 精密/近似の時間比: ${(elapsed / polyMs).toFixed(2)}`);
    expectWithinBudget(elapsed, 2_000, '100フィーチャーの精密HLR 1図');
  });

  it('三面図を1往復・5秒以内で作る', async () => {
    const started = performance.now();
    const result = await api.hiddenLineViews({
      bodyIds,
      views: [
        view('front', 'precise'),
        view('top', 'precise', [0, 1, 0], [1, 0, 0]),
        view('right', 'precise', [1, 0, 0], [0, 1, 0]),
      ],
    });
    const elapsed = performance.now() - started;
    expect(result.views).toHaveLength(3);
    console.log(`[実測] 100押し出し・100ボディの三面図HLR: ${elapsed.toFixed(2)}ms`);
    expectWithinBudget(elapsed, 5_000, '100フィーチャーの三面図HLR');
  });
});
