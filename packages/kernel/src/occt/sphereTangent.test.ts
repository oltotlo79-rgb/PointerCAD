/**
 * 球への外接直線(FR-430、計画書 P5 §2.9.3、タスク23)の検査。
 *
 * **OCCT を 1 度も読み込まない。** 期待値はすべて自分で導出したもので、
 * 計画書 §2.9.3 の表とは 1e-13 ほどしか違わない(浮動小数の丸めの差。許容 1e-9 の中で一致)。
 */

import { describe, expect, it } from 'vitest';

import type { Vec3Tuple } from '../types.js';
import type { TangentCone } from './sphereTangent.js';
import { tangentConeThroughCircle, tangentPointOnSphere } from './sphereTangent.js';

const ORIGIN: Vec3Tuple = [0, 0, 0];
const Z_AXIS: Vec3Tuple = [0, 0, 1];

function expectClose(actual: number, expected: number, tolerance = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
}

function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function magnitude(value: Vec3Tuple): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return magnitude(subtract(a, b));
}

/** 球 r=10 @原点 と、平面 z=−30 上の半径 20 の円(§2.9.3 の検算の題材)。 */
function baseCone(): TangentCone {
  const cone = tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, [0, 0, -30], 20);
  if (cone === null) {
    throw new Error('球 r=10 と円 r=20 @ z=-30 では円錐が求まるはず');
  }
  return cone;
}

describe('tangentConeThroughCircle(軸対称の外接円錐、§0.a-0.26-(a))', () => {
  it('頂点は軸上の z0 = (60 + √19200)/6 = 33.094010767585026', () => {
    const cone = baseCone();
    expectClose(cone.apex[0], 0);
    expectClose(cone.apex[1], 0);
    expectClose(cone.apex[2], 33.094010767585026);
    // 独立の導出: 3z0^2 - 60z0 - 1300 = 0 の正の解。
    expectClose(cone.apex[2], (60 + Math.sqrt(19200)) / 6);
  });

  it('半角は asin(r/z0) = 17.587953773993775 度', () => {
    const cone = baseCone();
    expectClose(cone.halfAngle, Math.asin(10 / cone.apex[2]));
    expectClose((cone.halfAngle * 180) / Math.PI, 17.587953773993775);
  });

  it('接触円の中心は軸上の r^2/z0 = 3.021694792519623', () => {
    const cone = baseCone();
    expectClose(cone.contactCenter[0], 0);
    expectClose(cone.contactCenter[1], 0);
    expectClose(cone.contactCenter[2], 3.021694792519623);
    expectClose(cone.contactCenter[2], 100 / cone.apex[2]);
  });

  it('接触円の半径は r√(z0^2 - r^2)/z0 = 9.532542188779432', () => {
    const cone = baseCone();
    expectClose(cone.contactRadius, 9.532542188779432);
    // 接触円は球面上にある(中心からの距離 = √(z^2 + 半径^2) = r)。
    expectClose(Math.hypot(cone.contactCenter[2], cone.contactRadius), 10);
  });

  it('検算: 頂点から z=-30 まで下ろした半径は与えた円の半径 20 に戻る', () => {
    const cone = baseCone();
    const tangent = Math.tan(cone.halfAngle);
    expectClose(tangent, 0.31698729810778076);
    expectClose((cone.apex[2] + 30) * tangent, 20);
  });

  it('軸を逆向きに渡しても同じ円錐になる(頂点は必ず円と反対の側)', () => {
    const cone = baseCone();
    const flipped = tangentConeThroughCircle(ORIGIN, 10, [0, 0, -1], [0, 0, -30], 20);
    expect(flipped).not.toBeNull();
    if (flipped === null) {
      return;
    }
    expectClose(flipped.apex[2], cone.apex[2]);
    expectClose(flipped.contactCenter[2], cone.contactCenter[2]);
    expectClose(flipped.contactRadius, cone.contactRadius);
    expectClose(flipped.halfAngle, cone.halfAngle);
  });

  it('球の中心と軸を動かしても、平行移動・回転した同じ形になる', () => {
    const cone = baseCone();
    // 中心 (1,2,3)、軸を +x にして、円を軸の -x 側 30mm のところへ置く。
    const moved = tangentConeThroughCircle([1, 2, 3], 10, [1, 0, 0], [-29, 2, 3], 20);
    expect(moved).not.toBeNull();
    if (moved === null) {
      return;
    }
    expectClose(distance(moved.apex, [1, 2, 3]), cone.apex[2]);
    expectClose(moved.apex[0], 1 + cone.apex[2]);
    expectClose(moved.apex[1], 2);
    expectClose(moved.apex[2], 3);
    expectClose(distance(moved.contactCenter, [1, 2, 3]), cone.contactCenter[2]);
    expectClose(moved.contactRadius, cone.contactRadius);
  });

  it('円の平面が球を切っているとき(r=20 @ z=-5、球 r=10)は null', () => {
    // 2 次方程式そのものは z0 = 13.685170918213299 という正の解を持つが、
    // 平面 z=-5 が球(z が -10..10)を切るので円錐台+球冠では立体にならない。
    expect(tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, [0, 0, -5], 20)).toBeNull();
  });

  it('円の中心が軸から外れているときは null(許容 1e-9)', () => {
    expect(tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, [0.001, 0, -30], 20)).toBeNull();
    // 許容のすぐ内側なら求まる。
    expect(tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, [1e-12, 0, -30], 20)).not.toBeNull();
  });

  it('円の半径が球の半径と同じときは null(円錐が閉じず円柱に退化する)', () => {
    // a = r では 1 次式になり z0 = -(a^2+h^2)/(2h) = -16.666666666666668 で負。
    expect(tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, [0, 0, -30], 10)).toBeNull();
  });

  it('円の半径が球の半径より小さいときは null(円錐が円の側へ開かない)', () => {
    // a < r では 2 解とも負(-59.148542155126755 と -20.851457844873238)。
    expect(tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, [0, 0, -30], 5)).toBeNull();
  });

  it('円の中心が球の中心に重なるときは null(頂点をどちらの側に置くか決まらない)', () => {
    expect(tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, ORIGIN, 20)).toBeNull();
  });

  it('半径が 0 以下・軸の長さが 0・値が非数のときは null', () => {
    expect(tangentConeThroughCircle(ORIGIN, 0, Z_AXIS, [0, 0, -30], 20)).toBeNull();
    expect(tangentConeThroughCircle(ORIGIN, -10, Z_AXIS, [0, 0, -30], 20)).toBeNull();
    expect(tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, [0, 0, -30], 0)).toBeNull();
    expect(tangentConeThroughCircle(ORIGIN, 10, [0, 0, 0], [0, 0, -30], 20)).toBeNull();
    expect(tangentConeThroughCircle(ORIGIN, Number.NaN, Z_AXIS, [0, 0, -30], 20)).toBeNull();
    expect(tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, [0, 0, Number.NaN], 20)).toBeNull();
    expect(
      tangentConeThroughCircle([Number.POSITIVE_INFINITY, 0, 0], 10, Z_AXIS, [0, 0, -30], 20),
    ).toBeNull();
  });
});

describe('tangentPointOnSphere(一般の輪郭の接点、§0.a-0.26-(b))', () => {
  it('球 r=10、距離 25 の点の接点は球面上にあり、接線の長さは 22.9128784747792', () => {
    const point: Vec3Tuple = [25, 0, 0];
    const contact = tangentPointOnSphere(ORIGIN, 10, Z_AXIS, point);
    expect(contact).not.toBeNull();
    if (contact === null) {
      return;
    }
    expectClose(magnitude(contact), 10);
    expectClose(distance(contact, point), 22.9128784747792);
    expectClose(distance(contact, point), Math.sqrt(25 * 25 - 10 * 10));
  });

  it('同じ点の接点は、中心から軸方向へ 4、軸から 9.16515138991168', () => {
    const contact = tangentPointOnSphere(ORIGIN, 10, Z_AXIS, [25, 0, 0]);
    expect(contact).not.toBeNull();
    if (contact === null) {
      return;
    }
    // u = +x なので軸方向の距離は x 成分、軸からの距離は残りの成分の長さ。
    expectClose(contact[0], 4);
    expectClose(contact[0], 100 / 25);
    expectClose(Math.hypot(contact[1], contact[2]), 9.16515138991168);
    // 方位は法線 +z の側なので、接点は z > 0 側の 1 点に決まる。
    expectClose(contact[1], 0);
    expectClose(contact[2], 9.16515138991168);
  });

  it('接点では (T - C) と (T - P) が直交する', () => {
    const point: Vec3Tuple = [25, 0, 0];
    const contact = tangentPointOnSphere(ORIGIN, 10, Z_AXIS, point);
    expect(contact).not.toBeNull();
    if (contact === null) {
      return;
    }
    expectClose(dot(subtract(contact, ORIGIN), subtract(contact, point)), 0, 1e-9);
  });

  it('法線の向きで接点が 1 つに決まる(球 r=10、P=(20,0,0))', () => {
    // 接点の円は x = r^2/d = 5、半径 r√(d^2-r^2)/d = 8.660254037844387(= 5√3)。
    const plus = tangentPointOnSphere(ORIGIN, 10, [0, 1, 0], [20, 0, 0]);
    const minus = tangentPointOnSphere(ORIGIN, 10, [0, -1, 0], [20, 0, 0]);
    expect(plus).not.toBeNull();
    expect(minus).not.toBeNull();
    if (plus === null || minus === null) {
      return;
    }
    expectClose(plus[0], 5);
    expectClose(plus[1], 8.660254037844387);
    expectClose(plus[2], 0);
    expectClose(minus[0], 5);
    expectClose(minus[1], -8.660254037844387);
    expectClose(minus[2], 0);
    expectClose(8.660254037844387, 5 * Math.sqrt(3));
    expectClose(distance(plus, [20, 0, 0]), Math.sqrt(300));
    expectClose(Math.sqrt(300), 17.320508075688775);
  });

  it('法線に軸方向の成分が混ざっていても、軸に垂直な向きへ直してから使う', () => {
    // (0,1,0) と (2,1,0) は u=+x を抜くと同じ +y になるので、同じ接点になる。
    const straight = tangentPointOnSphere(ORIGIN, 10, [0, 1, 0], [20, 0, 0]);
    const tilted = tangentPointOnSphere(ORIGIN, 10, [2, 1, 0], [20, 0, 0]);
    expect(straight).not.toBeNull();
    expect(tilted).not.toBeNull();
    if (straight === null || tilted === null) {
      return;
    }
    expectClose(tilted[0], straight[0]);
    expectClose(tilted[1], straight[1]);
    expectClose(tilted[2], straight[2]);
  });

  it('球の中心・法線・点が斜めでも、接点は球面上で接線条件を満たす', () => {
    const center: Vec3Tuple = [1, -2, 3];
    const point: Vec3Tuple = [14, 9, -5];
    const contact = tangentPointOnSphere(center, 6, [1, 1, 1], point);
    expect(contact).not.toBeNull();
    if (contact === null) {
      return;
    }
    expectClose(distance(contact, center), 6);
    expectClose(dot(subtract(contact, center), subtract(contact, point)), 0, 1e-9);
    expectClose(distance(contact, point), Math.sqrt(distance(point, center) ** 2 - 36));
  });

  it('点が球の中にあるときは null(接線が引けない)', () => {
    expect(tangentPointOnSphere(ORIGIN, 10, Z_AXIS, [5, 0, 0])).toBeNull();
    expect(tangentPointOnSphere(ORIGIN, 10, Z_AXIS, ORIGIN)).toBeNull();
  });

  it('点が球面上にあるときは null(接線の長さが 0 に退化する)', () => {
    expect(tangentPointOnSphere(ORIGIN, 10, Z_AXIS, [10, 0, 0])).toBeNull();
    expect(tangentPointOnSphere(ORIGIN, 10, Z_AXIS, [0, 0, 10])).toBeNull();
  });

  it('法線が球の中心から点への向きと平行なときは null(方位が決まらない)', () => {
    expect(tangentPointOnSphere(ORIGIN, 10, [1, 0, 0], [20, 0, 0])).toBeNull();
    expect(tangentPointOnSphere(ORIGIN, 10, [-3, 0, 0], [20, 0, 0])).toBeNull();
  });

  it('半径が 0 以下・法線の長さが 0・値が非数のときは null', () => {
    expect(tangentPointOnSphere(ORIGIN, 0, Z_AXIS, [20, 0, 0])).toBeNull();
    expect(tangentPointOnSphere(ORIGIN, -10, Z_AXIS, [20, 0, 0])).toBeNull();
    expect(tangentPointOnSphere(ORIGIN, 10, [0, 0, 0], [20, 0, 0])).toBeNull();
    expect(tangentPointOnSphere(ORIGIN, Number.NaN, Z_AXIS, [20, 0, 0])).toBeNull();
    expect(tangentPointOnSphere(ORIGIN, 10, Z_AXIS, [Number.NaN, 0, 0])).toBeNull();
    expect(tangentPointOnSphere([0, Number.POSITIVE_INFINITY, 0], 10, Z_AXIS, [20, 0, 0])).toBeNull();
  });

  it('軸から外れた輪郭(タスク24 の (b) の経路)でも、各点の接点が球面上に並ぶ', () => {
    // 計画書タスク24 の (b) の題材: 球 r=10 @原点、平面 z=-20、中心 (5,0,-20)、半径 8 の円。
    // 円の中心が球の中心の真下に無いので (a) の経路では断られるが、(b) は 72 点すべてで解ける。
    expect(tangentConeThroughCircle(ORIGIN, 10, Z_AXIS, [5, 0, -20], 8)).toBeNull();
    const normal: Vec3Tuple = [0, 0, -1];
    let count = 0;
    for (let index = 0; index < 72; index += 1) {
      const angle = (index / 72) * 2 * Math.PI;
      const point: Vec3Tuple = [5 + 8 * Math.cos(angle), 8 * Math.sin(angle), -20];
      const contact = tangentPointOnSphere(ORIGIN, 10, normal, point);
      expect(contact).not.toBeNull();
      if (contact === null) {
        continue;
      }
      expectClose(magnitude(contact), 10, 1e-6);
      expectClose(dot(contact, subtract(contact, point)), 0, 1e-6);
      count += 1;
    }
    expect(count).toBe(72);
  });
});
