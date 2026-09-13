import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyPartDocument, type Parameter, type PartDocument, type DocumentMathContext } from '@pointercad/model';
import {
  createFunctionMathSource,
  createMathBackend,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';

import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import { prepareDocumentMathEditor } from './prepareDocumentMathEditor.js';
import { prepareDocumentFunctionEditor } from './prepareDocumentFunctionEditor.js';
import { createFunctionCurveEvaluator } from '@pointercad/expression/math/geometry';


let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function row(name: string, source: string, cached = 999): Parameter {
  return { name, value: { source, value: cached, display: String(cached) }, unit: 'mm', description: '' };
}
function context(document: PartDocument): DocumentMathContext {
  return { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true, client: {
    evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
      result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
        { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result }),
  } };
}
describe('数式入力を開く準備は未確定の文書へ閉じ込める', () => {
  it('関数の確認画面へも係数の原式を渡し、1/3の小数キャッシュを拡大しない', async () => {
    const document = { ...createEmptyPartDocument(), parameters: [row('r', '1/3')] };
    const input = await prepareDocumentFunctionEditor(document, { source: 'X+(coef("r")*3-1)*10^40', notation: 'text', angleUnit: 'degree' },
      { axes: ['X'], parameters: [] }, context(document));
    expect(input.coefficientProblem).toBeNull();
    const scope = { axes: ['X'] as const, parameters: [], coefficients: input.coefficients };
    const definition = createFunctionMathSource('X+(coef("r")*3-1)*10^40', 'text', 'degree', scope, backend);
    const zero = createFunctionMathSource('0', 'text', 'degree', scope, backend);
    const curve = createFunctionCurveEvaluator([definition, zero, zero], 'X', input.coefficients, { backend, shouldStop: () => undefined });
    expect(curve.point(2)).toEqual([2,0,0]);
    expect(document.parameters[0].value.value).toBe(999);
  });

  it('保存キャッシュを係数値に使わず、原文書へIDや変更を追加しない', async () => {
    const document = { ...createEmptyPartDocument(), parameters: [row('幅', '1/3')] };
    const before = JSON.stringify(document);
    const result = await prepareDocumentMathEditor(document, row('input', '幅+1').value, context(document));
    expect(result.coefficients[0].decimal).toMatch(/^0\.33333333333333333333/u);
    expect(Number(result.coefficients[0].decimal)).not.toBe(999);
    expect(result.source).toContain('coef("幅")');
    expect(result.prepared.parameters[0].mathId).toBeDefined();
    expect(document.parameters[0]).not.toHaveProperty('mathId');
    expect(JSON.stringify(document)).toBe(before);
  });
  it('修正中の不正な係数とその依存先を除き、独立係数は候補に残す', async () => {
    const document = { ...createEmptyPartDocument(), parameters: [row('A', '1/0'), row('B', 'A*2'), row('C', 'B+1'), row('D', '7')] };
    const result = await prepareDocumentMathEditor(document, document.parameters[0].value, context(document), 'A');
    expect(result.coefficients.map(coefficient => coefficient.label)).toEqual(['D']);
    expect(result.coefficients[0].decimal).toBe('7');
    expect(result.coefficientProblem).toBeNull();
  });
  it('係数が未決定なら過去の値を候補へ流さず、原式を修正できる状態を返す', async () => {
    const document = { ...createEmptyPartDocument(), parameters: [row('A', '1/0')] };
    const result = await prepareDocumentMathEditor(document, row('input', 'A').value, context(document));
    expect(result.coefficients).toEqual([]);
    expect(result.coefficientProblem).not.toBeNull();
    expect(result.source).toContain('coef("A")');
  });
  it('不正な短式を開いても元の文字を捨てずに編集できる', async () => {
    const document = createEmptyPartDocument();
    const result = await prepareDocumentMathEditor(document, row('input', 'sqrt(').value, context(document));
    expect(result.source).toBe('sqrt(');
    expect(result.notation).toBe('text');
  });
  it('関数の軸Xと係数Xを別の挿入群にし、構造入力から同時に使って作図できる', async () => {
    const document = { ...createEmptyPartDocument(), parameters: [row('X', '3')] }, before = JSON.stringify(document);
    const input = await prepareDocumentFunctionEditor(document, { source: 'X+coef("X")', notation: 'text', angleUnit: 'radian' },
      { axes: ['X'], parameters: [] }, context(document));
    expect(input.coefficientProblem).toBeNull(); expect(input.groups.map(group => group.id)).toEqual(['axes','coefficients','constants']);
    const axis = input.groups.find(group => group.id === 'axes')?.choices[0], coefficient = input.groups.find(group => group.id === 'coefficients')?.choices[0];
    if (axis === undefined || coefficient === undefined) throw new Error('Expected separate variable groups');
    expect(axis.template).not.toBe(coefficient.template); expect(axis.meaning).not.toBe(coefficient.meaning);
    const request = { identity: { documentId: document.id, documentVersion: 1, editorId: 'function', inputRevision: 1 },
      source: `${axis.template}+${coefficient.template}`, notation: 'latex' as const, angleUnit: 'radian' as const,
      coefficients: input.coefficients, functionScope: input.functionScope };
    const result = decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
      { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(input.coefficients.map(value => value.id)), declaredIds: new Set() }).result;
    if (result.definition === null) throw new Error(JSON.stringify(result));
    const zero = createFunctionMathSource('0', 'text', 'radian', { axes: ['X'], parameters: [], coefficients: input.coefficients }, backend);
    const curve = createFunctionCurveEvaluator([result.definition, zero, zero], 'X', input.coefficients, { backend, shouldStop: () => undefined });
    expect(curve.point(2)).toEqual([5,0,0]); expect(JSON.stringify(document)).toBe(before);
    expect(input).not.toHaveProperty('value');
  });
  it('媒介変数とXYZを混ぜず、書きかけの関数を仮の数値へ変えずに編集へ渡す', async () => {
    const document = createEmptyPartDocument();
    const input = await prepareDocumentFunctionEditor(document, { source: 'sqrt(', notation: 'text', angleUnit: 'radian' },
      { axes: [], parameters: ['U','V'] }, context(document));
    expect(input.source).toBe('sqrt('); expect(input.functionScope).toEqual({ axes: [], parameters: ['U','V'] });
    expect(input.groups.some(group => group.id === 'axes')).toBe(false);
    expect(input.groups.find(group => group.id === 'parameters')?.choices.map(choice => choice.label)).toEqual(['U','V']);
    expect(input).not.toHaveProperty('value');
  });
  it.each(['X','Y','Z','T','U','V'] as const)('挿入した%sを実際の構造入力で指定した役割の変数へ戻せる', async name => {
    const document = createEmptyPartDocument();
    const scope = name === 'X' || name === 'Y' || name === 'Z' ? { axes: [name], parameters: [] }
      : { axes: [], parameters: [name] };
    const input = await prepareDocumentFunctionEditor(document, { source: '0', notation: 'latex', angleUnit: 'radian' }, scope, context(document));
    const choice = input.groups[0].choices[0];
    const request = { identity: { documentId: document.id, documentVersion: 1, editorId: 'function', inputRevision: 1 },
      source: choice.template, notation: 'latex' as const, angleUnit: 'radian' as const, coefficients: [], functionScope: input.functionScope };
    const result = decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
      { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'function', expression: { kind: 'symbol',
      reference: { role: scope.axes.length === 0 ? 'parameter' : 'axis', name } } });
  });
});
