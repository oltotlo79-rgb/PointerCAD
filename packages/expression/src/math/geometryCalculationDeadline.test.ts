import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { MathInputProblem } from './mathInputContract.js';
import { MathDeadlineExceeded, GEOMETRY_CALCULATION_MS, executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope } from './mathWorkRequest.js';
import * as preparation from './prepareMathCalculation.js';
import { createFunctionPointWorkEnvelope, saveFunctionPointInput, type FunctionPointWorkRequest } from './functionPointWorkRequest.js';
import { executeFunctionPointWorkRequest } from './functionPointWorkExecution.js';
import * as implicitSearch from './solveImplicitFunctionPoints.js';
import { decodeCurvePointWorkRequest, saveCurvePointInput, type CurvePointWorkRequest } from './curvePointWorkRequest.js';
import { createCurvePointWorkEnvelope } from './curvePointWorkEnvelope.js';
import { executeCurvePointWorkRequest } from './curvePointWorkExecution.js';
import * as curveSearch from './solveCurveFunctionPoints.js';
import { decodeSurfacePointWorkRequest, saveSurfacePointInput, type SurfacePointWorkRequest } from './surfacePointWorkRequest.js';
import { createSurfacePointWorkEnvelope } from './surfacePointWorkEnvelope.js';
import { executeSurfacePointWorkRequest } from './surfacePointWorkExecution.js';
import * as surfaceSearch from './solveSurfaceFunctionPoints.js';
import { FUNCTION_SURFACE_LIMITS } from './functionSurfaceLimits.js';
import { createFunctionPointContinuationWorkEnvelope } from './functionPointContinuationWork.js';
import { executeFunctionPointContinuationWork } from './functionPointContinuationWorkExecution.js';
import * as implicitContinuation from './continueImplicitFunctionPoint.js';
import { createCurvePointContinuationWorkEnvelope } from './curvePointContinuationWork.js';
import { executeCurvePointContinuationWork } from './curvePointContinuationWorkExecution.js';
import * as curveContinuation from './continueCurveFunctionPoint.js';
import { createSurfacePointContinuationWorkEnvelope } from './surfacePointContinuationWork.js';
import { executeSurfacePointContinuationWork } from './surfacePointContinuationWorkExecution.js';
import * as surfaceContinuation from './continueSurfaceFunctionPoint.js';
import * as compilation from './compileFunctionScalar.js';
import { createFunctionCurveWorkEnvelope, type FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import { executeFunctionCurveWorkRequest } from './functionCurveWorkExecution.js';
import { createFunctionSurfaceWorkEnvelope, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { executeFunctionSurfaceWorkRequest } from './functionSurfaceWorkExecution.js';
import { createFunctionImplicitWorkEnvelope, type FunctionImplicitWorkRequest } from './functionImplicitWorkRequest.js';
import { executeFunctionImplicitWorkRequest } from './functionImplicitWorkExecution.js';
import { createFunctionImplicitCurveWorkEnvelope, type FunctionImplicitCurveWorkRequest } from './functionImplicitCurveWorkRequest.js';
import { executeFunctionImplicitCurveWorkRequest } from './functionImplicitCurveWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Replace the clock; it stands still unless a test moves it. */
function replaceClock(): { readonly advance: (milliseconds: number) => void } {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return { advance: milliseconds => { now += milliseconds; } };
}
const identity = { documentId: 'point-deadline', documentVersion: 1, editorId: 'point', inputRevision: 1 };
function implicit(): FunctionPointWorkRequest {
  return { identity, expression: createFunctionMathSource('X^2+Y^2+Z^2-1', 'text', 'radian', { axes: ['X', 'Y', 'Z'], parameters: [], coefficients: [] }, backend),
    coefficients: [], minimum: [-2, -2, -2], maximum: [2, 2, 2], tolerance: 1e-6, known: [{ axis: 'X', value: 0 }, { axis: 'Y', value: 0 }] };
}
function curve(): CurvePointWorkRequest {
  return decodeCurvePointWorkRequest({ kind: 'curve', identity, independent: 'T',
    outputs: ['T^2', 'T', '0'].map(source => createFunctionMathSource(source, 'text', 'degree', { axes: [], parameters: ['T'], coefficients: [] }, backend)),
    lower: -4, upper: 4, minimum: [-4, -4, -4], maximum: [4, 4, 4], tolerance: 1e-7, coefficients: [], known: [{ axis: 'X', value: 1 }] });
}
function surface(): SurfacePointWorkRequest {
  return decodeSurfacePointWorkRequest({ kind: 'parametric-surface', identity, independent: ['U', 'V'],
    outputs: ['U+V', 'U-V', 'U*V'].map(source => createFunctionMathSource(source, 'text', 'degree', { axes: [], parameters: ['U', 'V'], coefficients: [] }, backend)),
    coefficients: [], lower: [-4, -4], upper: [4, 4], minimum: [-10, -10, -10], maximum: [10, 10, 10], tolerance: 1e-7,
    budget: FUNCTION_SURFACE_LIMITS, known: [{ axis: 'X', value: 3 }, { axis: 'Y', value: 1 }] });
}
type Result = { readonly status: string; readonly reason?: string };
type Stop = { readonly status: 'stopped'; readonly reason: 'budget' };
/** Runs before the calculation with its context; a returned stop replaces the calculation. */
type Before = (context: { readonly backend: MathExecutionBackend }) => Stop | undefined;
interface Kind {
  readonly name: string;
  /** Calculate once through the Worker entry. */
  readonly run: () => Result;
  /** Wrap the calculation this entry calls. */
  readonly around: (before: Before) => void;
}
type Ready<T> = Extract<T, { readonly status: 'ready' }>;
function isReady<T extends { readonly status: string }>(result: T): result is Ready<T> { return result.status === 'ready'; }
function searched<T extends { readonly status: string }>(result: T): Ready<T> { if (!isReady(result)) throw new Error(JSON.stringify(result)); return result; }
const kinds: readonly Kind[] = [
  { name: '等式の点の探索', run: () => executeFunctionPointWorkRequest(createFunctionPointWorkEnvelope(1, implicit()), backend).result,
    around: before => { const original = implicitSearch.solveImplicitFunctionPoints;
    vi.spyOn(implicitSearch, 'solveImplicitFunctionPoints').mockImplementation((request, context) => before(context) ?? original(request, context)); } },
  { name: '曲線の点の探索', run: () => executeCurvePointWorkRequest(createCurvePointWorkEnvelope(1, curve()), backend).result,
    around: before => { const original = curveSearch.solveCurveFunctionPoints;
    vi.spyOn(curveSearch, 'solveCurveFunctionPoints').mockImplementation((request, context) => before(context) ?? original(request, context)); } },
  { name: '曲面の点の探索', run: () => executeSurfacePointWorkRequest(createSurfacePointWorkEnvelope(1, surface()), backend).result,
    around: before => { const original = surfaceSearch.solveSurfaceFunctionPoints;
    vi.spyOn(surfaceSearch, 'solveSurfaceFunctionPoints').mockImplementation((request, context) => before(context) ?? original(request, context)); } },
  { name: '等式の点の追従', run: () => {
    const input = implicit(), found = searched(implicitSearch.solveImplicitFunctionPoints(input, { backend, shouldStop: () => undefined }));
    return executeFunctionPointContinuationWork(createFunctionPointContinuationWorkEnvelope(1, { identity, previous: saveFunctionPointInput(input),
      current: saveFunctionPointInput(input), anchor: found.candidates[0].location }), backend).result;
  }, around: before => { const original = implicitContinuation.continueImplicitFunctionPoint;
    vi.spyOn(implicitContinuation, 'continueImplicitFunctionPoint').mockImplementation((previous, current, anchor, context) =>
      before(context) ?? original(previous, current, anchor, context)); } },
  { name: '曲線の点の追従', run: () => {
    const input = curve(), found = searched(curveSearch.solveCurveFunctionPoints(input, { backend, shouldStop: () => undefined }));
    return executeCurvePointContinuationWork(createCurvePointContinuationWorkEnvelope(1, { identity, previous: saveCurvePointInput(input),
      current: saveCurvePointInput(input), anchor: found.candidates[0].location }), backend).result;
  }, around: before => { const original = curveContinuation.continueCurveFunctionPoint;
    vi.spyOn(curveContinuation, 'continueCurveFunctionPoint').mockImplementation((previous, current, anchor, context) =>
      before(context) ?? original(previous, current, anchor, context)); } },
  { name: '曲面の点の追従', run: () => {
    const input = surface(), found = searched(surfaceSearch.solveSurfaceFunctionPoints(input, { backend, shouldStop: () => undefined }));
    return executeSurfacePointContinuationWork(createSurfacePointContinuationWorkEnvelope(1, { identity, previous: saveSurfacePointInput(input),
      current: saveSurfacePointInput(input), anchor: found.candidates[0].location }), backend).result;
  }, around: before => { const original = surfaceContinuation.continueSurfaceFunctionPoint;
    vi.spyOn(surfaceContinuation, 'continueSurfaceFunctionPoint').mockImplementation((previous, current, anchor, context) =>
      before(context) ?? original(previous, current, anchor, context)); } },
];

describe('入力欄の通常の式は200ms、図形を作る計算は利用者が決めた2000msで区切る', () => {
  it('図形を作る計算の期限は2000ms（点の計算の既存の値）', () => { expect(GEOMETRY_CALCULATION_MS).toBe(2000); });

  it('通常の区画は200msを超えると時間の上限で止まる', () => {
    const clock = replaceClock();
    expect(() => backend.withinDeadline(() => { clock.advance(201); return 1; })).toThrow(MathDeadlineExceeded);
    expect(backend.withinDeadline(() => { clock.advance(199); return 1; })).toBe(1);
  });

  it('期限を渡した区画はその時間まで通り、中の通常の区画は200msのまま', () => {
    const clock = replaceClock();
    expect(backend.withinDeadline(() => { clock.advance(1999); return 1; }, GEOMETRY_CALCULATION_MS)).toBe(1);
    expect(() => backend.withinDeadline(() => { clock.advance(2001); return 1; }, GEOMETRY_CALCULATION_MS)).toThrow(MathDeadlineExceeded);
    expect(() => backend.withinDeadline(() => backend.withinDeadline(() => { clock.advance(201); return 1; }), GEOMETRY_CALCULATION_MS))
      .toThrow(MathDeadlineExceeded);
    // A nested block never outlasts the block around it.
    expect(() => backend.withinDeadline(() => backend.withinDeadline(() => { clock.advance(201); return 1; }, GEOMETRY_CALCULATION_MS)))
      .toThrow(MathDeadlineExceeded);
  });

  it('通常の式の評価は201msで計算量の上限のまま止まる（200msは変えない）', () => {
    const clock = replaceClock(), prepare = preparation.prepareMathCalculation;
    vi.spyOn(preparation, 'prepareMathCalculation').mockImplementation((...args) => { clock.advance(201); return prepare(...args); });
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, { identity, source: '1+2', notation: 'text', angleUnit: 'radian', coefficients: [] }), backend);
    expect(reply.evaluation).toEqual({ status: 'stopped', reason: 'budget' });
  });
});

describe.each(kinds)('$name は2000msの期限で打ち切り、時間の停止を時間の上限として返す', kind => {
  it('時計が止まっていれば候補が見つかる（基準）', () => {
    replaceClock();
    expect(kind.run().status).toBe('ready');
  });

  it('200msを超えても2000ms以内なら、外側の200msで打ち切らずに結果を返す', () => {
    const clock = replaceClock();
    kind.around(() => { clock.advance(1500); return undefined; });
    expect(kind.run().status).toBe('ready');
  });

  it('2000msを超えたら計算量ではなく時間の上限（deadline）で止まる', () => {
    const clock = replaceClock();
    kind.around(() => { clock.advance(GEOMETRY_CALCULATION_MS + 1); return undefined; });
    expect(kind.run()).toEqual({ status: 'stopped', reason: 'deadline' });
  });

  it('計算の中の区画は200msで止まらず、2000msまでの残りの時間を使う', () => {
    const clock = replaceClock();
    kind.around(context => { context.backend.withinDeadline(() => { clock.advance(500); return 0; }); return undefined; });
    expect(kind.run().status).toBe('ready');
  });

  it('中の区画が残りの時間を超えて止まり、計算が計算量の停止を返しても、時間の上限として返す', () => {
    const clock = replaceClock();
    kind.around(context => {
      try { context.backend.withinDeadline(() => { clock.advance(GEOMETRY_CALCULATION_MS + 1); return 0; }); }
      catch (error) { if (error instanceof MathInputProblem && error.code === 'budget') return { status: 'stopped', reason: 'budget' }; throw error; }
      throw new Error('The block must stop at the time left');
    });
    expect(kind.run()).toEqual({ status: 'stopped', reason: 'deadline' });
  });

  it('時計によらない手順・量の上限は、これまでどおり計算量の上限（budget）のまま', () => {
    replaceClock();
    kind.around(() => ({ status: 'stopped', reason: 'budget' }));
    expect(kind.run()).toEqual({ status: 'stopped', reason: 'budget' });
  });

  it('時計によらない計算量の例外も budget のまま、時間の例外は deadline にする', () => {
    replaceClock();
    kind.around(() => { throw new MathInputProblem('budget', '計算量の上限です。'); });
    expect(kind.run()).toEqual({ status: 'stopped', reason: 'budget' });
    vi.restoreAllMocks();
    replaceClock();
    kind.around(() => { throw new MathDeadlineExceeded(); });
    expect(kind.run()).toEqual({ status: 'stopped', reason: 'deadline' });
  });
});

const coordinates = (source: string, axes: readonly ('X' | 'Y' | 'Z')[], parameters: readonly ('T' | 'U' | 'V')[]) =>
  createFunctionMathSource(source, 'text', 'radian', { axes, parameters, coefficients: [] }, backend);
interface Sampling { readonly name: string; readonly run: () => { readonly status: string } }
const samplings: readonly Sampling[] = [
  { name: '関数曲線の見本', run: () => {
    const request: FunctionCurveWorkRequest = { identity, independent: 'X', outputs: [coordinates('X', ['X'], []), coordinates('X^2', ['X'], []),
      coordinates('0', ['X'], [])], lower: -1, upper: 1, minimum: [-1, -1, -1], maximum: [1, 1, 1], tolerance: 0.01, coefficients: [] };
    return executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(1, request), backend).result;
  } },
  { name: '関数曲面の見本（偏微分）', run: () => {
    const request: FunctionSurfaceWorkRequest = { identity, independent: ['U', 'V'], outputs: [coordinates('U', [], ['U', 'V']),
      coordinates('V', [], ['U', 'V']), coordinates('diff(U^2+V^2,U)', [], ['U', 'V'])], lower: [-1, -1], upper: [1, 1],
      minimum: [-1, -1, -3], maximum: [1, 1, 3], tolerance: 0.01, coefficients: [],
      budget: { maximumSamples: 10000, maximumCells: 10000, maximumTriangles: 10000, maximumDepth: 10 } };
    return executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1, request), backend).result;
  } },
  { name: '等式の曲面の見本', run: () => {
    const request: FunctionImplicitWorkRequest = { identity, expression: coordinates('X^2+Y^2+Z^2-1', ['X', 'Y', 'Z'], []),
      minimum: [-2, -2, -2], maximum: [2, 2, 2], tolerance: 1, coefficients: [],
      budget: { maximumSamples: 100_000, maximumCells: 400_000, maximumTriangles: 100_000, maximumDepth: 12 } };
    return executeFunctionImplicitWorkRequest(createFunctionImplicitWorkEnvelope(1, request), backend).result;
  } },
  { name: '等式の曲線の見本', run: () => {
    const request: FunctionImplicitCurveWorkRequest = { identity, expression: coordinates('X^2+Y^2-1', ['X', 'Y'], []), fixedAxis: 'Z',
      fixedCoordinate: 0, minimum: [-2, -2, -2], maximum: [2, 2, 2], tolerance: 0.1, coefficients: [],
      budget: { maximumSamples: 100_000, maximumCells: 400_000, maximumSegments: 100_000, maximumDepth: 12 } };
    return executeFunctionImplicitCurveWorkRequest(createFunctionImplicitCurveWorkEnvelope(1, request), backend).result;
  } },
];
/** The first formula compiled for the shape takes `milliseconds` (a cold Worker or a busy machine). */
function slowCompilation(clock: { readonly advance: (milliseconds: number) => void }, milliseconds: number): void {
  const compile = compilation.compileFunctionScalar;
  let slow = true;
  vi.spyOn(compilation, 'compileFunctionScalar').mockImplementation((...args) => {
    if (slow) { slow = false; clock.advance(milliseconds); }
    return compile(...args);
  });
}

describe.each(samplings)('$name の式の組立ては、200msではなく2000msの期限を使う', sampling => {
  it('時計が止まっていれば形ができる（基準）', () => {
    replaceClock();
    expect(sampling.run().status).toBe('ready');
  });

  it('式の組立てが500msかかっても（開き直した直後の冷えた状態）、時間の上限で止めずに形を作る', () => {
    const clock = replaceClock();
    slowCompilation(clock, 500);
    expect(sampling.run().status).toBe('ready');
  });

  it('式の組立てが2000msを超えたら、形を作らずに止める（これまでの中止の文のまま）', () => {
    const clock = replaceClock();
    slowCompilation(clock, GEOMETRY_CALCULATION_MS + 1);
    expect(sampling.run()).toEqual({ status: 'invalid', message: '関数の計算を中止しました。' });
  });
});
