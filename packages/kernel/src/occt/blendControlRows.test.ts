import { describe, expect, it } from 'vitest';
import type { Vec3Tuple } from '../types.js';
import { blendControlRows, measureBlend, type BlendSurfaceInput } from './blendControlRows.js';

const planes: BlendSurfaceInput = {
  uKnots: [2, 5], weightA: 3, weightB: 6, flipB: false,
  edgeA: u => ({ point: [u, 0, 0], tangent: [0, 2, 0] }),
  edgeB: u => ({ point: [u, 3, 9], tangent: [0, 0, 3] }),
};

describe('つなぎ面の制御点', () => {
  it('重みと接線の長さを保ち、U の極ごとに V の 4 行を作る', () => {
    // U runs linearly from 2 to 5: its cubic poles are 2, 3, 4, 5.
    // A + (3/3)*(0,2,0) has y=2; B - (6/3)*(0,0,3) has z=3.
    const expected = [[0, 0], [2, 0], [3, 3], [3, 9]].map(([y, z]) => [2, 3, 4, 5].map(x => [x, y, z]));
    expect(blendControlRows(planes)).toEqual(expected);
  });

  it('非等間隔の内部節で、左右の長さに応じた制御点が同じ点と傾きを表す', () => {
    const input: BlendSurfaceInput = { ...planes, uKnots: [0, 1, 4],
      edgeA: u => ({ point: [u, u * u, 2], tangent: [0, 0, 3] }) };
    // y=u² has secants 1, (16-0)/(4-0)=4, 5. At u=1 the inner poles
    // are 1-4/3 and 1+3*4/3. Their knot-weighted average equals 1.
    const row = blendControlRows(input)[0];
    const y = [0, 1 / 3, -1 / 3, 5, 11, 16];
    expect(row).toHaveLength(y.length);
    row.forEach((point, i) => expect(point[1]).toBeCloseTo(y[i], 12));
  });

  it('極を作る前提を満たさない指定と、有限な入力からの桁あふれを断る', () => {
    for (const uKnots of [[], [2], [2, 2], [2, 1], [0, NaN, 3], [-1e308, 1e308]]) {
      expect(() => blendControlRows({ ...planes, uKnots })).toThrow(RangeError);
    }
    for (const weightA of [0, -1, NaN, Infinity]) {
      expect(() => blendControlRows({ ...planes, weightA })).toThrow(RangeError);
    }
    for (const tangent of [[0, 0, 0], [0, 0, NaN], [0, 0, 1e308]] as const) {
      expect(() => blendControlRows({ ...planes, weightB: 9, edgeB: () => ({ point: [0, 0, 0], tangent }) }))
        .toThrow(RangeError);
    }
  });
});

const reference: BlendSurfaceInput = { ...planes, uKnots: [0, 1],
  edgeA: u => ({ point: [0, 0, u], tangent: [1, 0, 0] }),
  edgeB: u => ({ point: [1, 0, u], tangent: [1, 0, 0] }),
};

describe('両辺の離れと向き付き接線角の標本測定', () => {
  it('横接線が一致しても元の面との接平面の傾きと pcurve 側の離れを検出する', () => {
    const input: BlendSurfaceInput = { ...reference, edgeA: u => ({ ...reference.edgeA(u),
      support: { point: [0, 0.5, u], normal: [0, 1, 0] } }) };
    const result = measureBlend(input, { distanceMm: 0.4, angleDeg: 0.01 }, (u, side) => ({
      point: [side, 0, u], tangent: [1, 0, 0], alongU: [0, 1, 1],
    }));
    expect(result.maxDistanceMm).toBe(0.5);
    expect(result.maxAngleDeg).toBeCloseTo(45, 12);
    expect(result.withinTolerance).toBe(false);
  });

  it('片側の途中の 3-4-5 の離れと、もう片側の直角を別々に検出する', () => {
    const surfaceAt = (u: number, side: 0 | 1) => {
      const point: Vec3Tuple = side === 1 && u === 0.75 ? [4, 4, u] : [side, 0, u];
      const tangent: Vec3Tuple = side === 0 && u === 0.25 ? [0, 1, 0] : [7, 0, 0];
      return { point, tangent, alongU: [0, 0, 1] as const };
    };
    // hypot(3,4)=5 mm and atan2(1,0)=90°. Equality at either tolerance is allowed.
    const measurement = measureBlend(reference, { distanceMm: 5, angleDeg: 90 }, surfaceAt);
    expect(measurement).toEqual({ maxDistanceMm: 5, maxAngleDeg: 90, withinTolerance: true });
    expect(measureBlend(reference, { distanceMm: 4.9, angleDeg: 90 }, surfaceAt).withinTolerance).toBe(false);
    expect(measureBlend(reference, { distanceMm: 5, angleDeg: 89 }, surfaceAt).withinTolerance).toBe(false);
  });

  it('微小角と逆向きを区別し、長さや尺度で角度が変わらない', () => {
    for (const degrees of [0.005, 45, 180]) {
      const radians = degrees * Math.PI / 180;
      const result = measureBlend(reference, { distanceMm: 0, angleDeg: 0.01 }, (u, side) => ({
        point: [side, 0, u], alongU: [0, 0, 1e-200],
        tangent: [1e200 * Math.cos(radians), 1e200 * Math.sin(radians), 0],
      }));
      // atan2(sin(theta), cos(theta)) = theta on [0, pi].
      expect(result.maxAngleDeg).toBeCloseTo(degrees, 10);
      expect(result.withinTolerance).toBe(degrees < 0.01);
    }
  });

  it('面の接平面が定まらない標本を、角度の許容を最大にしても合格にしない', () => {
    for (const tangent of [[0, 0, 0], [0, 0, 2], [NaN, 0, 0]] as const) {
      const measured = measureBlend(reference, { distanceMm: 0, angleDeg: 180 }, (u, side) => ({
        point: [side, 0, u], tangent, alongU: [0, 0, 1],
      }));
      expect(measured).toEqual({ maxDistanceMm: 0, maxAngleDeg: Infinity, withinTolerance: false });
    }
  });

  it('無限・負の公差や 180° を超える許容量を断る', () => {
    for (const tolerance of [{ distanceMm: Infinity, angleDeg: 1 }, { distanceMm: -1, angleDeg: 0 },
      { distanceMm: 1, angleDeg: NaN }, { distanceMm: 0, angleDeg: 181 }]) {
      expect(() => measureBlend(reference, tolerance, () => {
        throw new Error('unexpected evaluation');
      })).toThrow(RangeError);
    }
  });
});
