import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber as number, type ExpressionValue } from '@pointercad/expression';
import { createFunctionMathSource, createMathBackend, executeExactMathWorkRequest, executeMathWorkRequest,
  type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { createFunctionCurveEvaluator } from '@pointercad/expression/math/geometry';
import { decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import type { MathWorkRequest } from '@pointercad/expression/math/client';
import { exactRuntimeBatch, sharedExactEngine } from '../../../expression/src/math/exactRuntimeTestSupport.js';
import { sameMathMeaning } from '../../../expression/src/math/mathNotationConversion.js';
import { evaluateMathGeometry } from '../measure/mathGeometry.js';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId } from '../measure/mathGeometryIdentity.js';
import type { MathGeometryDefinition, MathGeometryOutcome } from '../measure/mathGeometryTypes.js';
import { mathGeometryOperationMessage } from '../measure/mathGeometryCoefficients.js';
import { analyzeMathGeometryDependencies } from '../measure/mathGeometryDependencies.js';
import { FUNCTION_DEFINITION_FORMAT } from '../functionGeometry/functionDefinitionTypes.js';
import { resolveFunctionInputs } from '../functionGeometry/resolveFunctionInputs.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type { SketchLineFeature } from '../sketch/types.js';
import { createEmptyPartDocument } from './createPartDocument.js';
import { evaluateDocumentMath, type DocumentMathContext } from './evaluateDocumentMath.js';
import { resolvePart } from './resolvePart.js';
import type { PartDocument } from './types.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const script = fileURLToPath(new URL('../../../expression/src/math/exactRuntime/cas_region_integrals_test.py', import.meta.url));
const engine = sharedExactEngine(exactRuntimeBatch(script, 15_000));
const measuredInput = { id: mathGeometryCoefficientId('length'), label: 'G', decimal: '999' };
const coefficients = [measuredInput, { id: 'coefficient:1', label: 'R', decimal: '999' },
  { id: 'coefficient:2', label: 'P', decimal: '999' }];
const identity = { documentId: 'part-1', documentVersion: 1, editorId: 'integrals', inputRevision: 1 };
function decoded(raw: unknown, request: MathWorkRequest) {
  return decodeMathWorkReply(raw, request, { operationsById: backend.operationsById,
    coefficientIds: new Set(request.coefficients.map(item => item.id)), declaredIds: new Set() }).result;
}
function formula(source: string, angleUnit: 'degree' | 'radian' = 'degree'): ExpressionValue {
  const request: MathWorkRequest = { identity, source, angleUnit, coefficients, notation: 'text' };
  const result = decoded(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request);
  if (result.definition === null) throw new Error(JSON.stringify(result.evaluation));
  return { source, value: 999, display: '999', mathDefinition: result.definition };
}
function documentFor(source: string, length = 10, angleUnit: 'degree' | 'radian' = 'degree'): PartDocument {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  const line: SketchLineFeature = { id: 'measured-line', name: 'measured-line', kind: 'line', planeId: FREE_WORK_PLANE_ID,
    construction: false, from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(length, 0, 0) };
  const definition: MathGeometryDefinition = { id: 'length', name: 'G', documentId: document.id,
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE, quantity: { kind: 'length', curve: {
      kind: 'sketch-curve', sketchId: sketch.id, featureId: line.id } } };
  const point = createPointFeature(sketch, { ...absoluteCoordinate(0, 0, 0), x: formula('coef("P")+1') });
  return { ...document, mathGeometry: [definition], sketches: [{ ...sketch, features: [line] },
    { id: 'integral-user-sketch', name: 'integral-user-sketch', features: [point] }], parameters: [
    { name: 'R', mathId: 'coefficient:1', value: formula('coef("G")'), unit: 'mm', description: '' },
    { name: 'P', mathId: 'coefficient:2', value: formula(source, angleUnit), unit: 'mm', description: '' },
  ] };
}
async function measure(document: PartDocument): Promise<ReadonlyMap<string, MathGeometryOutcome>> {
  // Resolve and measure the actual sketch line. The point using P is deliberately not a measurement input.
  const measurementDocument = { ...document, parameters: [], sketches: document.sketches.map(sketch => ({
    ...sketch, features: sketch.features.filter(feature => feature.kind === 'line'),
  })) };
  const outcomes = await evaluateMathGeometry(document.mathGeometry ?? [], {
    documentId: document.id, generation: 1, resolved: resolvePart(measurementDocument), bodies: [], failedIds: new Set(),
    bridge: { measure: () => { throw new Error('A sketch length must not require a solid measurement'); } }, shouldCancel: () => false,
  });
  if (outcomes === null) throw new Error('Measurement cancelled');
  return new Map(outcomes.map(outcome => [outcome.id, outcome]));
}
function channel(document: PartDocument, geometry: ReadonlyMap<string, MathGeometryOutcome>, requests: MathWorkRequest[] = []): DocumentMathContext {
  return { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true, geometry, client: {
    evaluate: async request => {
      requests.push(request);
      const raw = await executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, { backend, engine, shouldStop: () => undefined });
      return { status: 'result', identity: request.identity, result: decoded(raw, request) };
    },
  } };
}
function pointX(document: PartDocument): number {
  const point = document.sketches.flatMap(sketch => sketch.features).find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('Expected an absolute point');
  return point.at.x.value;
}
const examples = [
  ['lineintegral(coef("R"),[x],[t],t,0,1)', 1],
  ['lineintegral(1,[x],[coef("R")*t],t,0,1)', 1],
  ['lineintegral(1,[x],[t],t,coef("R"),2*coef("R"))', 1],
  ['lineintegral(coef("R")*R,[R],[t],t,0,1)', 0.5],
  ['surfaceintegral(coef("R"),[x,y,z],[u,v,0],[u,v],[0,0],[1,1])', 1],
  ['surfaceintegral(1,[x,y,z],[coef("R")*u,v,0],[u,v],[0,0],[1,1])', 1],
  ['surfaceintegral(1,[x,y,z],[u,v,0],[u,v],[coef("R"),0],[2*coef("R"),1])', 1],
  ['circulation([coef("R"),0],[x,y],[t,0],t,1,0)', -1],
  ['fluxintegral([0,0,coef("R")],[x,y,z],[u,v,0],[u,v],[1,0],[0,1])', -1],
  ['volumeintegral(1,[x,y,z],[coef("R")*u,v,w],[u,v,w],[0,0,0],[1,1,1])', 1],
  ['lineintegral(coef("G"),[x],[t],t,0,1)', 1],
] as const;

describe('測った10mmを既存の積分へ渡す実計算', () => {
  it('量・座標式・両端点を別々に変更し、10→20mmで係数と点が追従し、保存原式を保持する', async () => {
    const cases = [10, 20].flatMap(length => examples.map(([source, factor]) => ({ source, length, expected: length * factor })));
    await Promise.all(cases.map(async ({ source, length, expected }) => {
      const document = documentFor(source, length), before = JSON.stringify(document), geometry = await measure(document), requests: MathWorkRequest[] = [];
      expect(geometry.get('length')).toMatchObject({ status: 'value', kind: 'real', value: length, unit: 'mm', representation: 'geometry-double' });
      const result = await evaluateDocumentMath(document, channel(document, geometry, requests));
      if (!result.ok) throw new Error(`${source}: ${JSON.stringify(result.failures)}`);
      expect(result.document.parameters[1].value.value, source).toBe(expected);
      expect(pointX(result.document), source).toBe(expected + 1);
      expect(result.analysis.geometryDerived).toEqual(new Map([['R', ['length']], ['P', ['length']]]));
      for (const name of ['R', 'P']) expect(result.analysis.mathCoefficients?.get(name)).not.toHaveProperty('exactExpression');
      for (const request of requests) for (const coefficient of request.coefficients) expect(coefficient).not.toHaveProperty('exactExpression');
      expect(result.document.parameters[1].value.mathDefinition).toEqual(document.parameters[1].value.mathDefinition);
      expect(JSON.stringify(document)).toBe(before);
    }));
  }, 90_000);

  it('保存した積分の通常入力と構造入力を実計算部で往復し、同名の変数・係数・角度単位を保つ', async () => {
    await Promise.all(([
      ['lineintegral(coef("R")*R,[R],[t],t,0,1)', 'degree', 5],
      ['surfaceintegral(coef("R")*u,[u,y,z],[u,v,0],[u,v],[0,0],[1,1])', 'degree', 5],
      ['lineintegral(1,[x],[coef("R")*sin(t)],t,0,90)', 'degree', 10],
      ['lineintegral(1,[x],[coef("R")*sin(t)],t,0,pi/2)', 'radian', 10],
    ] as const).map(async ([source, angleUnit, expected]) => {
      const document = documentFor(source, 10, angleUnit), context = channel(document, await measure(document));
      const result = await evaluateDocumentMath(document, context);
      if (!result.ok) throw new Error(JSON.stringify(result.failures));
      expect(result.document.parameters[1].value.value).toBe(expected);
      const stored = result.document.parameters[1].value.mathDefinition;
      if (stored === undefined) throw new Error('Missing saved integral');
      const available = [...(result.analysis.mathCoefficients?.values() ?? [])];
      const textInput: MathWorkRequest = { identity, source: stored.source, notation: 'text', angleUnit, coefficients: available,
        definition: stored, presentationNotation: 'latex' };
      // Conversion and parsing use the same worker path without starting the exact runtime again.
      // The saved text and the freshly parsed structure are each evaluated by the real runtime below.
      const presented = decoded(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: textInput }, backend), textInput);
      if (presented.presentation === undefined || presented.presentation === null) {
        throw new Error('Missing structure presentation');
      }
      const presentation = presented.presentation;
      expect(sameMathMeaning(presentation.expression, stored.expression)).toBe(true);
      const input: MathWorkRequest = { identity, source: presentation.source, notation: 'latex', angleUnit, coefficients: available,
        presentationNotation: 'text' };
      const reply = await context.client.evaluate(input, 5_000);
      if (reply.status !== 'result' || reply.result.definition === null) throw new Error('Missing structure round trip');
      expect(reply.result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
      expect(sameMathMeaning(reply.result.definition.expression, stored.expression)).toBe(true);
      const restored = reply.result.presentation;
      if (restored === undefined || restored === null) throw new Error('Missing text presentation');
      const restoredInput: MathWorkRequest = { ...input, source: restored.source, notation: 'text' };
      const reread = decoded(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: restoredInput }, backend), restoredInput);
      if (reread.definition === null) throw new Error('Missing text round trip');
      expect(sameMathMeaning(reread.definition.expression, stored.expression)).toBe(true);
      expect(reply.result.definition.angleUnit).toBe(angleUnit);
      expect(stored.source).toBe(source);
    }));
  }, 90_000);

  it('積分の答えを通常の係数として関数作図に渡し、保存し直した同じ原式で寸法変更後に描く', async () => {
    await Promise.all([10, 20].map(async length => {
      const original = documentFor('surfaceintegral(1,[x,y,z],[coef("R")*u,v,0],[u,v],[0,0],[1,1])', length);
      const scope = { axes: ['X'] as const, parameters: [], coefficients };
      const parse = (source: string) => createFunctionMathSource(source, 'text', 'degree', scope, backend);
      const bound = { min: number(0), max: number(1) };
      const plot = { format: FUNCTION_DEFINITION_FORMAT, bounds: { X: bound, Y: bound, Z: { min: number(0), max: number(30) } },
        tolerance: number(0.01), formula: { kind: 'coordinate-curve' as const, independent: 'X' as const,
          outputs: { Y: parse('coef("P")*X'), Z: parse('0') } } };
      const document: PartDocument = structuredClone({ ...original, sketches: [...original.sketches, { id: 'plot-sketch', name: 'plot', features: [
        { id: 'plot', name: 'plot', kind: 'functionCurve', planeId: FREE_WORK_PLANE_ID, construction: false, definition: plot },
      ] }] });
      const result = await evaluateDocumentMath(document, channel(document, await measure(document)));
      if (!result.ok) throw new Error(JSON.stringify(result.failures));
      const feature = result.document.sketches.flatMap(sketch => sketch.features).find(feature => feature.id === 'plot');
      if (feature?.kind !== 'functionCurve') throw new Error('Missing evaluated function curve');
      const inputs = await resolveFunctionInputs(result.document, feature.definition, result.analysis, () => true);
      if (inputs.status !== 'ready') throw new Error('Function inputs not ready');
      expect(inputs.coefficients).toEqual([{ id: 'coefficient:2', label: 'P', decimal: String(length) }]);
      const curve = createFunctionCurveEvaluator([parse('X'), plot.formula.outputs.Y, plot.formula.outputs.Z], 'X', inputs.coefficients,
        { backend, shouldStop: () => undefined });
      expect(curve.point(0.5)).toEqual([0.5, length / 2, 0]);
    }));
  }, 90_000);

  it('原式の穴・発散・不成立を0倍で隠さず、係数と利用先の点を無効にする', async () => {
    await Promise.all([
      '0*lineintegral(coef("R")/x,[x],[t],t,-1,1)',
      'lineintegral(1,[x],[coef("R")*t/t],t,0,1)',
      'surfaceintegral(0*coef("R")/z,[x,y,z],[u,v,0],[u,v],[0,0],[1,1])',
      'surfaceintegral(1,[x,y,z],[coef("R")*u/u,v,0],[u,v],[0,0],[1,1])',
    ].map(async source => {
      const document = documentFor(source), result = await evaluateDocumentMath(document, channel(document, await measure(document)));
      expect(result.ok, source).toBe(false);
      if (result.ok) throw new Error('Invalid integral accepted');
      expect(result.failures.some(failure => failure.ownerId === 'P')).toBe(true);
      expect(result.recompute?.analysis.variables.has('P')).toBe(false);
      expect(result.recompute?.invalidInputs.size).toBeGreaterThan(0);
    }));
  }, 90_000);

  it('不連続演算・測定参照切れ・待機・循環は古い999を使わず理由付きで拒否する', async () => {
    const document = documentFor('lineintegral(1,[x],[t],t,0,floor(coef("R")))'), requests: MathWorkRequest[] = [];
    const refused = await evaluateDocumentMath(document, channel(document, await measure(document), requests));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('Discontinuous integral accepted');
    expect(refused.failures.find(failure => failure.ownerId === 'P')?.message).toBe(mathGeometryOperationMessage('floor'));
    expect(requests.some(request => request.source.includes('lineintegral'))).toBe(false);
    const valid = documentFor(examples[0][0]);
    const missing = { ...valid, mathGeometry: [] };
    for (const candidate of [valid, missing]) {
      const result = await evaluateDocumentMath(candidate, channel(candidate, new Map()));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Unmeasured integral accepted');
      expect(result.recompute?.analysis.variables.has('P')).toBe(false);
    }
    const cycle = { ...valid, parameters: valid.parameters.map(parameter => parameter.name === 'R'
      ? { ...parameter, value: formula('coef("P")+coef("G")') } : parameter) };
    const cycleRequests: MathWorkRequest[] = [];
    const result = await evaluateDocumentMath(cycle, channel(cycle, await measure(cycle), cycleRequests));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Cycle accepted');
    expect(new Set(result.recompute?.analysis.circular)).toEqual(new Set(['R', 'P']));
    expect(result.failures.find(failure => failure.ownerId === 'P')?.message).toBe('係数の参照が循環しています。');
    expect(result.recompute?.analysis.variables.has('P')).toBe(false);
    expect(cycleRequests).toHaveLength(0);

    // A cycle through the measured shape is a separate dependency graph. Feed the integral back
    // into its source line and pass that graph's refusal to the normal document evaluation entry.
    const geometryCycle: PartDocument = { ...valid, sketches: valid.sketches.map(sketch => ({ ...sketch,
      features: sketch.features.map(feature => feature.kind === 'line'
        ? { ...feature, to: { ...absoluteCoordinate(0, 0, 0), x: formula('coef("P")') } } : feature),
    })) };
    const dependencies = analyzeMathGeometryDependencies(geometryCycle);
    expect(dependencies.cycles.length).toBeGreaterThan(0);
    expect(dependencies.cycles[0]).toMatchObject({ definitionIds: ['length'], coefficientNames: ['P'], shapeIds: [valid.sketches[0].id] });
    const geometryRequests: MathWorkRequest[] = [];
    const blocked = await evaluateDocumentMath(geometryCycle,
      { ...channel(geometryCycle, await measure(valid), geometryRequests), blocked: dependencies.blocked });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('Geometry cycle accepted');
    expect(blocked.failures.find(failure => failure.ownerId === 'P')?.message).toBe(dependencies.blocked.get('P'));
    expect(blocked.recompute?.analysis.variables.has('P')).toBe(false);
    expect(blocked.recompute?.invalidInputs.size).toBeGreaterThan(0);
    expect(geometryRequests).toHaveLength(0);
  });
});
