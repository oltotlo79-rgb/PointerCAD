import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import {
  CALCULATION_PACE_LIMITS, MathInputProblem, calculationPace, calculationPaceFromElapsed, createCalculationPaceMeter,
  createCalculationPaceMessage, isCalculationPaceMessage, measureCalculationReferenceMs, readCalculationPaceMessage, setCalculationPace,
} from './mathInputContract.js';
import { MathDeadlineExceeded, GEOMETRY_CALCULATION_MS, executeMathWorkRequest, geometryCalculationClock, type MathExecutionBackend } from './mathWorkExecution.js';
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

// v1.0.2: the stated limits are for a machine at its usual speed; a slower or throttled PC stretches them by its pace.
describe('計算の期限は機械の今の速さ（倍率1〜4）に合わせ、速い機械では今の期限のまま', () => {
  afterEach(() => { setCalculationPace(1); });

  it('倍率は基準の計算の時間から決め、1未満にも上限の4倍超にもしない。測れない時間は1', () => {
    const reference = CALCULATION_PACE_LIMITS.referenceMs;
    expect(calculationPaceFromElapsed(reference / 2)).toBe(1);
    expect(calculationPaceFromElapsed(reference)).toBe(1);
    expect(calculationPaceFromElapsed(reference * 2.5)).toBe(2.5);
    expect(calculationPaceFromElapsed(reference * 100)).toBe(CALCULATION_PACE_LIMITS.maximum);
    for (const unusable of [0, -1, NaN, Infinity]) expect(calculationPaceFromElapsed(unusable)).toBe(1);
    expect(CALCULATION_PACE_LIMITS.maximum).toBe(4);
  });

  it('Worker の外（窓・単体）の倍率は1で、不正な倍率は受け付けない', () => {
    expect(calculationPace()).toBe(1);
    for (const invalid of [0.99, 4.01, NaN, Infinity]) expect(() => setCalculationPace(invalid)).toThrow(RangeError);
    expect(calculationPace()).toBe(1);
  });

  it('基準の計算は決めた回数だけ測り、最も速い1回の時間を使う', () => {
    const marks = [0, 30, 100, 112, 200, 250];
    let index = 0;
    const now = (): number => marks[index++] ?? 0;
    expect(measureCalculationReferenceMs(now)).toBe(12);
    expect(index).toBe(CALCULATION_PACE_LIMITS.runs * 2);
  });

  it('測った値を5秒の間は使い回し、古くなったら測り直す', () => {
    let time = 0;
    const measured = [CALCULATION_PACE_LIMITS.referenceMs * 3, CALCULATION_PACE_LIMITS.referenceMs / 2];
    const measure = vi.fn(() => measured.shift() ?? 0);
    const meter = createCalculationPaceMeter(() => time, measure);
    expect(meter.current()).toBe(3);
    time = CALCULATION_PACE_LIMITS.reuseMs - 1;
    expect(meter.current()).toBe(3); expect(measure).toHaveBeenCalledTimes(1);
    time = CALCULATION_PACE_LIMITS.reuseMs;
    expect(meter.current()).toBe(1); expect(measure).toHaveBeenCalledTimes(2);
    expect(meter.elapsedMs).toBe(CALCULATION_PACE_LIMITS.referenceMs / 2);
  });

  it('倍率の知らせは種類と倍率だけを持ち、形の崩れた知らせは拒む', () => {
    const message = createCalculationPaceMessage(2.5);
    expect(message).toEqual({ kind: 'math-pace', pace: 2.5 });
    expect(isCalculationPaceMessage(message)).toBe(true);
    expect(readCalculationPaceMessage(message)).toBe(2.5);
    for (const other of [null, 1, 'math-pace', { kind: 'math-phase' }, { serial: 1 }]) {
      expect(isCalculationPaceMessage(other)).toBe(false); expect(readCalculationPaceMessage(other)).toBeNull();
    }
    for (const broken of [{ kind: 'math-pace' }, { kind: 'math-pace', pace: 0.5 }, { kind: 'math-pace', pace: 5 },
      { kind: 'math-pace', pace: '2' }, { kind: 'math-pace', pace: 2, serial: 1 }, Object.assign(Object.create({ extra: 1 }) as object, { kind: 'math-pace', pace: 2 })]) {
      expect(() => readCalculationPaceMessage(broken)).toThrow();
    }
    expect(() => createCalculationPaceMessage(4.5)).toThrow(RangeError);
  });

  it('形の計算の2秒は倍率をかけた時間で止め、速い機械（倍率1）では2秒のまま', () => {
    const time = replaceClock();
    const fast = geometryCalculationClock(backend, 0);
    time.advance(GEOMETRY_CALCULATION_MS - 1); expect(fast.shouldStop()).toBeUndefined();
    time.advance(1); expect(fast.shouldStop()).toBe('deadline');
    setCalculationPace(2.5);
    const slow = geometryCalculationClock(backend, GEOMETRY_CALCULATION_MS);
    // 2026-10-01: the curve of ADD-23 took 3143ms on this machine at 24% of its rated speed.
    time.advance(3143); expect(slow.shouldStop()).toBeUndefined();
    time.advance(GEOMETRY_CALCULATION_MS * 2.5 - 3143 - 1); expect(slow.shouldStop()).toBeUndefined();
    time.advance(1); expect(slow.shouldStop()).toBe('deadline');
  });

  it('通常の式の200msの区切りも倍率をかけ、明示した残り時間はそのまま使う', () => {
    const time = replaceClock();
    setCalculationPace(2);
    expect(backend.withinDeadline(() => { time.advance(399); return 1; })).toBe(1);
    expect(() => backend.withinDeadline(() => { time.advance(401); return 1; })).toThrow(MathDeadlineExceeded);
    expect(() => backend.withinDeadline(() => { time.advance(301); return 1; }, 300)).toThrow(MathDeadlineExceeded);
  });
});

describe.each(samplings)('$name の形の計算は、遅い機械では倍率をかけた期限まで続ける', sampling => {
  afterEach(() => { setCalculationPace(1); });

  it('倍率2.5の機械では、式の組立てに3143msかかっても形を作る', () => {
    setCalculationPace(2.5);
    const clock = replaceClock();
    slowCompilation(clock, 3143);
    expect(sampling.run().status).toBe('ready');
  });

  it('倍率2.5の機械でも、倍率をかけた期限を超えたら形を作らずに止める', () => {
    setCalculationPace(2.5);
    const clock = replaceClock();
    slowCompilation(clock, GEOMETRY_CALCULATION_MS * 2.5 + 1);
    expect(sampling.run()).toEqual({ status: 'invalid', message: '関数の計算を中止しました。' });
  });
});
