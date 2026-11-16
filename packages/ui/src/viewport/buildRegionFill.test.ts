import type { Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { appendRegionFills, buildRegionFills, sameRegionFillInput, type RegionFillInput } from './buildRegionFill.js';
import { buildSketchGeometry, EMPTY_RESOLVED_SKETCH } from './buildSketchGeometry.js';

// M-01 の M01-3: 押し出しで面を選んでいない時に、作図面の閉じた領域を薄く塗り、カーソルの下を濃くする。
// 塗りは面と同じ形(SketchFaceDraw)で返し、描く側(createSketchLayer)は面と同じ決まりで描く。

/** 辺ごとに `perEdge` 個の標本を持つ多角形(sketchRegions の標本の折れ線と同じく、同じ線の上の点を含む)。 */
function sampled(corners: readonly (readonly [number, number])[], perEdge = 4, z = 0): Vec3[] {
  const points: Vec3[] = [];
  corners.forEach(([x, y], index) => {
    const [nx, ny] = corners[(index + 1) % corners.length];
    for (let step = 0; step < perEdge; step += 1) {
      const ratio = step / perEdge;
      points.push([x + (nx - x) * ratio, y + (ny - y) * ratio, z]);
    }
  });
  return points;
}

/** 三角形の面積の和と、三角形の数。 */
function triangles(positions: Float32Array, indices: Uint32Array): { readonly area: number; readonly count: number } {
  let area = 0;
  for (let at = 0; at < indices.length; at += 3) {
    const [a, b, c] = [indices[at], indices[at + 1], indices[at + 2]].map(index => [
      positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]] as const);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    area += Math.hypot(cross[0], cross[1], cross[2]) / 2;
  }
  return { area, count: indices.length / 3 };
}

function input(regions: RegionFillInput['regions'], overrides: Partial<RegionFillInput> = {}): RegionFillInput {
  return { regions, hoveredElementId: null, chosenElementId: null, color: '#7f9fbf', ...overrides };
}

describe('領域の塗りを組み立てる(M01-3)', () => {
  it('塗る物が無ければ空', () => {
    expect(buildRegionFills(null)).toEqual([]);
    expect(buildRegionFills(input([]))).toEqual([]);
  });

  it('正方形は、同じ線の上の標本を除いて 2 枚の三角形になり、面積は 100', () => {
    const [fill] = buildRegionFills(input([{ elementId: '@region:rectangle-1', polygon: sampled([[0, 0], [10, 0], [10, 10], [0, 10]]) }]));
    expect(triangles(fill.positions, fill.indices)).toEqual({ area: 100, count: 2 });
    expect(fill.featureId).toBe('@region:rectangle-1');
    expect(fill.color).toBe('#7f9fbf');
    expect(Array.from(fill.normals.slice(0, 3)).map(Math.abs)).toEqual([0, 0, 1]);
  });

  it('へこんだ L 字も、時計回りの並びも、外へはみ出さずに塗る(面積が一致する)', () => {
    const shape: readonly (readonly [number, number])[] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
    const [counterclockwise] = buildRegionFills(input([{ elementId: '@region:a', polygon: sampled(shape) }]));
    expect(triangles(counterclockwise.positions, counterclockwise.indices)).toEqual({ area: 300, count: 4 });
    const [clockwise] = buildRegionFills(input([{ elementId: '@region:b', polygon: sampled([...shape].reverse()) }]));
    expect(triangles(clockwise.positions, clockwise.indices)).toEqual({ area: 300, count: 4 });
  });

  it('円の標本の多角形は、標本の数より 2 少ない三角形で、多角形と同じ面積になる', () => {
    const polygon: Vec3[] = Array.from({ length: 64 }, (_, index) => {
      const angle = (index / 64) * 2 * Math.PI;
      return [5 * Math.cos(angle), 5 * Math.sin(angle), 3];
    });
    const [fill] = buildRegionFills(input([{ elementId: '@region:arc-1', polygon }]));
    const measured = triangles(fill.positions, fill.indices);
    expect(measured.count).toBe(62);
    expect(measured.area).toBeCloseTo(0.5 * 64 * 25 * Math.sin((2 * Math.PI) / 64), 3);
  });

  it('カーソルの下は濃く(hovered)、選んだ領域は選択の濃さ(selected)、ほかは薄く(none)', () => {
    const square = sampled([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const other = sampled([[20, 0], [30, 0], [30, 10], [20, 10]]);
    const third = sampled([[40, 0], [50, 0], [50, 10], [40, 10]]);
    const fills = buildRegionFills(input([
      { elementId: '@region:a', polygon: square }, { elementId: '@region:b', polygon: other }, { elementId: '@region:c', polygon: third },
    ], { hoveredElementId: '@region:b', chosenElementId: '@region:c' }));
    expect(fills.map(fill => fill.emphasis)).toEqual(['none', 'hovered', 'selected']);
  });

  it('材料が同じ間は渡し直さない(塗る領域・カーソルの下・選んだ領域のどれかが変われば渡し直す)', () => {
    const polygon = sampled([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const base = input([{ elementId: '@region:a', polygon }]);
    expect(sameRegionFillInput(null, null)).toBe(true);
    expect(sameRegionFillInput(base, null)).toBe(false);
    expect(sameRegionFillInput(base, input([{ elementId: '@region:a', polygon }]))).toBe(true);
    expect(sameRegionFillInput(base, { ...base, hoveredElementId: '@region:a' })).toBe(false);
    expect(sameRegionFillInput(base, { ...base, chosenElementId: '@region:a' })).toBe(false);
    expect(sameRegionFillInput(base, input([{ elementId: '@region:a', polygon: [...polygon] }]))).toBe(false);
  });

  it('塗りが無ければ描画の一式をそのまま返し、あれば面の後ろへ足す', () => {
    const bundle = buildSketchGeometry(EMPTY_RESOLVED_SKETCH, null);
    expect(appendRegionFills(bundle, [])).toBe(bundle);
    const fills = buildRegionFills(input([{ elementId: '@region:a', polygon: sampled([[0, 0], [10, 0], [10, 10], [0, 10]]) }]));
    expect(appendRegionFills(bundle, fills).faces).toEqual([...bundle.faces, ...fills]);
  });

  it('ホバーが変わっただけなら、同じ三角形の並びを使い回す(描く側が作り直さずに色だけ塗り替えられる)', () => {
    const polygon = sampled([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const regions = [{ elementId: '@region:a', polygon }];
    const [first] = buildRegionFills(input(regions));
    const [second] = buildRegionFills(input(regions, { hoveredElementId: '@region:a' }));
    expect(second.positions).toBe(first.positions);
    expect(second.indices).toBe(first.indices);
    expect(second.emphasis).toBe('hovered');
  });
});
