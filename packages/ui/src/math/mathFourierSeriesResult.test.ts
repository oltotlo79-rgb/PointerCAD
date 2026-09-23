import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMathBackend, executeExactMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { mathFourierSeriesResult } from './mathFourierSeriesResult.js';

describe('フーリエ部分和の実結果を係数と収束条件で説明する', () => {
  it.each([
    { source: 'fourierseries(x,x,-pi,pi,2)', message: 'フーリエ部分和（最高次数） N=2',
      coefficients: 'a[1..N]=[0, 0]、b[1..N]=[2, -1]', convergence: '周期の両端での収束先: 0。' },
    { source: 'fourierseries(ln(x),x,0,1,0)', message: 'フーリエ部分和（最高次数） N=0',
      coefficients: '定数項 a0/2: -1。', convergence: '無限級数の点ごとの収束は未確認です。' },
  ])('$sourceの実計算から説明全文を照合する', async ({ source, message, coefficients, convergence }) => {
    const backend = createMathBackend();
    const request = { identity: { documentId: 'fourier-display', documentVersion: 1, editorId: 'X', inputRevision: 1 },
      source, notation: 'text' as const, angleUnit: 'degree' as const, coefficients: [] };
    const raw = await executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, {
      backend, shouldStop: () => undefined, engine: { evaluate: (expression, angleUnit) => {
        const script = fileURLToPath(new URL('../../../expression/src/math/exactRuntime/cas_fourier_series_test.py', import.meta.url));
        const result = spawnSync('python', ['-B', '-X', 'utf8', script, '--batch'], {
          input: JSON.stringify([{ expression, angleUnit }]), encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
        });
        if (result.status !== 0 || result.error !== undefined) throw new Error(result.stderr || result.error?.message);
        const replies: unknown = JSON.parse(result.stdout);
        if (!Array.isArray(replies) || replies.length !== 1) throw new Error('級数の返信数が不正です。');
        return Promise.resolve(replies[0]);
      } },
    });
    const evaluation = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result.evaluation;
    if (evaluation.status !== 'value' || evaluation.kind !== 'fourier-series') throw new Error(JSON.stringify(evaluation));
    const displayed = mathFourierSeriesResult(evaluation);
    expect(displayed.message).toBe(message);
    expect(displayed.detail).toContain(coefficients);
    expect(displayed.detail).toContain(convergence);
    expect(displayed.detail).toContain('元の関数と部分和の誤差は保証しません。');
    expect(displayed.detail).toContain('fourierat');
    expect(displayed.detail).not.toMatch(/(?:Power|Multiply|Add)\(/u);
  }, 45_000);
});
