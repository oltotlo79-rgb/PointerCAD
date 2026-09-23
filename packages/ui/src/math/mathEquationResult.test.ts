import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMathBackend, executeExactMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { mathEquationResult } from './mathEquationResult.js';

const selection = '有限個の解から使うものをsolution(...,番号)で選びます。番号は1から、実部、次に虚部の小さい順です。';
describe('方程式の実結果を解集合と重複度で示す', () => {
  it('数値の結果を解集合の形式として参照しない', () => {
    expect(mathEquationResult({ status: 'value', kind: 'real', exact: null, decimal: '2', coordinate: 2, approximation: null },
      { kind: 'operation', operation: 'solve-equation', operands: [] })).toBeNull();
  });
  it.each([
    { source: 'solve(x^2=1,x,ℝ)', message: '解集合: {-1, 1}', detail: `指定範囲: ℝ。${selection}` },
    { source: 'solve(1/x>0,x,ℝ)', message: '解集合: (0, ∞)', detail: `指定範囲: ℝ。${selection}` },
    { source: 'solve(x/x=1,x,ℝ)', message: '解集合: (-∞, 0) ∪ (0, ∞)', detail: `指定範囲: ℝ。${selection}` },
    { source: 'solve(x=x,x,ℝ)', message: '解集合: ℝ', detail: `指定範囲: ℝ。${selection}` },
    { source: 'solve(sqrt(x)=-1,x,ℝ)', message: '指定した範囲に解はありません。', detail: `指定範囲: ℝ。${selection}` },
    { source: 'polynomialroots((x-1)^2*(x+2),x,ℂ)', message: '多項式の根と重複度',
      detail: '-2 (重複度: 1)、1 (重複度: 2)。各行の1列目は根、2列目は重複度です。component(...,行,列)で選びます。行は実部、次に虚部の小さい順です。' },
  ])('$sourceの計算と表示の全文を確認する', async ({ source, message, detail }) => {
    const backend = createMathBackend();
    const request = { identity: { documentId: 'equation-display', documentVersion: 1, editorId: 'X', inputRevision: 1 },
      source, notation: 'text' as const, angleUnit: 'degree' as const, coefficients: [] };
    const raw = await executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, {
      backend, shouldStop: () => undefined, engine: { evaluate: (expression, angleUnit) => {
        const script = fileURLToPath(new URL('../../../expression/src/math/exactRuntime/cas_equations_test.py', import.meta.url));
        const output = spawnSync('python', ['-B', '-X', 'utf8', script, '--batch'], {
          input: JSON.stringify([{ expression, angleUnit }]), encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
        });
        if (output.status !== 0 || output.error !== undefined) throw new Error(output.stderr || output.error?.message);
        const replies: unknown = JSON.parse(output.stdout);
        if (!Array.isArray(replies) || replies.length !== 1) throw new Error('方程式の返信数が不正です。');
        return Promise.resolve(replies[0]);
      } },
    });
    const result = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(mathEquationResult(result.evaluation, result.definition?.expression)).toEqual({ message, detail });
  }, 45_000);
});
