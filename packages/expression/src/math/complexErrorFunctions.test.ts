import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { COMPLEX_ERROR_REFERENCES } from './complexErrorFunctionReferences.js';
import type { StoredMathExpression } from './mathInputContract.js';

const backend = createMathBackend();
const D = Decimal.clone({ precision: 380, rounding: Decimal.ROUND_HALF_EVEN });
function evaluate(source: string, angleUnit: 'degree' | 'radian' = 'radian', definition?: StoredMathExpression) {
  const request = { source, angleUnit, notation: definition?.inputNotation ?? 'text', coefficients: [],
    ...(definition === undefined ? {} : { definition }), presentationNotation: 'latex' as const,
    identity: { documentId: 'complex-erf', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}
function decimal(source: string, angleUnit: 'degree' | 'radian' = 'radian'): Decimal {
  const result = evaluate(source, angleUnit).evaluation;
  if (result.status !== 'value' || result.kind !== 'real') throw new Error(source + ': ' + JSON.stringify(result));
  return new D(result.decimal);
}

describe('複素数の誤差関数を元の式・両成分・成立条件のまま公開入力へ渡す', () => {
  it.each(COMPLEX_ERROR_REFERENCES)('実部$realと虚部$imaginaryの独立比較値を公開の返信でも40桁保持する', reference => {
    for (const id of ['erf', 'erfc'] as const) {
      const source = `${id}(complex(${reference.real},${reference.imaginary}))`;
      for (const [index, part] of ['re', 'im'].entries()) {
        expect(decimal(`${part}(${source})`).toString())
          .toBe(new D(reference[id][index]).toSignificantDigits(40).toString());
      }
    }
  }, 30_000);
  it('両成分の公開返信を全桁を保つ通常の十進表記で返す', () => {
    for (const [formula, expected] of [
      ['im(erf(i))', '1.650425758797542876025337729561362443896'],
      ['im(erfc(i))', '-1.650425758797542876025337729561362443896'],
      ['im(erf(sqrt(-1)))', '1.650425758797542876025337729561362443896'],
    ]) {
      expect(evaluate(formula).evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: expected });
    }
  });
  it('複素数をそのまま座標へ変換せず、実部・虚部の明示的な選択を必要とする', () => {
    expect(evaluate('erf(1+i)').evaluation).toMatchObject({ status: 'value', kind: 'complex' });
    expect(evaluate('erfc(i)').evaluation).toMatchObject({ status: 'value', kind: 'complex' });
    expect(decimal('re(erfc(i))').toString()).toBe('1');
    expect(decimal('im(erf(i))').toNumber()).toBeCloseTo(Number('1.6504257587975429'), 14);
    expect(decimal('im(erfc(i))').toString()).toBe(decimal('im(erf(i))').neg().toString());
  });
  it('複素数の四則・根・対数を引数として使い、実数へ戻った場合は実数の範囲を保つ', () => {
    expect(decimal('im(erf((1+i)/(1-i)))').toString()).toBe(decimal('im(erf(i))').toString());
    expect(decimal('im(erf(sqrt(-1)))').toString()).toBe(decimal('im(erf(i))').toString());
    expect(decimal('im(erf(ln(-1)))').toString()).toBe(decimal('im(erf(i*pi))').toString());
    expect(decimal('erfc(complex(10,0))').toString()).toBe(decimal('erfc(10)').toString());
    expect(decimal('erf(i-i)').toString()).toBe('0');
    expect(decimal('0*erfc(ln(-1))').toString()).toBe('0');
    expect(decimal('component([1,erfc(ln(-1))],1)').toString()).toBe('1');
  });
  it('度は引数の三角関数へだけ適用し、誤差関数自体の意味を変えない', () => {
    expect(decimal('im(erf(i))', 'degree').toString()).toBe(decimal('im(erf(i))').toString());
    expect(decimal('im(erf(i*sin(30)))', 'degree').toString()).toBe(decimal('im(erf(i/2))').toString());
  });
  it.each(['erf(1/(i-i))', 'erfc(ln(i-i))', 'erf(complex(1,i))', 'erf(complex(0,∞))'])(
  '%sの不成立を0倍や選択外の成分で隠さない', source => {
    for (const formula of [source, `0*${source}`, `component([7,${source}],1)`]) {
      expect(evaluate(formula).evaluation, formula).toMatchObject({ status: 'invalid', reason: 'domain' });
    }
  });
  it.each(['erf(9+i)', 'erfc(-9*i)', 'erf(complex(8+1e-100,1))', 'erfc(complex(1,-8-1e-100))'])(
  '%sの元の範囲超過を丸めや成分選択で隠さない', source => {
    for (const formula of [source, `0*${source}`, `component([7,${source}],1)`]) {
      expect(evaluate(formula).evaluation, formula).toMatchObject({ status: 'stopped', reason: 'budget' });
    }
  });
  it('表示切替と保存往復で元の複素数の式と両成分を保持する', () => {
    const source = 'im(erfc(1+i/2))+re(erf(1-i/3))';
    const first = evaluate(source);
    if (first.presentation === null || first.presentation === undefined || first.definition === null) throw new Error('Missing stored expression');
    expect(first.definition.source).toBe(source);
    const saved = JSON.parse(JSON.stringify(first.presentation)) as StoredMathExpression;
    const reopened = evaluate(saved.source, 'radian', saved);
    expect(reopened.evaluation).toEqual(first.evaluation);
    expect(reopened.definition?.expression).toEqual(first.definition.expression);
  });
  it('保存した複素数の元の式を係数から繰り返し評価しても、選んだ成分を保持する',()=>{
    const original=evaluate('im(erf(i))');
    if(original.definition===null)throw new Error('Missing definition');
    for(let revision=1;revision<=4;revision++) {
      const result=executeMathWorkRequest({kind:'evaluate-math',serial:revision,request:{
        source:'coef("a")',notation:'text',angleUnit:'radian',
        identity:{documentId:'complex-erf-recompute',documentVersion:1,editorId:'coordinate',inputRevision:revision},
        coefficients:[{id:'a',label:'a',decimal:'1.6504257587975429',exactExpression:original.definition.expression}],
      }},backend);
      expect(result.evaluation).toEqual(original.evaluation);
    }
  });
});
