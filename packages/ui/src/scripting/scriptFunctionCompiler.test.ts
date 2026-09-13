import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { createEmptyPartDocument } from '@pointercad/model';
import type { ScriptFunctionDefinition } from '@pointercad/model/scripting';
import { createScriptFunctionCompiler } from './scriptFunctionCompiler.js';
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const evaluate: MathWorkerClient['evaluate'] = request => Promise.resolve({
  status: 'result', identity: request.identity,
  result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(item => item.id)), declaredIds: new Set() }).result
});
const definition: ScriptFunctionDefinition = {
  angleUnit: 'degree', bounds: { X: ['-2', '2'], Y: ['-2', '2'], Z: ['-2', '2'] },
  tolerance: '0.01', formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: 'sin(X)', Z: '0' } }
};
describe('関数スクリプトを手入力と同じ実数学処理へ接続する', () => {
  it.each<ScriptFunctionDefinition['formula']>([
    definition.formula,
    { kind: 'parametric-curve', T: ['0', '360'], outputs: { X: 'cos(T)', Y: 'sin(T)', Z: '0' } },
    { kind: 'implicit-curve', fixedAxis: 'X', fixedCoordinate: '0', expression: 'Y^2+Z^2-1' },
    { kind: 'coordinate-surface', output: 'Y', expression: 'X*Z' },
    { kind: 'parametric-surface', U: ['-1', '1'], V: ['-1', '1'], outputs: { X: 'U', Y: 'V', Z: 'U*V' } },
    { kind: 'implicit-surface', expression: 'X^2+Y^2+Z^2-1' },
  ])('$kindの変数を区別し、全範囲と式を保存する', async (formula) => {
    const dispose = vi.fn(), compile = createScriptFunctionCompiler(() => ({ evaluate, dispose }));
    const document = createEmptyPartDocument(), before = JSON.stringify(document);
    const result = await compile(document, { ...definition, formula }, () => false);
    expect(result.definition.formula.kind).toBe(formula.kind);
    for (const axis of ['X', 'Y', 'Z'] as const)
      expect(result.definition.bounds[axis]).toMatchObject({ min: { source: '-2', value: -2 }, max: { source: '2', value: 2 } });
    expect(result.definition.tolerance).toMatchObject({ source: '0.01', value: 0.01 });
    expect(dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(document)).toBe(before);
  });
  it.each(['degree', 'radian'] as const)('角度%sと軸X・係数Xを混同しない', async (angleUnit) => {
    const document = {
      ...createEmptyPartDocument(), parameters: [{
        name: 'X', mathId: 'coefficient:x',
        unit: 'none' as const, value: expressionValueFromNumber(2), description: ''
      }]
    };
    const compile = createScriptFunctionCompiler(() => ({ evaluate, dispose: vi.fn() }));
    const result = await compile(document, {
      ...definition, angleUnit, formula: {
        kind: 'coordinate-curve', independent: 'X', outputs: { Y: 'coef("X")*sin(X)', Z: '0' },
      }
    }, () => false);
    const formula = result.definition.formula;
    if (formula.kind !== 'coordinate-curve' || formula.independent !== 'X')
      throw new Error('Wrong curve');
    expect(formula.outputs.Y).toMatchObject({ source: 'coef("X")*sin(X)', angleUnit });
    expect(result.document.parameters[0].mathId).toBe('coefficient:x');
  });
  it.each(['1/0', '', '2'])('Z最小値%sで範囲を確定できなければ文書を返さず解放する', async (minimum) => {
    const dispose = vi.fn(), compile = createScriptFunctionCompiler(() => ({ evaluate, dispose }));
    await expect(compile(createEmptyPartDocument(), { ...definition, bounds: { ...definition.bounds, Z: [minimum, '2'] } }, () => false)).rejects.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('未指定の変数Tと、不正なXYZ出力式を拒否する', async () => {
    const compile = createScriptFunctionCompiler(() => ({ evaluate, dispose: vi.fn() }));
    await expect(compile(createEmptyPartDocument(), {
      ...definition, formula: {
        kind: 'coordinate-curve', independent: 'X', outputs: { Y: 'T', Z: '0' },
      }
    }, () => false)).rejects.toThrow();
  });
  it('中止は次の式を評価せず、計算部を一度だけ解放する', async () => {
    let cancelled = false;
    const dispose = vi.fn(), run = vi.fn<MathWorkerClient['evaluate']>(async (...args) => {
      const result = await evaluate(...args);
      cancelled = true;
      return result;
    });
    const compile = createScriptFunctionCompiler(() => ({ evaluate: run, dispose }));
    await expect(compile(createEmptyPartDocument(), definition, () => cancelled)).rejects.toThrow('中止');
    expect(run).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
