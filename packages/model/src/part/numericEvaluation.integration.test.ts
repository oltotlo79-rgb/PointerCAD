import { evaluateExpression, evaluateExpressionExact } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { analyzeParameters } from '../parameters/parameterTable.js';
import type { Parameter, ParameterUnit } from '../parameters/types.js';
import { createEmptyPartDocument } from './createPartDocument.js';
import { applyParameters } from './reevaluatePart.js';

function parameter(name: string, source: string, unit: ParameterUnit = 'none'): Parameter {
  return { name, unit, description: '', value: { source, value: 0, display: '0' } };
}
describe('解析から適用まで同じ精度・単位・有限値を保つ（R04/R05/R08）', () => {
  it('1/7を再評価しても7*a-1が0のままになる', () => {
    const document = { ...createEmptyPartDocument(), parameters: [parameter('a', '1/7'), parameter('b', '7*a-1')] };
    const result = applyParameters(document);
    expect(result.analysis.variables.get('b')).toBe(0);
    expect(result.document.parameters[1].value.value).toBe(0);
    expect(result.failures).toEqual([]);
    expect(evaluateExpression('7*a-1', result.analysis)).toMatchObject({ ok: true, value: { value: 0 } });
  });
  it('公開doubleで1を失う大数も、下流の差では1を保つ', () => {
    const document = { ...createEmptyPartDocument(), parameters: [parameter('a', '10^16+1'), parameter('b', 'a-10^16')] };
    const result = applyParameters(document);
    expect(result.analysis.exactVariables.get('a')).toBe('10000000000000001');
    expect(result.document.parameters[1].value.value).toBe(1);
    expect(evaluateExpression('a-10^16', result.analysis)).toMatchObject({ ok: true, value: { value: 1 } });
  });
  it.each(['none', 'degree'] as const)('%sのパラメータをinch付き式で長さとして割らない', (unit) => {
    const document = { ...createEmptyPartDocument(), parameters: [parameter('n', '2', unit), parameter('w', '(n*1)in', 'mm')] };
    const result = applyParameters(document);
    expect(result.analysis.nonLengthVariables.has('n')).toBe(true);
    expect(result.document.parameters[1].value.value).toBe(50.8);
    expect(evaluateExpression('(n*1)in', result.analysis)).toMatchObject({ ok: true, value: { value: 50.8 } });
  });
  it('mmと無次元が混ざってもそれぞれの量の種類を保つ', () => {
    const result = applyParameters({ ...createEmptyPartDocument(), parameters: [parameter('w', '25.4', 'mm'), parameter('n', '2'), parameter('x', '(w+n)in', 'mm')] });
    expect(result.document.parameters[2].value.value).toBe(76.2);
  });
  it.each([evaluateExpression, evaluateExpressionExact])('公開numberの上限を通常/exactの両方で守る', (evaluate) => {
    expect(evaluate('10^308')).toMatchObject({ ok: true, value: { value: 1e308 } });
    expect(evaluate('10^309')).toMatchObject({ ok: false, error: { code: 'notFinite' } });
    expect(evaluate('-10^309')).toMatchObject({ ok: false, error: { code: 'notFinite' } });
    // 中間値のDecimal精度を制限せず、有限な最終結果は受理する。
    expect(evaluate('10^309/10')).toMatchObject({ ok: true, value: { value: 1e308 } });
  });
  it('上限超過を変数表へ漏らさない', () => {
    const analysis = analyzeParameters([parameter('overflow', '10^309'), parameter('dependent', 'overflow/10')], []);
    expect(analysis.variables.size).toBe(0); expect(analysis.exactVariables.size).toBe(0);
    expect(analysis.failures).toHaveLength(2);
  });
  it('再適用で丸め直しや不要な文書変更を起こさない', () => {
    const initial = { ...createEmptyPartDocument(), parameters: [parameter('a', '1/7'), parameter('b', '7*a-1')] };
    const first = applyParameters(initial).document;
    expect(applyParameters(first).document).toBe(first);
  });
});
