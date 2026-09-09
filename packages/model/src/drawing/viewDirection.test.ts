import { describe, expect, it } from 'vitest';
import type { ResolvedPlane } from '../geometry/planeSpec.js';
import { expressionValueFromNumber } from '@pointercad/expression';
import { baseWorkPlane } from '../sketch/planeMath.js';
import {
  auxiliaryDirectionFromPlane,
  auxiliaryPlacementDirection,
  createPartialProjection,
  resolveAuxiliaryDirection,
} from './viewDirection.js';

const root = Math.SQRT1_2;
const tilted: ResolvedPlane = {
  origin: [0, 0, 0], axisU: [root, -root, 0], axisV: [0, 0, 1], normal: [root, root, 0],
};

describe('viewDirection', () => {
  it('45度面の法線を視線にする', () => {
    const result = auxiliaryDirectionFromPlane(tilted, [0, 0, 1]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 単位化の丸めは1ULP生じる。計画書の向きの許容差1e-12で解析値と比較する。
      result.direction.normal.forEach((value, index) => expect(Math.abs(value - [root, root, 0][index])).toBeLessThanOrEqual(1e-12));
    }
  });
  it('xDirを法線へ直交させる', () => {
    const result = auxiliaryDirectionFromPlane(tilted, [0, 0, 1]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.direction.xDir[0] * result.direction.normal[0]
        + result.direction.xDir[1] * result.direction.normal[1]
        + result.direction.xDir[2] * result.direction.normal[2]).toBeCloseTo(0, 12);
    }
  });
  it('法線と元のvが平行なら理由を返す', () => {
    expect(auxiliaryDirectionFromPlane(tilted, tilted.normal)).toEqual({
      ok: false, message: 'この面からは向きが決まりません。',
    });
  });
  it('法線(0,-1,0)を正面図と同じ向きにする', () => {
    const result = auxiliaryDirectionFromPlane({ ...tilted, normal: [0, -1, 0] }, [0, 0, 1]);
    expect(result.ok && result.direction.normal).toEqual([0, -1, 0]);
  });
  it('部分投影図は輪郭の内側だけを残す', () => {
    const result = createPartialProjection(
      [{ kind: 'segment', from: [-10, 0], to: [10, 0] }],
      { kind: 'polygon', points: [[-2, -2], [2, -2], [2, 2], [-2, 2]] },
    );
    expect(result).toEqual([{ kind: 'segment', from: [-2, 0], to: [2, 0] }]);
  });
  it('補助図を面法線の用紙方向へ並べる', () => {
    expect(auxiliaryPlacementDirection([1, 0, 0], { normal: [0, -1, 0], xDir: [1, 0, 0] })).toEqual([1, 0]);
  });
  it('既存PlaneSpecの正面基準面を解決する', () => {
    const outcome = resolveAuxiliaryDirection({ kind: 'workPlane', planeId: 'xz', offset: expressionValueFromNumber(0) },
      { point: () => null, axis: () => null, workPlane: baseWorkPlane }, [0, 0, 1]);
    expect(outcome).toEqual({ ok: true, direction: { normal: [0, -1, 0], xDir: [0, 0, 1] } });
  });
  it('無い基準面を明確な文言で断る', () => {
    expect(resolveAuxiliaryDirection({ kind: 'workPlane', planeId: 'missing', offset: expressionValueFromNumber(0) },
      { point: () => null, axis: () => null, workPlane: baseWorkPlane }, [0, 0, 1])).toEqual({ ok: false, message: 'この面からは向きが決まりません。' });
  });
  it('部分投影の円弧も半径を保って切れる', () => {
    const curves = createPartialProjection([{ kind: 'arc', center: [0, 0], radius: 10, startAngle: 0, endAngle: 2 * Math.PI }],
      { kind: 'polygon', points: [[0, 0], [11, 0], [11, 11], [0, 11]] });
    expect(curves).toEqual([{ kind: 'arc', center: [0, 0], radius: 10, startAngle: 0, endAngle: Math.PI / 2 }]);
  });
  it('部分投影が完全に外なら線を作らない', () => {
    expect(createPartialProjection([{ kind: 'segment', from: [20, 20], to: [30, 30] }],
      { kind: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]] })).toEqual([]);
  });
});
