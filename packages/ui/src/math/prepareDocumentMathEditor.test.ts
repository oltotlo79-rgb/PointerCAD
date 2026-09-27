import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyPartDocument, evaluateDocumentMath, prepareDocumentMathIdentity,
  type Parameter, type PartDocument, type DocumentMathContext } from '@pointercad/model';
import { mathScalarExpression } from '@pointercad/expression';
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

import { prepareDocumentMathEditor, prepareDocumentMathEnvironment } from './prepareDocumentMathEditor.js';
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
  it.each(['Gamma・Beta分布の値', '板゠厚', 'かな゛幅'])('%sを含む文書でも入力を開き、候補を同じ値として挿入できる', async label => {
    const document = { ...createEmptyPartDocument(), parameters: [row(label, '3')] }, before = JSON.stringify(document);
    const prepared = await prepareDocumentMathEditor(document, row('input', label).value, context(document));
    expect(prepared.coefficientProblem).toBeNull();
    expect(prepared.source).toBe(`coef(${JSON.stringify(label)})`);
    const choice = prepared.groups.find(group => group.id === 'coefficients')?.choices[0];
    if (choice === undefined) throw new Error('係数の挿入候補がありません');
    const request = { identity: { documentId: document.id, documentVersion: 1, editorId: 'name', inputRevision: 1 },
      source: choice.template, notation: 'latex' as const, angleUnit: 'degree' as const, coefficients: prepared.coefficients };
    const result = await context(document).client.evaluate(request, 1000);
    if (result.status !== 'result') throw new Error(JSON.stringify(result));
    expect(result.result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 3 });
    expect(JSON.stringify(document)).toBe(before);
  });

  async function evaluatedCoefficientDocument() {
    const empty = createEmptyPartDocument(), client = context(empty).client;
    const completion = await client.evaluate({ identity: { documentId: empty.id, documentVersion: 1, editorId: 'seed', inputRevision: 1 },
      source: 'sin(30)', notation: 'text', angleUnit: 'degree', coefficients: [] }, 1_000);
    if (completion.status !== 'result') throw new Error('Expected an evaluated expression');
    const scalar = mathScalarExpression(completion.result);
    if (!scalar.ok) throw new Error(scalar.message);
    const candidate = prepareDocumentMathIdentity({ ...empty, parameters: [
      { ...row('A', scalar.value.source), value: scalar.value }, row('B', 'A*2'), row('C', '5'),
    ] });
    const evaluated = await evaluateDocumentMath(candidate, context(candidate));
    if (!evaluated.ok) throw new Error(JSON.stringify(evaluated.failures));
    return evaluated.document;
  }

  it('計算済みの同じ係数表で画面を繰り返し開く際は原式を保って再計算を省く', async () => {
    const document = await evaluatedCoefficientDocument(), channel = context(document);
    let requests = 0;
    const tracked: DocumentMathContext = { ...channel, client: { evaluate: (...args) => {
      requests += 1; return channel.client.evaluate(...args);
    } } };
    for (let index = 0; index < 2; index += 1) {
      const prepared = await prepareDocumentMathEditor(document, row('input', 'A').value, tracked);
      expect(prepared.coefficientProblem).toBeNull();
      expect(prepared.coefficients.map(coefficient => [coefficient.label, coefficient.decimal])).toEqual([['A','0.5'], ['B','1'], ['C','5']]);
      expect(prepared.coefficients[0].exactExpression).toMatchObject({ kind: 'operation', operation: 'sin' });
    }
    const repair = await prepareDocumentMathEnvironment(document, tracked, 'A');
    expect(repair.coefficients.map(coefficient => coefficient.label)).toEqual(['C']);
    expect(requests).toBe(0);
  });

  it('保存から作り直した係数表と角度単位を変更した係数表は再計算し、保存値を信用しない', async () => {
    const original = await evaluatedCoefficientDocument();
    for (const changeAngle of [false, true]) {
      const copy = structuredClone(original);
      const document = { ...copy, parameters: copy.parameters.map(parameter => {
        if (parameter.name !== 'A' || parameter.value.mathDefinition === undefined) return parameter;
        return { ...parameter, value: { ...parameter.value, value: 999, display: '999', mathDefinition: {
          ...parameter.value.mathDefinition, angleUnit: changeAngle ? 'radian' as const : 'degree' as const,
        } } };
      }) };
      const channel = context(document); let requests = 0;
      const prepared = await prepareDocumentMathEnvironment(document, { ...channel, client: {
        evaluate: (...args) => { requests += 1; return channel.client.evaluate(...args); },
      } });
      expect(requests).toBe(1); expect(prepared.coefficientProblem).toBeNull();
      const value = Number(prepared.coefficients[0].decimal);
      expect(value).toBeCloseTo(changeAngle ? Math.sin(30) : 0.5, 12);
      expect(document.parameters[0].value.value).toBe(999);
    }
  });

  it('取消済み・別文書・古い編集元では計算済みの係数も返さない', async () => {
    const document = await evaluatedCoefficientDocument(), controller = new AbortController(); controller.abort();
    const valid = context(document);
    for (const channel of [{ ...valid, signal: controller.signal }, { ...valid, isCurrent: () => false },
      { ...valid, identity: { ...valid.identity, documentId: 'another-document' } }]) {
      const prepared = await prepareDocumentMathEnvironment(document, channel);
      expect(prepared.coefficients).toEqual([]); expect(prepared.coefficientProblem).not.toBeNull();
    }
  });

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
