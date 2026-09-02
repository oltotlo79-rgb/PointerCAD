import { describe, expect, it } from 'vitest';

import { HOME_ORBIT, MAX_ELEVATION, type OrbitState } from '../viewport/cameraMath.js';
import {
  directionFromRegion,
  FACE_REGIONS,
  interpolateOrbit,
  normalizeAngle,
  orbitStateForRegion,
  regionFromLocalPoint,
} from './viewCubeMath.js';

describe('ビューキューブの領域判定(FR-103)', () => {
  it('面の中央は面の領域になる', () => {
    expect(regionFromLocalPoint([1, 0, 0])).toEqual(FACE_REGIONS.right);
    expect(regionFromLocalPoint([0, -1, 0])).toEqual(FACE_REGIONS.front);
    expect(regionFromLocalPoint([0, 0, 1])).toEqual(FACE_REGIONS.top);
  });

  it('面の端寄り(しきい値未満)はまだ面の領域', () => {
    expect(regionFromLocalPoint([1, 0.2, -0.1])).toEqual(FACE_REGIONS.right);
  });

  it('辺の近くは 2 軸の領域になる', () => {
    expect(regionFromLocalPoint([1, 0.9, 0])).toEqual({ x: 1, y: 1, z: 0 });
  });

  it('頂点の近くは 3 軸の領域になる', () => {
    expect(regionFromLocalPoint([0.9, 0.8, 0.7])).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('中央付近は領域なし', () => {
    expect(regionFromLocalPoint([0.1, -0.2, 0.3])).toBeNull();
  });

  it('26 種類すべてを取り出せる', () => {
    const found = new Set<string>();
    for (const x of [-1, 0, 1]) {
      for (const y of [-1, 0, 1]) {
        for (const z of [-1, 0, 1]) {
          const region = regionFromLocalPoint([x, y, z]);
          if (region !== null) {
            found.add(`${region.x},${region.y},${region.z}`);
          }
        }
      }
    }
    expect(found.size).toBe(26);
  });
});

describe('領域から視点を決める(FR-103)', () => {
  it('前面をクリックすると -Y の方向から見る', () => {
    const next = orbitStateForRegion(FACE_REGIONS.front, HOME_ORBIT);
    expect(next.azimuth).toBeCloseTo(-Math.PI / 2, 12);
    expect(next.elevation).toBeCloseTo(0, 12);
  });

  it('右面をクリックすると +X の方向から見る', () => {
    const next = orbitStateForRegion(FACE_REGIONS.right, HOME_ORBIT);
    expect(next.azimuth).toBeCloseTo(0, 12);
    expect(next.elevation).toBeCloseTo(0, 12);
  });

  it('上面をクリックしても真上を越えず、視界が反転しない', () => {
    const next = orbitStateForRegion(FACE_REGIONS.top, HOME_ORBIT);
    expect(next.elevation).toBeCloseTo(MAX_ELEVATION, 12);
  });

  it('頂点をクリックすると等角視の向きになる', () => {
    const [x, y, z] = directionFromRegion({ x: 1, y: 1, z: 1 });
    const expected = 1 / Math.sqrt(3);
    expect(x).toBeCloseTo(expected, 12);
    expect(y).toBeCloseTo(expected, 12);
    expect(z).toBeCloseTo(expected, 12);

    const next = orbitStateForRegion({ x: 1, y: 1, z: 1 }, HOME_ORBIT);
    expect(next.azimuth).toBeCloseTo(Math.PI / 4, 12);
    expect(next.elevation).toBeCloseTo(Math.asin(expected), 12);
  });

  it('距離と注視点は変えない', () => {
    const next = orbitStateForRegion(FACE_REGIONS.left, { ...HOME_ORBIT, distance: 77, target: [1, 2, 3] });
    expect(next.distance).toBe(77);
    expect(next.target).toEqual([1, 2, 3]);
  });
});

describe('視点の補間', () => {
  const from: OrbitState = { azimuth: 0, elevation: 0, distance: 100, target: [0, 0, 0] };

  it('進み具合 0 で出発点、1 で目標点になる', () => {
    const to: OrbitState = { ...from, azimuth: 1, elevation: 0.5 };
    expect(interpolateOrbit(from, to, 0).azimuth).toBeCloseTo(0, 12);
    expect(interpolateOrbit(from, to, 1).azimuth).toBeCloseTo(1, 12);
    expect(interpolateOrbit(from, to, 1).elevation).toBeCloseTo(0.5, 12);
  });

  it('範囲外の進み具合は 0 〜 1 に丸める', () => {
    const to: OrbitState = { ...from, azimuth: 1, elevation: 0 };
    expect(interpolateOrbit(from, to, -5).azimuth).toBeCloseTo(0, 12);
    expect(interpolateOrbit(from, to, 5).azimuth).toBeCloseTo(1, 12);
  });

  it('遠回りせず近い側へ回る', () => {
    // 0 度から 350 度へは +350 度ではなく -10 度で回る。
    const to: OrbitState = { ...from, azimuth: (350 * Math.PI) / 180 };
    const middle = interpolateOrbit(from, to, 0.5);
    expect(middle.azimuth).toBeCloseTo((-5 * Math.PI) / 180, 9);
  });

  it('角度の折り返しが -π 〜 +π に収まる', () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(0.5)).toBeCloseTo(0.5, 12);
  });
});
