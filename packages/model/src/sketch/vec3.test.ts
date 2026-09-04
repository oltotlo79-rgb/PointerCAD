import { describe, expect, it } from 'vitest';

import {
  addVec3, crossVec3, distanceVec3, dotVec3, isSamePoint, lerpVec3,
  lengthVec3, normalizeVec3, rotateAboutAxis, rotateDirection, scaleVec3,
  SKETCH_TOLERANCE_MM, subVec3,
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

describe('軸まわりの回転(ロドリゲスの回転公式、FR-328)', () => {
  const quarter = Math.PI / 2;

  it('XY 平面の法線 (0,0,1) を X 軸まわりに 90 度回すと (0,-1,0)', () => {
    // v cosθ + (k × v) sinθ + k(k·v)(1−cosθ) で θ=90°、k=(1,0,0)、v=(0,0,1) なら
    // 第1項と第3項が 0 になり、k × v = (1,0,0)×(0,0,1) = (0,-1,0) がそのまま残る。
    const rotated = rotateDirection([0, 0, 1], [1, 0, 0], quarter);
    expect(rotated[0]).toBeCloseTo(0, 12);
    expect(rotated[1]).toBeCloseTo(-1, 12);
    expect(rotated[2]).toBeCloseTo(0, 12);
  });

  it('軸に平行な向きは回しても変わらない', () => {
    const rotated = rotateDirection([0, 0, 3], [0, 0, 2], quarter);
    expect(rotated[0]).toBeCloseTo(0, 12);
    expect(rotated[1]).toBeCloseTo(0, 12);
    expect(rotated[2]).toBeCloseTo(3, 12);
  });

  it('30 度の回転は sin30=0.5・cos30=0.8660254037844387 になる', () => {
    // k=(0,0,1)、v=(1,0,0) を 30 度。x = cos30、y = sin30。
    const rotated = rotateDirection([1, 0, 0], [0, 0, 1], Math.PI / 6);
    expect(rotated[0]).toBeCloseTo(0.8660254037844387, 12);
    expect(rotated[1]).toBeCloseTo(0.5, 12);
    expect(rotated[2]).toBeCloseTo(0, 12);
  });

  it('長さ 0 の軸では回さずそのまま返す', () => {
    expect(rotateDirection([1, 2, 3], [0, 0, 0], quarter)).toEqual([1, 2, 3]);
  });

  it('軸の原点を通らない回転は、相対位置を回してから戻す', () => {
    // 点 (0,0,0) を「(0,10,0) を通る X 軸」まわりに 90 度。相対 (0,-10,0) を回すと
    // (0,0,-10)(k × v = (1,0,0)×(0,-10,0) = (0,0,-10))で、戻すと (0,10,-10)。
    const rotated = rotateAboutAxis([0, 0, 0], [0, 10, 0], [1, 0, 0], quarter);
    expect(rotated[0]).toBeCloseTo(0, 12);
    expect(rotated[1]).toBeCloseTo(10, 12);
    expect(rotated[2]).toBeCloseTo(-10, 12);
  });
});
