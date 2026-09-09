import { describe, expect, it } from 'vitest';
import { clipCurves, type ClipRegion } from './clipRegion.js';

const circle: ClipRegion = { kind: 'circle', center: [0, 0], radius: 10 };
describe('図の切り取り', () => {
  it('円を横切る線分を交点で切る', () => expect(clipCurves([
    { kind: 'segment', from: [-20, 0], to: [20, 0] },
  ], circle)).toEqual([{ kind: 'segment', from: [-10, 0], to: [10, 0] }]));
  it('完全に外の線分は消える', () => expect(clipCurves([{ kind: 'segment', from: [20, 0], to: [30, 0] }], circle)).toEqual([]));
  it('完全に内の線分はそのまま', () => expect(clipCurves([{ kind: 'segment', from: [-2, 0], to: [2, 0] }], circle)).toEqual([{ kind: 'segment', from: [-2, 0], to: [2, 0] }]));
  it('折れ線は内側の区間へ分かれる', () => expect(clipCurves([{ kind: 'polyline', points: [[-20, 0], [0, 0], [20, 0]], closed: false }], circle)).toHaveLength(2));
  it('円弧は交点の角度で切られる', () => {
    const result = clipCurves([{ kind: 'arc', center: [5, 0], radius: 10, startAngle: 0, endAngle: Math.PI }], circle);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.kind).toBe('arc');
  });
  it('閉じた輪郭でも切れる', () => expect(clipCurves([{ kind: 'segment', from: [-5, 5], to: [15, 5] }], {
    kind: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]],
  })).toEqual([{ kind: 'segment', from: [0, 5], to: [10, 5] }]));
  it('閉じた折れ線の最後から最初への辺も残す', () => {
    const result = clipCurves([{ kind: 'polyline', points: [[-2, -2], [2, -2], [2, 2]], closed: true }], circle);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ kind: 'segment', from: [2, 2], to: [-2, -2] });
  });
  it('輪郭の辺と重なる線分を落とさない', () => {
    expect(clipCurves([{ kind: 'segment', from: [0, 10], to: [10, 10] }], {
      kind: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]],
    })).toEqual([{ kind: 'segment', from: [0, 10], to: [10, 10] }]);
  });
  it('円と輪郭頂点が重なるときも四分円の角度を求める', () => {
    expect(clipCurves([{ kind: 'arc', center: [0, 0], radius: 10, startAngle: 0, endAngle: 2 * Math.PI }], {
      kind: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]],
    })).toEqual([{ kind: 'arc', center: [0, 0], radius: 10, startAngle: 0, endAngle: Math.PI / 2 }]);
  });
  it('逆回りの弧でも円同士の解析交点の角度になる', () => {
    const result = clipCurves([{ kind: 'arc', center: [5, 0], radius: 10, startAngle: Math.PI, endAngle: 0 }], circle);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'arc', startAngle: Math.PI, endAngle: Math.acos(-0.25) });
  });
  it('凹んだ輪郭を横切る線は離れた2区間になる', () => {
    const result = clipCurves([{ kind: 'segment', from: [-1, 3], to: [7, 3] }], {
      kind: 'polygon', points: [[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]],
    });
    expect(result).toEqual([{ kind: 'segment', from: [0, 3], to: [2, 3] }, { kind: 'segment', from: [4, 3], to: [6, 3] }]);
  });
  it('円への接線は長さ0の線として残さない', () => expect(clipCurves([
    { kind: 'segment', from: [-20, 10], to: [20, 10] },
  ], circle)).toEqual([]));
});
