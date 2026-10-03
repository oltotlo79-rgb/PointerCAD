import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest, type ExactMathEngine } from './exactMathWorkExecution.js';
import { MathInputProblem, setCalculationPace } from './mathInputContract.js';
import { executeMathWorkRequest, MathDeadlineExceeded } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import * as preparation from './prepareMathCalculation.js';

afterEach(() => { vi.restoreAllMocks(); });

function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'wall-clock', documentVersion: 1, editorId: 'input', inputRevision: 1 } };
}
/** A synchronous answer never reaches the exact engine. */
const unused: ExactMathEngine = { evaluate: () => Promise.reject(new Error('The exact engine must not run')) };
/** Replace the clock. Each synchronous preparation first takes the next queued delay (none: the clock stands still). */
function replaceClock(): { readonly delays: number[]; readonly advance: (milliseconds: number) => void } {
  let now = 0;
  const delays: number[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const prepare = preparation.prepareMathCalculation;
  vi.spyOn(preparation, 'prepareMathCalculation').mockImplementation((...args) => {
    now += delays.shift() ?? 0;
    return prepare(...args);
  });
  return { delays, advance: milliseconds => { now += milliseconds; } };
}
function calculate(source: string, options: {
  readonly engine?: ExactMathEngine; readonly shouldStop?: () => 'cancelled' | 'deadline' | undefined;
} = {}) {
  const backend = createMathBackend(), blocks = vi.spyOn(backend, 'withinDeadline');
  const reply = executeExactMathWorkRequest(createMathWorkEnvelope(1, request(source)),
    { backend, engine: options.engine ?? unused, shouldStop: options.shouldStop ?? (() => undefined) });
  return { reply, blocks };
}
// A matrix operation the synchronous calculation leaves to the exact engine; the stub answers 3.
const exactOnly = 'component(rowreduce([[sqrt(2),1],[2,sqrt(2)]]),1,2)';
const three = { status: 'value', kind: 'real', expression: { kind: 'number', decimal: '3' }, domainConditions: [], coordinateAuthorized: false };

describe('時間の上限による停止を手順の上限と区別し、同じ依頼を1回だけ計算し直す', () => {
  it('(a) 1回目だけ時間の上限で止まり、計算し直した2回目が通れば値を返す', async () => {
    replaceClock().delays.push(201);
    const { reply, blocks } = calculate('1+2');
    expect((await reply).evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: '3', coordinate: 3 });
    expect(blocks).toHaveBeenCalledTimes(2);
  });

  it('(b) 2回とも時間の上限で止まれば、計算量ではなく時間の上限として止める', async () => {
    replaceClock().delays.push(...Array.from({ length: 10 }, () => 201));
    const { reply, blocks } = calculate('1+2');
    expect((await reply).evaluation).toEqual({ status: 'stopped', reason: 'deadline' });
    expect(blocks).toHaveBeenCalledTimes(2);
  });

  it.each(['zeta(129)', 'plusminus(1)+plusminus(2)+plusminus(4)+plusminus(8)+plusminus(16)+plusminus(32)'])(
    '(c) 手順・構造の上限の%sは計算し直さず、計算量の上限のまま止める', async source => {
      replaceClock().delays.push(150);
      const { reply, blocks } = calculate(source);
      expect((await reply).evaluation).toEqual({ status: 'stopped', reason: 'budget' });
      expect(blocks).toHaveBeenCalledTimes(1);
    });

  // The screen checks expect the calculation-size message for these inputs (e2e/tests/math*Flow.ts).
  it.each(['besselj(129,1)', 'beta(20000,1e-100)', 'erf(500001)', 'gamma(20001)', 'legendre(129,1)',
    'component([7,erf(9+i)],1)', 'zeta(129)', 'zetaderivative(18,2)'])(
    '画面で計算量の上限を示す%sは、実際の時計でも計算し直さず計算量の上限のまま', async source => {
      const { reply, blocks } = calculate(source);
      expect((await reply).evaluation).toEqual({ status: 'stopped', reason: 'budget' });
      expect(blocks).toHaveBeenCalledTimes(1);
    });

  it('依頼元が止めた期限は計算し直さない', async () => {
    replaceClock().delays.push(201);
    let asked = 0;
    const { reply, blocks } = calculate('1+2', { shouldStop: () => (asked++ === 0 ? undefined : 'deadline') });
    expect((await reply).evaluation).toEqual({ status: 'stopped', reason: 'deadline' });
    expect(blocks).toHaveBeenCalledTimes(1);
  });

  it('実計算の後の段だけを計算し直し、実計算部は1回しか呼ばない', async () => {
    const clock = replaceClock();
    const evaluate = vi.fn(() => { clock.delays.push(201); return Promise.resolve(three); });
    const { reply } = calculate(exactOnly, { engine: { evaluate } });
    expect((await reply).evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: '3', coordinate: 3 });
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('実計算の前の準備が時間で止まっても、計算し直してから実計算部を1回だけ呼ぶ', async () => {
    const clock = replaceClock(), prepare = preparation.prepareExactMathCalculation;
    let slow = true;
    vi.spyOn(preparation, 'prepareExactMathCalculation').mockImplementation((...args) => {
      if (slow) { slow = false; clock.advance(201); }
      return prepare(...args);
    });
    const evaluate = vi.fn(() => Promise.resolve(three));
    const { reply } = calculate(exactOnly, { engine: { evaluate } });
    expect((await reply).evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: '3', coordinate: 3 });
    expect(slow).toBe(false);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('計算し直しは1つの依頼につき1回だけ: 後の段の時間の停止はそのまま時間の上限にする', async () => {
    const clock = replaceClock(), prepare = preparation.prepareExactMathCalculation;
    let slow = true;
    // The preparation before the engine uses the one recalculation of this request.
    vi.spyOn(preparation, 'prepareExactMathCalculation').mockImplementation((...args) => {
      if (slow) { slow = false; clock.advance(201); }
      return prepare(...args);
    });
    const evaluate = vi.fn(() => { clock.delays.push(201); return Promise.resolve(three); });
    const { reply } = calculate(exactOnly, { engine: { evaluate } });
    expect((await reply).evaluation).toEqual({ status: 'stopped', reason: 'deadline' });
    expect(slow).toBe(false);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('同期の段を直接呼ぶ既存の読み手には、時間の停止を計算量の停止のまま渡す', () => {
    replaceClock().delays.push(201);
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request('1+2')), createMathBackend());
    expect(reply.evaluation).toEqual({ status: 'stopped', reason: 'budget' });
    const problem = new MathDeadlineExceeded();
    expect(problem).toBeInstanceOf(MathInputProblem);
    expect(problem.code).toBe('budget');
  });
});

describe('通常の式の200msの区切りは、機械の速さの倍率をかけて使う（v1.0.2）', () => {
  afterEach(() => { setCalculationPace(1); });

  it('倍率1の機械で2回とも301msかかれば、時間の上限として止める（今までどおり）', async () => {
    replaceClock().delays.push(...Array.from({ length: 10 }, () => 301));
    const { reply } = calculate('1+2');
    expect((await reply).evaluation).toEqual({ status: 'stopped', reason: 'deadline' });
  });

  it('倍率2の機械では、301msかかっても1回目で値を返す', async () => {
    setCalculationPace(2);
    replaceClock().delays.push(301);
    const { reply, blocks } = calculate('1+2');
    expect((await reply).evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: '3', coordinate: 3 });
    expect(blocks).toHaveBeenCalledTimes(1);
  });
});
