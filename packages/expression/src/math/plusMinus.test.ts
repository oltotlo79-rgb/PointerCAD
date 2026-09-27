import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { decodeStoredMathStructure } from './decodeStoredMath.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { formatMathText } from './formatMathText.js';
import { coordinateFromMath, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { mathScalarExpression, mathScalarValue } from './mathScalarExpression.js';
import { executeMathWorkRequest } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { expandPlusMinus, MAX_PLUS_MINUS_CANDIDATES, plusMinusEvaluation } from './plusMinus.js';
import { rationalOfExpression } from './exactRational.js';
import * as preparation from './prepareMathCalculation.js';

afterEach(() => { vi.restoreAllMocks(); });

const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(['a']), declaredIds: new Set<string>() };
function request(source: string, changes: Partial<MathWorkRequest> = {}): MathWorkRequest {
  return { identity: { documentId: 'part', documentVersion: 1, editorId: 'X', inputRevision: 1 },
    source, notation: 'text', angleUnit: 'radian', coefficients: [{ id: 'a', label: 'a', decimal: '4' }], ...changes };
}
function evaluate(source: string, changes: Partial<MathWorkRequest> = {}) {
  const input = request(source, changes);
  return decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, input), createMathBackend()), input, context).result;
}
function candidates(result: MathEvaluation): readonly MathNode[] {
  expect(result.status).toBe('multiple');
  if (result.status !== 'multiple') throw new Error(JSON.stringify(result));
  expect(result.exhaustive).toBe(true);
  expect(result).not.toHaveProperty('coordinate');
  return result.candidates;
}
function rationalValues(result: MathEvaluation): readonly number[] {
  return candidates(result).map(node => {
    const rational = rationalOfExpression(node);
    if (rational === null) throw new Error(JSON.stringify(node));
    return Number(rational.numerator) / Number(rational.denominator);
  });
}
const number = (decimal: string): MathNode => ({ kind: 'number', decimal });

describe('±・∓の候補を計算し、一意な座標と混同しない', () => {
  it.each([
    ['1±2', [3, -1]], ['1∓2', [-1, 3]], ['±2', [2, -2]], ['∓2', [-2, 2]],
    ['1±(2±3)', [6, 0, -4, 2]],
    ['plusminus(1,2)', [3, -1]], ['minusplus(1,2)', [-1, 3]],
    ['plusminus(2)', [2, -2]], ['minusplus(2)', [-2, 2]],
    ['plusminus(0)', [0, 0]], ['plusminus(1,0)', [1, 1]],
    ['plusminus(1,plusminus(2,3))', [6, 0, -4, 2]],
    ['plusminus(1,2)+minusplus(4,8)', [-1, 15, -5, 11]],
    ['2*plusminus(1,2)', [6, -2]], ['0*plusminus(1,2)', [0, 0]],
    ['plusminus(1/3,1/6)', [1/2, 1/6]],
    ['sum(plusminus(k),k,1,3)', [6, -6]],
    ['sum(k,k,1,plusminus(2,1))', [6, 1]],
    ['component([7,plusminus(1,2)],2)', [3, -1]],
    ['component([7,plusminus(1,2)],1)', [7, 7]],
  ] as const)('%sを全ての符号の候補として保持する', (source, expected) => {
    const output = evaluate(source);
    expect(output.definition?.source).toBe(source);
    expect(rationalValues(output.evaluation)).toEqual(expected);
    expect(mathScalarExpression(output).ok).toBe(false);
    expect(mathScalarValue(output.evaluation).ok).toBe(false);
    expect(() => coordinateFromMath(output.evaluation)).toThrow();
  });

  it('分数を丸めず候補に保持する', () => {
    const values = candidates(evaluate('plusminus(1/3,1/6)').evaluation).map(node => rationalOfExpression(node));
    expect(values).toEqual([{ numerator: 1n, denominator: 2n }, { numerator: 1n, denominator: 6n }]);
  });
  it('複素候補を実数へ変換せず、実部を明示しても符号の選択を求める', () => {
    const result = evaluate('plusminus(1,i)').evaluation;
    expect(candidates(result)).toHaveLength(2);
    expect(mathScalarValue(result).ok).toBe(false);
    expect(rationalValues(evaluate('im(plusminus(1,i))').evaluation)).toEqual([1, -1]);
  });
  it('角度の規約を候補ごとに一度だけ適用する', () => {
    expect(rationalValues(evaluate('plusminus(sin(30),1)', { angleUnit: 'degree' }).evaluation)).toEqual([1.5, -0.5]);
  });
  it.each([
    [String.raw`\operatorname{plusminus}\left(1,2\right)`, [3, -1]],
    [String.raw`1\pm2`, [3, -1]], [String.raw`1\mp2`, [-1, 3]],
  ] as const)('構造入力%sにも同じ候補を返す', (source, expected) => {
    expect(rationalValues(evaluate(source, { notation: 'latex' }).evaluation)).toEqual(expected);
  });
  it('元の式と係数の識別を保存往復し、係数を変えると候補を再計算する', () => {
    const source = 'plusminus(coef("a"),2)', output = evaluate(source);
    expect(rationalValues(output.evaluation)).toEqual([6, 2]);
    expect(output.definition).not.toBeNull();
    const stored: unknown = JSON.parse(JSON.stringify(output.definition));
    const definition = decodeStoredMathStructure(stored, context);
    expect(definition).toEqual(output.definition);
    expect(JSON.stringify(definition.expression)).toContain('coefficient');
    expect(rationalValues(evaluate(source, { definition }).evaluation)).toEqual([6, 2]);
    expect(rationalValues(evaluate(source, { definition, coefficients: [{ id: 'a', label: 'a', decimal: '8' }] }).evaluation)).toEqual([10, 6]);
  });
  it('符号を明示した元の式なら座標に使え、再保存でも符号を保つ', () => {
    for (const [source, expected] of [['coef("a")+2', 6], ['coef("a")-2', 2]] as const) {
      const output = evaluate(source);
      expect(mathScalarExpression(output)).toMatchObject({ ok: true, value: { value: expected } });
      expect(output.definition).not.toBeNull();
      const definition = decodeStoredMathStructure(JSON.parse(JSON.stringify(output.definition)), context);
      expect(evaluate(source, { definition }).evaluation).toEqual(output.evaluation);
    }
  });
  it.each(['1/plusminus(1,1)', '0*(1/plusminus(1,1))',
    'component([7,1/plusminus(1,1)],1)', 'plusminus(1,1/0)'])(
    '%sの一方の不成立を消して成功した候補だけを返さない', source => {
      expect(evaluate(source).evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    });
  it.each(['plusminus(true)', 'plusminus([1,2])', '0*plusminus({1,2})'])(
    '%sの数でない引数を座標へ通さない', source => {
      const output = evaluate(source);
      expect(output.evaluation.status).not.toBe('value');
      expect(output.evaluation.status).not.toBe('multiple');
    });
  it('5個の符号による32候補を保持し、6個目は計算前に理由付きで拒否する', () => {
    const source = Array.from({ length: 5 }, (_, index) => `plusminus(${String(2 ** index)})`).join('+');
    const values = rationalValues(evaluate(source).evaluation);
    expect(values).toHaveLength(MAX_PLUS_MINUS_CANDIDATES);
    expect([...new Set(values)].sort((a, b) => a - b)).toEqual(Array.from({ length: 32 }, (_, index) => 2 * index - 31));
    const backend = createMathBackend(), box = vi.spyOn(backend, 'box');
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request(`${source}+plusminus(32)`)), backend);
    expect(reply.evaluation).toEqual({ status: 'stopped', reason: 'budget' });
    const expression = reply.expression;
    if (expression === null) throw new Error('Missing source');
    expect(() => expandPlusMinus(expression)).toThrow('32');
    expect(box).not.toHaveBeenCalled();
  });
  it('符号数が少なくても全枝を合わせた構造の上限を生成前に検査する', () => {
    const list: MathNode = { kind: 'operation', operation: 'list', operands: Array.from({ length: 150 }, () => number('1')) };
    const choice: MathNode = { kind: 'operation', operation: 'plus-minus', operands: [number('1')] };
    const source: MathNode = { kind: 'operation', operation: 'list', operands: [list, ...Array.from({ length: 5 }, () => choice)] };
    expect(() => expandPlusMinus(source)).toThrow('4096');
  });
  it('符号がない式の経路を変えない', () => {
    expect(expandPlusMinus(number('3'))).toBeNull();
    expect(evaluate('1+2').evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 3 });
  });
  it.each([
    'which(1<2,3,2<1,plusminus(1,2))',
    'which(false,plusminus(1,2),true,3)',
    `which(true,3,true,${Array.from({ length: 6 }, () => 'plusminus(1)').join('+')})`,
  ])('%sの選ばれない枝の符号を候補にも上限にも数えない', source => {
    const output = evaluate(source, { angleUnit: 'degree' });
    expect(output.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 3 });
    expect(output.definition?.source).toBe(source);
  });
  it.each([
    ['which(plusminus(1)>0,3,true,4)', [3, 4]],
    ['which(true,plusminus(1,2),true,4)', [3, -1]],
    ['plusminus(which(true,3,true,plusminus(1,2)),1)', [4, 2]],
  ] as const)('%sの条件や選んだ枝の符号は候補として保持する', (source, expected) => {
    expect(rationalValues(evaluate(source).evaluation)).toEqual(expected);
  });
  it('通常計算でまだ決まらない条件は、符号のない基準式と同じく未確定のまま座標へ通さない', () => {
    for (const source of ['which(sin(30)=1/2,3,true,2)', 'which(sin(30)=1/2,3,true,plusminus(1,2))']) {
      const output = evaluate(source, { angleUnit: 'degree' });
      expect(output.evaluation).toMatchObject({ status: 'unresolved', reason: 'missing-condition', names: ['which'] });
      expect(mathScalarExpression(output).ok).toBe(false);
    }
  });
  it.each([['plusminus(1,2)', 120, 'stopped'], ['plusminus(gamma(1),1)', 250, 'multiple']] as const)(
    '%sは候補間で親の期限を共有し、元の高精度関数の期限も保つ', (source, delay, status) => {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const prepare = preparation.prepareMathCalculation;
      vi.spyOn(preparation, 'prepareMathCalculation').mockImplementation((...args) => { now += delay; return prepare(...args); });
      expect(evaluate(source).evaluation.status).toBe(status);
    });
  it('未選択の符号を関数作図の定義へ通さない', () => {
    const result = evaluate('plusminus(X,1)', { functionScope: { axes: ['X'], parameters: [] } }).evaluation;
    expect(result).toMatchObject({ status: 'invalid', reason: 'unsupported' });
    if (result.status !== 'invalid') throw new Error(JSON.stringify(result));
    expect(result.detail).toContain('符号');
  });
  it('未確定・不成立・中止を候補の一部として隠さない', () => {
    const unknown: MathEvaluation = { status: 'unresolved', reason: 'unevaluated', names: [] };
    const invalid: MathEvaluation = { status: 'invalid', reason: 'domain', detail: 'undefined branch' };
    const stopped: MathEvaluation = { status: 'stopped', reason: 'deadline' };
    const branch = (evaluation: MathEvaluation) => ({ expression: number('1'), evaluation });
    expect(plusMinusEvaluation([branch(unknown), branch(invalid)])).toEqual(invalid);
    expect(plusMinusEvaluation([branch(invalid), branch(stopped)])).toEqual(stopped);
  });
  it('推定値の小数を厳密値の候補にすり替えない', () => {
    const expression: MathNode = { kind: 'operation', operation: 'sin', operands: [number('1')] };
    const result = plusMinusEvaluation([{ expression, evaluation: { status: 'value', kind: 'real', exact: null,
      decimal: '0.84', coordinate: 0.84, approximation: { absoluteError: null } } }]);
    expect(candidates(result)).toEqual([expression]);
  });
  it('追加計算を要する候補も一括で実計算し、原式と保存往復を保持する', async () => {
    const engine = sharedExactEngine(exactRuntimeBatch(fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py', import.meta.url)), 60_000));
    const evaluateMany = vi.spyOn(engine, 'evaluateMany');
    const inputs = ['plusminus(derivativeat(x^3,x,2),1)', 'derivativeat(plusminus(x^3,x),x,2)'].map(source => request(source));
    const results = await Promise.all(inputs.map(input => executeExactMathWorkRequest(createMathWorkEnvelope(1, input),
      { backend: createMathBackend(), engine, shouldStop: () => undefined })));
    for (const [index, reply] of results.entries()) {
      const output = decodeMathWorkReply(reply, inputs[index], context).result;
      expect(rationalValues(output.evaluation)).toEqual([13, 11]);
      expect(output.definition?.source).toBe(inputs[index].source);
      expect(mathScalarExpression(output).ok).toBe(false);
    }
    expect(evaluateMany).toHaveBeenCalledTimes(2);
    const reopened = await Promise.all(results.map((reply, index) => {
      const definition = decodeMathWorkReply(reply, inputs[index], context).result.definition;
      if (definition === null) throw new Error('Missing original expression');
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...inputs[index], definition })));
      return executeExactMathWorkRequest(saved, { backend: createMathBackend(), engine, shouldStop: () => undefined });
    }));
    expect(reopened.map(reply => reply.evaluation)).toEqual(results.map(reply => reply.evaluation));
  }, 90_000);
  it('追加計算後の取消では候補を返さない', async () => {
    let cancelled = false;
    const evaluateMany = vi.fn(() => { cancelled = true; return Promise.resolve([]); });
    const result = await executeExactMathWorkRequest(createMathWorkEnvelope(1, request('plusminus(derivativeat(x^3,x,2),1)')),
      { backend: createMathBackend(), engine: { evaluate: () => Promise.resolve(null), evaluateMany },
        shouldStop: () => cancelled ? 'cancelled' : undefined });
    expect(evaluateMany).toHaveBeenCalledTimes(1);
    expect(result.evaluation).toEqual({ status: 'stopped', reason: 'cancelled' });
  });
  it('候補返信が欠けたときは部分的な解を返さない', async () => {
    const result = await executeExactMathWorkRequest(createMathWorkEnvelope(1, request('plusminus(derivativeat(x^3,x,2),1)')),
      { backend: createMathBackend(), engine: { evaluate: () => Promise.resolve(null), evaluateMany: () => Promise.resolve([]) },
        shouldStop: () => undefined });
    expect(result.evaluation).toMatchObject({ status: 'invalid', reason: 'unsupported' });
    if (result.evaluation.status !== 'invalid') throw new Error(JSON.stringify(result.evaluation));
    expect(result.evaluation.detail).toContain('数が一致');
  });
  it('候補の式は通常入力へ表示して再評価できる', () => {
    for (const node of candidates(evaluate('plusminus(1,2)').evaluation)) {
      expect(evaluate(formatMathText(node, CANDIDATE_MATH_BY_ID)).evaluation).toMatchObject({ status: 'value', kind: 'real' });
    }
  });
});
