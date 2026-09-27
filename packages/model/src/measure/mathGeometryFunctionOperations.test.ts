/**
 * GR-06b (`scratchpad/claude/plans/geomref-plan.md` §4(e)「関数作図の式」, §5.2 GR-06b; the lead's decision of
 * 2026-09-24): a function-plot formula may use a geometry-derived coefficient, but never as an operand of an operation
 * whose result jumps at a value boundary. The implicit `=` that defines a curve or surface is not refused. Every formula
 * is parsed by the real math engine, and the recompute paths run the real function workers (and OCCT for sketch curves).
 *
 * R is geometry-derived (its formula is `coef("G")`, G the measured length of a 2 mm sketch line); A (2.5) is not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber as number, mathScalarExpression, type ExpressionValue, type StoredMathExpression,
} from '@pointercad/expression';
import {
  createFunctionMathSource, createMathBackend, executeCurvePointContinuationWork, executeFunctionCurveWorkRequest,
  executeFunctionImplicitCurveWorkRequest, executeFunctionImplicitWorkRequest, executeFunctionPointContinuationWork,
  executeFunctionSurfaceWorkRequest, executeMathWorkRequest, executeSurfacePointContinuationWork, type MathExecutionBackend,
} from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeFunctionImplicitWorkReply, decodeMathWorkReply, isCurvePointContinuation,
  isSurfacePointContinuation } from '@pointercad/expression/math/contracts';
import type { MathWorkRequest } from '@pointercad/expression/math/client';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { FUNCTION_DEFINITION_FORMAT, type FunctionDefinition, type FunctionFormula } from '../functionGeometry/functionDefinitionTypes.js';
import { readFunctionPointChoice, type FunctionPointReference } from '../functionGeometry/functionPointReference.js';
import { createFunctionSurface, type FunctionSurfaceFeature } from '../functionGeometry/functionSurfaceFeature.js';
import { recomputeFunctionCurves, type FunctionRecomputeContext } from '../functionGeometry/recomputeFunctionCurves.js';
import { recomputeFunctionPoints } from '../functionGeometry/recomputeFunctionPoints.js';
import { recomputeFunctionSurfaces } from '../functionGeometry/recomputeFunctionSurfaces.js';
import { IMPLICIT_EQUATION_EQUALS_MESSAGE, resolveFunctionInputs } from '../functionGeometry/resolveFunctionInputs.js';
import type { Parameter } from '../parameters/types.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { evaluateDocumentMath, type DocumentMathContext } from '../part/evaluateDocumentMath.js';
import { recomputePart } from '../part/recomputePart.js';
import type { PartDocument } from '../part/types.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { sampleSpline } from '../sketch/splineMath.js';
import type { ResolvedCurve, ResolvedSpline, SketchFeature, SketchFunctionCurveFeature, SketchLineFeature } from '../sketch/types.js';
import { mathGeometryOperationMessage, mathGeometryOutsideCoefficientMessage } from './mathGeometryCoefficients.js';
import { checkGeometryDerivedFunctionOperations, functionFormulaExpressions, mathGeometryDerivedCoefficientIds,
} from './mathGeometryFunctionOperations.js';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId } from './mathGeometryIdentity.js';
import type { MathGeometryDefinition, MathGeometryOutcome } from './mathGeometryTypes.js';

const createBridge = () => createDirectKernelBridge(createKernelApi(loadOcctForNode));
let backend: MathExecutionBackend, bridge: ReturnType<typeof createBridge>;
beforeAll(async () => {
  backend = createMathBackend(); await loadOcctForNode(); bridge = createBridge();
}, 180_000);
afterAll(() => { bridge.dispose(); });

const EMPTY = createEmptyPartDocument();
const DOCUMENT_ID = EMPTY.id, MEASURED_SKETCH_ID = 'sketch-measured';
const R_ID = 'coefficient:1', A_ID = 'coefficient:2', G_ID = 'g1';
const DERIVED: ReadonlySet<string> = new Set([R_ID]);
/** What the coefficient editor offers for the measured value G while R's formula is typed (value irrelevant). */
const G_INPUT = { id: mathGeometryCoefficientId(G_ID), label: 'G', decimal: '1' };
const identity = { documentId: DOCUMENT_ID, documentVersion: 1, editorId: 'test', inputRevision: 1 };

function calculate(request: MathWorkRequest) {
  const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result;
}
/** A saved scalar formula with its accepted value, produced by the real engine exactly as an editor would. */
function scalar(source: string, coefficients: MathWorkRequest['coefficients']): ExpressionValue {
  const result = mathScalarExpression(calculate({ identity, source, notation: 'text', angleUnit: 'degree', coefficients }));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
/** A plot formula parsed by the real engine in the plot's own variable scope, with R and A available as coefficients. */
function parse(source: string, axes: readonly ('X' | 'Y' | 'Z')[], parameters: readonly ('T' | 'U' | 'V')[] = []): StoredMathExpression {
  return createFunctionMathSource(source, 'text', 'radian',
    { axes, parameters, coefficients: [{ id: R_ID, label: 'R' }, { id: A_ID, label: 'A' }] }, backend);
}
type Form = 'curve' | 'implicit-curve' | 'surface' | 'implicit-surface' | 'parametric-curve';
function formulaOf(form: Form, source: string): FunctionFormula {
  switch (form) {
    case 'curve': return { kind: 'coordinate-curve', independent: 'X', outputs: { Y: parse(source, ['X']), Z: parse('0', ['X']) } };
    case 'implicit-curve': return { kind: 'implicit-curve', expression: parse(source, ['X', 'Y']), fixedAxis: 'Z', fixedCoordinate: number(0) };
    case 'surface': return { kind: 'coordinate-surface', output: 'Z', expression: parse(source, ['X', 'Y']) };
    case 'implicit-surface': return { kind: 'implicit-surface', expression: parse(source, ['X', 'Y', 'Z']) };
    case 'parametric-curve': return { kind: 'parametric-curve', T: { min: number(0), max: number(1) },
      outputs: { X: parse('T', [], ['T']), Y: parse('2*T', [], ['T']), Z: parse(source, [], ['T']) } };
  }
}
const BOUNDS = { X: { min: number(-4), max: number(4) }, Y: { min: number(-4), max: number(4) }, Z: { min: number(-4), max: number(4) } };
function plot(formula: FunctionFormula, tolerance = 0.05): FunctionDefinition {
  return { format: FUNCTION_DEFINITION_FORMAT, bounds: BOUNDS, tolerance: number(tolerance), formula };
}
function curveFeature(id: string, formula: FunctionFormula, tolerance?: number): SketchFunctionCurveFeature {
  return { id, name: id, kind: 'functionCurve', planeId: FREE_WORK_PLANE_ID, construction: false, definition: plot(formula, tolerance) };
}
function surfaceFeature(id: string, formula: FunctionFormula): FunctionSurfaceFeature {
  return { ...createFunctionSurface(EMPTY, plot(formula)), id, name: id };
}
/** G measures this 2 mm line, so a stage recomputation that measures G for real gets the same R = 2 as the tests pass. */
const MEASURED_LINE: SketchLineFeature = { id: 'measured-line', name: '測る線', kind: 'line', planeId: FREE_WORK_PLANE_ID,
  construction: false, from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(2, 0, 0) };
const G_DEFINITION: MathGeometryDefinition = { id: G_ID, documentId: DOCUMENT_ID, name: 'G', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE,
  quantity: { kind: 'length', curve: { kind: 'sketch-curve', sketchId: MEASURED_SKETCH_ID, featureId: MEASURED_LINE.id } } };
const MEASURED: ReadonlyMap<string, MathGeometryOutcome> = new Map<string, MathGeometryOutcome>([[G_ID, { id: G_ID,
  documentId: DOCUMENT_ID, generation: 1, status: 'value', kind: 'real', value: 2, unit: 'mm', representation: 'geometry-double',
  tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }]]);
function coefficients(): readonly Parameter[] {
  return [{ name: 'R', mathId: R_ID, unit: 'mm', description: '', value: scalar('coef("G")', [G_INPUT]) },
    { name: 'A', mathId: A_ID, unit: 'none', description: '', value: number(2.5) }];
}
function part(features: readonly SketchFeature[], solids: readonly FunctionSurfaceFeature[] = []): PartDocument {
  const sketch = EMPTY.sketches[0];
  return { ...EMPTY, parameters: coefficients(), mathGeometry: [G_DEFINITION],
    sketches: [{ ...sketch, features }, { id: MEASURED_SKETCH_ID, name: '測るスケッチ', features: [MEASURED_LINE] }], solids };
}
function mathContext(document: PartDocument, geometry?: ReadonlyMap<string, MathGeometryOutcome>): DocumentMathContext {
  return { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity, result: calculate(request) }) },
    ...(geometry === undefined ? {} : { geometry }) };
}
/** `evaluateDocumentMath` as the recomputation runs it; a partial result (a pending R) is used like `recomputePart` does. */
async function evaluate(document: PartDocument, geometry?: ReadonlyMap<string, MathGeometryOutcome>) {
  const context = mathContext(document, geometry), result = await evaluateDocumentMath(document, context);
  if (result.ok) return { context, document: result.document, analysis: result.analysis, invalidInputs: new Map<string, string>() };
  if (result.cancelled || result.recompute === undefined) throw new Error(JSON.stringify(result.failures));
  return { context, document: result.recompute.document, analysis: result.recompute.analysis, invalidInputs: result.recompute.invalidInputs };
}
/** The real function workers, counting how often each one is asked to sample. */
function workers() {
  const calls = { curves: 0, implicitCurves: 0, surfaces: 0, implicitSurfaces: 0, points: 0 };
  const functions: FunctionRecomputeContext = {
    curves: { evaluate: request => { calls.curves += 1; return Promise.resolve({ status: 'result', identity: request.identity,
      result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result }); } },
    implicitCurves: { evaluate: request => { calls.implicitCurves += 1; return Promise.resolve({ status: 'result', identity: request.identity,
      result: executeFunctionImplicitCurveWorkRequest({ kind: 'sample-function-implicit-curve', serial: 1, request }, backend).result }); } },
    surfaces: { evaluate: request => { calls.surfaces += 1; return Promise.resolve({ status: 'result', identity: request.identity,
      result: executeFunctionSurfaceWorkRequest({ kind: 'sample-function-surface', serial: 1, request }, backend).result }); } },
    implicitSurfaces: { evaluate: request => { calls.implicitSurfaces += 1; return Promise.resolve({ status: 'result',
      identity: request.identity, result: decodeFunctionImplicitWorkReply(executeFunctionImplicitWorkRequest(
        { kind: 'sample-function-implicit-surface', serial: 1, request }, backend), request).result }); } },
    points: { evaluate: request => { calls.points += 1; return Promise.resolve({ status: 'result', identity: request.identity,
      result: isSurfacePointContinuation(request)
        ? executeSurfacePointContinuationWork({ kind: 'continue-surface-point', serial: 1, request }, backend).result
        : isCurvePointContinuation(request)
          ? executeCurvePointContinuationWork({ kind: 'continue-curve-point', serial: 1, request }, backend).result
          : executeFunctionPointContinuationWork({ kind: 'continue-function-point', serial: 1, request }, backend).result }); } },
  };
  return { functions, calls };
}
function functionCurve(document: PartDocument, id: string): SketchFunctionCurveFeature {
  const feature = document.sketches[0].features.find(item => item.id === id);
  if (feature?.kind !== 'functionCurve') throw new Error(`Expected the function curve ${id}`);
  return feature;
}
function samplesOf(curves: readonly ResolvedCurve[] | undefined) {
  const splines = (curves ?? []).filter((curve): curve is ResolvedSpline => curve.kind === 'spline');
  expect(splines.length).toBeGreaterThan(0);
  return splines.flatMap(spline => sampleSpline(spline, 16));
}
const operationMessage = (name: string) => mathGeometryOperationMessage(name);

describe('関数作図の式の一覧と、図形由来の係数の識別番号', () => {
  it('式の一覧は画面の一覧と同じく、陰関数・座標曲面は1つ、座標曲線は独立軸以外、媒介変数は X・Y・Z の順で、範囲の欄を含まない', () => {
    const [first, second, third] = ['1', '2', '3'].map(source => parse(source, ['X']));
    const cases: readonly (readonly [FunctionFormula, readonly StoredMathExpression[]])[] = [
      [{ kind: 'coordinate-curve', independent: 'X', outputs: { Y: first, Z: second } }, [first, second]],
      [{ kind: 'coordinate-curve', independent: 'Y', outputs: { X: first, Z: second } }, [first, second]],
      [{ kind: 'coordinate-curve', independent: 'Z', outputs: { X: first, Y: second } }, [first, second]],
      [{ kind: 'parametric-curve', T: { min: number(0), max: number(1) }, outputs: { X: first, Y: second, Z: third } }, [first, second, third]],
      [{ kind: 'parametric-surface', U: { min: number(0), max: number(1) }, V: { min: number(0), max: number(1) },
        outputs: { X: first, Y: second, Z: third } }, [first, second, third]],
      [{ kind: 'implicit-curve', expression: first, fixedAxis: 'Z', fixedCoordinate: number(0) }, [first]],
      [{ kind: 'implicit-surface', expression: first }, [first]],
      [{ kind: 'coordinate-surface', output: 'Y', expression: first }, [first]],
    ];
    for (const [formula, expected] of cases) {
      const listed = functionFormulaExpressions(plot(formula));
      expect(listed, formula.kind).toHaveLength(expected.length);
      expected.forEach((expression, index) => { expect(listed[index], `${formula.kind} ${index}`).toBe(expression); });
    }
  });

  it('図形由来の係数の名前から数式の識別番号を求め、識別番号の無い旧式の係数と図形由来でない係数は含めない', () => {
    const parameters: readonly Parameter[] = [
      { name: 'R', mathId: R_ID, unit: 'mm', description: '', value: number(2) },
      { name: 'A', mathId: A_ID, unit: 'none', description: '', value: number(2.5) },
      { name: 'L', unit: 'mm', description: '', value: number(4) },
    ];
    expect(mathGeometryDerivedCoefficientIds(parameters, new Map([['R', ['g1']], ['L', ['g1']]]))).toEqual(new Set([R_ID]));
    expect(mathGeometryDerivedCoefficientIds(parameters, undefined).size).toBe(0);
    expect(mathGeometryDerivedCoefficientIds(parameters, new Map()).size).toBe(0);
  });
});

describe('規則: 演算ごとに、その被演算子が図形由来の係数を読むときだけ断る', () => {
  it('座標曲線 Y = floor(coef("R"))*X は付録Cの「演算」の文で断り、どの式か(Y)も返す', () => {
    expect(checkGeometryDerivedFunctionOperations(plot(formulaOf('curve', 'floor(coef("R"))*X')), DERIVED)).toEqual({
      operation: 'floor', output: 'Y',
      message: '図形の測定値から計算する式では「floor」を使えません。値の境目で結果が変わる計算は使えません。' });
  });

  it.each([
    ['curve', 'X<coef("R")', 'less', 'less', 'Y'],
    ['curve', 'which(X<coef("R"),0,X>=coef("R"),1)', 'which', 'which', 'Y'],
    ['curve', 'sum(X^k,k,1,coef("R"))', 'sum', 'sum', 'Y'],
    ['curve', 'sum(coef("R")*X^k,k,1,3)', 'sum', 'sum', 'Y'],
    ['curve', 'mod(X,coef("R"))', 'mod', 'modulo', 'Y'],
    ['curve', 'gcd(X,coef("R"))', 'gcd', 'gcd', 'Y'],
    ['curve', 'element(coef("R"),{1,2})', 'element', 'element', 'Y'],
    ['curve', 'X=coef("R")', 'equal', 'equal', 'Y'],
    ['implicit-curve', 'X^2+Y^2=floor(coef("R"))^2', 'floor', 'floor', null],
    ['implicit-curve', 'floor(coef("R"))*X^2+Y^2=1', 'floor', 'floor', null],
    ['implicit-curve', 'X^2=coef("R")=Y^2', 'and', 'and', null],
    ['surface', 'round(coef("R"))*X', 'round', 'round', 'Z'],
    ['implicit-surface', 'X^2+Y^2+Z^2=ceil(coef("R"))', 'ceil', 'ceiling', null],
    ['parametric-curve', 'T*floor(coef("R"))', 'floor', 'floor', 'Z'],
  ] as const)('%s の %s は「%s」を理由に断る', (form, source, name, operation, output) => {
    expect(checkGeometryDerivedFunctionOperations(plot(formulaOf(form, source)), DERIVED))
      .toEqual({ operation, message: operationMessage(name), output });
  });

  it.each([
    ['curve', 'floor(X)+coef("R")'],
    ['curve', 'abs(X-coef("R"))+max(X,coef("R"))'],
    ['curve', 'sum(X^k,k,1,3)+coef("R")'],
    ['curve', 'floor(coef("A"))*X+coef("R")'],
    ['implicit-curve', 'X^2+Y^2=coef("R")^2'],
    ['implicit-curve', 'X^2+Y^2-coef("R")^2'],
    ['implicit-surface', 'X^2+Y^2+Z^2=coef("R")^2'],
    ['surface', 'coef("R")*(X+Y)/10'],
    ['parametric-curve', 'coef("R")*T'],
  ] as const)('%s の %s は受理する', (form, source) => {
    expect(checkGeometryDerivedFunctionOperations(plot(formulaOf(form, source)), DERIVED)).toBeNull();
  });

  it('図形由来の係数が無ければ何も調べず、範囲の欄(スカラーの欄)は GR-04 の検査に任せてこの規則では見ない', () => {
    const floor = plot(formulaOf('curve', 'floor(coef("R"))*X'));
    expect(checkGeometryDerivedFunctionOperations(floor, new Set())).toBeNull();
    expect(checkGeometryDerivedFunctionOperations(floor, new Set([A_ID]))).toBeNull();
    const ranged = plot(formulaOf('curve', 'coef("R")*X/4'));
    const bounded = { ...ranged, bounds: { ...BOUNDS, X: { min: number(-4), max: scalar('floor(coef("R"))+3', [{ id: R_ID, label: 'R', decimal: '2' }]) } } };
    expect(checkGeometryDerivedFunctionOperations(bounded, DERIVED)).toBeNull();
  });
});

describe('再計算での拒否(実際の数学計算部・関数の計算部・形の計算部)', () => {
  it.each([['測った値がある', MEASURED], ['まだ測っていない(計算待ち)', undefined]] as const)(
    'resolveFunctionInputs は floor(coef("R")) を値の参照より前に断る(%s)', async (_case, geometry) => {
      const { document, analysis } = await evaluate(part([curveFeature('refused', formulaOf('curve', 'floor(coef("R"))*X'))]), geometry);
      expect(analysis.geometryDerived).toEqual(new Map([['R', [G_ID]]]));
      await expect(resolveFunctionInputs(document, functionCurve(document, 'refused').definition, analysis, () => true))
        .rejects.toThrow(new Error(operationMessage('floor')));
    });

  it.each([['implicit-curve', 'X^2+Y^2-coef("R")^2'], ['curve', 'floor(X)+coef("R")']] as const)(
    'resolveFunctionInputs は %s の %s を受理し、R は小数だけで渡る(exactExpression なし)', async (form, source) => {
      const { document, analysis } = await evaluate(part([curveFeature('accepted', formulaOf(form, source))]), MEASURED);
      const inputs = await resolveFunctionInputs(document, functionCurve(document, 'accepted').definition, analysis, () => true);
      if (inputs.status !== 'ready') throw new Error('Expected resolved inputs');
      expect(inputs.coefficients).toEqual([{ id: R_ID, label: 'R', decimal: '2' }]);
      expect(inputs.coefficients[0]).not.toHaveProperty('exactExpression');
    });

  // rules/06 §10.317 (GR-18b): the plan's own example used "=" at the implicit root
  // (`X^2+Y^2=coef("R")^2`) as something `resolveFunctionInputs` accepts; real computation showed the
  // calculation tape has no `equal` at all, so it failed deep in sampling with an unclear message. The
  // case above now uses the F=0 form (`X^2+Y^2-coef("R")^2`) that is actually drawable; the cases below
  // fix the wrong premise by checking the "=" form is refused early, with a clear reason, instead.
  it.each([['X^2+Y^2=4', undefined], ['X^2+Y^2=coef("R")^2', MEASURED]] as const)(
    'resolveFunctionInputs は陰関数曲線の根の「=」(%s)を、図形由来の係数の有無や測定の有無によらず同じ案内の文で断る',
    async (source, geometry) => {
      const { document, analysis } = await evaluate(part([curveFeature('rooted', formulaOf('implicit-curve', source))]), geometry);
      await expect(resolveFunctionInputs(document, functionCurve(document, 'rooted').definition, analysis, () => true))
        .rejects.toThrow(new Error(IMPLICIT_EQUATION_EQUALS_MESSAGE));
    });

  it('resolveFunctionInputs は陰関数曲面の根の「=」(X^2+Y^2+Z^2=4)も同じ案内の文で断る', async () => {
    const { document, analysis } = await evaluate(part([], [surfaceFeature('rooted', formulaOf('implicit-surface', 'X^2+Y^2+Z^2=4'))]));
    const feature = document.solids.find(item => item.id === 'rooted');
    if (feature?.kind !== 'functionSurface') throw new Error('Expected the surface feature');
    await expect(resolveFunctionInputs(document, feature.definition, analysis, () => true))
      .rejects.toThrow(new Error(IMPLICIT_EQUATION_EQUALS_MESSAGE));
  });

  it('陰関数のF=0のF形(根に「=」が無い)は、根の「=」の検査には引っかからず従来どおり受理する', async () => {
    const { document, analysis } = await evaluate(part([curveFeature('circle', formulaOf('implicit-curve', 'X^2+Y^2-4'))]));
    const inputs = await resolveFunctionInputs(document, functionCurve(document, 'circle').definition, analysis, () => true);
    expect(inputs.status).toBe('ready');
  });

  it('関数曲線: 断る曲線は計算部へ送らず理由を残し、陰関数(F=0の形)の円は測った半径2、図形由来でない係数の floor は従来どおり描く', async () => {
    const { context, document, analysis } = await evaluate(part([
      curveFeature('refused', formulaOf('curve', 'floor(coef("R"))*X')),
      curveFeature('circle', formulaOf('implicit-curve', 'X^2+Y^2-coef("R")^2')),
      curveFeature('line', formulaOf('curve', 'floor(coef("A"))*X/4+coef("R")')),
    ]), MEASURED);
    const { functions, calls } = workers();
    const result = await recomputeFunctionCurves(document, bridge, analysis, context, functions, undefined, () => false);
    expect(result.cancelled).toBe(false);
    expect(Object.fromEntries(result.invalidInputs)).toEqual({ refused: operationMessage('floor') });
    expect(result.curves.has('refused')).toBe(false);
    for (const [x, y, z] of samplesOf(result.curves.get('circle'))) {
      expect(Math.abs(Math.hypot(x, y) - 2)).toBeLessThan(0.05); expect(z).toBeCloseTo(0, 10);
    }
    for (const [x, y, z] of samplesOf(result.curves.get('line'))) {
      expect(Math.abs(y - (x / 2 + 2))).toBeLessThan(1e-6); expect(z).toBeCloseTo(0, 10);
    }
    expect(calls).toMatchObject({ curves: 1, implicitCurves: 1 });
  }, 60_000);

  it('関数曲面: 座標曲面と陰関数曲面の不連続な演算を断り、図形由来の係数の平面と陰関数(F=0の形)の球は描く', async () => {
    const { context, document, analysis } = await evaluate(part([], [
      surfaceFeature('refused-coordinate', formulaOf('surface', 'floor(coef("R"))*X')),
      surfaceFeature('refused-implicit', formulaOf('implicit-surface', 'X^2+Y^2+Z^2-round(coef("R"))')),
      surfaceFeature('plane', formulaOf('surface', 'coef("R")*(X+Y)/10')),
      surfaceFeature('sphere', formulaOf('implicit-surface', 'X^2+Y^2+Z^2-coef("R")^2')),
    ]), MEASURED);
    const { functions, calls } = workers();
    const result = await recomputeFunctionSurfaces(document, analysis, context, functions, new Map(), () => false);
    expect(result.cancelled).toBe(false);
    expect(Object.fromEntries(result.invalidInputs)).toEqual({
      'refused-coordinate': operationMessage('floor'), 'refused-implicit': operationMessage('round') });
    const plane = result.plans.get('plane')?.geometry;
    if (plane === undefined || !('vertices' in plane)) throw new Error('Expected a sampled plane');
    expect(plane.vertices.length).toBeGreaterThan(3);
    for (const [x, y, z] of plane.vertices) expect(Math.abs(z - (x + y) / 5)).toBeLessThan(1e-9);
    const sphere = result.plans.get('sphere')?.geometry;
    if (sphere === undefined) throw new Error('Expected the sphere');
    if ('primitive' in sphere) expect(sphere.primitive).toEqual({ kind: 'sphere', center: [0, 0, 0], radius: 2 });
    else for (const [x, y, z] of sphere.vertices) expect(Math.abs(Math.hypot(x, y, z) - 2)).toBeLessThan(0.05);
    expect(calls).toMatchObject({ surfaces: 1, implicitSurfaces: 1 });
  }, 60_000);

  function circleWithPoint(source: string): PartDocument {
    const sketch = EMPTY.sketches[0], chosenOn = parse('X^2+Y^2-coef("R")^2', ['X', 'Y']);
    const circle = curveFeature('circle', { kind: 'implicit-curve', expression: parse(source, ['X', 'Y']), fixedAxis: 'Z',
      fixedCoordinate: number(0) }, 1e-6);
    // The point was chosen on the valid circle (R = 1 then); only the parent's current formula decides what follows.
    const reference: FunctionPointReference = { kind: 'functionPoint', parent: { kind: 'curve', sketchId: sketch.id, featureId: circle.id },
      known: [{ axis: 'X', value: number(0) }], choice: readFunctionPointChoice({ input: { expression: chosenOn,
        minimum: [-4, -4, -4], maximum: [4, 4, 4], tolerance: 1e-6, coefficients: [{ id: R_ID, label: 'R', decimal: '1' }],
        known: [{ axis: 'X', value: 0 }], fixed: { axis: 'Z', value: 0 } },
      location: { kind: 'implicit', axis: 'Y', interval: { lower: 1, upper: 1 } } }) };
    const point = { ...createPointFeature(sketch, { mode: 'relative', base: reference, dx: number(0), dy: number(0), dz: number(0) }),
      id: 'chosen', planeId: FREE_WORK_PLANE_ID };
    return part([circle, point]);
  }
  async function pointResult(source: string) {
    const { context, document, analysis } = await evaluate(circleWithPoint(source), MEASURED);
    const { functions, calls } = workers();
    const result = await recomputeFunctionPoints(document, analysis, context, functions, new Map(), () => false);
    const point = document.sketches[0].features.find(item => item.id === 'chosen');
    if (point?.kind !== 'point' || point.at.mode !== 'relative' || point.at.base.kind !== 'functionPoint') throw new Error('Missing point');
    return { result, calls, position: result.resolve(point.at.base, point.id) };
  }

  it('関数上の点: 図形由来の係数の陰関数の円上の点は測った半径2へ追従する', async () => {
    const { result, calls, position } = await pointResult('X^2+Y^2-coef("R")^2');
    expect(result.cancelled).toBe(false); expect([...result.invalidInputs]).toEqual([]);
    expect(position?.[0]).toBeCloseTo(0, 9); expect(position?.[1]).toBeCloseTo(2, 9); expect(position?.[2]).toBeCloseTo(0, 9);
    expect(calls.points).toBe(1);
  });

  it('関数上の点: 親の式が floor(coef("R")) を使うと、点の経路でも同じ理由で断り計算部へ送らない', async () => {
    const { result, calls, position } = await pointResult('X^2+Y^2-floor(coef("R"))^2');
    expect(result.cancelled).toBe(false);
    expect(Object.fromEntries(result.invalidInputs)).toEqual({ chosen: operationMessage('floor') });
    expect(position).toBeNull(); expect(calls.points).toBe(0);
  });

  it('文書全体の再計算(開いたファイルと同じ経路)でも断った曲線だけが理由付きで失敗し、測った半径の円は描く', async () => {
    const document = part([curveFeature('refused', formulaOf('curve', 'floor(coef("R"))*X')),
      curveFeature('circle', formulaOf('implicit-curve', 'X^2+Y^2-coef("R")^2'))]);
    const { functions } = workers();
    try {
      const result = await recomputePart(document, bridge, { math: mathContext(document, MEASURED), functions });
      expect(result.cancelled).toBe(false);
      expect(result.errors.map(error => [error.featureId, error.message])).toEqual([['refused', operationMessage('floor')]]);
      const circle = result.sketches[0].resolved.splines.filter(spline => spline.featureId === 'circle');
      for (const [x, y] of samplesOf(circle)) expect(Math.abs(Math.hypot(x, y) - 2)).toBeLessThan(0.05);
    } finally { await bridge.releasePart(document.id); }
  }, 60_000);

  it('関数作図の式から図形の測定値を直接使うと、GR-04 の「係数の式の中でだけ」の理由で断る', async () => {
    const direct = createFunctionMathSource('coef("G")*X', 'text', 'radian',
      { axes: ['X'], parameters: [], coefficients: [{ id: mathGeometryCoefficientId(G_ID), label: 'G' }] }, backend);
    const { document, analysis } = await evaluate(part([curveFeature('direct',
      { kind: 'coordinate-curve', independent: 'X', outputs: { Y: direct, Z: parse('0', ['X']) } })]), MEASURED);
    await expect(resolveFunctionInputs(document, functionCurve(document, 'direct').definition, analysis, () => true))
      .rejects.toThrow(new Error(mathGeometryOutsideCoefficientMessage('G')));
  });

  it('範囲の欄の floor(coef("R")) は GR-04 の数式評価が断る(この規則は式だけを見て二重に判定しない)', async () => {
    const formula = formulaOf('curve', 'coef("R")*X/4');
    const bounded = { ...curveFeature('ranged', formula), definition: { ...plot(formula),
      bounds: { ...BOUNDS, X: { min: number(-4), max: scalar('floor(coef("R"))+3', [{ id: R_ID, label: 'R', decimal: '2' }]) } } } };
    expect(checkGeometryDerivedFunctionOperations(bounded.definition, DERIVED)).toBeNull();
    const { invalidInputs } = await evaluate(part([bounded]), MEASURED);
    expect(invalidInputs.get('ranged')).toBe(operationMessage('floor'));
  });
});

describe('図形由来の係数が無い文書は従来どおり', () => {
  function plainPart(): PartDocument {
    const sketch = EMPTY.sketches[0];
    return { ...EMPTY, parameters: [{ name: 'A', mathId: A_ID, unit: 'none', description: '', value: number(2.5) }],
      sketches: [{ ...sketch, features: [curveFeature('line', formulaOf('curve', 'floor(coef("A"))*X/4'))] }] };
  }

  it('resolveFunctionInputs は解析結果の係数(原式付き)をそのまま返し、floor(coef("A")) を断らない', async () => {
    const { document, analysis } = await evaluate(plainPart());
    expect(analysis).not.toHaveProperty('geometryDerived');
    const inputs = await resolveFunctionInputs(document, functionCurve(document, 'line').definition, analysis, () => true);
    if (inputs.status !== 'ready') throw new Error('Expected resolved inputs');
    expect(inputs.coefficients).toHaveLength(1);
    expect(inputs.coefficients[0]).toBe(analysis.mathCoefficients?.get('A'));
    expect(inputs.coefficients[0]).toHaveProperty('exactExpression');
    expect(inputs.ranges.tolerance).toBe(0.05);
  });

  it('文書全体の再計算は従来どおり曲線 Y = X/2 を1回の計算で描き、誤りを出さない', async () => {
    const document = plainPart(), { functions, calls } = workers();
    try {
      const result = await recomputePart(document, bridge, { math: mathContext(document), functions });
      expect(result.cancelled).toBe(false); expect(result.errors).toEqual([]);
      const line = result.sketches[0].resolved.splines.filter(spline => spline.featureId === 'line');
      for (const [x, y, z] of samplesOf(line)) { expect(Math.abs(y - x / 2)).toBeLessThan(1e-6); expect(z).toBeCloseTo(0, 10); }
      expect(calls).toEqual({ curves: 1, implicitCurves: 0, surfaces: 0, implicitSurfaces: 0, points: 0 });
    } finally { await bridge.releasePart(document.id); }
  }, 60_000);
});
