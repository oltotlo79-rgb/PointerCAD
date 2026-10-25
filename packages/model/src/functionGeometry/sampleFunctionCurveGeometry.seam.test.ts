import { beforeAll, describe, expect, it } from 'vitest';
import { createFunctionMathSource, createMathBackend, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import type { FunctionCurveWorkRequest } from '@pointercad/expression/math/contracts';
import { FunctionPlotBounds } from './functionPlotBounds.js';
import { sampleFunctionCurveGeometry } from './sampleFunctionCurveGeometry.js';
import type { FunctionFormula } from './functionDefinitionTypes.js';
import type { FunctionRecomputeContext } from './recomputeFunctionCurves.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'coefficient:1', label: 'w', decimal: '1' }];
const context = { identity: { documentId: 'seam-route', documentVersion: 1, editorId: 'function', inputRevision: 1 }, coefficients };
const inT = (source: string) => createFunctionMathSource(source, 'text', 'radian', { axes: [], parameters: ['T'], coefficients }, backend);
const inX = (source: string) => createFunctionMathSource(source, 'text', 'radian', { axes: ['X'], parameters: [], coefficients }, backend);
const closed = (source: string) => createFunctionMathSource(source, 'text', 'radian', { axes: [], parameters: [], coefficients }, backend);
function ranges(parameters: ResolvedFunctionRanges['parameters']): ResolvedFunctionRanges {
  const checked = FunctionPlotBounds.read({ X: { min: -2, max: 2 }, Y: { min: -2, max: 2 }, Z: { min: -2, max: 2 } });
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  return { bounds: checked.bounds, tolerance: 0.001, parameters, fixedCoordinate: null };
}
/** A curve client that only records what the actual geometry route sends; nothing is computed here. */
function recordingClients(sent: FunctionCurveWorkRequest[]): FunctionRecomputeContext {
  return { curves: { evaluate: (request: FunctionCurveWorkRequest) => {
    sent.push(request);
    return Promise.resolve({ status: 'cancelled' as const, identity: request.identity });
  } } };
}

describe('実際の作図の道は、媒介変数曲線の T の範囲の原式を周期の判定のために送る', () => {
  it('円の定義は T.min・T.max の保存された原式をそのまま送り、取消なら形を作らない', async () => {
    const lower = closed('0'), upper = closed('2*pi'), sent: FunctionCurveWorkRequest[] = [];
    const formula: FunctionFormula = { kind: 'parametric-curve', outputs: { X: inT('cos(T)'), Y: inT('sin(T)'), Z: inT('0') },
      T: { min: { source: '0', value: 0, display: '0', mathDefinition: lower },
        max: { source: '2*pi', value: 2 * Math.PI, display: '6.28318530718', mathDefinition: upper } } };
    const result = await sampleFunctionCurveGeometry('loop', formula, ranges([{ parameter: 'T', range: { min: 0, max: 2 * Math.PI } }]),
      context, recordingClients(sent), undefined, () => true);
    expect(result).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].parameterSources?.lower.expression).toEqual(lower.expression);
    expect(sent[0].parameterSources?.upper.expression).toEqual(upper.expression);
    expect(sent[0].lower).toBe(0); expect(sent[0].upper).toBe(2 * Math.PI);
  });

  it('原式の無い範囲と座標曲線は、従来どおり原式を送らない', async () => {
    const sent: FunctionCurveWorkRequest[] = [];
    const numeric: FunctionFormula = { kind: 'parametric-curve', outputs: { X: inT('cos(T)'), Y: inT('sin(T)'), Z: inT('0') },
      T: { min: { source: '0', value: 0, display: '0' }, max: { source: '6.28', value: 6.28, display: '6.28' } } };
    await sampleFunctionCurveGeometry('numeric', numeric, ranges([{ parameter: 'T', range: { min: 0, max: 6.28 } }]),
      context, recordingClients(sent), undefined, () => true);
    const coordinate: FunctionFormula = { kind: 'coordinate-curve', independent: 'X', outputs: { Y: inX('X^2'), Z: closed('0') } };
    await sampleFunctionCurveGeometry('graph', coordinate, ranges([]), context, recordingClients(sent), undefined, () => true);
    expect(sent).toHaveLength(2);
    for (const request of sent) expect(request).not.toHaveProperty('parameterSources');
  });
});
