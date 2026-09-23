import Decimal from 'decimal.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { BESSEL_INTEGER_REFERENCES } from './besselIntegerReferences.js';
import { BESSEL_SECOND_REFERENCES } from './besselSecondKindReferences.js';

const D = Decimal.clone({ precision: 300, rounding: Decimal.ROUND_HALF_EVEN });
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function request(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  return { source, angleUnit, notation: 'text' as const, coefficients: [],
    identity: { documentId: 'bessel-functions', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
}
function evaluate(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  const input = request(source, angleUnit), raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
  return decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
}
function value(source: string): number {
  const result = evaluate(source).evaluation;
  if (result.status !== 'value' || result.kind !== 'real') throw new Error(source+': '+JSON.stringify(result));
  return result.coordinate;
}
const references = [...BESSEL_INTEGER_REFERENCES, ...BESSEL_SECOND_REFERENCES]
  .filter(([, , , text]) => Number.isFinite(Number(text)) && Number(text) !== 0);

describe('四種類のBesselの次数と引数を通常入力へ接続する', () => {
  it.each(references)('%s_%s(%s)を独立した確認値へ渡す', (kind, n, x, expected) => {
    const source = `bessel${kind.toLowerCase()}(${n},${x})`;
    expect(Math.abs(value(source)/Number(expected)-1)).toBeLessThan(5e-14);
    if (n === 0 && x === '1') {
      expect(JSON.stringify(evaluate(source).evaluation)).toContain(new D(expected).toSignificantDigits(40).toString());
    }
  });
  it('原点の正確な値と、合成・角度の意味を保持する', () => {
    for (const name of ['besselj', 'besseli']) {
      expect(value(`${name}(0,0)`)).toBe(1); expect(value(`${name}(1,0)`)).toBe(0);
      expect(value(`${name}(-2,0)`)).toBe(0);
    }
    expect(value('besselj(0,sin(30))')).toBe(value('besselj(0,0.5)'));
    expect(value('besselj(0,besseli(0,0))')).toBe(value('besselj(0,1)'));
    expect(evaluate('besselk(0,1)', 'degree').evaluation).toEqual(evaluate('besselk(0,1)', 'radian').evaluation);
  });
  it.each(['besselj', 'bessely', 'besseli', 'besselk'])('%sの構造表示・原式・保存した定義が往復する', name => {
    const source = `2*${name}(0,1)`, input = { ...request(source), presentationNotation: 'latex' as const };
    const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
    const result = decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
    if (raw.expression === null || raw.presentation === undefined || raw.presentation === null || result.definition === null) throw new Error(JSON.stringify(raw));
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
    expect(result.definition.source).toBe(source);
    const back = executeMathWorkRequest({ kind: 'evaluate-math', serial: 2, request: { ...input,
      notation: 'latex', source: raw.presentation.source, definition: raw.presentation, presentationNotation: 'text' } }, backend);
    if (back.presentation === undefined || back.presentation === null) throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(raw.expression, back.presentation.expression)).toBe(true); expect(back.evaluation).toEqual(raw.evaluation);
    const saved: unknown = JSON.parse(JSON.stringify({ kind: 'evaluate-math', serial: 3, request: { ...input, definition: result.definition } }));
    const reopened = executeMathWorkRequest(saved, backend);
    expect(reopened.source).toBe(source); expect(reopened.evaluation).toEqual(raw.evaluation);
  });
  it.each(['bessely(0,0)', 'besselk(1,-1)', 'besselj(0,1/0)', 'besseli(0,[1])', 'bessely(0,true)',
    'besselk(0,∞)', 'besselj(0.5,1)', 'besselj(0,i)', 'besselk(0,sqrt(-1))'])(
    '%sの不成立を0倍や成分選択で消さない', source => {
      for (const formula of [source, `0*${source}`, `component([7,${source}],1)`]) {
        expect(evaluate(formula).evaluation.status).not.toBe('value');
      }
    });
  it('上限の元の分数と、倍精度へ収まらない結果を保持して拒否する', () => {
    for (const source of ['besselj(129,1)', 'besseli(-129,1)', 'bessely(0,128+1e-100)', 'besselk(0,1e-3000)']) {
      expect(evaluate(`0*${source}`).evaluation, source).toMatchObject({ status: 'stopped', reason: 'budget' });
    }
    for (const source of ['bessely(128,0.125)', 'besselk(128,0.125)']) {
      expect(evaluate(source).evaluation).toMatchObject({ status: 'invalid', reason: 'non-finite' });
    }
  });
});
