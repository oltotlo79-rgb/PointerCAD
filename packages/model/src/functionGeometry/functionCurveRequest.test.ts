import { beforeAll, describe, expect, it } from 'vitest';
import { createFunctionMathSource, createMathBackend, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { FunctionPlotBounds } from './functionPlotBounds.js';
import { functionCurveRequest, type ExplicitFunctionCurveFormula } from './functionCurveRequest.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'coefficient:1', label: 'w', decimal: '2' }];
const context = () => ({ identity: { documentId: 'curve-request', documentVersion: 1, editorId: 'function', inputRevision: 1 }, coefficients });
const curve = (source: string) => createFunctionMathSource(source, 'text', 'radian', { axes: [], parameters: ['T'], coefficients }, backend);
const closed = (source: string, scope = coefficients) =>
  createFunctionMathSource(source, 'text', 'radian', { axes: [], parameters: [], coefficients: scope }, backend);
function ranges(): ResolvedFunctionRanges {
  const checked = FunctionPlotBounds.read({ X: { min: -2, max: 2 }, Y: { min: -2, max: 2 }, Z: { min: -2, max: 2 } });
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  return { bounds: checked.bounds, tolerance: 0.01, parameters: [{ parameter: 'T', range: { min: 0, max: 2 * Math.PI } }], fixedCoordinate: null };
}
function loop(lower = closed('0'), upper = closed('2*pi')): ExplicitFunctionCurveFormula {
  return { kind: 'parametric-curve', outputs: { X: curve('cos(T)'), Y: curve('sin(T)'), Z: curve('0') },
    T: { min: { source: lower.source, value: 0, display: '0', mathDefinition: lower },
      max: { source: upper.source, value: 2 * Math.PI, display: '6.28318530718', mathDefinition: upper } } };
}

describe('媒介変数曲線の依頼は、求められた時だけ T の範囲の原式を付ける', () => {
  it('既定では従来と同じ項目のまま（点の依頼が広げても厳密な復号を壊さない）', () => {
    const request = functionCurveRequest(loop(), ranges(), context());
    expect(request).not.toHaveProperty('parameterSources');
    expect(Object.keys(request).sort()).toEqual(['coefficients', 'identity', 'independent', 'lower', 'maximum', 'minimum', 'outputs', 'tolerance', 'upper']);
  });

  it('periodicIntent では、保存された T.min・T.max の原式そのものを凍結して付ける', () => {
    const lower = closed('0'), upper = closed('2*pi');
    const request = functionCurveRequest(loop(lower, upper), ranges(), context(), { periodicIntent: true });
    expect(request.parameterSources?.lower.expression).toEqual(lower.expression);
    expect(request.parameterSources?.upper.expression).toEqual(upper.expression);
    expect(Object.isFrozen(request.parameterSources?.upper.expression)).toBe(true);
    expect(request.lower).toBe(0); expect(request.upper).toBe(2 * Math.PI);
  });

  it('原式が無い・依頼に無い係数を使う範囲には付けず、失敗にもしない', () => {
    const numeric = loop();
    const withoutSource: ExplicitFunctionCurveFormula = numeric.kind === 'parametric-curve'
      ? { ...numeric, T: { min: { source: '0', value: 0, display: '0' }, max: numeric.T.max } } : numeric;
    expect(functionCurveRequest(withoutSource, ranges(), context(), { periodicIntent: true })).not.toHaveProperty('parameterSources');
    const foreign = closed('2*pi*coef("k")', [{ id: 'coefficient:9', label: 'k', decimal: '1' }]);
    expect(functionCurveRequest(loop(closed('0'), foreign), ranges(), context(), { periodicIntent: true })).not.toHaveProperty('parameterSources');
  });

  it('座標曲線は T の範囲を持たないので、求められても付けない', () => {
    const coordinate: ExplicitFunctionCurveFormula = { kind: 'coordinate-curve', independent: 'X',
      outputs: { Y: createFunctionMathSource('X^2', 'text', 'radian', { axes: ['X'], parameters: [], coefficients }, backend), Z: closed('0') } };
    const checked = ranges();
    expect(functionCurveRequest(coordinate, checked, context(), { periodicIntent: true })).not.toHaveProperty('parameterSources');
  });
});
