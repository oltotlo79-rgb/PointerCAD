import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeMathDeclarations, referencedMathDeclarations, type MathDeclaration } from './mathDeclarations.js';
import { createMathBackend } from './createMathBackend.js';
import { createMathWorkEnvelope, decodeMathWorkRequest, type MathWorkRequest } from './mathWorkRequest.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { decodeMathExpressionStorage } from './mathExpressionStorage.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { coordinateFromMath } from './mathInputContract.js';

const real: MathDeclaration = { id: 'symbol-a', label: 'a_1', meaning: '自由に変わる実数の長さ', type: 'real' };
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function input(source: string, declarations: readonly MathDeclaration[] = [real]): MathWorkRequest {
  return { identity: { documentId: 'part', documentVersion: 7, editorId: 'math', inputRevision: 2 },
    source, notation: 'text', angleUnit: 'radian', coefficients: [], declarations };
}
function result(request: MathWorkRequest) {
  const envelope = createMathWorkEnvelope(1, request);
  const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(),
    declaredIds: new Set((envelope.request.declarations ?? []).map(value => value.id)) };
  const reply = executeMathWorkRequest(envelope, backend);
  return { reply, context, result: decodeMathWorkReply(reply, envelope.request, context).result };
}

describe('数学記号の名前・意味・種類は実行命令と区別して原式に保持する', () => {
  it.each(['real', 'complex', 'integer', 'natural', 'rational', 'boolean', 'set', 'vector', 'matrix', 'function', 'symbolic'] as const)(
    '%sの定義を複製して固定し、呼出側の変更が依頼へ混入しない', type => {
      const declaration = { ...real, type }, source = [declaration];
      const copy = decodeMathDeclarations(source);
      declaration.meaning = '変更後';
      expect(copy).toEqual([{ ...real, type }]);
      expect(Object.isFrozen(copy)).toBe(true); expect(Object.isFrozen(copy[0])).toBe(true);
    });
  it.each([
    { ...real, id: '' }, { ...real, label: ' a' }, { ...real, label: 'a+b' },
    { ...real, label: '1a' }, { ...real, meaning: '' }, { ...real, meaning: 'a\nline' },
    { ...real, type: 'unknown' }, { ...real, value: '0' }, { ...real, meaning: 'x'.repeat(513) },
  ])('不正な定義%jを受け入れない', declaration => {
    expect(() => decodeMathDeclarations([declaration])).toThrow();
  });
  it.each(['X', 'T', 'pi', 'e', 'i', 'π', 'ℝ', 'True', 'Integers'])(
    '予約名%sを自由記号へ差し替えない', label => {
      expect(() => decodeMathDeclarations([{ ...real, label }])).toThrow();
    });
  it('重複・件数超過・説明の総量と読み取り時に実行される項目を拒否する', () => {
    expect(() => decodeMathDeclarations([real, real])).toThrow();
    expect(() => decodeMathDeclarations([real, { ...real, id: 'other' }])).toThrow();
    expect(() => decodeMathDeclarations([real, { ...real, label: 'other' }])).toThrow();
    expect(() => decodeMathDeclarations(Array.from({ length: 129 }, (_, index) => ({ ...real, id: String(index), label: `a${index}` })))).toThrow();
    expect(() => decodeMathDeclarations(Array.from({ length: 33 }, (_, index) => ({ ...real, id: String(index), label: `a${index}`, meaning: 'x'.repeat(512) })))).toThrow();
    const getter = vi.fn(() => 'a');
    expect(() => decodeMathDeclarations([{ ...real, get meaning() { return getter(); } }])).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const list = [real];
    Object.defineProperty(list, '0', { get: getter, enumerable: true });
    expect(() => decodeMathDeclarations(list)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => decodeMathDeclarations(new Array<MathDeclaration>(2))).toThrow();
  });
  it('名前と識別子・日本語の説明・種類を保存再開し、未指定の値を座標へ使わない', () => {
    const first = result(input('a_1^2+1')).result;
    expect(first.evaluation).toEqual({ status: 'unresolved', reason: 'missing-condition', names: ['a_1'] });
    expect(() => coordinateFromMath(first.evaluation)).toThrow();
    const saved = decodeMathExpressionStorage(JSON.parse(JSON.stringify(first.definition)), 'a_1^2+1');
    expect(saved.declarations).toEqual([real]);
    const base = { ...input(saved.source) }; delete base.declarations;
    const reopened = result({ ...base, definition: saved }).result;
    expect(reopened).toEqual(first);
    expect(referencedMathDeclarations(saved.expression, saved.declarations ?? [])).toEqual([real]);
  });
  it('通常入力と構造入力の往復で添字名と定義を保持する', () => {
    const first = result({ ...input('a_1 × 2'), presentationNotation: 'latex' }).result;
    expect(first.presentation?.declarations).toEqual([real]);
    if (first.presentation === undefined || first.presentation === null) throw new Error('Missing presentation');
    const second = result({ ...input(first.presentation.source), notation: 'latex', definition: first.presentation,
      presentationNotation: 'text' }).result;
    expect(second.presentation?.declarations).toEqual([real]);
    expect(second.evaluation).toEqual(first.evaluation);
  });
  it('種類が曖昧な積をスカラーと推測せず、明示した数の積だけ構造へ変換する', () => {
    expect(result(input('a_1 × 2', [{ ...real, type: 'vector' }])).result.evaluation).toMatchObject({ status: 'invalid', reason: 'unsupported' });
    expect(result(input('a_1 × 2')).result.evaluation).toMatchObject({ status: 'unresolved' });
  });
  it.each(['a_1-a_1', '0*a_1', 'a_1/a_1'])(
    '%sを値や型を確認せず簡約して座標へ通さず、型のない別計算へ転送しない', async source => {
      const evaluate = vi.fn(() => Promise.resolve({ status: 'invalid', reason: 'unsupported' }));
      const request = input(source);
      const output = await executeExactMathWorkRequest(createMathWorkEnvelope(1, request), {
        backend, engine: { evaluate }, shouldStop: () => undefined,
      });
      expect(output.evaluation.status).toBe('unresolved');
      expect(evaluate).not.toHaveBeenCalled();
    });
  it.each(['sin(a_1)', 'a_1+2', '0*a_1', 'a_1/a_1'])(
    '集合の記号を使う%sの型違反を未解決の数値式として通さない', source => {
      expect(result(input(source, [{ ...real, type: 'set' }])).result.evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    });
  it('記号が残っていても、確認できる元の式の不成立を隠さない', () => {
    expect(result(input('a_1+1/0')).result.evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
  it('式の中で局所的に束縛した同名変数を外の記号と混同しない', () => {
    expect(result(input('sum(a_1,a_1,1,3)')).result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 6 });
    expect(result(input('sum(a_1,a_1,1,3)+a_1')).result.evaluation.status).toBe('unresolved');
  });
  it('未定義の記号、型・説明の差し替え、保存された参照名の不一致を拒否する', () => {
    expect(result(input('not_defined')).result.evaluation.status).toBe('invalid');
    const saved = result(input('a_1')).result.definition;
    expect(() => decodeMathWorkRequest({ ...input('a_1', [{ ...real, type: 'set' }]), definition: saved })).toThrow();
    expect(() => decodeMathWorkRequest({ ...input('a_1', [{ ...real, meaning: '別の意味' }]), definition: saved })).toThrow();
    expect(() => decodeMathExpressionStorage({ ...saved, declarations: [{ ...real, label: 'b' }] }, 'a_1')).toThrow();
    expect(() => decodeMathExpressionStorage({ ...saved, declarations: [] }, 'a_1')).toThrow();
  });
  it('返信が型や意味を差し替えたり未指定の記号を数値へすり替えたら採用しない', () => {
    const request = { ...input('a_1'), presentationNotation: 'latex' as const };
    const { reply, context } = result(request);
    expect(() => decodeMathWorkReply({ ...reply, presentation: { ...reply.presentation,
      declarations: [{ ...real, type: 'set' }] } }, request, context)).toThrow();
    expect(() => decodeMathWorkReply({ ...reply, evaluation: { status: 'value', kind: 'real', exact: null,
      decimal: '0', coordinate: 0, approximation: null } }, request, context)).toThrow();
  });
  it('従来の数式には新しい保存項目を強制せず、入力の宣言命令を許可しない', () => {
    const request = { ...input('1+2') }; delete request.declarations;
    const old = result(request).result;
    expect(old.definition).not.toHaveProperty('declarations');
    expect(old.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 3 });
    expect(result(input('Declare(a_1,RealNumbers)')).result.evaluation.status).toBe('invalid');
  });
});
