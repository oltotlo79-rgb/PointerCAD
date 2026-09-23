import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMathBackend, executeExactMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, type MathEvaluation } from '@pointercad/expression/math/contracts';
import { mathTransformResult } from './mathTransformResult.js';

describe('連続変換の実結果を利用者が読める式と条件で表示する', () => {
  it('負の数を底にした累乗を、累乗した後の負号と混同しない', () => {
    const binding = { variable: { role: 'bound', id: 's', label: 's' }, domain: { kind: 'unrestricted' } } as const;
    const evaluation: Extract<MathEvaluation, { kind: 'transform' }> = {
      status: 'value', kind: 'transform', expression: { kind: 'number', decimal: '0' },
      transform: { operation: 'laplace-transform', convention: 'laplace-unilateral',
        formula: { kind: 'binder', operation: 'lambda', bindings: [binding], body: { kind: 'operation', operation: 'power',
          operands: [{ kind: 'number', decimal: '-2' }, { kind: 'symbol', reference: binding.variable }] } },
        condition: { kind: 'binder', operation: 'lambda', bindings: [binding], body: { kind: 'constant', name: 'true' } },
      },
    };
    expect(mathTransformResult(evaluation).message).toBe('変換結果 F(s) = (-2)^s');
  });
  it.each([
    { source: 'laplace(exp(-x),x,S)', formula: '変換結果 F(S) = 1/(1 + S)', domain: '成立範囲: re(S) > -1。' },
    { source: 'inverselaplace(1/x,x,t)', formula: '変換結果 F(t) = 1', domain: '成立範囲: t > 0。' },
  ])('$sourceの実計算・返信と表示を照合する', async ({ source, formula, domain }) => {
    const backend = createMathBackend();
    const request = { identity: { documentId: 'transform-display', documentVersion: 1, editorId: 'X', inputRevision: 1 },
      source, notation: 'text' as const, angleUnit: 'degree' as const, coefficients: [] };
    const raw = await executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, {
      backend, shouldStop: () => undefined, engine: { evaluate: (expression, angleUnit) => {
        const script = fileURLToPath(new URL('../../../expression/src/math/exactRuntime/cas_transforms_test.py', import.meta.url));
        const result = spawnSync('python', ['-B', '-X', 'utf8', script, '--batch'], {
          input: JSON.stringify([{ expression, angleUnit }]), encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
        });
        if (result.status !== 0 || result.error !== undefined) throw new Error(result.stderr || result.error?.message);
        const replies: unknown = JSON.parse(result.stdout);
        if (!Array.isArray(replies) || replies.length !== 1) throw new Error('変換の返信数が不正です。');
        return Promise.resolve(replies[0]);
      } },
    });
    const result = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result.evaluation;
    if (result.status !== 'value' || result.kind !== 'transform') throw new Error(JSON.stringify(result));
    const displayed = mathTransformResult(result);
    expect(displayed.message).toBe(formula); expect(displayed.detail).toContain(domain);
    expect(displayed.detail).toContain('transformat');
  }, 45_000);
});
