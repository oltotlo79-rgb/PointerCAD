import { describe, expect, it } from 'vitest';
import { createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import type { MathEvaluation } from '@pointercad/expression/math/contracts';
import { mathEditorResultText } from './mathEditorResult.js';
import type { MathEditorSnapshot } from './MathEditorController.js';
const input = { identity: { documentId: 'part', documentVersion: 1, editorId: 'X', inputRevision: 0 },
  source: '1/3', notation: 'text' as const, angleUnit: 'radian' as const };
function evaluated(evaluation: MathEvaluation): MathEditorSnapshot {
  return { state: { status: 'evaluated', input, output: { input, definition: null, evaluation }, canApply: false }, query: '', problem: null };
}
describe('数学の型と未確定状態を数値の成功と混同しない表示', () => {
  it.each([
    ['im(erf(i))', '= 1.650425758797542876025337729561362443896'],
    ['im(erfc(i))', '= -1.650425758797542876025337729561362443896'],
    ['im(erf(sqrt(-1)))', '= 1.650425758797542876025337729561362443896'],
  ])('%sを実計算・公開返信から読みやすい小数の全文へ表示する', (source, expected) => {
    const request = { ...input, source, coefficients: [] };
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
    const output = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    const view = mathEditorResultText(evaluated(output.evaluation));
    expect(view.message).toBe(expected);
    expect(view.hasError).toBe(false);
  });
  it.each(['zeta(129)', 'zetaderivative(18,2)', '0*zeta(129)', 'component([7,zeta(129)],1)'])('%sの計算上限を公開返信から画面へ伝え、値や内部の例外文にしない', source => {
    const request = { ...input, source, coefficients: [] };
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
    const output = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(output.evaluation).toEqual({ status: 'stopped', reason: 'budget' });
    const view = mathEditorResultText(evaluated(output.evaluation));
    expect(view.message).toBe('計算量の上限に達しました。式や範囲を小さくしてください。');
    expect(view.detail).toBe('');
    expect(view.busy).toBe(false);
  });
  it('展開した式・中心・打切り次数を示し、O記号を数値の誤差上限にしない', () => {
    const number = (decimal: string) => ({ kind: 'number' as const, decimal });
    const expression = { kind: 'operation' as const, operation: 'maclaurin', operands: [
      { kind: 'binder' as const, operation: 'lambda', bindings: [{ variable: { role: 'bound' as const, id: 'local', label: 'x' },
        domain: { kind: 'unrestricted' as const } }], body: number('1') }, number('4')] };
    const evaluation: Extract<MathEvaluation, { kind: 'series' }> = { status: 'value', kind: 'series', expression,
      expansion: { center: number('0'), degree: '4', coefficients: Array.from({ length: 5 }, () => number('1')),
        exact: false, remainderOrder: '5', convergence: { kind: 'disk', radius: number('1') } } };
    const view = mathEditorResultText(evaluated(evaluation));
    expect(view.message).toBe('P4(x) = 1 + x + x^2 + x^3 + x^4');
    expect(view.detail).toContain('O(x^5)');
    expect(view.detail).toContain('数値誤差の上限ではありません');
    expect(view.detail).toContain('|x| < 1');
    expect(view.detail).toContain('境界と範囲外');
    const unknown = mathEditorResultText(evaluated({ ...evaluation,
      expansion: { ...evaluation.expansion, convergence: { kind: 'unknown', radius: null } } }));
    expect(unknown.detail).toContain('収束範囲は未確認');
    expect(unknown.detail).not.toContain('全ての有限');
    const exact = mathEditorResultText(evaluated({ ...evaluation,
      expansion: { ...evaluation.expansion, exact: true, convergence: { kind: 'entire', radius: null } } }));
    expect(exact.detail).toContain('省略項は0');
    expect(exact.detail).not.toContain('O(');
  });
  it.each([['true', '真（成立）'], ['false', '偽（不成立）']] as const)('確定した%sを真偽の結果として表示する', (name, expected) => {
    const view = mathEditorResultText(evaluated({ status: 'value', kind: 'boolean', expression: { kind: 'constant', name } }));
    expect(view.message).toBe(expected);
    expect(view.hasError).toBe(false);
    expect(view.message).not.toMatch(/= [01]/u);
  });
  it('真偽が未確定なら偽として表示しない', () => {
    const view = mathEditorResultText(evaluated({ status: 'unresolved', reason: 'unevaluated', names: [] }));
    expect(view.message).not.toContain('偽');
    expect(view.message).not.toContain('真（');
  });
  it('数値積分の推定値は≈で示し、推定誤差を保証値と呼ばない', () => {
    const view = mathEditorResultText(evaluated({ status: 'value', kind: 'real', decimal: '0.3102683017233811', coordinate: 0.3102683017233811,
      exact: null, approximation: { absoluteError: null, estimatedAbsoluteError: 1e-12 } }));
    expect(view.message).toBe('≈ 0.3102683017233811');
    expect(view.detail).toContain('推定誤差');
    expect(view.detail).toContain('保証値ではありません');
    expect(view.detail).toContain('1e-12');
    expect(view.detail).toContain('誤差上限を確認できません');
  });
  it('誤差不明の数値を誤差0として表示しない', () => {
    const view = mathEditorResultText(evaluated({ status: 'value', kind: 'real', decimal: '0.5', coordinate: 0.5,
      exact: null, approximation: { absoluteError: null } }));
    expect(view.message).toBe('= 0.5');
    expect(view.detail).toContain('誤差上限を確認できません');
  });
  it('網羅されていない解候補には、そのことを添える', () => {
    const view = mathEditorResultText(evaluated({ status: 'multiple', candidates: [{ kind: 'number', decimal: '1' }], exhaustive: false }));
    expect(view.message).toContain('複数');
    expect(view.detail).toContain('候補以外');
  });
  it('複素数を黙って実部だけの座標に見せない', () => {
    const view = mathEditorResultText(evaluated({ status: 'value', kind: 'complex', expression: { kind: 'constant', name: 'imaginary-unit' } }));
    expect(view.message).toContain('複素数');
    expect(view.message).not.toContain('= 0');
  });
  it('計算中と入力待ちを別の状態として表示する', () => {
    const pending = { query: '', problem: null };
    expect(mathEditorResultText({ ...pending, state: { status: 'calculating', input } }).busy).toBe(true);
    expect(mathEditorResultText({ ...pending, state: { status: 'editing', input } }).busy).toBe(false);
  });
});
