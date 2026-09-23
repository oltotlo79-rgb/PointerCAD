import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { COMPLEX_ELEMENTARY_REFERENCES } from './complexElementaryReferences.js';
import type { StoredMathExpression } from './mathInputContract.js';

const backend = createMathBackend();
const D = Decimal.clone({ precision: 230 });
function evaluate(source: string, angleUnit: 'degree' | 'radian' = 'radian', definition?: StoredMathExpression) {
  const request = { source, angleUnit, notation: definition?.inputNotation ?? 'text', coefficients: [],
    ...(definition === undefined ? {} : { definition }),
    presentationNotation: 'latex' as const,
    identity: { documentId: 'complex-elementary', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const result = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(result, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}
function decimal(source: string, angleUnit: 'degree' | 'radian' = 'radian'): Decimal {
  const { evaluation: result } = evaluate(source, angleUnit);
  if (result.status !== 'value' || result.kind !== 'real') throw new Error(`${source}: ${JSON.stringify(result)}`);
  return new D(result.decimal);
}

describe('複素数の初等関数は主値・角度・元の不成立を保持する', () => {
  it.each(COMPLEX_ELEMENTARY_REFERENCES)('%sの両成分を独立計算の値と照合する', (source, real, imaginary) => {
    for (const [part, expected] of [['re', real], ['im', imaginary]]) {
      const actual = decimal(`${part}(${source})`), reference = new D(expected);
      if (reference.isZero()) expect(actual.toString()).toBe('0');
      else expect(actual.sub(reference).abs().div(reference.abs()).toNumber()).toBeLessThan(2e-37);
    }
  });
  it.each([
    ['re(exp(i*pi))', '-1'], ['im(exp(i*pi))', '0'], ['re(exp(i*pi/2))', '0'],
    ['im(exp(i*pi/2))', '1'], ['re(sin(i*ln(2)))', '0'], ['im(sin(i*ln(2)))', '0.75'],
    ['re(sqrt(3+4*i))', '2'], ['im(sqrt(3+4*i))', '1'], ['im(sqrt(3-4*i))', '-1'],
    ['re((-4)^0.5)', '0'], ['im((-4)^0.5)', '2'], ['im(ln(-1))', String(Math.PI)],
  ])('%sの既知値を保つ', (source, expected) => {
    if (source === 'im(ln(-1))') expect(decimal(source).toNumber()).toBeCloseTo(Number(expected), 14);
    else expect(decimal(source).toString()).toBe(expected);
  });
  it.each([
    'ln(i-i)', 'log(2,1+i-i)', 'atan(i)', 'atan(-i)', 'atan((1+i)/(1-i))',
    'atanh(1)', 'atanh(-1)', '1/(i-i)', 'complex(0,0)^complex(1,1)', 'complex(0,0)^0',
    'complex(1,i)',
  ])('%sは0倍や選択外の成分でも不成立のままにする', source => {
    for (const input of [source, `0*(${source})`, `component([7,${source}],1)`]) {
      expect(evaluate(input).evaluation, input).toMatchObject({ status: 'invalid', reason: 'domain' });
    }
  });
  it('通常の実数根と複素主値を混同せず、複素値を座標に自動変換しない', () => {
    expect(decimal('root(-8,3)').toString()).toBe('-2');
    expect(evaluate('root(-8,2)').evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    expect(evaluate('sqrt(-4)').evaluation).toMatchObject({ status: 'value', kind: 'complex' });
    expect(evaluate('asin(2)').evaluation).toMatchObject({ status: 'value', kind: 'complex' });
  });
  it('度は三角関数と逆三角関数だけへ適用し、指数・対数の主値を変えない', () => {
    expect(decimal('im(sin(complex(0,180/pi)))', 'degree').sub(decimal('im(sin(i))')).abs().toNumber()).toBeLessThan(1e-37);
    expect(decimal('re(asin(2))', 'degree').toString()).toBe('90');
    expect(decimal('im(asin(2))', 'degree').mul(new D(Math.PI.toString())).div(180).toNumber()).toBeCloseTo(decimal('im(asin(2))').toNumber(), 13);
    expect(decimal('im(ln(-2))', 'degree').toString()).toBe(decimal('im(ln(-2))').toString());
    expect(decimal('arg(-1)', 'degree').toString()).toBe('180');
  });
  it('構造入力と保存の往復後も元の複素数と角度を保持する', () => {
    const source = 'im(asin(2+i/3))+re(exp(i*pi))';
    const first = evaluate(source, 'degree');
    expect(first.presentation).not.toBeNull();
    if (first.presentation === null || first.presentation === undefined) throw new Error('No presentation');
    const saved = JSON.parse(JSON.stringify(first.presentation)) as StoredMathExpression;
    const second = evaluate(saved.source, 'degree', saved);
    expect(second.evaluation).toEqual(first.evaluation);
    expect(second.definition?.expression).toEqual(first.definition?.expression);
  });
});
