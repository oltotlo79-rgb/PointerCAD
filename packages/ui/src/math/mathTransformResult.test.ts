import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMathBackend, executeExactMathWorkRequest } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, type MathEvaluation } from '@pointercad/expression/math/contracts';
import { mathTransformResult, readableMathResult } from './mathTransformResult.js';

describe('指数がちょうど1の累乗は底だけを表示し、不要な^1を付けない（MC-21で見つかった表示不具合）', () => {
  it('底がsqrt(30)で指数が1の場合、^1を付けずsqrt(30)とだけ表示する', () => {
    const root = { kind: 'operation' as const, operation: 'sqrt', operands: [{ kind: 'number' as const, decimal: '30' }] };
    const power = { kind: 'operation' as const, operation: 'power', operands: [root, { kind: 'number' as const, decimal: '1' }] };
    expect(readableMathResult(power)).toBe('sqrt(30)');
  });
  it('底が和のように優先順位の低い式でも、指数1は底の表示をそのまま使う（余分な括弧を付けない）', () => {
    const sum = { kind: 'operation' as const, operation: 'add',
      operands: [{ kind: 'number' as const, decimal: '1' }, { kind: 'number' as const, decimal: '2' }] };
    const power = { kind: 'operation' as const, operation: 'power', operands: [sum, { kind: 'number' as const, decimal: '1' }] };
    expect(readableMathResult(power)).toBe('1 + 2');
  });
  it('指数が1以外(2、-1、10)のときは従来どおり^表記または逆数のまま表示する', () => {
    const base = { kind: 'symbol' as const, reference: { role: 'declared' as const, id: 'a', label: 'a' } };
    const powered = (decimal: string) => readableMathResult({ kind: 'operation' as const, operation: 'power',
      operands: [base, { kind: 'number' as const, decimal }] });
    expect(powered('2')).toBe('a^2');
    expect(powered('-1')).toBe('1/a');
    expect(powered('10')).toBe('a^10');
  });
});

describe('|x| の行列の読み方の実計算の候補を、模擬でなく実計算部の返信で表示まで確かめる（MC-21のE2Eで見つかった不具合）', () => {
  it('|[[1,2],[3,4]]|の実計算は行列式-2とノルムsqrt(30)を候補にし、ノルム側に^1を付けない', async () => {
    const backend = createMathBackend();
    const request = { identity: { documentId: 'candidate-display', documentVersion: 1, editorId: 'X', inputRevision: 1 },
      source: '|[[1,2],[3,4]]|', notation: 'text' as const, angleUnit: 'radian' as const, coefficients: [] };
    const raw = await executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, {
      backend, shouldStop: () => undefined, engine: { evaluate: (expression, angleUnit) => {
        const script = fileURLToPath(new URL('../../../expression/src/math/exactRuntime/cas_transforms_test.py', import.meta.url));
        const result = spawnSync('python', ['-B', '-X', 'utf8', script, '--batch'], {
          input: JSON.stringify([{ expression, angleUnit }]), encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
        });
        if (result.status !== 0 || result.error !== undefined) throw new Error(result.stderr || result.error?.message);
        const replies: unknown = JSON.parse(result.stdout);
        if (!Array.isArray(replies) || replies.length !== 1) throw new Error('計算の返信数が不正です。');
        return Promise.resolve(replies[0]);
      } },
    });
    const result = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result.evaluation;
    if (result.status !== 'multiple') throw new Error(JSON.stringify(result));
    expect(result.candidates.map(readableMathResult)).toEqual(['-2', 'sqrt(30)']);
  }, 45_000);
});

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
