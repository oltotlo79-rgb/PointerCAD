import { describe, expect, it } from 'vitest';
import type { MathEvaluation } from '@pointercad/expression/math/contracts';
import { mathEditorResultText } from './mathEditorResult.js';
import type { MathEditorSnapshot } from './MathEditorController.js';
const input = { identity: { documentId: 'part', documentVersion: 1, editorId: 'X', inputRevision: 0 },
  source: '1/3', notation: 'text' as const, angleUnit: 'radian' as const };
function evaluated(evaluation: MathEvaluation): MathEditorSnapshot {
  return { state: { status: 'evaluated', input, output: { input, definition: null, evaluation }, canApply: false }, query: '', problem: null };
}
describe('数学の型と未確定状態を数値の成功と混同しない表示', () => {
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
