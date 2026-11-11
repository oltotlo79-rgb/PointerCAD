import { describe, expect, it } from 'vitest';
import { keyCurveList } from './cacheKey.js';
import { toKeyCurve } from './solidPlanKeyGeometry.js';
import { mirrorTransform, transformCurve } from '../sketch/copyMath.js';
import { reverseSpline, splineCurveData } from '../sketch/splineMath.js';
import type { ResolvedSpline } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';

/** Same eight poles, read as four different valid curves. */
const points: Vec3[] = [[0, 0, 0], [0.4, 0.6, 0], [1.1, 1.2, 0], [1.6, 1.3, 0], [2.4, 1.2, 0], [3.0, 0.5, 0], [3.3, 0.2, 0], [3.6, 0, 0]];
const uniform: ResolvedSpline = { kind: 'spline', featureId: 'a', mode: 'control', closed: false, points };
const linear: ResolvedSpline = { ...uniform, degree: 1 };
const smooth: ResolvedSpline = { ...uniform, degree: 3, knots: [0, 0.3, 1.5, 1.6] };
const shifted: ResolvedSpline = { ...smooth, knots: [0, 1.2, 1.5, 1.6] };
const key = (curve: ResolvedSpline) => keyCurveList([toKeyCurve(curve)]);

describe('立体の計画の鍵は次数と明示節点を含み、同じ極の別の曲線の形状を再利用しない', () => {
  it('4つとも有効で形の違う曲線は、すべて別の計画の鍵になる', () => {
    for (const curve of [uniform, linear, smooth, shifted]) expect(splineCurveData(curve)).not.toBeNull();
    expect(new Set([uniform, linear, smooth, shifted].map(key)).size).toBe(4);
  });

  it('一様なスプラインの鍵の文字列は変えず、計画の鍵と曲線の鍵は同じ規則で作る', () => {
    const legacy: ResolvedSpline = { kind: 'spline', featureId: 'legacy', mode: 'control', closed: false, points: [[0, 0, 0], [1, 2, 0]] };
    expect(key(legacy)).toBe('1:[spline(control|false|2:[0.000000000,0.000000000,0.000000000,1.000000000,2.000000000,0.000000000])]');
    for (const curve of [uniform, linear, smooth]) expect(key(curve)).toBe(keyCurveList([curve]));
  });

  it('featureIdは形に関わらず、同じ形なら同じ鍵になる', () => {
    expect(key({ ...smooth, featureId: 'other' })).toBe(key(smooth));
  });

  it('鏡像・反転・閉じた輪でも節点が鍵に残り、反転した輪を元の向きの鍵と取り違えない', () => {
    const mirrored = transformCurve(mirrorTransform([0, 0, 0], [1, 0, 0]), smooth, 'mirror');
    if (mirrored.kind !== 'spline') throw new Error('Expected spline');
    expect(key(mirrored)).toContain('|knots:4:[0,0.3,1.5,1.6]|');
    const reversed = reverseSpline(smooth);
    expect(key(reversed)).not.toBe(key(smooth));
    expect(key(reversed)).toContain('degree:3|knots:4:');
    const loop: ResolvedSpline = { ...smooth, points: [...points.slice(0, 7), points[0]] };
    const loopUniform: ResolvedSpline = { ...uniform, points: loop.points };
    expect(splineCurveData(loop)).not.toBeNull();
    expect(key(loop)).not.toBe(key(loopUniform));
    expect(key(reverseSpline(loop))).not.toBe(key(loop));
  });
});
