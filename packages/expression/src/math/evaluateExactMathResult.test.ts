import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { evaluateExactMathResult, type ExactMathEvaluationContext } from './evaluateExactMathResult.js';
import { mathScalarValue } from './mathScalarExpression.js';
import { type MathNode, type MathEvaluation } from './mathInputContract.js';

const n = (decimal: string): MathNode => ({ kind: 'number', decimal });
const op = (operation: string, ...operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation, operands });
const c = (name: Extract<MathNode, { kind: 'constant' }>['name']): MathNode => ({ kind: 'constant', name });
const a: MathNode = { kind: 'symbol', reference: { role: 'coefficient', id: 'a-id', label: 'a' } };
const wire = (expression: MathNode, kind = 'real', domainConditions: readonly MathNode[] = []) => ({
  status: 'value', kind, expression, domainConditions, coordinateAuthorized: false,
});
let context: ExactMathEvaluationContext;
beforeAll(() => {
  context = { backend: createMathBackend(), angleUnit: 'degree', shouldStop: () => undefined,
    references: { coefficientIds: new Set(['a-id']), declaredIds: new Set() }, resolve: () => null };
});

function scalar(value: MathEvaluation, expected: number): void {
  const result = mathScalarValue(value);
  expect(result).toMatchObject({ ok: true, value: expected });
}
describe('厳密な戻り値も元の式と成立条件を確認してから作図へ接続する', () => {
  it('分数を丸めず保持して既存の有限実数の入口へ渡す', () => {
    const fraction = op('divide', n('1'), n('3'));
    const result = evaluateExactMathResult(wire(fraction), fraction, context);
    scalar(result, 1 / 3);
    expect(result).toMatchObject({ status: 'value', kind: 'real', exact: fraction, approximation: null });
  });
  it.each(['1e-40', '-1e-40', '1.25e-40', '1e40'])('分母や分子が指数表記になる%sを丸めずに受け取る', decimal => {
    const source = n(decimal);
    const result = evaluateExactMathResult(wire(source), source, context);
    scalar(result, Number(decimal));
    expect(result).toMatchObject({ status: 'value', kind: 'real', approximation: null });
  });
  it.each([
    op('multiply', n('0'), op('divide', n('1'), n('0'))),
    op('power', n('0'), n('0')),
    op('divide', n('0'), n('0')),
  ])('結果が0でも元の未定義演算を隠せない: %j', source => {
    const box = vi.fn(context.backend.box);
    const result = evaluateExactMathResult(wire(n('0')), source, { ...context, backend: { ...context.backend, box } });
    expect(result).toMatchObject({ status: 'invalid', reason: 'domain' });
    expect(box).not.toHaveBeenCalled();
  });
  it('同じ係数IDの現在値で原式と消えた分母の条件を確認する', () => {
    const source = op('divide', a, a), returned = wire(n('1'), 'real', [op('not-equal', a, n('0'))]);
    scalar(evaluateExactMathResult(returned, source, { ...context, resolve: () => n('2') }), 1);
    expect(evaluateExactMathResult(returned, source, { ...context, resolve: () => n('0') }))
      .toMatchObject({ status: 'invalid', reason: 'domain' });
    expect(evaluateExactMathResult(returned, source, context)).toMatchObject({ status: 'unresolved', reason: 'missing-condition' });
  });
  it('元の式に問題がなくても追加条件が偽なら拒否する', () => {
    expect(evaluateExactMathResult(wire(n('1'), 'real', [c('false')]), n('1'), context))
      .toMatchObject({ status: 'invalid', reason: 'domain' });
  });
  it('度とラジアンを明示した結果の三角関数をそれぞれ一度だけ変換する', () => {
    const degree = op('sin', n('30')), radian = op('sin', op('divide', c('pi'), n('6')));
    scalar(evaluateExactMathResult(wire(degree), degree, context), 0.5);
    scalar(evaluateExactMathResult(wire(radian), radian, { ...context, angleUnit: 'radian' }), 0.5);
  });
  it('実数という申告に従って虚部を切り捨てない', () => {
    const result = evaluateExactMathResult(wire(c('imaginary-unit')), c('imaginary-unit'), context);
    expect(result).toMatchObject({ status: 'value', kind: 'complex' });
    expect(mathScalarValue(result).ok).toBe(false);
  });
  it('行列や集合を先頭成分の座標へ変えず、微小な有理数も式のまま保つ', () => {
    const tiny = op('divide', n('1'), n('10000000000000000000000000000000000000000'));
    for (const [kind, source] of [
      ['matrix', op('matrix', op('list', op('list', tiny, n('0')), op('list', n('0'), n('1'))))],
      ['set', op('set', n('1'), n('2'))],
    ] as const) {
      const result = evaluateExactMathResult(wire(source, kind), source, context);
      expect(result).toEqual({ status: 'value', kind, expression: source });
      expect(mathScalarValue(result).ok).toBe(false);
    }
  });
  it('表示できる極小値でも作図用数値へ変換して0になる場合は拒否する', () => {
    const source = n('1e-999');
    const result = evaluateExactMathResult(wire(source), source, context);
    expect(result).toMatchObject({ status: 'invalid', reason: 'non-finite' });
    expect(mathScalarValue(result).ok).toBe(false);
  });
  it.each(['cancelled', 'deadline'] as const)('外側が%sなら計算せず同じ状態を返す', reason => {
    const box = vi.fn(context.backend.box);
    expect(evaluateExactMathResult(wire(n('1')), n('1'), {
      ...context, shouldStop: () => reason, backend: { ...context.backend, box },
    })).toEqual({ status: 'stopped', reason });
    expect(box).not.toHaveBeenCalled();
  });
});
