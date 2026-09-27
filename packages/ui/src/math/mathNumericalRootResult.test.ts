import { describe, expect, it } from 'vitest';
import { createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { mathNumericalRootResult } from './mathNumericalRootResult.js';

const select = '候補は小さい順です。rootinterval(...,番号)で[下限,上限]を選び、component(...,1または2)で上下限を使えます。上下限は解そのものの正確な値ではありません。未解決の範囲がある場合は選択できません。表示の小数は区間を狭めない向きに丸めます。';
describe('数値の解を区間と未解決の範囲で表示する', () => {
  it.each([
    { source: 'numericroots(x,x,-1,1,0.000001)', message: '指定範囲の解を区間で確認しました。',
      detail: `探索範囲: -1 ≤ x ≤ 1。区間の幅の上限: 0.000001。\n候補 1: -1e-323 ≤ x ≤ 1e-323\n${select}` },
    { source: 'numericroots(x^2+1,x,-1,1,0.000001)', message: '指定した範囲に解はありません。',
      detail: `探索範囲: -1 ≤ x ≤ 1。区間の幅の上限: 0.000001。\n${select}` },
    { source: 'numericroots(0,x,-1,1,0.000001)', message: '判定できない範囲が残っています。解なしとは限りません。',
      detail: `探索範囲: -1 ≤ x ≤ 1。区間の幅の上限: 0.000001。\n未解決の範囲:\n-1 ≤ x ≤ 1 (範囲全体で0になる)\n${select}` },
  ])('$sourceの実計算から説明の全文を照合する', ({ source, message, detail }) => {
    const backend = createMathBackend();
    const request = { identity: { documentId: 'numeric-root-display', documentVersion: 1, editorId: 'X', inputRevision: 1 },
      source, notation: 'text' as const, angleUnit: 'degree' as const, coefficients: [] };
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
    const { evaluation } = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    if (evaluation.status !== 'value' || evaluation.kind !== 'root-intervals') throw new Error(JSON.stringify(evaluation));
    if (source === 'numericroots(x,x,-1,1,0.000001)') {
      expect(evaluation.intervals.roots).toHaveLength(1);
      const root = evaluation.intervals.roots[0];
      expect(root.lower).toBeLessThanOrEqual(0); expect(root.upper).toBeGreaterThanOrEqual(0);
      expect(root.upper - root.lower).toBeLessThanOrEqual(0.000001);
    }
    expect(mathNumericalRootResult(evaluation)).toEqual({ message, detail });
  });
});
