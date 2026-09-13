import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarCurveCurvature } from './scalarCurveCurvature.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { sampleFunctionCurve, type FunctionCurveOptions } from './adaptiveFunctionCurve.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'width', label: 'X', decimal: '3' }, { id: 'scale', label: 'pi', decimal: '2' }];
const context = () => ({ backend, shouldStop: () => undefined });
function definition(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return createFunctionMathSource(source, 'text', angleUnit, { axes: ['X'], parameters: [], coefficients }, backend);
}
const options: FunctionCurveOptions = { lower: -2, upper: 2, minimum: [-3, -5, -1], maximum: [3, 5, 1],
  tolerance: 0.001, maximumSamples: 20_000, maximumCells: 40_000, maximumDepth: 40 };
function evaluator(x: string, y: string, z: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return createFunctionCurveEvaluator([definition(x, angleUnit), definition(y, angleUnit), definition(z, angleUnit)], 'X', coefficients, context());
}

describe('数式入力と区間付き関数曲線を実エンジンで接続する', () => {
  it('QRの成分は係数の原式で一度だけ準備し、標本ごとに行列を再計算しない', () => {
    const source = definition('component(qrq([[coef("X"),0],[4,5]]),1,1)*X');
    let evaluations = 0;
    const countedBackend: MathExecutionBackend = { ...backend, box(expression) {
      evaluations += 1;
      return backend.box(expression);
    } };
    const initial = createScalarSampler(compileFunctionScalar(source, ['X'], coefficients,
      { backend: countedBackend, shouldStop: () => undefined }));
    const preparedEvaluations = evaluations;
    for (let index = 0; index <= 100; index += 1) expect(initial([index / 50])).toBeCloseTo(0.6 * index / 50, 12);
    expect(evaluations).toBe(preparedEvaluations);
    const changed = coefficients.map(value => value.id === 'width' ? { ...value, decimal: '5' } : value);
    const edited = createScalarSampler(compileFunctionScalar(source, ['X'], changed, context()));
    expect(edited([2])).toBeCloseTo(10 / Math.sqrt(41), 12);
    expect(initial([2])).toBeCloseTo(1.2, 12);
  });
  it('行列から取り出した直交方向でもXYZ範囲と曲線精度を保つ', () => {
    const result = sampleFunctionCurve(evaluator('X', 'component(qrq([[3,0],[4,5]]),1,1)*X', '0'), options);
    expect(result).toMatchObject({ status: 'ready', stats: { samples: 2 } });
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components[0][0].point).toEqual([-2, -1.2, 0]);
    expect(result.components[0].at(-1)?.point).toEqual([2, 1.2, 0]);
  });
  it('軸X・係数X・定数pi・係数piを混同せず、現在の係数値で再計算する', () => {
    const original = definition('X*coef("X")+coef("pi")+sin(pi/2)'), before = JSON.stringify(original);
    const initial = createScalarSampler(compileFunctionScalar(original, ['X'], coefficients, context()));
    expect(initial([2])).toBe(9);
    const changed = coefficients.map(value => value.id === 'width' ? { ...value, decimal: '5' } : value);
    expect(createScalarSampler(compileFunctionScalar(original, ['X'], changed, context()))([2])).toBe(13);
    expect(initial([2])).toBe(9); expect(JSON.stringify(original)).toBe(before);
  });

  it('保存ASTの差替え、係数の欠落・重複、未宣言の軸、非有限の係数を断る', () => {
    const original = definition('X+coef("X")');
    expect(() => compileFunctionScalar({ ...original, expression: definition('X+2').expression }, ['X'], coefficients, context())).toThrow();
    expect(() => compileFunctionScalar(original, ['X'], [], context())).toThrow();
    expect(() => compileFunctionScalar(original, ['X'], [...coefficients, coefficients[0]], context())).toThrow();
    expect(() => compileFunctionScalar(original, ['T'], coefficients, context())).toThrow();
    expect(() => compileFunctionScalar(original, ['X'], [{ ...coefficients[0], decimal: 'Infinity' }], context())).toThrow();
  });

  it.each(['X+0*(1/0)', 'X+0*(-1)!', 'X+0*root(-8,1.5)', 'X+2*integrate(sin(t^2),t,0,1)', 'X+[1,2]'])(
    '%sの未定義・未保証近似・非スカラーを定数の簡約で隠さない', source => {
      expect(() => compileFunctionScalar(definition(source), ['X'], coefficients, context())).toThrow();
    });

  it('計算中止後は新しい関数の計算計画を作らない', () => {
    expect(() => compileFunctionScalar(definition('X^2'), ['X'], coefficients,
      { backend, shouldStop: () => 'cancelled' })).toThrow();
  });

  it.each([
    { source: 'X^2+2*X+1', lower: -1, upper: 2, second: () => 2 },
    { source: 'X^3', lower: -2, upper: 3, second: (x: number) => 6 * x },
    { source: '1/X', lower: 0.5, upper: 2, second: (x: number) => 2 / (x*x*x) },
    { source: 'sin(X^2)', lower: -2, upper: 2, second: (x: number) => 2*Math.cos(x*x) - 4*x*x*Math.sin(x*x) },
    { source: 'sqrt(X)', lower: 0.2, upper: 4, second: (x: number) => -1/(4*x*Math.sqrt(x)) },
    { source: 'ln(X)', lower: 0.2, upper: 4, second: (x: number) => -1/(x*x) },
    { source: 'tan(X)', lower: 0.2, upper: 0.6, second: (x: number) => 2*Math.tan(x)/(Math.cos(x)**2) },
    { source: 'cot(X)', lower: 0.2, upper: 0.6, second: (x: number) => 2/Math.tan(x)/(Math.sin(x)**2) },
    { source: 'sec(X)', lower: 0.2, upper: 0.6, second: (x: number) => (2/(Math.cos(x)**2)-1)/Math.cos(x) },
    { source: 'csc(X)', lower: 0.2, upper: 0.6, second: (x: number) => (2/(Math.sin(x)**2)-1)/Math.sin(x) },
  ])('$sourceの二階微分上限が独立した解析式を包む', ({ source, lower, upper, second }) => {
    const bound = createScalarCurveCurvature(compileFunctionScalar(definition(source), ['X'], coefficients, context()))(lower, upper);
    expect(bound).not.toBeNull();
    if (bound === null) throw new Error('Expected derivative bound');
    for (let index = 0; index <= 40; index++) expect(Math.abs(second(lower + (upper - lower) * index / 40))).toBeLessThanOrEqual(bound);
  });

  it('放物線の全辺の内部残差が指定精度以内となり、直線を不要に細分化しない', () => {
    const result = sampleFunctionCurve(evaluator('X', 'X^2', '0'), options);
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(1); expect(result.stats.samples).toBeLessThan(150);
    for (let index = 1; index < result.components[0].length; index++) {
      const a = result.components[0][index - 1], b = result.components[0][index];
      for (const fraction of [0.25, 0.5, 0.75]) {
        const x = a.parameter + (b.parameter - a.parameter) * fraction;
        const chord = a.point[1] + (b.point[1] - a.point[1]) * fraction;
        expect(Math.abs(chord - x*x)).toBeLessThanOrEqual(options.tolerance);
      }
    }
    const line = sampleFunctionCurve(evaluator('X', '2*X+1', '0'), options);
    expect(line).toMatchObject({ status: 'ready', stats: { samples: 2 } });
  });

  it('三角関数の度数を一度だけ換算し、立体のらせんを同じ精度で分割する', () => {
    const curve = evaluator('cos(X)', 'sin(X)', 'X/360', 'degree');
    expect(curve.point(90)?.[0]).toBeCloseTo(0, 12); expect(curve.point(90)?.[1]).toBeCloseTo(1, 12);
    const result = sampleFunctionCurve(curve, { ...options, lower: 0, upper: 720, minimum: [-2, -2, -1], maximum: [2, 2, 3] });
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(1); expect(result.stats.samples).toBeLessThan(600);
    const samples = result.components[0];
    expect(samples[0].point).toEqual([1, 0, 0]); expect(samples.at(-1)?.point[2]).toBe(2);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i], middle = (a.parameter + b.parameter)/2*Math.PI/180;
      expect(Math.hypot((a.point[0]+b.point[0])/2-Math.cos(middle), (a.point[1]+b.point[1])/2-Math.sin(middle)))
        .toBeLessThanOrEqual(options.tolerance);
    }
  });

  it('端点と中点が重なる高速振動を平らにせず、周期の途中の残差も精度内へ抑える', () => {
    const result = sampleFunctionCurve(evaluator('X', 'sin(64*pi*X)', '0'), { ...options, lower: 0, upper: 1 });
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    const samples = result.components[0]; expect(samples.length).toBeGreaterThan(1000);
    expect(Math.max(...samples.map(sample => sample.point[1]))).toBeGreaterThan(0.999);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i], x = (a.parameter + b.parameter)/2;
      expect(Math.abs((a.point[1]+b.point[1])/2 - Math.sin(64*Math.PI*x))).toBeLessThanOrEqual(options.tolerance);
    }
  });

  it('無限に続く双曲線を有限のXYZ範囲で除外し、極を横断する辺を作らない', () => {
    const result = sampleFunctionCurve(evaluator('X', '1/X', '0'), options);
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(2); expect(result.stats.samples).toBeLessThan(1000);
    expect(result.components[0].every(sample => sample.parameter < 0)).toBe(true);
    expect(result.components[1].every(sample => sample.parameter > 0)).toBe(true);
  });
  it('対数の負側と負の無限大へ発散する側をXYZの外へ除き、正側の曲線だけを採用する', () => {
    const result = sampleFunctionCurve(evaluator('X', 'ln(X)', '0'), options);
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(1); expect(result.stats.samples).toBeLessThan(3000);
    const samples = result.components[0]; expect(samples.every(sample => sample.parameter > 0)).toBe(true);
    for (let index = 1; index < samples.length; index++) {
      const a = samples[index-1], b = samples[index];
      expect(Math.abs((a.point[1]+b.point[1])/2-Math.log((a.parameter+b.parameter)/2))).toBeLessThanOrEqual(options.tolerance);
    }
  });
  it('巨大な平行移動で座標の丸めが要求精度を超える場合、二階微分だけを根拠に成功としない', () => {
    const result = sampleFunctionCurve(evaluator('X', 'X^2+10000000000000000', '0'),
      { ...options, lower: 0, upper: 1, minimum: [-1, 1e16-10, -1], maximum: [2, 1e16+10, 1], maximumDepth: 8 });
    expect(result.status).toBe('stopped'); expect(result).not.toHaveProperty('components');
  });
  it.each([
    { source: 'tan(X)', poles: [-Math.PI/2, Math.PI/2], branches: 3, at: Math.tan },
    { source: 'cot(X)', poles: [0], branches: 2, at: (x: number) => 1/Math.tan(x) },
    { source: 'sec(X)', poles: [-Math.PI/2, Math.PI/2], branches: 3, at: (x: number) => 1/Math.cos(x) },
    { source: 'csc(X)', poles: [0], branches: 2, at: (x: number) => 1/Math.sin(x) },
  ])('$sourceを有限のXYZ範囲へ絞り、全ての極を接続せず内部残差も指定精度以内にする', ({ source, poles, branches, at }) => {
    const result = sampleFunctionCurve(evaluator('X', source, '0'), options);
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(branches); expect(result.stats.samples).toBeLessThan(3000);
    for (const component of result.components) for (let index = 1; index < component.length; index++) {
      const a = component[index-1], b = component[index];
      for (const pole of poles) expect(a.parameter < pole && b.parameter > pole).toBe(false);
      for (const fraction of [0.25, 0.5, 0.75]) {
        const x = a.parameter+(b.parameter-a.parameter)*fraction;
        expect(Math.abs(a.point[1]+(b.point[1]-a.point[1])*fraction-at(x))).toBeLessThanOrEqual(options.tolerance);
      }
    }
  });
});
