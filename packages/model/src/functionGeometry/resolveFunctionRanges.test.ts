import { describe, expect, it } from 'vitest';
import { evaluateExpression, expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import type { FunctionDefinition } from './functionDefinitionTypes.js';
import { resolveFunctionRanges, type FunctionRangeContext } from './resolveFunctionRanges.js';

function input(source: string, variables = new Map([['width', 10]])): ExpressionValue {
  const result = evaluateExpression(source, { variables });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function definition(): FunctionDefinition {
  return { format: 'pointercad-function/1', bounds: {
    X: { min: input('-width'), max: input('width') }, Y: { min: input('-10'), max: input('10') }, Z: { min: input('-1'), max: input('1') },
  }, tolerance: input('0.01'), formula: { kind: 'implicit-surface', expression: {
    format: 'pointercad-math/1', source: '0', inputNotation: 'text', angleUnit: 'radian', expression: { kind: 'number', decimal: '0' },
  } } };
}
function context(width: number): FunctionRangeContext {
  return { isCurrent: () => true, evaluate: value => {
    const result = evaluateExpression(value.source, { variables: new Map([['width', width]]) });
    return Promise.resolve(result.ok ? { ok: true, value: result.value.value } : { ok: false, message: result.error.message });
  } };
}
describe('描画範囲を現在の係数と世代で検証する', () => {
  it('保存キャッシュ±10を使わず、現在の係数から±20を求める', async () => {
    const original = definition(), before = JSON.stringify(original);
    const result = await resolveFunctionRanges(original, context(20));
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.ranges.bounds.interval('X')).toEqual({ min: -20, max: 20 });
    expect(result.ranges.bounds.contains([15, 0, 0])).toBe(true);
    expect(result.ranges.bounds.contains([21, 0, 0])).toBe(false);
    expect(JSON.stringify(original)).toBe(before);
  });
  it.each([0, -10, Infinity])('係数%sで範囲が同値・逆転・非有限になると生成前に拒否する', async (width) => {
    const result = await resolveFunctionRanges(definition(), context(width));
    expect(result.status).toBe('invalid');
    expect(result).not.toHaveProperty('ranges');
  });
  it('処理中に世代が変わると、数値が正しくても古い範囲を返さない', async () => {
    let current = true;
    const evaluation = context(20);
    const pending = resolveFunctionRanges(definition(), { isCurrent: () => current, evaluate: evaluation.evaluate });
    current = false;
    expect(await pending).toEqual({ status: 'cancelled' });
  });
  it('XYZの入力欄すべての数値失敗をまとめて返す', async () => {
    const result = await resolveFunctionRanges(definition(), { isCurrent: () => true,
      evaluate: (_value, field) => Promise.resolve(field.startsWith('bounds.') ? { ok: true, value: NaN } : { ok: true, value: 0.01 }) });
    if (result.status !== 'invalid') throw new Error(JSON.stringify(result));
    expect(result.issues.map(issue => issue.field)).toEqual(['bounds.X.min', 'bounds.X.max', 'bounds.Y.min', 'bounds.Y.max', 'bounds.Z.min', 'bounds.Z.max']);
  });
  it('媒介Tの有効範囲があっても、XYZの無効な範囲を補完しない', async () => {
    const original = definition();
    if (original.formula.kind !== 'implicit-surface') throw new Error('Expected fixture');
    const candidate: FunctionDefinition = { ...original, formula: { kind: 'parametric-curve',
      T: { min: input('0'), max: input('360') }, outputs: { X: original.formula.expression, Y: original.formula.expression, Z: original.formula.expression } } };
    expect((await resolveFunctionRanges(candidate, context(0))).status).toBe('invalid');
  });
  it('現在の精度が0なら古い正の保存値で生成しない', async () => {
    const candidate = { ...definition(), tolerance: { ...expressionValueFromNumber(0.01), source: 'width' } };
    const result = await resolveFunctionRanges(candidate, context(0));
    if (result.status !== 'invalid') throw new Error(JSON.stringify(result));
    expect(result.issues.some(issue => issue.field === 'tolerance')).toBe(true);
  });
});
