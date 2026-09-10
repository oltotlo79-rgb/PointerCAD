import { describe, expect, it } from 'vitest';
import { drawingRegionContainsPoint, type DrawingView, type Point2, type Vector3 } from '@pointercad/drawing';
import { createDrawingSurfaceAnchor } from './drawingSurfaceAnchor.js';
import type { ConstructedDrawingView } from './viewConstruction.js';

const view: DrawingView = { id: 'view', name: '平面', kind: 'top', direction: [0, 0, -1], xDir: [1, 0, 0], position: [100, 100],
  scale: 1, layerId: 'layer-1', showHidden: true, showCenterLines: true };
const triangle: readonly [Vector3, Vector3, Vector3] = [[0, 0, 0], [20, 0, 0], [0, 20, 0]];
const plane = { origin: [0, 0, 5] as const, normal: [0, 0, 1] as const, axisU: [1, 0, 0] as const, axisV: [0, 1, 0] as const };
function anchor(patch: Partial<ConstructedDrawingView> = {}, points = triangle): Point2 | null {
  const frame = { view, modelCenter: [0, 0, 0] as const, ...patch };
  const pick = createDrawingSurfaceAnchor(frame.view, 1, { instances: [], modelCenter: [0, 0, 0], viewFrames: new Map([[view.id, frame]]) });
  const result = pick?.(points); return result == null ? null : [result.paperPoint[0] - 100, result.paperPoint[1] - 100];
}
function requirePoint(point: Point2 | null): Point2 { expect(point).not.toBeNull(); if (point === null) throw new Error('面の指示点なし'); return point; }

describe('表示範囲と断面を保った幾何公差の面指示点', () => {
  it('元の面の実三角形の重心を使い、同じ入力の結果は一致する', () => {
    expect(anchor()?.[0]).toBeCloseTo(20 / 3, 10); expect(anchor()?.[1]).toBeCloseTo(20 / 3, 10);
    expect(anchor()).toEqual(anchor());
  });
  it('三角形の全頂点が外でも、内部の小さい詳細円へ指示できる', () => {
    const point = requirePoint(anchor({ clips: [{ kind: 'circle', center: [12, 2], radius: 0.1 }] }));
    expect(point[0]).toBeCloseTo(12, 10); expect(point[1]).toBeCloseTo(2, 10);
  });
  it('円の中心が元面外にあっても、実際に交わった範囲へ置く', () => {
    const circle = { kind: 'circle' as const, center: [11, 10] as const, radius: 1 };
    const point = requirePoint(anchor({ clips: [circle] }));
    expect(point[0] + point[1]).toBeLessThanOrEqual(20 + 1e-9);
    expect(drawingRegionContainsPoint(point, circle)).toBe(true);
  });
  it('中心が互いの外にある二円の細い共通領域でも交点から指示点を求める', () => {
    const clips = [{ kind: 'circle' as const, center: [7.9, 2] as const, radius: 1 }, { kind: 'circle' as const, center: [9.8, 2] as const, radius: 1 }];
    const point = requirePoint(anchor({ clips }));
    for (const region of clips) expect(drawingRegionContainsPoint(point, region)).toBe(true);
  });
  it.each([false, true])('凹形の部分図を穴埋めせず、境界の逆順=%sでも内部へ置く', (reverse) => {
    const points: readonly Point2[] = [[12, 1], [16, 1], [16, 2], [13, 2], [13, 4], [12, 4]];
    const region = { kind: 'polygon' as const, points: reverse ? [...points].reverse() : points };
    const point = requirePoint(anchor({ clips: [region] }));
    expect(drawingRegionContainsPoint(point, region)).toBe(true);
    expect(point[0] <= 13 || point[1] <= 2).toBe(true);
  });
  it('領域が別々なら元面の重心へ代替しない', () => {
    expect(anchor({ clips: [{ kind: 'circle', center: [25, 25], radius: 1 }] })).toBeNull();
    expect(anchor({ clips: [{ kind: 'circle', center: [2, 2], radius: 1 }, { kind: 'circle', center: [12, 2], radius: 1 }] })).toBeNull();
  });
  it.each(['positive', 'negative'] as const)('全断面の%s側だけへ傾斜面上の指示点を置く', (keepSide) => {
    const points: readonly [Vector3, Vector3, Vector3] = [[0, 0, 0], [20, 0, 20], [0, 20, 0]];
    const point = requirePoint(anchor({ section: { plane, kind: 'full', keepSide } }, points));
    if (keepSide === 'positive') expect(point[0]).toBeGreaterThanOrEqual(5 - 1e-9);
    else expect(point[0]).toBeLessThanOrEqual(5 + 1e-9);
    expect(point[0] + point[1]).toBeLessThanOrEqual(20 + 1e-9);
  });
  it('半断面で切らない側の面を保持し、切り取った側へ指示しない', () => {
    const point = requirePoint(anchor({ section: { plane, kind: 'half', keepSide: 'positive', boundary: [[0, 0], [20, 20]] } }));
    expect(point[1]).toBeLessThan(point[0]);
  });
  it('部分断面では除去した多角形の外だけが元面として残る', () => {
    const boundary: readonly Point2[] = [[0, 0], [8, 0], [8, 8], [0, 8]];
    const point = requirePoint(anchor({ section: { plane, kind: 'local', keepSide: 'positive', boundary } }));
    expect(drawingRegionContainsPoint(point, { kind: 'polygon', points: boundary })).toBe(false);
    expect(point[0] + point[1]).toBeLessThanOrEqual(20 + 1e-9);
  });
  it.each(['positive', 'negative'] as const)('段付き断面の段を跨いだ平均位置を使わない（%s）', (keepSide) => {
    const point = requirePoint(anchor({ section: { plane: { ...plane, origin: [0, 0, 0] }, kind: 'stepped', keepSide,
      boundary: [[0, 0], [5, 0], [5, 10], [20, 10]] } }, [[0, 0, 5], [20, 0, 5], [0, 20, 5]]));
    if (keepSide === 'positive') expect(point[0]).toBeLessThan(5);
    else expect(point[0]).toBeGreaterThan(5);
  });
  it('全てを取り去る断面と、輪郭だけの回転断面に元面の注記を置かない', () => {
    expect(anchor({ section: { plane, kind: 'full', keepSide: 'positive' } })).toBeNull();
    expect(anchor({ section: { plane, kind: 'revolved', keepSide: 'negative' } })).toBeNull();
  });
  it('省略区間の両側を別々に扱い、隙間や取り去った区間へ戻さない', () => {
    const frame = { breakSpec: { axis: 'u' as const, from: 103, to: 115, keepGap: 2 } };
    const point = requirePoint(anchor(frame)); expect(point[0] <= 3 || point[0] >= 5).toBe(true);
    expect(anchor(frame, [[5, 0, 0], [10, 0, 0], [5, 5, 0]])).toBeNull();
  });
  it('非有限座標・退化面・投影でつぶれる面を解決済みにしない', () => {
    expect(anchor({}, [[NaN, 0, 0], [20, 0, 0], [0, 20, 0]])).toBeNull();
    expect(anchor({}, [[0, 0, 0], [20, 0, 0], [10, 0, 0]])).toBeNull();
    expect(anchor({}, [[0, 0, 0], [20, 0, 0], [0, 0, 20]])).toBeNull();
  });
});
