import { describe, expect, it } from 'vitest';
import { intervalUnion, unionDivide } from './mathIntervalUnion.js';
import { sampleFunctionCurve, type FunctionCurveEvaluator, type FunctionCurveOptions } from './adaptiveFunctionCurve.js';

const options: FunctionCurveOptions = { lower: -2, upper: 2, minimum: [-3, -5, -1], maximum: [3, 5, 1],
  tolerance: 0.01, maximumSamples: 20_000, maximumCells: 40_000, maximumDepth: 40 };
const line: FunctionCurveEvaluator = {
  point: parameter => [parameter, 0, 0],
  enclosure: (a, b) => [intervalUnion(a, b), intervalUnion(0), intervalUnion(0)],
};

describe('XYZ範囲と区間の連続性で関数曲線を適応分割する（ADD-4）', () => {
  it('放物線を二階微分の上限で分割し、独立した中点残差が指定精度以内になる', () => {
    const result = sampleFunctionCurve({
      point: parameter => [parameter, parameter * parameter, 0],
      enclosure: (a, b) => [intervalUnion(a, b), intervalUnion(a <= 0 && b >= 0 ? 0 : Math.min(a*a, b*b), Math.max(a*a, b*b)), intervalUnion(0)],
      chordErrorBound: (a, b) => (b - a) ** 2 / 4, // |Y''| h²/8 = 2h²/8.
    }, options);
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(1);
    expect(result.maximumChordErrorBound).toBeLessThanOrEqual(options.tolerance);
    const points = result.components[0];
    expect(points.length).toBeGreaterThan(2);
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index], middle = (a.parameter + b.parameter) / 2;
      const chordY = (a.point[1] + b.point[1]) / 2;
      expect(Math.abs(chordY - middle * middle)).toBeLessThanOrEqual(options.tolerance);
    }
    expect(result.stats.samples).toBe(points.length);
  });

  it('1/Xの極を跨がず、有限のY範囲内へ戻る2本の枝を別々に作る', () => {
    const result = sampleFunctionCurve({ point: parameter => parameter === 0 ? null : [parameter, 1 / parameter, 0],
      enclosure: (a, b) => [intervalUnion(a, b), unionDivide(intervalUnion(1), intervalUnion(a, b)), intervalUnion(0)],
    }, options);
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2);
    expect(result.components[0].every(sample => sample.parameter < 0)).toBe(true);
    expect(result.components[1].every(sample => sample.parameter > 0)).toBe(true);
    expect(result.maximumChordErrorBound).toBeLessThanOrEqual(options.tolerance);
    for (const branch of result.components) for (const sample of branch) {
      expect(sample.point[0] * sample.point[1]).toBeCloseTo(1, 12);
    }
  });

  it('振動の端点が同じでも、区間の値域を包めなければ直線で置き換えない', () => {
    const result = sampleFunctionCurve({ point: parameter => [parameter, Math.sin(64 * Math.PI * parameter), 0],
      enclosure: (a, b) => [intervalUnion(a, b), intervalUnion(-1, 1), intervalUnion(0)],
    }, { ...options, lower: 0, upper: 1, maximumDepth: 8 });
    expect(result.status).toBe('stopped'); expect(result).not.toHaveProperty('components');
  });

  it('直線は区間による距離上限でも収束し、証明された零曲率なら分割を増やさない', () => {
    const generic = sampleFunctionCurve(line, options);
    if (generic.status !== 'ready') throw new Error(JSON.stringify(generic));
    expect(generic.components[0].length).toBeGreaterThan(2);
    const affine = sampleFunctionCurve({ ...line, chordErrorBound: () => 0 }, options);
    if (affine.status !== 'ready') throw new Error(JSON.stringify(affine));
    expect(affine.components[0]).toHaveLength(2); expect(affine.stats.samples).toBe(2);
  });

  it.each(['samples', 'cells', 'subdivision'] as const)('%s上限で停止した際、途中の形を完成として返さない', reason => {
    const limited = { ...options, ...(reason === 'samples' ? { maximumSamples: 2 } : reason === 'cells' ? { maximumCells: 1 } : { maximumDepth: 1 }) };
    const result = sampleFunctionCurve(line, limited);
    expect(result).toMatchObject({ status: 'stopped', reason }); expect(result).not.toHaveProperty('components');
    expect(result.stats.samples).toBeLessThanOrEqual(limited.maximumSamples);
    expect(result.stats.cells).toBeLessThanOrEqual(limited.maximumCells);
  });

  it('中止を各区間で受け付け、部分結果を返さない', () => {
    let checks = 0;
    const result = sampleFunctionCurve(line, { ...options, shouldStop: () => ++checks > 3 ? 'cancelled' : undefined });
    expect(result).toMatchObject({ status: 'stopped', reason: 'cancelled' }); expect(result).not.toHaveProperty('components');
  });

  it('範囲外を先に除外し、標本を評価せず空を返す', () => {
    let evaluated = false;
    const result = sampleFunctionCurve({ point: () => { evaluated = true; return [100, 0, 0]; },
      enclosure: () => [intervalUnion(100), intervalUnion(0), intervalUnion(0)],
    }, options);
    expect(result).toMatchObject({ status: 'empty', stats: { samples: 0 } }); expect(evaluated).toBe(false);
  });

  it('全て同じ位置へ写す式はゼロ長の辺を作らず退化を報告する', () => {
    const result = sampleFunctionCurve({ point: () => [0, 0, 0],
      enclosure: () => [intervalUnion(0), intervalUnion(0), intervalUnion(0)] }, options);
    expect(result.status).toBe('degenerate');
  });

  it('有限で正しい範囲と予算の検証前に標本や区間の処理を呼ばない', () => {
    const never = (): never => { throw new Error('Evaluation should not begin'); };
    expect(() => sampleFunctionCurve({ point: never, enclosure: never }, { ...options, maximum: [3, Infinity, 1] })).toThrow(RangeError);
    expect(() => sampleFunctionCurve({ point: never, enclosure: never }, { ...options, upper: -2 })).toThrow(RangeError);
    expect(() => sampleFunctionCurve({ point: never, enclosure: never }, { ...options, tolerance: 0 })).toThrow(RangeError);
  });
});
