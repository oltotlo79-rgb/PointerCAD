import { describe, expect, it } from 'vitest';
import { absoluteCoordinate as xyz } from './createSketchDocument.js';
import { resolveSketch } from './resolveSketch.js';
import { splitLineIntersections } from './splitLineIntersections.js';
import { explodeCompoundFeature } from './trimExtend.js';
import type { SketchDocument, SketchFeature, SketchRectangleFeature } from './types.js';
import type { Vec3 } from './vec3.js';

const outer: SketchRectangleFeature = { id: 'outer', name: 'outer', kind: 'rectangle', planeId: 'xy',
  corner1: xyz(0, 0, 0), corner2: xyz(60, 40, 0), construction: false };
const inner: SketchRectangleFeature = { ...outer, id: 'inner', corner1: xyz(10, 10, 0), corner2: xyz(20, 30, 0) };
function withHole(features: readonly SketchFeature[], ids: readonly string[]): SketchDocument {
  return { id: 'sketch', name: 'sketch', features: [outer, ...features,
    { id: 'face', name: 'face', kind: 'face', planeId: 'xy', color: '#ffffff', boundary: [{ featureId: 'outer' }],
      holes: [ids.map(featureId => ({ featureId }))] }] };
}

describe('穴の参照を保った輪郭の編集', () => {
  it('穴の矩形を分解しても同じ4辺の穴として解決する', () => {
    const result = explodeCompoundFeature(withHole([inner], ['inner']), 'inner');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const after = resolveSketch(result.document);
    expect(after.errors).toEqual([]);
    expect(after.faces[0].holes?.[0]).toHaveLength(4);
  });

  it('穴の辺を交点で分けても穴が閉じたまま保たれる', () => {
    const points: readonly Vec3[] = [[10, 10, 0], [20, 10, 0], [20, 30, 0], [10, 30, 0]];
    const lines: SketchFeature[] = points.map((from, index) => ({ id: `inner-${String(index)}`, name: 'inner', kind: 'line',
      planeId: 'xy', from: xyz(...from), to: xyz(...points[(index + 1) % 4]), construction: false }));
    const crossing: SketchFeature = { id: 'crossing', name: 'crossing', kind: 'line', planeId: 'xy',
      from: xyz(15, 5, 0), to: xyz(15, 15, 0), construction: false };
    const result = splitLineIntersections(withHole([...lines, crossing], lines.map(line => line.id)), 'crossing');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const after = resolveSketch(result.document);
    expect(after.errors).toEqual([]);
    expect(after.faces[0].holes?.[0]).toHaveLength(5);
  });
});
