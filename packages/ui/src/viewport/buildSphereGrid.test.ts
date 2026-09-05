/**
 * 球面グリッドの組み立てと吸着の検査(計画書 docs/plans/P5-高度なソリッド・外観と測定.md
 * §2.8.3、タスク20 の検証表)。
 *
 * 期待値はすべてこのファイルの中で導出し直している(計画書の数値をそのまま信じない。
 * `rules/06` の「計画書の検算に誤りがあった」の教訓)。導出は各検査の注釈に書く。
 */
import type { Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { PointerRay } from '../sketch/trackMath.js';
import { expectWithinBudget } from '../testUtils/perfBudget.js';
import {
  buildSphereGrid, buildSphereGridPositions, nearestSphereGridPoint, sphereGridLatitudes,
  sphereGridLatLonOf, sphereGridLongitudes, sphereGridPointAt, sphereGridPoints,
  snapToSphereGrid, SPHERE_GRID_DIVISIONS, SPHERE_GRID_STEP_RANGE_MESSAGE,
  type SphereGridSpec,
} from './buildSphereGrid.js';

const UNIT_SPHERE_R10: SphereGridSpec = { center: [0, 0, 0], radius: 10, stepDegrees: 15 };

/** 度 → ラジアン(検査側で独立に持つ。実装の変換関数を使わない)。 */
const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** 期待値を式のまま書くための、検査側の独立な計算(実装とは別に書き下す)。 */
function expectedPoint(radius: number, latitude: number, longitude: number): Vec3 {
  const ring = radius * Math.cos(rad(latitude));
  return [ring * Math.cos(rad(longitude)), ring * Math.sin(rad(longitude)), radius * Math.sin(rad(latitude))];
}

function expectVec3Close(actual: Vec3, expected: Vec3, tolerance = 1e-9): void {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[2] - expected[2])).toBeLessThanOrEqual(tolerance);
}

/** 中心へ向かう光線(外側から球の中心を狙う)。狙った点の手前側にちょうど当たる。 */
function rayThrough(spec: SphereGridSpec, latitude: number, longitude: number): PointerRay {
  const target = expectedPoint(spec.radius, latitude, longitude);
  const direction: Vec3 = [
    -target[0] / spec.radius,
    -target[1] / spec.radius,
    -target[2] / spec.radius,
  ];
  // 球の外(半径の 3 倍の位置)から中心へ向ける。
  const origin: Vec3 = [
    spec.center[0] + target[0] * 3,
    spec.center[1] + target[1] * 3,
    spec.center[2] + target[2] * 3,
  ];
  return { origin, direction };
}

describe('球面グリッドの緯線・経線の本数(§2.8.3)', () => {
  it('15° の緯線は 11 本(−75〜75。180/15 − 1)で、極は含まない', () => {
    const latitudes = sphereGridLatitudes(15);
    expect(latitudes.length).toBe(11);
    expect(latitudes[0]).toBe(-75);
    expect(latitudes[latitudes.length - 1]).toBe(75);
    expect(latitudes).not.toContain(90);
    expect(latitudes).not.toContain(-90);
  });

  it('15° の経線は 24 本(360/15)で、0° から東回りに並ぶ', () => {
    const longitudes = sphereGridLongitudes(15);
    expect(longitudes.length).toBe(24);
    expect(longitudes[0]).toBe(0);
    expect(longitudes[1]).toBe(15);
    expect(longitudes[longitudes.length - 1]).toBe(345);
  });

  it('5° は緯線 35 本・経線 72 本、10° は緯線 17 本・経線 36 本', () => {
    expect(sphereGridLatitudes(5).length).toBe(35);
    expect(sphereGridLongitudes(5).length).toBe(72);
    expect(sphereGridLatitudes(10).length).toBe(17);
    expect(sphereGridLongitudes(10).length).toBe(36);
  });

  it('90° は緯線が赤道 1 本だけ・経線 4 本になる(上限の端)', () => {
    expect(sphereGridLatitudes(90)).toEqual([0]);
    expect(sphereGridLongitudes(90)).toEqual([0, 90, 180, 270]);
  });
});

describe('格子点の一覧(§2.8.3)', () => {
  it('15° の格子点は 266 個(11×24 + 極 2)', () => {
    const points = sphereGridPoints(UNIT_SPHERE_R10);
    expect(points.length).toBe(11 * 24 + 2);
    expect(points.length).toBe(266);
  });

  it('5° は 2522 個(35×72+2)、10° は 614 個(17×36+2)', () => {
    expect(sphereGridPoints({ ...UNIT_SPHERE_R10, stepDegrees: 5 }).length).toBe(2522);
    expect(sphereGridPoints({ ...UNIT_SPHERE_R10, stepDegrees: 10 }).length).toBe(614);
  });

  it('格子点はすべて球面の上にある(|p − c| = r、± 1e-9)', () => {
    const spec: SphereGridSpec = { center: [5, 5, 5], radius: 7.5, stepDegrees: 15 };
    for (const point of sphereGridPoints(spec)) {
      const distance = Math.hypot(
        point.position[0] - spec.center[0],
        point.position[1] - spec.center[1],
        point.position[2] - spec.center[2],
      );
      expect(Math.abs(distance - spec.radius)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('極は 1 点ずつだけ持ち、位置は軸の上(中心 ± (0,0,r))に厳密に一致する', () => {
    const points = sphereGridPoints({ center: [1, 2, 3], radius: 10, stepDegrees: 15 });
    const poles = points.filter((point) => Math.abs(point.latitude) === 90);
    expect(poles.length).toBe(2);
    expect(poles.map((pole) => pole.position)).toEqual([[1, 2, -7], [1, 2, 13]]);
    // 極の経度は 0 に揃える(経度が意味を持たないため)。
    expect(poles.every((pole) => pole.longitude === 0)).toBe(true);
  });

  it('中心を動かすと格子点は中心ぶんだけ平行移動する(追従)', () => {
    const origin = sphereGridPoints(UNIT_SPHERE_R10);
    const moved = sphereGridPoints({ ...UNIT_SPHERE_R10, center: [5, 5, 5] });
    expect(moved.length).toBe(origin.length);
    for (let index = 0; index < origin.length; index += 1) {
      expectVec3Close(moved[index].position, [
        origin[index].position[0] + 5,
        origin[index].position[1] + 5,
        origin[index].position[2] + 5,
      ]);
    }
  });
});

describe('線分列(1 本の LineSegments 用、§2.8.3)', () => {
  it('5° の線分は 7704 本(35×72 + 72×72)で、数値は 46224 個', () => {
    const positions = buildSphereGridPositions({ ...UNIT_SPHERE_R10, stepDegrees: 5 });
    expect(positions.length / 6).toBe(7704);
    expect(positions.length).toBe(46224);
  });

  it('10° の線分は 3816 本(17×72 + 36×72)、15° は 2520 本((11+24)×72)', () => {
    expect(buildSphereGridPositions({ ...UNIT_SPHERE_R10, stepDegrees: 10 }).length / 6).toBe(3816);
    expect(buildSphereGridPositions(UNIT_SPHERE_R10).length / 6).toBe(2520);
  });

  it('線分の端点はすべて球面の上にある(Float32 の丸めぶんだけ緩めて ± 1e-4)', () => {
    // Float32Array は有効数字が約 7 桁しかないので、r=10 では約 1e-6 の誤差が残る。
    // 組み立ての式そのものの精度は「格子点はすべて球面の上にある」(倍精度、1e-9)で確かめている。
    const positions = buildSphereGridPositions(UNIT_SPHERE_R10);
    let worst = 0;
    for (let offset = 0; offset < positions.length; offset += 3) {
      const distance = Math.hypot(positions[offset], positions[offset + 1], positions[offset + 2]);
      worst = Math.max(worst, Math.abs(distance - 10));
    }
    expect(worst).toBeLessThanOrEqual(1e-4);
  });

  it('経線の端は北極・南極の 1 点に集約する(すべての経線で同じ値)', () => {
    const positions = buildSphereGridPositions(UNIT_SPHERE_R10);
    const ringSegments = 11 * SPHERE_GRID_DIVISIONS;
    for (let meridian = 0; meridian < 24; meridian += 1) {
      const first = (ringSegments + meridian * SPHERE_GRID_DIVISIONS) * 6;
      const last = (ringSegments + meridian * SPHERE_GRID_DIVISIONS + SPHERE_GRID_DIVISIONS - 1) * 6;
      // 経線の 1 本目の始点が南極、72 本目の終点が北極。
      expect([positions[first], positions[first + 1], positions[first + 2]]).toEqual([0, 0, -10]);
      expect([positions[last + 3], positions[last + 4], positions[last + 5]]).toEqual([0, 0, 10]);
    }
  });

  it('buildSphereGrid は線分列と格子点の両方を返す', () => {
    const grid = buildSphereGrid(UNIT_SPHERE_R10);
    expect(grid.spec).toBe(UNIT_SPHERE_R10);
    expect(grid.positions.length).toBe(2520 * 6);
    expect(grid.points.length).toBe(266);
  });

  it('間隔が 1 度未満・90 度超なら組み立ては断る', () => {
    expect(() => buildSphereGridPositions({ ...UNIT_SPHERE_R10, stepDegrees: 0.5 })).toThrow(
      SPHERE_GRID_STEP_RANGE_MESSAGE,
    );
    expect(() => buildSphereGridPositions({ ...UNIT_SPHERE_R10, stepDegrees: 91 })).toThrow(
      SPHERE_GRID_STEP_RANGE_MESSAGE,
    );
    expect(() => sphereGridPoints({ ...UNIT_SPHERE_R10, stepDegrees: 0 })).toThrow(
      SPHERE_GRID_STEP_RANGE_MESSAGE,
    );
  });
});

describe('緯度・経度と位置の対応(軸の規約: 北極 +Z、経度 0 は +X)', () => {
  it('緯度 0・経度 0 は +X の上の点(r=10 で [10,0,0])', () => {
    expect(sphereGridPointAt(UNIT_SPHERE_R10, 0, 0)).toEqual([10, 0, 0]);
  });

  it('緯度 0・経度 90 は +Y(r=25 で [0,25,0])、北極は +Z', () => {
    expectVec3Close(sphereGridPointAt({ ...UNIT_SPHERE_R10, radius: 25 }, 0, 90), [0, 25, 0]);
    expect(sphereGridPointAt(UNIT_SPHERE_R10, 90, 0)).toEqual([0, 0, 10]);
  });

  it('r=10、緯度 30・経度 45 は [6.123724356957945, 6.123724356957945, 5](10cos30cos45 ほか)', () => {
    expectVec3Close(sphereGridPointAt(UNIT_SPHERE_R10, 30, 45), [
      6.123724356957945, 6.123724356957945, 5,
    ]);
  });

  it('r=10、緯度 60・経度 120 は [−2.5, 4.330127018922194, 8.660254037844387]', () => {
    expectVec3Close(sphereGridPointAt(UNIT_SPHERE_R10, 60, 120), [
      -2.5, 4.330127018922194, 8.660254037844387,
    ]);
  });

  it('半径を 20 にすると同じ緯度・経度の点が 2 倍の位置へ動く(FR-431 の追従)', () => {
    expectVec3Close(sphereGridPointAt({ ...UNIT_SPHERE_R10, radius: 20 }, 30, 45), [
      12.24744871391589, 12.24744871391589, 10,
    ]);
  });

  it('経度は 360 で回る(450 度は 90 度と同じ点)', () => {
    expectVec3Close(
      sphereGridPointAt(UNIT_SPHERE_R10, 20, 450),
      sphereGridPointAt(UNIT_SPHERE_R10, 20, 90),
    );
  });

  it('r=10 の (30°,45°) と (60°,120°) の直線距離は 9.538504747461981', () => {
    // 独立の導出: 弦長 = 2r·sin(Δσ/2)、cosΔσ = sinφ1 sinφ2 + cosφ1 cosφ2 cos(Δλ)。
    const cosSigma =
      Math.sin(rad(30)) * Math.sin(rad(60)) +
      Math.cos(rad(30)) * Math.cos(rad(60)) * Math.cos(rad(120 - 45));
    const chord = 2 * 10 * Math.sin(Math.acos(cosSigma) / 2);
    const a = sphereGridPointAt(UNIT_SPHERE_R10, 30, 45);
    const b = sphereGridPointAt(UNIT_SPHERE_R10, 60, 120);
    const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    // 計画書 §2.8.3 の値は 9.538504747461981 だが、その桁数は倍精度で表せない
    // (最も近い倍精度は …982)。許容誤差 1e-9 の範囲内なので桁を落として書く。
    expect(Math.abs(distance - 9.538504747462)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(distance - chord)).toBeLessThanOrEqual(1e-9);
  });

  it('位置 → 緯度・経度 → 位置の往復が一致する(± 1e-9)', () => {
    const spec: SphereGridSpec = { center: [-3, 4, 12], radius: 6.25, stepDegrees: 15 };
    const cases: readonly (readonly [number, number])[] = [
      [0, 0], [30, 45], [-75, 345], [60, 120], [12.5, 359.9], [-90, 0], [90, 0],
    ];
    for (const [latitude, longitude] of cases) {
      const position = sphereGridPointAt(spec, latitude, longitude);
      const back = sphereGridLatLonOf(position, spec.center);
      expect(Math.abs(back.latitude - latitude)).toBeLessThanOrEqual(1e-9);
      // 極では経度が定まらないので位置だけを見る。
      if (Math.abs(latitude) !== 90) {
        expect(Math.abs(back.longitude - longitude)).toBeLessThanOrEqual(1e-9);
      }
      expectVec3Close(sphereGridPointAt(spec, back.latitude, back.longitude), position);
    }
  });

  it('中心とまったく同じ点は緯度・経度とも 0 を返す(向きが決まらない)', () => {
    expect(sphereGridLatLonOf([2, 2, 2], [2, 2, 2])).toEqual({ latitude: 0, longitude: 0 });
  });
});

describe('光線から最寄りの交点を求める(§2.8.2、候補を全部回さない)', () => {
  it('球の中心を通る光線は手前の交点を返す(奥の交点ではない)', () => {
    const found = nearestSphereGridPoint(UNIT_SPHERE_R10, {
      origin: [30, 0, 0],
      direction: [-1, 0, 0],
    });
    expect(found).not.toBeNull();
    expect(found?.latitude).toBe(0);
    expect(found?.longitude).toBe(0);
    expectVec3Close(found?.position ?? [0, 0, 0], [10, 0, 0]);
  });

  it('球を外れる光線・球が背後にある光線は null', () => {
    // 球から 50mm 横へずらした光線(交わらない)。
    expect(nearestSphereGridPoint(UNIT_SPHERE_R10, {
      origin: [50, 0, -100], direction: [0, 0, 1],
    })).toBeNull();
    // 球を通り過ぎて反対を向いている光線(t が両方とも負)。
    expect(nearestSphereGridPoint(UNIT_SPHERE_R10, {
      origin: [0, 0, 100], direction: [0, 0, 1],
    })).toBeNull();
  });

  it('視点が球の中にあるときは進む向きの交点を採る', () => {
    const found = nearestSphereGridPoint(UNIT_SPHERE_R10, {
      origin: [0, 0, 0], direction: [1, 0, 0],
    });
    expectVec3Close(found?.position ?? [0, 0, 0], [10, 0, 0]);
  });

  it('格子点をちょうど指す光線はその緯度・経度を返す(5° 刻み)', () => {
    const spec: SphereGridSpec = { ...UNIT_SPHERE_R10, stepDegrees: 5 };
    const found = nearestSphereGridPoint(spec, rayThrough(spec, 30, 45));
    expect(found?.latitude).toBe(30);
    expect(found?.longitude).toBe(45);
    expectVec3Close(found?.position ?? [0, 0, 0], [6.123724356957945, 6.123724356957945, 5]);
  });

  it('緯度 32・経度 47 を指すと最寄りの (30, 45) へ丸める(5° 刻み)', () => {
    const spec: SphereGridSpec = { ...UNIT_SPHERE_R10, stepDegrees: 5 };
    const found = nearestSphereGridPoint(spec, rayThrough(spec, 32, 47));
    expect(found?.latitude).toBe(30);
    expect(found?.longitude).toBe(45);
  });

  it('緯度 33.5 は 35 へ丸める(近い方へ)', () => {
    const spec: SphereGridSpec = { ...UNIT_SPHERE_R10, stepDegrees: 5 };
    expect(nearestSphereGridPoint(spec, rayThrough(spec, 33.5, 0))?.latitude).toBe(35);
  });

  it('経度 359 は 0 へ回り込んで丸める(360 で回る)', () => {
    const spec: SphereGridSpec = { ...UNIT_SPHERE_R10, stepDegrees: 15 };
    expect(nearestSphereGridPoint(spec, rayThrough(spec, 0, 359))?.longitude).toBe(0);
  });

  it('極の近くを指すと緯度 ±90・経度 0(極も格子点)', () => {
    const spec: SphereGridSpec = { ...UNIT_SPHERE_R10, stepDegrees: 15 };
    const found = nearestSphereGridPoint(spec, rayThrough(spec, 88, 200));
    expect(found?.latitude).toBe(90);
    expect(found?.longitude).toBe(0);
    expect(found?.position).toEqual([0, 0, 10]);
  });

  it('丸めた先は必ず格子点の一覧の中にある(15° で 200 通りの向きを試す)', () => {
    const spec: SphereGridSpec = { center: [2, -3, 4], radius: 8, stepDegrees: 15 };
    const keys = new Set(
      sphereGridPoints(spec).map((point) => `${point.latitude}/${point.longitude}`),
    );
    for (let index = 0; index < 200; index += 1) {
      // 疑似乱数を使わず、緯度・経度を細かくずらして走査する。
      const latitude = -90 + (index * 180) / 199;
      const longitude = (index * 359) / 199;
      const found = nearestSphereGridPoint(spec, rayThrough(spec, latitude, longitude));
      expect(found).not.toBeNull();
      expect(keys.has(`${found?.latitude}/${found?.longitude}`)).toBe(true);
    }
  });

  it('間隔が範囲外・半径が 0 以下のときは例外を投げずに null を返す', () => {
    expect(nearestSphereGridPoint(
      { ...UNIT_SPHERE_R10, stepDegrees: 0.5 }, { origin: [30, 0, 0], direction: [-1, 0, 0] },
    )).toBeNull();
    expect(nearestSphereGridPoint(
      { ...UNIT_SPHERE_R10, radius: 0 }, { origin: [30, 0, 0], direction: [-1, 0, 0] },
    )).toBeNull();
  });
});

describe('交点への吸着(FR-107、画面 12 画素)', () => {
  /** 1mm = 10 画素の平行投影に見立てた写し(判定そのものだけを測る)。 */
  const project = (point: Vec3): readonly [number, number] => [point[0] * 10, point[1] * 10];
  const ray: PointerRay = { origin: [30, 0, 0], direction: [-1, 0, 0] };

  it('画面距離が 12 画素以内なら吸い付く', () => {
    const found = snapToSphereGrid(UNIT_SPHERE_R10, ray, project, [100 + 11, 0]);
    expect(found?.latitude).toBe(0);
    expect(found?.longitude).toBe(0);
  });

  it('画面距離が 12 画素を超えると吸い付かない', () => {
    expect(snapToSphereGrid(UNIT_SPHERE_R10, ray, project, [100 + 13, 0])).toBeNull();
  });

  it('判定半径は呼び出し側で変えられる', () => {
    expect(snapToSphereGrid(UNIT_SPHERE_R10, ray, project, [100 + 13, 0], 20)).not.toBeNull();
  });

  it('画面へ写せない(視野の外)ときは吸い付かない', () => {
    expect(snapToSphereGrid(UNIT_SPHERE_R10, ray, () => null, [100, 0])).toBeNull();
  });

  it('光線が球を外れていれば吸い付かない', () => {
    expect(snapToSphereGrid(
      UNIT_SPHERE_R10, { origin: [50, 0, -100], direction: [0, 0, 1] }, project, [0, 0],
    )).toBeNull();
  });
});

describe('費用の実測(NFR-PF-1。上限は参考判定)', () => {
  /*
   * 上限で落とさず実測を出力に残すのは、並列作業中の CPU 競合で境界値の判定が落ちる
   * ため(`rules/06-過去の失敗と対策.md` 10.3)。目標(組み立て 16ms、吸着 1 万回 10ms)に
   * 対しては十分に緩い上限だけを機械で確かめ、実測値は報告に載せる。
   */
  it('1° の組み立て(線分 38,808 本 = 頂点 77,616)の所要を実測する(目標 16ms)', () => {
    const spec: SphereGridSpec = { ...UNIT_SPHERE_R10, stepDegrees: 1 };
    const start = performance.now();
    const positions = buildSphereGridPositions(spec);
    const elapsedMs = performance.now() - start;
    expect(positions.length / 6).toBe(38808);
    // 既定の 5°(タスク21 が実際に描く大きさ)も併せて測り、報告に載せる。
    const defaultStart = performance.now();
    const defaultPositions = buildSphereGridPositions({ ...UNIT_SPHERE_R10, stepDegrees: 5 });
    const defaultElapsedMs = performance.now() - defaultStart;
    console.log(
      `buildSphereGridPositions(1°): 頂点 ${positions.length / 3} 個 ${elapsedMs.toFixed(2)}ms / `
      + `(5°): 頂点 ${defaultPositions.length / 3} 個 ${defaultElapsedMs.toFixed(2)}ms`,
    );
    expectWithinBudget(elapsedMs, 200, 'buildSphereGridPositions(1°)');
  });

  it('吸着(nearestSphereGridPoint)を 10,000 回呼んだ所要を実測する(目標 10ms)', () => {
    const spec: SphereGridSpec = { ...UNIT_SPHERE_R10, stepDegrees: 5 };
    const rays: PointerRay[] = [];
    for (let index = 0; index < 100; index += 1) {
      rays.push(rayThrough(spec, -80 + (index * 160) / 99, (index * 359) / 99));
    }
    const start = performance.now();
    for (let call = 0; call < 10000; call += 1) {
      nearestSphereGridPoint(spec, rays[call % rays.length]);
    }
    const elapsedMs = performance.now() - start;
    console.log(
      `nearestSphereGridPoint: 10,000 回 ${elapsedMs.toFixed(2)}ms = ${(elapsedMs / 10000).toFixed(5)}ms/回`,
    );
    expectWithinBudget(elapsedMs, 200, 'nearestSphereGridPoint 10,000 回');
  });
});
