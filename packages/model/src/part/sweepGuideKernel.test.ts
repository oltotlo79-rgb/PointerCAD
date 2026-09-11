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
import type { PartDocument, SweepFeature } from './types.js';

let bridge: KernelBridge;
beforeAll(async () => { await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode)); }, 180_000);
function fixture(): { document: PartDocument; sweep: SweepFeature } {
  const base = createEmptyPartDocument(); let sketch = base.sketches[0];
  const points = [[4, 2], [-4, 2], [-4, -2], [4, -2]];
  points.forEach(([x, y], index) => {
    const next = points[(index + 1) % points.length];
    sketch = appendFeature(sketch, { id: `edge-${index}`, name: `輪郭${index}`, kind: 'line', planeId: 'xy', construction: false,
      from: absoluteCoordinate(x, y, 0), to: absoluteCoordinate(next[0], next[1], 0) });
  });
  sketch = appendFeature(sketch, { id: 'face', name: '断面', kind: 'face', planeId: 'xy',
    boundary: points.map((_, index) => ({ featureId: `edge-${index}` })), color: '#6699aa' });
  sketch = appendFeature(sketch, { id: 'path', name: '経路', kind: 'line', planeId: FREE_WORK_PLANE_ID, construction: false,
    from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(0, 0, 100) });
  const guideSketch = appendFeature({ ...base.sketches[0], id: 'guide-sketch', name: '案内線用' }, {
    id: 'guide', name: '案内線', kind: 'line', planeId: FREE_WORK_PLANE_ID, construction: false,
    from: absoluteCoordinate(4, 2, 0), to: absoluteCoordinate(2, 1, 100) });
  const sweep: SweepFeature = { id: 'guided-sweep', name: 'スイープ', kind: 'sweep', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: 'face' }, path: { sketchId: sketch.id, curveIds: ['path'] },
    guide: { sketchId: guideSketch.id, curveIds: ['guide'] }, frenet: true };
  return { document: appendSolid({ ...replaceSketch(base, sketch), sketches: [sketch, guideSketch] }, sweep), sweep };
}

describe('P11b 案内線の文書→依存→キャッシュ→実OCCT', () => {
  it('倍率の元線変更は再計算に伝わり、案内なし/Undo相当の復元も正しい', async () => {
    const { document, sweep } = fixture();
    const caches = { offsets: createOffsetCache(), projections: createProjectionCache(), subShapes: createSubShapeCache() };
    const first = await recomputePart(document, bridge, caches);
    expect(first.errors).toEqual([]); expect(first.bodies).toHaveLength(1);
    expect(first.bodies[0].volume).toBeCloseTo(32 * 100 * (1 + 0.5 + 0.25) / 3, 2);
    const guideSketch = document.sketches[1];
    const edited = replaceSketch(document, { ...guideSketch, features: guideSketch.features.map((feature) => feature.kind === 'line'
      ? { ...feature, to: absoluteCoordinate(3, 1.5, 100) } : feature) });
    const second = await recomputePart(edited, bridge, caches);
    expect(second.errors).toEqual([]); expect(second.cacheHits).toBe(0);
    expect(second.bodies[0].volume).toBeCloseTo(32 * 100 * (1 + 0.75 + 0.75 ** 2) / 3, 2);
    const plain = await recomputePart(replaceSolid(document, sweep.id, { ...sweep, guide: undefined }), bridge, caches);
    expect(plain.errors).toEqual([]); expect(plain.cacheHits).toBe(0); expect(plain.bodies[0].volume).toBeCloseTo(3200, 2);
    const restored = await recomputePart(document, bridge, caches);
    expect(restored.errors).toEqual([]); expect(restored.cacheHits).toBe(1); expect(restored.bodies[0].volume).toBe(first.bodies[0].volume);
  });
  it('別スケッチの案内線も依存へ入り、消した場合は案内線のエラーを出す', () => {
    const { document, sweep } = fixture();
    expect(referencedSketchIds(sweep)).toContain('guide-sketch');
    const missing = { ...document, sketches: document.sketches.slice(0, 1) };
    const errors = resolvePart(missing).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ featureId: sweep.id, code: 'missingProfile' });
    expect(errors[0].message).toContain('案内線');
  });
});
