import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as adaptive from './adaptiveFunctionSurface.js';
import * as smoothing from './smoothFunctionSurface.js';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createFunctionSurfaceWorkEnvelope, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { executeFunctionSurfaceWorkRequest, type FunctionSurfaceWorkResult } from './functionSurfaceWorkExecution.js';
import { setCalculationPace } from './mathInputContract.js';
import { GEOMETRY_CALCULATION_MS, type MathExecutionBackend } from './mathWorkExecution.js';

// 2026-11-12 統括の決定（design.md 案1）: 関数曲面の依頼は、時計で止まった段だけを依頼ごとに1回だけ計算し直す
// （通常の式の exactMathWorkExecution.ts と同じ決まり）。2,000ms×倍率の時計と、回数・大きさ・丸め誤差・取消の停止は変えない。
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
afterEach(() => { vi.restoreAllMocks(); setCalculationPace(1); });

/** Replace the clock; it stands still unless a test moves it. */
function replaceClock(): { readonly advance: (milliseconds: number) => void; readonly now: () => number } {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return { advance: milliseconds => { now += milliseconds; }, now: () => now };
}
// 画面検査と同じ式・精度0.001の小さな範囲（頂点1,089・なめらかな面あり）。時計を止めた状態で速く流せる。
const request = (): FunctionSurfaceWorkRequest => {
  const source = (text: string) => createFunctionMathSource(text, 'text', 'radian', { axes: ['X', 'Y'], parameters: [], coefficients: [] }, backend);
  return { identity: { documentId: 'surface-recalculation', documentVersion: 1, editorId: 'surface', inputRevision: 1 },
    independent: ['X', 'Y'], outputs: [source('X'), source('Y'), source('(X^2+Y^2)/10')], lower: [-1, -1], upper: [1, 1],
    minimum: [-1, -1, -1], maximum: [1, 1, 4], tolerance: 0.001, coefficients: [],
    budget: { maximumSamples: 100_000, maximumCells: 400_000, maximumTriangles: 100_000, maximumDepth: 24 } };
};
const run = (): FunctionSurfaceWorkResult => executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1, request()), backend).result;
/** The same request on a clock that never moves: the ordinary, uninterrupted result. */
function reference(): FunctionSurfaceWorkResult {
  replaceClock();
  const result = run();
  vi.restoreAllMocks();
  return result;
}
/** Count the stage calls; `before[n]` runs before the n-th call (0-based) of the real stage. */
function watchStages(sampleBefore: readonly (() => void)[], smoothBefore: readonly (() => void)[]) {
  const realSample = adaptive.sampleFunctionSurface, realSmooth = smoothing.smoothFunctionSurface;
  const calls = { sample: 0, smooth: 0 };
  vi.spyOn(adaptive, 'sampleFunctionSurface').mockImplementation((...args) => {
    sampleBefore[calls.sample++]?.(); return realSample(...args);
  });
  vi.spyOn(smoothing, 'smoothFunctionSurface').mockImplementation((...args) => {
    smoothBefore[calls.smooth++]?.(); return realSmooth(...args);
  });
  return calls;
}

describe('関数曲面は時計で止まった段だけを依頼ごとに1回だけ計算し直し、2,000ms×倍率の時計は変えない', () => {
  it('1回目で ready ならやり直さず、標本化・なめらか化を1回ずつだけ行う', () => {
    const expected = reference();
    replaceClock();
    const calls = watchStages([], []);
    const result = run();
    expect(result).toMatchObject({ status: 'ready' }); expect(result).toHaveProperty('spline');
    expect(result).toEqual(expected); expect(calls).toEqual({ sample: 1, smooth: 1 });
  });

  it('標本化が時計で1回止まったら、標本化を1回だけやり直し、止まらなかった時と同じ形・同じ結果を返す', () => {
    const expected = reference();
    const clock = replaceClock();
    const calls = watchStages([() => clock.advance(GEOMETRY_CALCULATION_MS)], []);
    expect(run()).toEqual(expected);
    expect(calls).toEqual({ sample: 2, smooth: 1 });
  });

  it('なめらか化が時計で1回止まったら、確かめ済みの三角形の面はそのままに、なめらか化だけを1回やり直す', () => {
    const expected = reference();
    const clock = replaceClock();
    const calls = watchStages([], [() => clock.advance(GEOMETRY_CALCULATION_MS)]);
    expect(run()).toEqual(expected);
    expect(calls).toEqual({ sample: 1, smooth: 2 });
  });

  it('やり直した標本化も時計で止まれば、3回目は行わず、これまでどおり stopped・deadline を返す', () => {
    const clock = replaceClock();
    const calls = watchStages([() => clock.advance(GEOMETRY_CALCULATION_MS), () => clock.advance(GEOMETRY_CALCULATION_MS)], []);
    const result = run();
    expect(result).toMatchObject({ status: 'stopped', reason: 'deadline' });
    expect(Object.keys(result).sort()).toEqual(['reason', 'stats', 'status']);
    expect(calls).toEqual({ sample: 2, smooth: 0 });
  });

  it('やり直しは依頼ごとに1回まで: 標本化でやり直した後のなめらか化の時計の停止は、やり直さずに stopped・deadline を返す', () => {
    const clock = replaceClock();
    const calls = watchStages([() => clock.advance(GEOMETRY_CALCULATION_MS)], [() => clock.advance(GEOMETRY_CALCULATION_MS)]);
    const result = run();
    expect(result).toMatchObject({ status: 'stopped', reason: 'deadline' });
    expect(Object.keys(result).sort()).toEqual(['reason', 'stats', 'status']);
    expect(calls).toEqual({ sample: 2, smooth: 1 });
  });

  it('なめらか化が2回とも時計で止まれば、3回目は行わず stopped・deadline を返す', () => {
    const clock = replaceClock();
    const calls = watchStages([], [() => clock.advance(GEOMETRY_CALCULATION_MS), () => clock.advance(GEOMETRY_CALCULATION_MS)]);
    expect(run()).toMatchObject({ status: 'stopped', reason: 'deadline' });
    expect(calls).toEqual({ sample: 1, smooth: 2 });
  });

  it.each(['samples', 'cells', 'triangles', 'subdivision', 'roundoff'] as const)('回数・大きさ・丸め誤差の停止（%s）ではやり直さない', reason => {
    replaceClock();
    const stopped = { status: 'stopped', reason, stats: { samples: 1, cells: 1, triangles: 0 } } as const;
    const sample = vi.spyOn(adaptive, 'sampleFunctionSurface').mockReturnValue(stopped);
    const smooth = vi.spyOn(smoothing, 'smoothFunctionSurface');
    expect(run()).toEqual(stopped);
    expect(sample).toHaveBeenCalledTimes(1); expect(smooth).not.toHaveBeenCalled();
  });

  it('取消（cancelled）の停止ではやり直さない', () => {
    replaceClock();
    const stopped = { status: 'stopped', reason: 'cancelled', stats: { samples: 0, cells: 0, triangles: 0 } } as const;
    const sample = vi.spyOn(adaptive, 'sampleFunctionSurface').mockReturnValue(stopped);
    expect(run()).toEqual(stopped);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 4])('倍率%sでも、やり直しを含む依頼の全体は4,000ms×倍率で必ず止まり、2回目の時計は2,000ms×倍率を超えない', pace => {
    setCalculationPace(pace);
    const clock = replaceClock(), length = GEOMETRY_CALCULATION_MS * pace, overshoot = 500;
    const seen: (string | undefined)[] = [];
    const realSample = adaptive.sampleFunctionSurface;
    let calls = 0;
    vi.spyOn(adaptive, 'sampleFunctionSurface').mockImplementation((evaluator, options, observer) => {
      calls++;
      if (calls === 1) { clock.advance(length + overshoot); return realSample(evaluator, options, observer); }
      // 2回目の時計は1回目の時計の終わり（開始から2,000ms×倍率）から数え、超過した500msはやり直しへ持ち越さない。
      seen.push(options.shouldStop?.());
      clock.advance(2 * length - clock.now() - 1); seen.push(options.shouldStop?.());
      clock.advance(1); seen.push(options.shouldStop?.());
      return realSample(evaluator, options, observer);
    });
    expect(run()).toMatchObject({ status: 'stopped', reason: 'deadline' });
    expect(seen).toEqual([undefined, undefined, 'deadline']);
    expect(clock.now()).toBe(2 * length);
    expect(calls).toBe(2);
  });
});
