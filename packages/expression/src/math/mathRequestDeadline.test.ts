import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { MathInputProblem, MATH_INPUT_FORMAT, type MathNode } from './mathInputContract.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import type { MathWorkRequest } from './mathWorkRequest.js';
import * as preparation from './prepareMathCalculation.js';

afterEach(() => { vi.restoreAllMocks(); });

function request(source: string, options: Partial<MathWorkRequest> = {}): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'request-deadline', documentVersion: 1, editorId: 'input', inputRevision: 1 }, ...options };
}
function evaluate(value: MathWorkRequest, backend = createMathBackend()) {
  return executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: value }, backend).evaluation;
}
function delayedPreparation(delay: number) {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const prepare = preparation.prepareMathCalculation;
  vi.spyOn(preparation, 'prepareMathCalculation').mockImplementation((...args) => {
    now += delay;
    return prepare(...args);
  });
  return { set: (value: number) => { now = value; } };
}
const elliptic: MathNode = { kind: 'operation', operation: 'ellipticf',
  operands: [{ kind: 'number', decimal: '0' }, { kind: 'number', decimal: '0' }] };

describe('高精度計算の期限を準備の前から依頼全体へ適用する', () => {
  it.each(['elliptick(0)', 'elliptice(0)', 'ellipticf(0,0)', 'ellipticeinc(0,0)',
    'ellipticpi(0,0)', 'ellipticpiinc(0,0,0)'])('%sは準備に250msかかっても通常式の期限で停止しない', source => {
    delayedPreparation(250);
    expect(evaluate(request(source))).toMatchObject({ status: 'value', kind: 'real' });
  });

  it.each(['gamma(1)', 'beta(1,1)', 'erf(0)', 'zeta(2)'])('%sも準備を含めた1秒の期限を使う', source => {
    delayedPreparation(250);
    expect(evaluate(request(source))).toMatchObject({ status: 'value', kind: 'real' });
  });

  it('通常の式は準備を含め200msのまま停止する', () => {
    delayedPreparation(201);
    expect(evaluate(request('1+2'))).toEqual({ status: 'stopped', reason: 'budget' });
  });

  it.each([['ellipticf(0,0)', 3001], ['gamma(1)', 1001]] as const)(
    '%sは計算に着いても開始からの期限を更新しない', (source, delay) => {
      delayedPreparation(delay);
      expect(evaluate(request(source))).toEqual({ status: 'stopped', reason: 'budget' });
    });

  it('構造入力でも準備1633msを楕円積分の3秒へ含め、値と桁を保つ', () => {
    delayedPreparation(1633);
    const backend: MathExecutionBackend = { ...createMathBackend(),
      parseLatex: () => ['EllipticF', { num: '0' }, { num: '0' }] };
    expect(evaluate(request('elliptic input', { notation: 'latex' }), backend))
      .toMatchObject({ status: 'value', kind: 'real', decimal: '0', coordinate: 0 });
  });

  it('保存された式と係数を展開して初めて現れる楕円積分にも開始から適用する', () => {
    const clock = delayedPreparation(250);
    const stored = { format: MATH_INPUT_FORMAT, source: 'ellipticf(0,0)', inputNotation: 'text' as const,
      angleUnit: 'radian' as const, expression: elliptic };
    expect(evaluate(request(stored.source, { definition: stored }))).toMatchObject({ status: 'value', decimal: '0' });
    clock.set(0);
    expect(evaluate(request('coef("a")', { coefficients: [{ id: 'a', label: 'a', decimal: '0', exactExpression: elliptic }] })))
      .toMatchObject({ status: 'value', decimal: '0' });
  });

  it('外側に通常式の200ms期限がある場合は準備中の延長で越えない', () => {
    delayedPreparation(250);
    const backend = createMathBackend();
    expect(() => backend.withinDeadline(() => evaluate(request('ellipticf(0,0)'), backend))).toThrow(MathInputProblem);
  });

  it('宣言した値の楕円積分は親の依頼も開始から延長してから入れ子へ渡す', () => {
    delayedPreparation(250);
    expect(evaluate(request('a', { declarations: [{ id: 'a', label: 'a', meaning: '値', type: 'real',
      valueSource: 'ellipticf(0,0)' }] }))).toMatchObject({ status: 'value', kind: 'real', decimal: '0' });
  });

  it('準備中の例外で延長を次の通常式へ持ち越さない', () => {
    const clock = delayedPreparation(250), backend = createMathBackend();
    expect(evaluate(request('elliptick(1)'), backend)).toMatchObject({ status: 'invalid', reason: 'domain' });
    clock.set(0);
    expect(evaluate(request('1+2'), backend)).toEqual({ status: 'stopped', reason: 'budget' });
  });

  it('準備中の別の評価にも楕円積分の延長を適用する', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const backend = createMathBackend(), prepare = preparation.prepareMathCalculation;
    vi.spyOn(preparation, 'prepareMathCalculation').mockImplementation((...args) => {
      now = 250;
      backend.box({ num: '1' }).evaluate();
      return prepare(...args);
    });
    expect(evaluate(request('ellipticf(0,0)'), backend)).toMatchObject({ status: 'value', decimal: '0' });
  });

  it.each(['EllipticF', 'Gamma'])('%sの箱を先に作っても最初の期限確認より先に種類を判定する', head => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const backend = createMathBackend(), args = head === 'Gamma' ? [{ num: '1' }] : [{ num: '0' }, { num: '0' }];
    const box = backend.box([head, ...args]);
    expect(() => backend.withinDeadline(() => { now = 250; return box.evaluate().N(); })).not.toThrow();
  });
});
