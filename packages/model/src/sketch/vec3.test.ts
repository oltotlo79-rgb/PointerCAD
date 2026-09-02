import { describe, expect, it } from 'vitest';

import {
  addVec3, crossVec3, distanceVec3, dotVec3, isSamePoint, lerpVec3,
  lengthVec3, normalizeVec3, scaleVec3, SKETCH_TOLERANCE_MM, subVec3,
} from './vec3.js';

describe('ベクトルの計算', () => {
  it('足し算・引き算・定数倍', () => {
    expect(addVec3([1, 2, 3], [4, 5, 6])).toEqual([5, 7, 9]);
    expect(subVec3([4, 5, 6], [1, 2, 3])).toEqual([3, 3, 3]);
    expect(scaleVec3([1, 2, 3], 2)).toEqual([2, 4, 6]);
  });

  it('内積と外積(右手系)', () => {
    expect(dotVec3([1, 2, 3], [4, 5, 6])).toBe(32); // 4 + 10 + 18
    expect(crossVec3([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(crossVec3([0, 1, 0], [0, 0, 1])).toEqual([1, 0, 0]);
  });

  it('長さと距離', () => {
    expect(lengthVec3([3, 4, 0])).toBe(5);
    expect(distanceVec3([1, 1, 1], [1, 1, 4])).toBe(3);
  });

  it('正規化。長さ 0 は原点のまま', () => {
    expect(normalizeVec3([0, 5, 0])).toEqual([0, 1, 0]);
    expect(normalizeVec3([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('補間と同一点の判定(許容誤差 1e-6 mm)', () => {
    expect(lerpVec3([0, 0, 0], [10, 0, 0], 0.25)).toEqual([2.5, 0, 0]);
    expect(SKETCH_TOLERANCE_MM).toBe(1e-6);
    expect(isSamePoint([0, 0, 0], [5e-7, 0, 0])).toBe(true);
    expect(isSamePoint([0, 0, 0], [2e-6, 0, 0])).toBe(false);
  });
});
