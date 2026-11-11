import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { functionCurvePeriodicity } from './functionCurvePeriodicity.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'w', label: 'w', decimal: '2.5' }];
const output = (source: string, unit: 'degree' | 'radian' = 'radian') =>
  createFunctionMathSource(source, 'text', unit, { axes: [], parameters: ['T'], coefficients }, backend);
const bound = (source: string) => createFunctionMathSource(source, 'text', 'radian', { axes: [], parameters: [], coefficients }, backend);
function prove(outputs: readonly [string, string, string], lower: string, upper: string, values: readonly [number, number],
  unit: 'degree' | 'radian' = 'radian') {
  return functionCurvePeriodicity({ outputs: [output(outputs[0], unit), output(outputs[1], unit), output(outputs[2], unit)],
    lower: bound(lower), upper: bound(upper), lowerValue: values[0], upperValue: values[1], coefficients });
}
const TWO_PI = 2 * Math.PI;

describe('原式の T の範囲が共通周期のちょうど整数倍であることを、数値の一致に頼らずに証明する', () => {
  it('円 (cos T, sin T, 0) の 0..2π は周期 2π の1周', () => {
    expect(prove(['cos(T)', 'sin(T)', '0'], '0', '2*pi', [0, TWO_PI]))
      .toEqual({ status: 'proved', turns: 1, period: { numerator: '2', denominator: '1', piPower: 1 } });
  });

  it('ずらした1周 π/2..5π/2 と2周 0..4π も、端点の値ではなく原式の差で数える', () => {
    expect(prove(['cos(T)', 'sin(T)', '0'], 'pi/2', '5*pi/2', [Math.PI / 2, 5 * Math.PI / 2])).toMatchObject({ status: 'proved', turns: 1 });
    expect(prove(['cos(T)', 'sin(T)', '0'], '0', '4*pi', [0, 2 * TWO_PI])).toMatchObject({ status: 'proved', turns: 2 });
  });

  it('度の角度では 0..360 が周期 360 の1周', () => {
    expect(prove(['cos(T)', 'sin(T)', '0'], '0', '360', [0, 360], 'degree'))
      .toEqual({ status: 'proved', turns: 1, period: { numerator: '360', denominator: '1', piPower: 0 } });
  });

  it('cos 2T + cos 3T と sin T の共通周期は 2π、係数 w = 2.5 の cos(wT) は 4π/5 で 0..4π は5周', () => {
    expect(prove(['cos(2*T)+cos(3*T)', 'sin(T)', '0'], '0', '2*pi', [0, TWO_PI]))
      .toEqual({ status: 'proved', turns: 1, period: { numerator: '2', denominator: '1', piPower: 1 } });
    expect(prove(['cos(coef("w")*T)', 'sin(coef("w")*T)', '0'], '0', '4*pi', [0, 2 * TWO_PI]))
      .toEqual({ status: 'proved', turns: 5, period: { numerator: '4', denominator: '5', piPower: 1 } });
  });

  it('周期でない座標 Z = T/(2π) のらせんは、端点が周期に見えても証明しない', () => {
    expect(prove(['cos(T)', 'sin(T)', 'T/(2*pi)'], '0', '2*pi', [0, TWO_PI])).toEqual({ status: 'unproved', reason: 'nonperiodic-coordinate' });
  });

  it('2π に近い小数・半周は整数倍でないので証明しない', () => {
    expect(prove(['cos(T)', 'sin(T)', '0'], '0', '6.283185307', [0, 6.283185307])).toEqual({ status: 'unproved', reason: 'not-whole-period' });
    expect(prove(['cos(T)', 'sin(T)', '0'], '0', 'pi', [0, Math.PI])).toEqual({ status: 'unproved', reason: 'not-whole-period' });
  });

  it('端点が一致するだけの曲線 (T(T−1), 0, 0) の 0..1 は証明しない', () => {
    expect(prove(['T*(T-1)', '0', '0'], '0', '1', [0, 1])).toEqual({ status: 'unproved', reason: 'nonperiodic-coordinate' });
  });

  it('扱わない関数・通約できない周波数・定数だけの曲線は、理由を付けて未証明', () => {
    expect(prove(['tan(T)', '0', '0'], '0', 'pi', [0, Math.PI])).toEqual({ status: 'unproved', reason: 'nonperiodic-coordinate' });
    expect(prove(['abs(sin(T))', '0', '0'], '0', 'pi', [0, Math.PI])).toEqual({ status: 'unproved', reason: 'nonperiodic-coordinate' });
    expect(prove(['cos(T)+cos(pi*T)', '0', '0'], '0', '2*pi', [0, TWO_PI])).toEqual({ status: 'unproved', reason: 'incommensurate' });
    expect(prove(['1', '2', '3'], '0', '2*pi', [0, TWO_PI])).toEqual({ status: 'unproved', reason: 'no-frequency' });
  });

  it('実際に描く範囲と食い違う古い原式や、T を含む範囲の原式は証明に使わない', () => {
    expect(prove(['cos(T)', 'sin(T)', '0'], '0', '2*pi', [0, 7])).toEqual({ status: 'unproved', reason: 'range-mismatch' });
    expect(functionCurvePeriodicity({ outputs: [output('cos(T)'), output('sin(T)'), output('0')], lower: output('0'), upper: output('T'),
      lowerValue: 0, upperValue: TWO_PI, coefficients })).toEqual({ status: 'unproved', reason: 'unsupported-expression' });
  });
});
