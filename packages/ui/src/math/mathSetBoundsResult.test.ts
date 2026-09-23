import { describe, expect, it } from 'vitest';
import type { MathEvaluation, MathNode } from '@pointercad/expression/math/contracts';
import type { MathEditorSnapshot } from './MathEditorController.js';
import { mathEditorResultText } from './mathEditorResult.js';

const input = { identity: { documentId: 'bounds', documentVersion: 1, editorId: 'X', inputRevision: 0 },
  source: 'sup(ℕ)', notation: 'text' as const, angleUnit: 'radian' as const };
function view(evaluation: MathEvaluation) {
  const snapshot: MathEditorSnapshot = { state: { status: 'evaluated', input,
    output: { input, definition: null, evaluation }, canApply: false }, query: '', problem: null };
  return mathEditorResultText(snapshot);
}
describe('集合の無限の上下限を座標用数値とは区別して表示する', () => {
  it.each(['positive','negative'])('%sの無限大は記号と適用できない理由を表示する', sign => {
    const positive: MathNode = { kind: 'constant', name: 'infinity' };
    const result = view({ status: 'value', kind: 'infinite-bound', expression: sign === 'positive' ? positive
      : { kind: 'operation', operation: 'negate', operands: [positive] } });
    expect(result.message).toBe(sign === 'positive' ? '= +∞' : '= −∞');
    expect(result.detail).toContain('無限大は座標には使えません');
    expect(result.busy).toBe(false);
    expect(result.hasError).toBe(false);
  });
});
