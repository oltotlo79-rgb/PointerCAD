import { describe, expect, it } from 'vitest';
import { createProjectedArcLengthDimensionGeometry, type ArcLengthDimensionInput } from './arcLengthGeometry.js';

const input: ArcLengthDimensionInput = { center: [20, 30], axes: [[10, 0], [0, 10]], sweep: Math.PI / 2 };
describe('弧長寸法の配置', () => {
  it('四分円に外側8mmの寸法円弧と2本の補助線・矢印を作る', () => {
    const result = createProjectedArcLengthDimensionGeometry(input);
    expect(result?.points[0]).toEqual([38, 30]);
    expect(result?.points.at(-1)?.[0]).toBeCloseTo(20); expect(result?.points.at(-1)?.[1]).toBeCloseTo(48);
    expect(result?.extensionLines).toHaveLength(2); expect(result?.arrows).toHaveLength(2);
    expect(result?.textPosition[0]).toBeCloseTo(20 + 19 / Math.sqrt(2));
  });
  it('時計回りと大弧の向きを保ち、円全周では放射状の補助線を重ねない', () => {
    const reverse = createProjectedArcLengthDimensionGeometry({ ...input, sweep: -Math.PI * 1.5 });
    expect(reverse?.points[1]?.[1]).toBeLessThan(30); expect(reverse?.points.at(-1)?.[1]).toBeCloseTo(48);
    const circle = createProjectedArcLengthDimensionGeometry({ ...input, sweep: 2 * Math.PI });
    expect(circle?.extensionLines).toEqual([]); expect(circle?.points.at(-1)?.[0]).toBeCloseTo(38);
  });
  it('斜めの投影の楕円も短軸側に8mm以上の間隔を残す', () => {
    const result = createProjectedArcLengthDimensionGeometry({ ...input, axes: [[10, 0], [0, 5]] });
    expect(result?.points[0]).toEqual([46, 30]); expect(result?.points.at(-1)?.[1]).toBeCloseTo(43);
    expect(result?.points[1]?.[0]).toBeLessThan(46);
  });
  it('用紙上の弦誤差を0.01mm以下に収め、有限な点列を返す', () => {
    const result = createProjectedArcLengthDimensionGeometry({ ...input, axes: [[100, 0], [0, 100]], sweep: Math.PI * 1.5 });
    expect(result).not.toBeNull();
    if (result === null) return;
    for (let i = 1; i < result.points.length; i += 1) {
      const a = result.points[i - 1], b = result.points[i];
      const midpointRadius = Math.hypot((a[0] + b[0]) / 2 - 20, (a[1] + b[1]) / 2 - 30);
      expect(108 - midpointRadius).toBeLessThanOrEqual(0.01);
    }
  });
  it('潰れた投影、過大な点列、不正な角度を拒む', () => {
    expect(createProjectedArcLengthDimensionGeometry({ ...input, axes: [[10, 0], [5, 0]] })).toBeNull();
    expect(createProjectedArcLengthDimensionGeometry({ ...input, axes: [[1e20, 0], [0, 1e20]] })).toBeNull();
    for (const sweep of [0, NaN, Infinity, Math.PI * 3]) expect(createProjectedArcLengthDimensionGeometry({ ...input, sweep })).toBeNull();
  });
});
