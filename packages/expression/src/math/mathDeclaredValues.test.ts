import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { createMathWorkEnvelope, decodeMathWorkRequest, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { decodeMathDeclarations, type MathDeclaration } from './mathDeclarations.js';
import { originalCoefficientExpression } from './mathCoefficientExpression.js';
import { mathScalarExpression } from './mathScalarExpression.js';
import type { MathNode } from './mathInputContract.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

let backend: MathExecutionBackend;
const identity = { documentId: 'part', documentVersion: 2, editorId: 'value', inputRevision: 1 };
beforeAll(() => { backend = createMathBackend(); });
function declaration(type: MathDeclaration['type'], valueSource?: string): MathDeclaration {
  return { id: 'symbol:a', label: 'a_1', meaning: '明示した値', type, ...(valueSource === undefined ? {} : { valueSource }) };
}
function request(source: string, value: MathDeclaration): MathWorkRequest {
  return { identity, source, notation: 'text', angleUnit: 'degree', coefficients: [], declarations: [value] };
}
function decode(raw: ReturnType<typeof executeMathWorkRequest>, input: MathWorkRequest) {
  return decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
    coefficientIds: new Set(input.coefficients.map(value => value.id)), declaredIds: new Set(input.declarations?.map(value => value.id)) }).result;
}
function evaluate(source: string, type: MathDeclaration['type'], valueSource: string) {
  const input = request(source, declaration(type, valueSource));
  return decode(executeMathWorkRequest(createMathWorkEnvelope(1, input), backend), input);
}
const nativeResults = new Map<string, unknown>();
const native = { evaluate: (expression: MathNode,
  angleUnit: 'degree' | 'radian'): Promise<unknown> => {
  const payload = JSON.stringify([{ expression, angleUnit }]);
  if (nativeResults.has(payload)) return Promise.resolve(nativeResults.get(payload));
  const result = spawnExactRuntime(['-B', '-X', 'utf8', fileURLToPath(new URL('./exactRuntime/cas_mappings_test.py', import.meta.url)), '--batch'], {
    input: payload, encoding: 'utf8', timeout: 45_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) throw new Error(`${result.error?.message ?? ''}\n${result.stderr}`);
  const values: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(values) || values.length !== 1) throw new Error('Expected one actual calculation');
  nativeResults.set(payload, values[0]); return Promise.resolve(values[0]);
} };
async function actual(input: MathWorkRequest) {
  return decode(await executeExactMathWorkRequest(createMathWorkEnvelope(1, input), {
    backend, engine: native, shouldStop: () => undefined,
  }), input);
}

describe('記号の型を証明した閉じた値を、条件・成分・数値へつなぐ', () => {
  it.each([
    ['real', '1/3', 'a_1*3', 1], ['complex', '3+4*i', 'abs(a_1)', 5],
    ['integer', '6/2', 'a_1+1', 4], ['natural', '0', 'a_1+1', 1],
    ['rational', '1/3', 'a_1*3', 1], ['boolean', 'true', 'which(a_1,4,true,7)', 4],
    ['set', 'set(1,2)', 'which(element(2,a_1),4,true,7)', 4],
    ['vector', '[1,2,3]', 'component(a_1,2)', 2], ['matrix', '[[1,2],[3,4]]', 'component(a_1,2,1)', 3],
    ['symbolic', '2+3', 'a_1+2', 7],
  ] as const)('%sの値%sを%sへ渡し、保存と表示往復で元の値の式を保つ', async (type, valueSource, source, coordinate) => {
    const input = request(source, declaration(type, valueSource));
    const first = await actual(input);
    if (first.definition === null) throw new Error('Expected original formula');
    expect(first.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate });
    expect(first.definition?.declarations).toEqual(input.declarations);
    const saved = JSON.parse(JSON.stringify(first.definition)) as unknown;
    const reopened = decodeMathWorkRequest({ ...input, definition: saved });
    expect((await actual(reopened)).evaluation).toEqual(first.evaluation);
    const converted = { ...input, presentationNotation: 'latex' as const };
    const presentation = (await actual(converted)).presentation;
    if (presentation === null || presentation === undefined) throw new Error('Expected structured input');
    const latex = { ...input, source: presentation.source, notation: 'latex' as const, definition: presentation };
    expect((await actual(latex)).evaluation).toEqual(first.evaluation);
    expect(presentation.declarations).toEqual(input.declarations);
  }, 60_000);
  it('写像の値を実計算し、局所変数を別の総和へ混入せず逆写像と合成に使う', async () => {
    const input = request('mapat(inversemap(a_1),9)+sum(x,x,1,3)', declaration('function', 'mapping(2*x+1,x,ℝ,ℝ)'));
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(1, input), { backend, engine: native, shouldStop: () => undefined });
    expect(decode(raw, input).evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 10 });
  }, 60_000);
  it.each([
    ['which(element(2,a_1),4,true,1/0)', 4],
    ['which(element(3,a_1),1/0,true,7)', 7],
  ] as const)('集合の条件%sで成立した枝だけを計算する', async (source, coordinate) => {
    expect((await actual(request(source, declaration('set', 'set(1,2)')))).evaluation)
      .toMatchObject({ status: 'value', kind: 'real', coordinate });
  }, 60_000);
  it.each(['which(element(1/0,a_1),4,true,7)', 'which(element(2,a_1),1/0,true,7)',
    'which(2,4,element(2,a_1),7)'])(
    '条件・選んだ枝・数値の真偽への誤変換を%sで拒否する', async source => {
      expect((await actual(request(source, declaration('set', 'set(1,2)')))).evaluation.status).toBe('invalid');
    }, 60_000);
  it.each([
    ['integer', '1.5'], ['natural', '-1'], ['real', 'i'], ['boolean', '1'],
    ['set', '2'], ['vector', '[[1,2],[3,4]]'], ['matrix', '[1,2]'], ['function', '3'],
  ] as const)('%sに%sを指定しても0倍で型違反を消さない', (type, source) => {
    expect(evaluate('0*a_1', type, source).evaluation.status).toBe('invalid');
  });
  it.each(['a_1', 'coef("A")', 'X', 'T', 'globalThis', 'x=2', '1/0', '[1,1/0]'])(
    '値の式%sで別の参照や命令、不成立を持ち込めない', source => {
      expect(evaluate('a_1', 'symbolic', source).evaluation.status).toBe('invalid');
    });
  it('整数であると証明できない値を、近い小数から整数と推測しない', () => {
    expect(evaluate('a_1', 'integer', 'sqrt(2)').evaluation.status).toBe('unresolved');
  });
  it('その他の記号を数の型と推測して曖昧な積を構造表示へ変換しない', () => {
    const input = { ...request('a_1*2', declaration('symbolic', '2+3')), presentationNotation: 'latex' as const };
    const result = decode(executeMathWorkRequest(createMathWorkEnvelope(1, input), backend), input);
    expect(result.evaluation.status).toBe('invalid'); expect(result.presentation).toBeNull();
  });
  it('複素数・真偽・集合の値が決まっても数値の結果へ自動変換しない', () => {
    for (const [type, source] of [['complex', 'i'], ['boolean', 'true'], ['set', 'set(1,2)']] as const) {
      const value = evaluate('a_1', type, source).evaluation;
      expect(value).toMatchObject({ status: 'value', kind: type }); expect(value).not.toHaveProperty('coordinate');
    }
  });
  it('角度の設定と厳密な係数の原式を引き継ぎ、差を拡大しても丸め誤差を増やさない', () => {
    expect(evaluate('a_1', 'real', 'sin(30)').evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 0.5 });
    const result = mathScalarExpression(evaluate('a_1', 'rational', '1/3'));
    if (!result.ok) throw new Error(result.message);
    const exact = originalCoefficientExpression(result.value, { resolveVariable: () => null }, []);
    const input = { ...request('(coef("R")*3-1)*10^40', declaration('real')),
      coefficients: [{ id: 'R', label: 'R', decimal: '0.3333333333333333', exactExpression: exact }] };
    expect(decode(executeMathWorkRequest(createMathWorkEnvelope(5, input), backend), input).evaluation)
      .toMatchObject({ status: 'value', kind: 'real', coordinate: 0 });
  });
  it('型・値・識別番号を変更した古い保存内容や返信を採用しない', () => {
    const input = request('a_1', declaration('real', '4'));
    const first = decode(executeMathWorkRequest(createMathWorkEnvelope(1, input), backend), input);
    const definition = first.definition;
    if (definition === null) throw new Error('Expected original formula');
    expect(() => decodeMathWorkRequest({ ...input, definition, declarations: [declaration('real', '6')] })).toThrow();
    const converted = { ...input, presentationNotation: 'latex' as const };
    const raw = executeMathWorkRequest(createMathWorkEnvelope(2, converted), backend);
    expect(() => decode({ ...raw, presentation: { ...definition, declarations: [declaration('real', '6')] } }, converted)).toThrow();
  });
  it('空欄・読み取り時の処理・過大な値の式を受け入れず、未指定を0へしない', () => {
    expect(() => decodeMathDeclarations([declaration('real', '')])).toThrow();
    const getter = vi.fn(() => '2');
    expect(() => decodeMathDeclarations([{ ...declaration('real'), get valueSource() { return getter(); } }])).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => decodeMathDeclarations([declaration('real', '1+'.repeat(8200)+'1')])).toThrow();
    const input = request('a_1-a_1', declaration('real'));
    expect(decode(executeMathWorkRequest(createMathWorkEnvelope(1, input), backend), input).evaluation.status).toBe('unresolved');
  });
});
