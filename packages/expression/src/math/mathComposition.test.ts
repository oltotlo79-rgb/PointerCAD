import { beforeAll, describe, expect, it } from 'vitest';
import { addExpression, divideExpression, multiplyExpression, subtractExpression } from '../combineExpression.js';
import { expressionValueFromNumber, type ExpressionValue } from '../evaluateExpression.js';
import { mathScalarExpression } from '../index.js';
import { bindMathCompositionNames } from './mathComposition.js';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { decodeMathExpressionStorage } from './mathExpressionStorage.js';
import { sameMathMeaning } from './mathNotationConversion.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'coefficient:1', label: '幅', decimal: '10' }];
function evaluate(value: ExpressionValue | string, angleUnit: 'degree' | 'radian' = 'degree') {
  const definition = typeof value === 'string' ? undefined : value.mathDefinition;
  const request = { identity: { documentId: 'part', documentVersion: 1, editorId: 'composed', inputRevision: 1 },
    source: typeof value === 'string' ? value : value.source, notation: definition?.inputNotation ?? 'text' as const,
    angleUnit: definition?.angleUnit ?? angleUnit, coefficients, ...(definition === undefined ? {} : { definition }) };
  const result = decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(coefficients.map(item => item.id)), declaredIds: new Set() }).result;
  const scalar = mathScalarExpression(result);
  if (!scalar.ok) throw new Error(JSON.stringify(result));
  return scalar.value;
}

describe('CADの自動生成式が数学AST・束縛・角度を保持する', () => {
  it.each(['0.25', 'coef("幅")*sin(30)', 'sum(i,i,1,3)'])('座標方向を往復しても%sの式に符号変換が積み重ならない', source => {
    const original = evaluate(source), negativeOne = expressionValueFromNumber(-1);
    let current = original;
    for (let edit = 0; edit < 5; edit += 1) {
      const negative = multiplyExpression(current, negativeOne);
      current = multiplyExpression(negative, negativeOne);
      if (!current.mathDefinition || !original.mathDefinition) throw new Error('The original math definition was lost');
      expect(sameMathMeaning(current.mathDefinition.expression, original.mathDefinition.expression)).toBe(true);
      expect(current.mathDefinition?.angleUnit).toBe(original.mathDefinition?.angleUnit);
      expect(evaluate(current).value).toBe(original.value);
    }
    if (source === '0.25') expect(current.source).toBe(source);
  });
  it('値が-1の係数を符号変換と取り違えて消さない', () => {
    const coefficient = { ...evaluate('coef("幅")'), value: -1, display: '-1' };
    const product = multiplyExpression(multiplyExpression(evaluate('2'), coefficient), expressionValueFromNumber(-1));
    expect(product.source).toContain('coef("幅")');
    // 実際の係数表の幅=10で計算し直すと-20。キャッシュ値-1による簡約は誤り。
    expect(evaluate(product).value).toBe(-20);
  });
  it.each([
    ['+', addExpression, 2.5], ['-', subtractExpression, -1.5],
    ['*', multiplyExpression, 1], ['/', divideExpression, 0.25],
  ] as const)('%sを定数と合成して保存しても、原式を照合した実計算が同じになる', (_operator, compose, expected) => {
    const a = evaluate('sin(30)'), b = expressionValueFromNumber(2), combined = compose(a, b);
    expect(combined.mathDefinition).toBeDefined();
    const definition = decodeMathExpressionStorage(JSON.parse(JSON.stringify(combined.mathDefinition)), combined.source);
    expect(evaluate({ ...combined, mathDefinition: definition }).value).toBeCloseTo(expected, 12);
    expect(a.source).toBe('sin(30)');
  });
  it('度のsinとラジアンのsinを混ぜても、各入力の規約を保存する', () => {
    const combined = addExpression(evaluate('sin(30)'), evaluate('sin(pi/6)', 'radian'));
    expect(combined.mathDefinition?.angleUnit).toBe('radian');
    expect(evaluate(combined).value).toBe(1);
  });
  it('別々の総和で同じ添字を使っても束縛が混線せず保存して再計算できる', () => {
    const combined = addExpression(evaluate('sum(i,i,1,3)'), evaluate('sum(i,i,1,4)'));
    expect(evaluate(combined).value).toBe(16);
    expect(decodeMathExpressionStorage(combined.mathDefinition, combined.source)).toBeDefined();
  });
  it('旧形式のinch入力と数学定義を合成し、係数の長さの意味を保つ', () => {
    const a = evaluate('2');
    bindMathCompositionNames(a, [{ id: 'coefficient:1', label: '幅', kind: 'length' }]);
    const combined = addExpression(a, { source: '(幅+1)in', value: 35.4, display: '35.4' });
    expect(evaluate(combined).value).toBeCloseTo(37.4, 12);
    expect(combined.source).toContain('coef("幅")');
  });
  it('意味の異なる同じ係数名を黙って統合せず、元の値も変更しない', () => {
    const a = evaluate('2'), b = evaluate('3');
    bindMathCompositionNames(a, [{ id: 'coefficient:1', label: '幅', kind: 'length' }]);
    bindMathCompositionNames(b, [{ id: 'coefficient:9', label: '幅', kind: 'length' }]);
    expect(() => addExpression(a, b)).toThrow('係数参照が一致しません');
    expect(a.value).toBe(2); expect(b.value).toBe(3);
  });
  it('係数の単位情報が未準備なら、旧式の単位付き変数を長さと推測しない', () => {
    const a = evaluate('coef("幅")');
    expect(() => addExpression(a, { source: '(幅+1)in', value: 279.4, display: '279.4' })).toThrow('係数');
  });
});
