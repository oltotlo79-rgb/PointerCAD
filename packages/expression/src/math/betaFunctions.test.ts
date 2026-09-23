import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { BETA_FUNCTION_REFERENCES } from './betaFunctionReferences.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import type { MathNode } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function request(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  return { source, angleUnit, notation: 'text' as const, coefficients: [],
    identity: { documentId: 'beta-functions', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
}
function evaluate(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  const input = request(source, angleUnit), raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
  return decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
}
function value(source: string) {
  const result = evaluate(source).evaluation;
  if (result.status !== 'value' || result.kind !== 'real') throw new Error(source+': '+JSON.stringify(result));
  return result.coordinate;
}

describe('Betaの二つの正の引数と元の式を入力・追加計算・保存へ渡す', () => {
  it.each(BETA_FUNCTION_REFERENCES.filter(([, , text]) => Number.isFinite(Number(text)) && Number(text) !== 0))(
    'Beta(%s,%s)を独立な計算値へ照合する', (a, b, expected) => {
      expect(Math.abs(value(`beta(${a},${b})`)/Number(expected)-1)).toBeLessThan(5e-14);
    });
  it('結果全文・分数・合成と角度の意味を保つ', () => {
    expect(value('beta(1,4)')).toBe(0.25);
    expect(JSON.stringify(evaluate('beta(0.5,0.5)').evaluation)).toContain('3.141592653589793238462643383279502884197');
    expect(JSON.stringify(evaluate('beta(2,3)').evaluation)).toContain('0.08333333333333333333333333333333333333333');
    expect(evaluate('beta(0.5,0.5)', 'degree').evaluation).toEqual(evaluate('beta(0.5,0.5)', 'radian').evaluation);
    expect(value('beta(sin(30),0.5)')).toBeCloseTo(Math.PI, 14);
    expect(value('beta(sqrt(2),1)')).toBeCloseTo(1/Math.sqrt(2), 14);
    expect(value('beta(beta(1,2),0.5)')).toBeCloseTo(Math.PI, 14);
  });
  it('構造入力との意味の一致と、保存した原文の往復を確認する', () => {
    const source = '2*beta(2,3)+beta(1,4)', input = { ...request(source), presentationNotation: 'latex' as const };
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
  it.each([
    ['beta(0,1)', 'domain', 'Beta関数の引数はどちらも正の実数で指定してください。'],
    ['beta(1,-0.5)', 'domain', 'Beta関数の引数はどちらも正の実数で指定してください。'],
    ['beta(true,1)', 'domain', 'Beta関数の引数はどちらも実数の式で指定してください。'],
    ['beta(1,[1])', 'domain', 'Beta関数の引数はどちらも実数の式で指定してください。'],
    ['beta(∞,1)', 'domain', 'Beta関数の引数は有限の値で指定してください。'],
    ['beta(1,i)', 'unsupported', 'Beta関数の複素引数の数値計算にはまだ対応していません。'],
  ] as const)('%sの不成立を0倍や成分選択で隠さない', (source, reason, detail) => {
    for (const formula of [source, `0*${source}`, `component([7,${source}],1)`]) {
      expect(evaluate(formula).evaluation).toEqual({ status: 'invalid', reason, detail });
    }
  });
  it('丸める前の和の上限と、内側の0割りを確認する', () => {
    for (const source of ['beta(1/0,1)','0*beta(1,sqrt(-1))']) expect(evaluate(source).evaluation.status).not.toBe('value');
    expect(evaluate('0*beta(20000,1e-100)').evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
    expect(value('beta(19999,1)')).toBe(1/19999);
  });
  it('固定計算部の点の微分・混合微分・級数と元の正の領域を確認する', () => {
    const script = fileURLToPath(new URL('./exactRuntime/cas_beta_functions_test.py', import.meta.url));
    const execution = spawnSync('python', ['-B', '-X', 'utf8', script], { encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
    expect(execution.error, execution.stderr).toBeUndefined(); expect(execution.status, execution.stderr).toBe(0);
  }, 90_000);
  it('実際の追加計算の返信を数値へ渡し、保存再開でも原式と厳密な答えを保つ', async () => {
    const engine = { evaluate(expression: MathNode, angleUnit: 'degree' | 'radian'): Promise<unknown> {
      const script = fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py', import.meta.url));
      const execution = spawnSync('python', ['-B', '-X', 'utf8', script, '--batch'], {
        input: JSON.stringify([{ expression, angleUnit }]), encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      });
      if (execution.error !== undefined || execution.status !== 0) throw new Error(execution.stderr);
      const replies: unknown = JSON.parse(execution.stdout);
      if (!Array.isArray(replies) || replies.length !== 1) throw new Error('Betaの返信数が一致しません。');
      return Promise.resolve(replies[0]);
    } };
    for (const [source, expected] of [
      ['derivativeat(beta(x,1),x,1)', -1],
      ['derivativeat(beta(x,1),x,1,2)', 2],
      ['component(gradientat(beta(x,y),[x,y],[1,1]),2)', -1],
      ['component(hessianat(beta(x,y),[x,y],[1,1]),1,2)', 2-Math.PI**2/6],
    ] as const) {
      const input = request(source), envelope = { kind: 'evaluate-math', serial: 4, request: input };
      const raw = await executeExactMathWorkRequest(envelope, { backend, engine, shouldStop: () => undefined });
      const result = decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID,
        coefficientIds: new Set(), declaredIds: new Set() }).result;
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real' || result.definition === null) throw new Error(JSON.stringify(result));
      expect(result.evaluation.coordinate).toBeCloseTo(expected, 12); expect(result.evaluation.exact).not.toBeNull();
      expect(result.definition.source).toBe(source);
      const saved: unknown = JSON.parse(JSON.stringify({ ...envelope, request: { ...input, definition: result.definition } }));
      const reopened = await executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined });
      expect(reopened.source).toBe(source); expect(reopened.evaluation).toEqual(raw.evaluation);
    }
  }, 90_000);
});
