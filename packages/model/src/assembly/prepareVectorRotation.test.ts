import { describe, expect, it } from 'vitest';
import { prepareVectorRotation } from './prepareVectorRotation.js';
import { exponentialMap, quaternionFromAxisAngle, rotateVector, type Quaternion } from './placementMath.js';

describe('部品の評価内でのみ回転の正規化と係数を共有する', () => {
  it.each([
    [0, 0, 0, 1], [1, 2, 3, 4], [-1, -2, -3, -4], [1e-14, -2e-14, 3e-14, 1],
    [0, 1, 0, 0], [0, 0, 0, 0], [NaN, 0, 0, 1], [0, 0, 0, Infinity],
  ] as const)('四元数 %s,%s,%s,%s は既存の回転と丸めまで一致する', (x, y, z, w) => {
    const q: Quaternion = [x, y, z, w], rotate = prepareVectorRotation(q);
    for (const vector of [[0, 0, 0], [1, -3, 7], [1e12, -1e12, 3e-6], [1e-20, 2e-20, -3e-20]] as const) {
      expect(rotate(vector)).toEqual(rotateVector(q, vector));
    }
  });
  it('基準回転と微小な増分の順序を保ち、別の姿勢は別に準備する', () => {
    const base = quaternionFromAxisAngle([1, 2, 3], 0.7), delta = exponentialMap([1e-14, -2e-14, 3e-14]);
    const baseRotation = prepareVectorRotation(base), trialRotation = prepareVectorRotation(delta);
    for (const vector of [[10, 30, 50], [1e12, -2e12, 3e12]] as const) {
      expect(trialRotation(baseRotation(vector))).toEqual(rotateVector(delta, rotateVector(base, vector)));
    }
    expect(prepareVectorRotation([0, 0, 0, 1])([1, 0, 0])).toEqual([1, 0, 0]);
    expect(prepareVectorRotation([0, 0, 1, 0])([1, 0, 0])).toEqual([-1, 0, 0]);
  });
  it('準備後は入力の四元数を読み返さず、点ごとの正規化を再導入しない', () => {
    let sealed = false;
    const q = new Proxy([1, 2, 3, 4] as const, { get(target, property, receiver): unknown {
      if (sealed) throw new Error('Rotation was read again for another point');
      return Reflect.get(target, property, receiver);
    } });
    const rotate = prepareVectorRotation(q);
    sealed = true;
    expect(rotate([1, 0, 0])).toEqual(rotateVector([1, 2, 3, 4], [1, 0, 0]));
    expect(rotate([0, 1, 0])).toEqual(rotateVector([1, 2, 3, 4], [0, 1, 0]));
  });
});
