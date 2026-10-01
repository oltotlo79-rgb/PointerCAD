import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyPartDocument, DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId, mathGeometryOperationMessage,
  absoluteCoordinate, FREE_WORK_PLANE_ID, type DocumentMathContext, type MathGeometryOutcome, type PartDocument } from '@pointercad/model';
import type { ExpressionValue } from '@pointercad/expression';
import { createMathBackend, executeExactMathWorkRequest, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import type { MathWorkRequest } from '@pointercad/expression/math/client';
import { exactRuntimeBatch, sharedExactEngine } from '../../../expression/src/math/exactRuntimeTestSupport.js';
import { mathGeometryEditorCandidate, mathGeometryEditorProblem, prepareDocumentMathEditor, prepareDocumentMathEnvironment } from './prepareDocumentMathEditor.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const engine = sharedExactEngine(exactRuntimeBatch(fileURLToPath(new URL('../../../expression/src/math/exactRuntime/cas_region_integrals_test.py', import.meta.url)), 15_000));
const coefficients = [{ id: mathGeometryCoefficientId('g'), label: 'G', decimal: '10' }, { id: 'coefficient:1', label: 'R', decimal: '10' }];
function request(source: string): MathWorkRequest {
  return { source, coefficients, notation: 'text', angleUnit: 'degree',
    identity: { documentId: 'part-1', documentVersion: 1, editorId: 'test', inputRevision: 1 } };
}
function decode(raw: unknown, input: MathWorkRequest) {
  return decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
    coefficientIds: new Set(input.coefficients.map(value => value.id)), declaredIds: new Set() }).result;
}
function value(source: string): ExpressionValue {
  const input = request(source), result = decode(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend), input);
  if (result.definition === null) throw new Error(JSON.stringify(result.evaluation));
  return { source, value: 999, display: '999', mathDefinition: result.definition };
}
function part(source: string): PartDocument {
  const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
  return { ...empty, sketches: [{ ...sketch, features: [{ id: 'line', name: 'line', kind: 'line', planeId: FREE_WORK_PLANE_ID,
    construction: false, from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0) }] }],
  mathGeometry: [{ id: 'g', name: 'G', documentId: empty.id, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE,
    quantity: { kind: 'length', curve: { kind: 'sketch-curve', sketchId: sketch.id, featureId: 'line' } } }], parameters: [
    { name: 'R', mathId: 'coefficient:1', value: value('coef("G")'), unit: 'mm', description: '' },
    { name: 'P', mathId: 'coefficient:2', value: value(source), unit: 'mm', description: '' },
  ] };
}
function context(document: PartDocument, amount: number): DocumentMathContext {
  const outcome: MathGeometryOutcome = { id: 'g', documentId: document.id, generation: 1, status: 'value', kind: 'real', value: amount,
    unit: 'mm', representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
  return { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true, geometry: new Map([['g', outcome]]), client: {
    evaluate: async input => ({ status: 'result', identity: input.identity,
      result: decode(await executeExactMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input },
        { backend, engine, shouldStop: () => undefined }), input) }),
  } };
}

describe('図形由来の積分を係数の入力画面へ渡す', () => {
  it('線積分・面積分を候補として適用でき、測定の変更後は999や前の値を候補へ戻さない', async () => {
    await Promise.all([
      'lineintegral(coef("R"),[x],[t],t,0,1)',
      'surfaceintegral(1,[x,y,z],[coef("R")*u,v,0],[u,v],[0,0],[1,1])',
    ].map(async source => {
      const document = part(source), before = JSON.stringify(document);
      expect(mathGeometryEditorProblem(document)).toBeNull();
      for (const amount of [10, 20]) {
        const result = await prepareDocumentMathEnvironment(document, context(document, amount));
        expect(result.coefficientProblem).toBeNull();
        expect(result.coefficients).toEqual([
          { id: 'coefficient:1', label: 'R', decimal: String(amount) },
          { id: 'coefficient:2', label: 'P', decimal: String(amount) },
        ]);
      }
      const editor = await prepareDocumentMathEditor(document, document.parameters[1].value, context(document, 20), 'P', true);
      expect(editor.source).toBe(source);
      expect(editor.coefficientProblem).toBeNull();
      expect(editor.coefficients).toEqual([
        { id: 'coefficient:1', label: 'R', decimal: '20' },
        { id: mathGeometryCoefficientId('g'), label: 'G', decimal: '20' },
      ]);
      expect(JSON.stringify(document)).toBe(before);
    }));
  }, 90_000);

  it.each([
    'lineintegral(floor(x),[x],[coef("R")*t],t,0,1)',
    'surfaceintegral(1,[x,y,z],[u,v,0],[u,v],[0,0],[floor(coef("R")),1])',
  ])('編集候補 %s は積分内の不連続演算の名前で拒否する', source => {
    const document = part('coef("R")');
    expect(mathGeometryEditorProblem(mathGeometryEditorCandidate(document, 'P', value(source))))
      .toBe(mathGeometryOperationMessage('floor'));
  });
});
