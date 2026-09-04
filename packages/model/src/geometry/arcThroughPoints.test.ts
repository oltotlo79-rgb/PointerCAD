import { describe, expect, it } from 'vitest';

import { crossVec3, distanceVec3, lengthVec3, type Vec3 } from '../sketch/vec3.js';
import { arcThroughPoints, type ArcThroughPointsResult } from './arcThroughPoints.js';

/** 円弧上の点を再構成する(検証用。実装の `angleOf` と対になる)。 */
function pointOnArc(arc: ArcThroughPointsResult, angle: number): Vec3 {
  const yAxis = crossVec3(arc.normal, arc.xAxis);
  return [
    arc.center[0] + arc.radius * (Math.cos(angle) * arc.xAxis[0] + Math.sin(angle) * yAxis[0]),
    arc.center[1] + arc.radius * (Math.cos(angle) * arc.xAxis[1] + Math.sin(angle) * yAxis[1]),
    arc.center[2] + arc.radius * (Math.cos(angle) * arc.xAxis[2] + Math.sin(angle) * yAxis[2]),
  ];
}

/** 中心から見た点の角度(独立に atan2 で求める。検証専用)。 */
function angleOfIndependently(arc: ArcThroughPointsResult, point: Vec3): number {
  const yAxis = crossVec3(arc.normal, arc.xAxis);
  const relative: Vec3 = [
    point[0] - arc.center[0],
    point[1] - arc.center[1],
    point[2] - arc.center[2],
  ];
  const alongX = relative[0] * arc.xAxis[0] + relative[1] * arc.xAxis[1] + relative[2] * arc.xAxis[2];
  const alongY = relative[0] * yAxis[0] + relative[1] * yAxis[1] + relative[2] * yAxis[2];
  return Math.atan2(alongY, alongX);
}

function expectVec3CloseTo(actual: Vec3, expected: Vec3, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

describe('arcThroughPoints(3 点の円弧、P4 タスク36、FR-330)', () => {
  it('頂点 (10,0,0)(0,10,0)(0,0,10) を通る円弧は中心が重心、半径 10√(2/3)、法線 (1,1,1)/√3', () => {
    const p0: Vec3 = [10, 0, 0];
    const p1: Vec3 = [0, 10, 0];
    const p2: Vec3 = [0, 0, 10];
    const arc = arcThroughPoints(p0, p1, p2);
    if (arc === null) {
      throw new Error('3 点が同一直線上ではないので null になってはいけない');
    }
    expectVec3CloseTo(arc.center, [10 / 3, 10 / 3, 10 / 3]);
    expect(arc.radius).toBeCloseTo(10 * Math.sqrt(2 / 3), 9);
    expect(arc.radius).toBeCloseTo(8.16496580927726, 9);
    const invSqrt3 = 1 / Math.sqrt(3);
    expectVec3CloseTo(arc.normal, [invSqrt3, invSqrt3, invSqrt3]);
    expect(arc.startAngle).toBe(0);
  });

  it('始点・終点・通過点はいずれも中心からの距離が半径と一致する(円周上にある)', () => {
    const p0: Vec3 = [10, 0, 0];
    const p1: Vec3 = [0, 10, 0];
    const p2: Vec3 = [0, 0, 10];
    const arc = arcThroughPoints(p0, p1, p2);
    if (arc === null) {
      throw new Error('null になってはいけない');
    }
    expect(distanceVec3(arc.center, p0)).toBeCloseTo(arc.radius, 9);
    expect(distanceVec3(arc.center, p1)).toBeCloseTo(arc.radius, 9);
    expect(distanceVec3(arc.center, p2)).toBeCloseTo(arc.radius, 9);
    // 始点は角度 0、終了角の位置に終点が来る。
    expectVec3CloseTo(pointOnArc(arc, arc.startAngle), p0);
    expectVec3CloseTo(pointOnArc(arc, arc.endAngle), p1);
  });

  it('通過点を経由する側の弧を選ぶ(半円の例、始点(10,0,0)・終点(-10,0,0)・通過点(0,10,0))', () => {
    const p0: Vec3 = [10, 0, 0];
    const p1: Vec3 = [-10, 0, 0];
    const p2: Vec3 = [0, 10, 0];
    const arc = arcThroughPoints(p0, p1, p2);
    if (arc === null) {
      throw new Error('null になってはいけない');
    }
    expectVec3CloseTo(arc.center, [0, 0, 0]);
    expect(arc.radius).toBeCloseTo(10, 9);
    // 通過点の角度は、始点(0)から終了角までの間になければならない(向きに関わらず)。
    const via = angleOfIndependently(arc, p2);
    const low = Math.min(arc.startAngle, arc.endAngle);
    const high = Math.max(arc.startAngle, arc.endAngle);
    // atan2 は (-π, π] を返すので、区間の外に出ていないか±2πの等価表現も見る。
    const equivalents = [via, via + 2 * Math.PI, via - 2 * Math.PI];
    expect(equivalents.some((value) => value >= low - 1e-9 && value <= high + 1e-9)).toBe(true);
    expectVec3CloseTo(pointOnArc(arc, arc.endAngle), p1);
  });

  it('通常の作図面(XY 面)の 3 点では、法線が作図面の法線 (0,0,1) と一致する', () => {
    const p0: Vec3 = [0, 0, 0];
    const p1: Vec3 = [10, 0, 0];
    const p2: Vec3 = [0, 10, 0];
    const arc = arcThroughPoints(p0, p1, p2);
    if (arc === null) {
      throw new Error('null になってはいけない');
    }
    expectVec3CloseTo(arc.normal, [0, 0, 1]);
  });

  it('3 点が一直線上にあれば null(外接円が発散する)', () => {
    expect(arcThroughPoints([0, 0, 0], [5, 0, 0], [10, 0, 0])).toBeNull();
    // 2 点が重なる場合も外接円が定まらないので null。
    expect(arcThroughPoints([1, 1, 1], [1, 1, 1], [2, 2, 2])).toBeNull();
  });

  it('法線は単位ベクトル、xAxis は法線に直交する単位ベクトル', () => {
    const arc = arcThroughPoints([10, 0, 0], [0, 10, 0], [0, 0, 10]);
    if (arc === null) {
      throw new Error('null になってはいけない');
    }
    expect(lengthVec3(arc.normal)).toBeCloseTo(1, 12);
    expect(lengthVec3(arc.xAxis)).toBeCloseTo(1, 12);
    const dot =
      arc.normal[0] * arc.xAxis[0] + arc.normal[1] * arc.xAxis[1] + arc.normal[2] * arc.xAxis[2];
    expect(dot).toBeCloseTo(0, 12);
  });
});
