import { describe, expect, it } from 'vitest';

import {
  hasDuplicateSplinePoint,
  MAX_SPLINE_POINTS,
  sampleSpline,
  sampleSplineCurve,
  splineCurveData,
  splineDegree,
} from './splineMath.js';
import type { ResolvedSpline } from './types.js';
import { distanceVec3, type Vec3 } from './vec3.js';

function splineOf(
  points: readonly Vec3[],
  mode: 'interpolate' | 'control' = 'interpolate',
  closed = false,
): ResolvedSpline {
  return { kind: 'spline', featureId: 's1', mode, points, closed };
}

/** 線分の上で、与えた点にいちばん近いところまでの距離。 */
function distanceToSegment(from: Vec3, to: Vec3, point: Vec3): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) {
    return distanceVec3(from, point);
  }
  const raw =
    ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy + (point[2] - from[2]) * dz) /
    lengthSquared;
  const ratio = Math.min(Math.max(raw, 0), 1);
  return distanceVec3([from[0] + dx * ratio, from[1] + dy * ratio, from[2] + dz * ratio], point);
}

/**
 * 折れ線(標本点を順に結んだもの)の上で、与えた点にいちばん近いところまでの距離。
 * 標本点そのものとの距離ではなく線分との距離を測るのは、刻みの粗さ(標本点の間隔)を
 * 曲線からのずれと取り違えないため。
 */
function distanceToPolyline(polyline: readonly Vec3[], point: Vec3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < polyline.length; index += 1) {
    best = Math.min(best, distanceToSegment(polyline[index], polyline[index + 1], point));
  }
  return best;
}

const WAVE: readonly Vec3[] = [
  [0, 0, 0],
  [10, 5, 0],
  [20, 0, 0],
  [30, 5, 0],
];

describe('スプラインの次数(FR-317、§0.a-0.17)', () => {
  it('点の数 − 1 と 3 の小さいほうになる', () => {
    expect(splineDegree(2)).toBe(1);
    expect(splineDegree(3)).toBe(2);
    expect(splineDegree(4)).toBe(3);
    expect(splineDegree(50)).toBe(3);
  });
});

describe('通過点方式は与えた点をぴったり通る(FR-317)', () => {
  it('開いた 4 点のスプラインは、パラメータを細かく刻むと各点の上を通る', () => {
    const data = splineCurveData(splineOf(WAVE));
    expect(data).not.toBeNull();
    if (data === null) {
      throw new Error('曲線を解けませんでした。');
    }
    expect(data.degree).toBe(3);
    expect(data.periodic).toBe(false);
    expect(data.poles).toHaveLength(4);

    // 2000 分割した折れ線から測って、どの通過点も 1e-5 mm 以内に曲線が通る
    // (残る差は折れ線が弧を弦で置き換えるぶんだけ。曲線そのものは端点の検査で厳密に見る)。
    const samples = sampleSplineCurve(data, 2000);
    for (const point of WAVE) {
      expect(distanceToPolyline(samples, point)).toBeLessThan(1e-5);
    }
  });

  it('両端はパラメータの端でぴったり一致する(丸め誤差 1e-9mm 以内)', () => {
    const data = splineCurveData(splineOf(WAVE));
    if (data === null) {
      throw new Error('曲線を解けませんでした。');
    }
    const samples = sampleSplineCurve(data, 1);
    expect(distanceVec3(samples[0], WAVE[0])).toBeLessThan(1e-9);
    expect(distanceVec3(samples[samples.length - 1], WAVE[3])).toBeLessThan(1e-9);
  });

  it('2 点なら 1 次(直線)になり、中点が 2 点の真ん中に来る', () => {
    const line = splineOf([
      [0, 0, 0],
      [10, 20, 0],
    ]);
    const data = splineCurveData(line);
    if (data === null) {
      throw new Error('曲線を解けませんでした。');
    }
    expect(data.degree).toBe(1);
    const samples = sampleSplineCurve(data, 2);
    expect(distanceVec3(samples[1], [5, 10, 0])).toBeLessThan(1e-9);
  });

  it('閉じた通過点のスプラインは各点を通り、始まりと終わりが同じ位置になる', () => {
    // 半径 10 の円周上の 8 点。閉じるための重複点は入れない。
    const ring: Vec3[] = [];
    for (let index = 0; index < 8; index += 1) {
      const angle = (2 * Math.PI * index) / 8;
      ring.push([10 * Math.cos(angle), 10 * Math.sin(angle), 0]);
    }
    const data = splineCurveData(splineOf(ring, 'interpolate', true));
    if (data === null) {
      throw new Error('曲線を解けませんでした。');
    }
    expect(data.periodic).toBe(true);
    expect(data.multiplicities.every((value) => value === 1)).toBe(true);

    const samples = sampleSplineCurve(data, 2000);
    for (const point of ring) {
      expect(distanceToPolyline(samples, point)).toBeLessThan(1e-5);
    }
    // 1 周して戻る(輪になっている)。
    expect(distanceVec3(samples[0], samples[samples.length - 1])).toBeLessThan(1e-9);
    // 円の近似なので、どの標本点も半径 10 からそう離れない(8 点の 3 次補間で 0.1mm 程度)。
    for (const sample of samples) {
      expect(Math.abs(Math.hypot(sample[0], sample[1]) - 10)).toBeLessThan(0.1);
    }
  });
});

describe('制御点方式は与えた点を極にする(FR-317)', () => {
  it('開いた曲線は両端の節点を重ねるので、始点・終点は最初と最後の点に一致する', () => {
    const data = splineCurveData(splineOf(WAVE, 'control'));
    if (data === null) {
      throw new Error('曲線を解けませんでした。');
    }
    expect(data.poles).toEqual(WAVE);
    expect(data.multiplicities[0]).toBe(data.degree + 1);
    expect(data.multiplicities[data.multiplicities.length - 1]).toBe(data.degree + 1);

    const samples = sampleSplineCurve(data, 4);
    expect(distanceVec3(samples[0], WAVE[0])).toBeLessThan(1e-9);
    expect(distanceVec3(samples[samples.length - 1], WAVE[3])).toBeLessThan(1e-9);
  });

  it('中ほどの点は曲線の上に無い(引っぱるだけ)', () => {
    const data = splineCurveData(splineOf(WAVE, 'control'));
    if (data === null) {
      throw new Error('曲線を解けませんでした。');
    }
    const samples = sampleSplineCurve(data, 400);
    // 通過点方式なら 1e-3 未満で見つかる点が、制御点方式では明確に離れている。
    expect(distanceToPolyline(samples, WAVE[1])).toBeGreaterThan(1);
  });

  it('制御点方式は同じ位置の点が続いていても解ける(通過点方式との違い)', () => {
    const doubled = splineOf(
      [
        [0, 0, 0],
        [0, 0, 0],
        [10, 10, 0],
      ],
      'control',
    );
    expect(splineCurveData(doubled)).not.toBeNull();

    const interpolated = splineOf([
      [0, 0, 0],
      [0, 0, 0],
      [10, 10, 0],
    ]);
    expect(splineCurveData(interpolated)).toBeNull();
  });
});

describe('使えない指定(FR-504)', () => {
  it('点が足りない・多すぎるときは解かない', () => {
    expect(splineCurveData(splineOf([[0, 0, 0]]))).toBeNull();
    const three: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ];
    // 閉じた曲線は 3 点から、開いた曲線は 2 点から。
    expect(splineCurveData(splineOf(three.slice(0, 2), 'interpolate', true))).toBeNull();
    expect(splineCurveData(splineOf(three, 'interpolate', true))).not.toBeNull();

    const tooMany: Vec3[] = [];
    for (let index = 0; index <= MAX_SPLINE_POINTS; index += 1) {
      tooMany.push([index, 0, 0]);
    }
    expect(tooMany).toHaveLength(MAX_SPLINE_POINTS + 1);
    expect(splineCurveData(splineOf(tooMany))).toBeNull();
    expect(splineCurveData(splineOf(tooMany.slice(0, MAX_SPLINE_POINTS)))).not.toBeNull();
  });

  it('重なった点は通過点方式でだけ見つかる。閉じた曲線では先頭と末尾も見る', () => {
    const straight: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ];
    expect(hasDuplicateSplinePoint(straight, false)).toBe(false);
    expect(hasDuplicateSplinePoint(straight, true)).toBe(false);

    const repeated: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 0, 0],
    ];
    // 開いた曲線としては重なりが無く、閉じると先頭と末尾が重なる。
    expect(hasDuplicateSplinePoint(repeated, false)).toBe(false);
    expect(hasDuplicateSplinePoint(repeated, true)).toBe(true);
  });
});

describe('表示用の折れ線(sampleSpline)', () => {
  it('両端を含み、点の数に応じて細かくなる', () => {
    const polyline = sampleSpline(splineOf(WAVE));
    // 3 スパン × 既定の 16 分割 + 1。
    expect(polyline).toHaveLength(49);
    expect(distanceVec3(polyline[0], WAVE[0])).toBeLessThan(1e-9);
    expect(distanceVec3(polyline[polyline.length - 1], WAVE[3])).toBeLessThan(1e-9);
  });

  it('刻みの粗さを指定できる', () => {
    expect(sampleSpline(splineOf(WAVE), 4)).toHaveLength(13);
  });

  it('曲線を解けないときは置いた点をそのまま結んで返す(止めずに描く、NFR-RE-1)', () => {
    const broken = splineOf([
      [0, 0, 0],
      [0, 0, 0],
      [10, 10, 0],
    ]);
    expect(sampleSpline(broken)).toEqual(broken.points);

    // 閉じた曲線は最初の点へ戻して輪に見せる。
    const brokenClosed = splineOf(
      [
        [0, 0, 0],
        [0, 0, 0],
        [10, 10, 0],
      ],
      'interpolate',
      true,
    );
    expect(sampleSpline(brokenClosed)).toEqual([...brokenClosed.points, brokenClosed.points[0]]);
  });
});
