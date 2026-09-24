import { beforeAll, describe, expect, it } from 'vitest';
import { mathScalarExpression, type ExpressionValue } from '@pointercad/expression';
import { createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, type MathDeclaration } from '@pointercad/expression/math/contracts';
import type { MathWorkRequest } from '@pointercad/expression/math/client';
import { createEmptyPartDocument } from './createPartDocument.js';
import { evaluateDocumentMath, type DocumentMathContext } from './evaluateDocumentMath.js';
import { affectsShape } from './documentChange.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import type { PartDocument } from './types.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const identity = { documentId: 'test', documentVersion: 1, editorId: 'coefficient', inputRevision: 1 };
function calculate(request: MathWorkRequest) {
  const declarations = request.declarations ?? request.definition?.declarations ?? [];
  return decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(value => value.id)),
      declaredIds: new Set(declarations.map(value => value.id)) }).result;
}
function math(source: string, coefficients: MathWorkRequest['coefficients'], declarations: readonly MathDeclaration[] = []): ExpressionValue {
  const value = mathScalarExpression(calculate({ identity, source, coefficients, declarations, notation: 'text', angleUnit: 'degree' }));
  if (!value.ok) throw new Error(value.message);
  return value.value;
}
function part(): PartDocument {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  const value = math('a_1', [], [{ id: 'symbol:a', label: 'a_1', meaning: '分数の長さ', type: 'rational', valueSource: '1/3' }]);
  const x = math('coef("R")*3', [{ id: 'coefficient:1', label: 'R', decimal: '0.3333333333333333' }]);
  return { ...document, mathParameterSerial: 1,
    parameters: [{ name: 'R', mathId: 'coefficient:1', value, unit: 'mm', description: '' }],
    sketches: [{ ...sketch, features: [createPointFeature(sketch, { ...absoluteCoordinate(0, 0, 0), x })] }] };
}
function context(document: PartDocument): DocumentMathContext {
  return { identity: { documentId: document.id, documentVersion: 2 }, isCurrent: () => true,
    client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity, result: calculate(request) }) } };
}
function x(document: PartDocument): number {
  const feature = document.sketches[0].features[0];
  if (feature.kind !== 'point' || feature.at.mode !== 'absolute') throw new Error('Expected absolute point');
  return feature.at.x.value;
}
function changed(document: PartDocument, valueSource: string): PartDocument {
  const parameter = document.parameters[0], definition = parameter.value.mathDefinition;
  if (definition?.declarations === undefined) throw new Error('Expected declared value');
  return { ...document, parameters: [{ ...parameter, value: { ...parameter.value,
    mathDefinition: { ...definition, declarations: definition.declarations.map(value => ({ ...value, valueSource })) } } }] };
}
describe('記号の値の変更だけでも係数と点の再計算へ伝える', () => {
  it('保存往復後に分数を丸めず係数と座標へ渡す', async () => {
    const document = structuredClone(part());
    const result = await evaluateDocumentMath(document, context(document));
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(x(result.document)).toBe(1);
    expect(result.document.parameters[0].value.mathDefinition?.declarations?.[0].valueSource).toBe('1/3');
    expect(result.analysis.mathCoefficients?.get('R')?.exactExpression).toEqual({ kind: 'operation', operation: 'divide',
      operands: [{ kind: 'number', decimal: '1' }, { kind: 'number', decimal: '3' }] });
  });
  it('式の文字が同じでも値の変更は形の変更であり、元の文書を変えず2へ追従する', async () => {
    const document = part(), edited = changed(document, '2/3');
    expect(affectsShape(document, edited)).toBe(true);
    const result = await evaluateDocumentMath(edited, context(edited));
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(x(result.document)).toBe(2);
    expect(document.parameters[0].value.mathDefinition?.declarations?.[0].valueSource).toBe('1/3');
  });
  it('保存された古い座標があっても不正な値や種類では再計算を成功させない', async () => {
    const document = changed(part(), '1/0');
    const result = await evaluateDocumentMath(document, context(document));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Invalid value must not reuse old coordinate');
    expect(result.failures.length).toBeGreaterThan(0);
  });
});
