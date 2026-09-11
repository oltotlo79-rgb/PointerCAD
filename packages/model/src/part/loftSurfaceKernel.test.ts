import { expressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type KernelBridge } from '../kernelBridge.js';
import { absoluteCoordinate, appendFeature } from '../sketch/createSketchDocument.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { createOffsetCache } from '../sketch/offsetMath.js';
import { createProjectionCache } from '../sketch/projectionMath.js';
import { appendSolid, createEmptyPartDocument, replaceSketch, replaceSolid } from './createPartDocument.js';
import { recomputePart } from './recomputePart.js';
import { resolvePart, referencedSketchIds } from './resolvePart.js';
import { createSubShapeCache } from './subShapeCache.js';
import type { LoftFeature, PartDocument } from './types.js';

let bridge: KernelBridge;
beforeAll(async () => { await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode)); }, 180_000);
function fixture(smooth: boolean): { document: PartDocument; loft: LoftFeature } {
  const base = createEmptyPartDocument(); let sketch = base.sketches[0];
  const levels = [[0, 1], [20, 2], [60, 1.5], [100, 1]];
  for (const [z, scale] of levels) sketch = appendFeature(sketch, { id: `spline-${z}`, name: `輪郭${z}`,
    kind: 'spline', planeId: FREE_WORK_PLANE_ID, mode: 'control', closed: true, construction: false,
    points: [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => absoluteCoordinate(x * scale, y * scale, z)) });
  const loft: LoftFeature = { id: 'loft-surface', name: 'ロフト', kind: 'loft', suppressed: false, smooth,
    twist: expressionValueFromNumber(0), sections: levels.map(([z]) => ({ kind: 'sketchCurves', ref: { sketchId: sketch.id, curveIds: [`spline-${z}`] } })) };
  return { document: appendSolid(replaceSketch(base, sketch), loft), loft };
}

describe('P11b 閉スプラインの文書→キャッシュ→実OCCT', () => {
  it('平滑化の切替は別の鍵で再計算され、元へ戻すと同じ形を再利用する', async () => {
    const { document, loft } = fixture(false);
    const caches = { offsets: createOffsetCache(), projections: createProjectionCache(), subShapes: createSubShapeCache() };
    const first = await recomputePart(document, bridge, caches);
    expect(first.errors).toEqual([]); expect(first.bodies).toHaveLength(1);
    const changed = replaceSolid(document, loft.id, { ...loft, smooth: true });
    const second = await recomputePart(changed, bridge, caches);
    expect(second.errors).toEqual([]); expect(second.cacheHits).toBe(0);
    expect(second.bodies[0].volume).toBeGreaterThan(0);
    expect(second.bodies[0].volume).not.toBeCloseTo(first.bodies[0].volume, 2);
    const restored = await recomputePart(document, bridge, caches);
    expect(restored.errors).toEqual([]); expect(restored.cacheHits).toBe(1);
    expect(restored.bodies[0].volume).toBe(first.bodies[0].volume);
  });
  it('曲線のスケッチを依存として追い、参照切れを断る', () => {
    const { document, loft } = fixture(true);
    expect(referencedSketchIds(loft)).toContain(document.activeSketchId);
    const missing = replaceSolid(document, loft.id, { ...loft, sections: [loft.sections[0],
      { kind: 'sketchCurves', ref: { sketchId: 'missing', curveIds: ['spline-20'] } }] });
    expect(resolvePart(missing).errors.some((error) => error.featureId === loft.id && error.code === 'missingProfile')).toBe(true);
  });
});
