import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend, executeExactMathWorkRequest, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { mathEquationSystemResult } from './mathEquationSystemResult.js';

const examples = [
  { source: 'solvesystem([x+y=3,x-y=1],[x,y],ℝ)', row: '候補 1: x = 2, y = 1。値を指定する変数の順番: なし。成立条件: 指定範囲の有限な値' },
  { source: 'solvesystem([x+y=2],[x,y],ℝ)', row: '候補 1: x = 2 - y, y = y。値を指定する変数の順番: y。成立条件: 指定範囲の有限な値' },
  { source: 'solvesystem([x*y=1],[x,y],ℝ)', row: '候補 1: x = 1/y, y = y。値を指定する変数の順番: y。成立条件: y ≠ 0' },
  { source: 'solvesystem([x+y=2,x+y=3],[x,y],ℝ)', row: '' },
];
const backend = createMathBackend();
const request = (source: string) => ({ identity: { documentId: 'system-display', documentVersion: 1, editorId: 'X', inputRevision: 1 },
  source, notation: 'text' as const, angleUnit: 'degree' as const, coefficients: [] });
let results: readonly unknown[];
beforeAll(() => {
  const payloads = examples.map(({ source }) => {
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: request(source) }, backend);
    if (reply.expression === null) throw new Error('式を読めません');
    return { expression: reply.expression, angleUnit: 'degree' };
  });
  const script = fileURLToPath(new URL('../../../expression/src/math/exactRuntime/cas_equation_systems_test.py', import.meta.url));
  const output = spawnSync('python', ['-B', '-X', 'utf8', script, '--batch'], {
    input: JSON.stringify(payloads), encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (output.status !== 0 || output.error !== undefined) throw new Error(output.stderr || output.error?.message);
  const decoded: unknown = JSON.parse(output.stdout);
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('返信数が一致しません');
  results = decoded;
}, 45_000);
describe('複数の方程式の実結果に候補・自由変数・条件を表示する', () => {
  it.each(examples)('$sourceの表示を確認する', async example => {
    const input = request(example.source);
    const raw = await executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, {
      backend, shouldStop: () => undefined,
      engine: { evaluate: () => Promise.resolve(results[examples.indexOf(example)]) },
    });
    const result = decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'equation-system' });
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'equation-system') throw new Error('解がありません');
    const display = mathEquationSystemResult(result.evaluation);
    expect(display.message).toBe(example.row === '' ? '指定した範囲に解はありません。' : '複数の方程式の解');
    expect(display.detail).toBe(`指定範囲: ℝ。${example.row}\nsystemsolution(...,候補番号,[自由変数の値])で選び、component(...,成分番号)で座標に使う成分を指定します。番号は1からです。有限個の解は未知数の順に実部、次に虚部の小さい順、自由変数がある場合は表示順です。条件を満たさない値は使えません。`);
  });
});
