import { SKETCH_TOLERANCE_MM, type Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { isSimplePolygon, orderFacePoints } from './facePointOrder.js';

describe('面の角の並び(R30)', () => {
  it('交差しない選択順は三角形・凹形・一直線の角を含めてそのまま使う', () => {
    const cases: readonly (readonly Vec3[])[] = [
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [10, 10, 0]],
      [[0, 0, 0], [30, 0, 0], [60, 0, 0], [30, 20, 0]],
      [[-10, -10, -10], [10, -10, -10], [10, 10, 10], [-10, 10, 10]],
    ];
    for (const points of cases) {
      expect(orderFacePoints(points)).toEqual({ ok: true, order: points.map((_, index) => index), reordered: false });
    }
  });
  it('交差する選択順は重心の周りの角度順に並べ直し、最初に選んだ点から始める', () => {
    expect(orderFacePoints([[0, 0, 0], [30, 0, 0], [0, 20, 0], [30, 20, 0]]))
      .toEqual({ ok: true, order: [0, 1, 3, 2], reordered: true });
    // Folding back along one line is also a crossing of the outline.
    expect(orderFacePoints([[0, 0, 0], [60, 0, 0], [30, 0, 0], [30, 20, 0]]))
      .toEqual({ ok: true, order: [0, 2, 1, 3], reordered: true });
    const tilted: readonly Vec3[] = [[-10, -10, -10], [10, 10, 10], [10, -10, -10], [-10, 10, 10]];
    const result = orderFacePoints(tilted);
    if (!result.ok) throw new Error(result.reason);
    expect(result.reordered).toBe(true);
    expect(result.order[0]).toBe(0);
    const edges = result.order.map((index, position) => [index, result.order[(position + 1) % 4]].sort().join('-')).sort();
    expect(edges).toEqual(['0-2', '0-3', '1-2', '1-3']);
  });
  it('重なる点・一直線・同じ平面に乗らない点・並べ直しても交差する点を理由付きで断る', () => {
    expect(orderFacePoints([[0, 0, 0], [10, 0, 0], [0, 0, 0]])).toEqual({ ok: false, reason: 'samePoint' });
    expect(orderFacePoints([[0, 0, 0], [10, 0, 0], [SKETCH_TOLERANCE_MM / 2, 0, 0], [0, 10, 0]]))
      .toEqual({ ok: false, reason: 'samePoint' });
    expect(orderFacePoints([[0, 0, 0], [10, 0, 0], [20, 0, 0]])).toEqual({ ok: false, reason: 'collinear' });
    expect(orderFacePoints([[0, 0, 0], [10, 10, 10], [-5, -5, -5], [30, 30, 30]])).toEqual({ ok: false, reason: 'collinear' });
    expect(orderFacePoints([[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]])).toEqual({ ok: false, reason: 'notPlanar' });
    // A corner within the same-point tolerance of the opposite side encloses no usable area in any order.
    expect(orderFacePoints([[0, 0, 0], [1000, 0, 0], [500, SKETCH_TOLERANCE_MM / 2, 0]]))
      .toEqual({ ok: false, reason: 'selfIntersecting' });
  });
  it('平面と重なりの判定は面の境界と同じ許容差の内外で分かれる', () => {
    const square = (height: number): readonly Vec3[] => [[0, 0, 0], [10, 0, 0], [10, 10, height], [0, 10, 0]];
    expect(orderFacePoints(square(SKETCH_TOLERANCE_MM / 2)).ok).toBe(true);
    expect(orderFacePoints(square(SKETCH_TOLERANCE_MM * 2))).toEqual({ ok: false, reason: 'notPlanar' });
    expect(orderFacePoints([[0, 0, 0], [10, 0, 0], [SKETCH_TOLERANCE_MM * 2, 0, 0], [0, 10, 0]]).ok).toBe(true);
  });
  it('閉じた折れ線の交差・接触・折り返しを見つけ、真っすぐな角と凹形は通す', () => {
    expect(isSimplePolygon([[0, 0], [10, 0], [0, 10]])).toBe(true);
    expect(isSimplePolygon([[0, 0], [10, 0], [20, 0], [10, 10]])).toBe(true);
    expect(isSimplePolygon([[0, 0], [20, 0], [20, 20], [10, 5], [0, 20]])).toBe(true);
    expect(isSimplePolygon([[0, 0], [10, 0], [0, 10], [10, 10]])).toBe(false);
    expect(isSimplePolygon([[0, 0], [20, 0], [20, 20], [10, 0], [0, 20]])).toBe(false);
    expect(isSimplePolygon([[0, 0], [20, 0], [10, 0], [10, 10]])).toBe(false);
    expect(isSimplePolygon([[0, 0], [10, 0]])).toBe(false);
  });
});
