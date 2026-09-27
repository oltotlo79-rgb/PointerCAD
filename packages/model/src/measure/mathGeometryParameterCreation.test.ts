/**
 * GR-03b (`scratchpad/claude/plans/geomref-plan.md` §5.2 GR-03b, Q2=U3): the draft coefficient behind
 * "この値の係数を作る". Its stored formula must be exactly what the math editor saves for
 * `coef("<name>")`, so the file boundary accepts it, the real math engine re-parses its source to the same
 * expression, and a recomputation with the measured value evaluates it (GR-04).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeMathExpressionStorage } from '@pointercad/expression';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, formatMathText, MATH_INPUT_FORMAT } from '@pointercad/expression/math/contracts';
import type { MathWorkRequest } from '@pointercad/expression/math/client';
import { createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';

import {
  mathGeometryParameterDraft,
  type MathGeometryParameterDraftInput,
  type MathGeometryValueUnit,
} from './mathGeometryParameterCreation.js';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId } from './mathGeometryIdentity.js';
import type { MathGeometryDefinition, MathGeometryOutcome } from './mathGeometryTypes.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { evaluateDocumentMath, type DocumentMathContext } from '../part/evaluateDocumentMath.js';
import type { PartDocument } from '../part/types.js';
import type { Parameter, ParameterUnit } from '../parameters/types.js';

const DOCUMENT_ID = createEmptyPartDocument().id;
const NOT_FOUND_MESSAGE = '指定した図形の測定値が見つかりません。';
const NO_VALUE_MESSAGE = '値が決まっていないため、係数を作れません。';

function definition(id: string, name: string): MathGeometryDefinition {
  return { id, documentId: DOCUMENT_ID, name, quantity: { kind: 'volume', body: { kind: 'body', featureId: 'box-1' } },
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}
function part(definitions: readonly MathGeometryDefinition[]): PartDocument {
  return { ...createEmptyPartDocument(), mathGeometry: definitions };
}
function input(overrides: Partial<MathGeometryParameterDraftInput> = {}): MathGeometryParameterDraftInput {
  return { name: '箱1体積の値', value: 24000, unit: 'mm3', description: '図形の測定値「箱1体積」(体積、mm³)から作った係数', ...overrides };
}
function draft(document: PartDocument, definitionId: string, overrides: Partial<MathGeometryParameterDraftInput> = {}): Parameter {
  const result = mathGeometryParameterDraft(document, definitionId, input(overrides));
  if (!result.ok) throw new Error(result.message);
  return result.parameter;
}

describe('mathGeometryParameterDraft(Q2=U3、GR-03b)', () => {
  it('定義の名前を coef("…") で参照する係数の下書きを作り、文書は変えない', () => {
    const document = part([definition('def-1', '箱1体積')]);
    const before = structuredClone(document);
    const result = mathGeometryParameterDraft(document, 'def-1', input());
    const source = 'coef("箱1体積")';
    expect(result).toEqual({ ok: true, parameter: {
      name: '箱1体積の値',
      value: { source, value: 24000, display: '24000', mathDefinition: { format: MATH_INPUT_FORMAT, source, inputNotation: 'text',
        angleUnit: 'degree', expression: { kind: 'symbol', reference: { role: 'coefficient', id: 'math-geometry:def-1', label: '箱1体積' } } } },
      unit: 'none',
      description: '図形の測定値「箱1体積」(体積、mm³)から作った係数',
    } });
    // No coefficient ID yet: `commitAddParameter` decides that when the draft is added (GR-31).
    if (result.ok) expect(result.parameter).not.toHaveProperty('mathId');
    expect(document).toEqual(before);
  });

  it.each([
    ['mm', 'mm'],
    ['degree', 'degree'],
    ['mm2', 'none'],
    ['mm3', 'none'],
    ['radian', 'none'],
  ] as const satisfies readonly (readonly [MathGeometryValueUnit, ParameterUnit])[])(
    '係数の単位は測定値の単位だけで決まる(%s → %s。量の種類は見ない)', (unit, expected) => {
      // The definition measures a volume on purpose: only the unit passed in decides the coefficient's unit.
      expect(draft(part([definition('def-1', '箱1体積')]), 'def-1', { unit }).unit).toBe(expected);
    });

  it.each(['箱1体積', 'Aの辺', 'width_2'])('作った式は保存の検査を通り、formatMathText の結果が原文と一致する(%s)', (name) => {
    const value = draft(part([definition('def-1', name)]), 'def-1').value;
    const stored = value.mathDefinition;
    if (stored === undefined) throw new Error('mathDefinition is missing');
    expect(value.source).toBe(`coef(${JSON.stringify(name)})`);
    expect(stored.source).toBe(value.source);
    expect(formatMathText(stored.expression, CANDIDATE_MATH_BY_ID)).toBe(value.source);
    expect(decodeMathExpressionStorage(stored, value.source)).toEqual(stored);
    // The same check after a save/load round trip through JSON (what `.pcad` keeps).
    const reloaded: unknown = JSON.parse(JSON.stringify(stored));
    expect(decodeMathExpressionStorage(reloaded, value.source)).toEqual(stored);
  });

  it('値は渡された倍精度を丸めずに持ち、表示は有効12桁', () => {
    const value = draft(part([definition('def-1', '面積1')]), 'def-1', { value: 0.1 + 0.2, unit: 'mm2' }).value;
    expect(value.value).toBe(0.30000000000000004);
    expect(value.display).toBe('0.3');
  });

  it.each([
    ['別の識別番号の定義しか無い文書', part([definition('def-1', '体積1')])],
    ['図形の測定値の欄が無い文書', createEmptyPartDocument()],
  ] as const)('定義が見つからなければ notFound で断る(%s。GR-03 と同じ文)', (_label, document) => {
    expect(mathGeometryParameterDraft(document, 'no-such-id', input()))
      .toEqual({ ok: false, reason: 'notFound', message: NOT_FOUND_MESSAGE });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('値が %s なら noValue で断る', (value) => {
    expect(mathGeometryParameterDraft(part([definition('def-1', '体積1')]), 'def-1', input({ value })))
      .toEqual({ ok: false, reason: 'noValue', message: NO_VALUE_MESSAGE });
  });

  it('定義が無く値も無いときは notFound を先に返す', () => {
    expect(mathGeometryParameterDraft(createEmptyPartDocument(), 'no-such-id', input({ value: Number.NaN })))
      .toMatchObject({ ok: false, reason: 'notFound' });
  });
});

describe('実際の計算部で使える(GR-04 との接続)', () => {
  let backend: MathExecutionBackend;
  beforeAll(() => { backend = createMathBackend(); });
  const identity = { documentId: DOCUMENT_ID, documentVersion: 1, editorId: 'test', inputRevision: 1 };

  function calculate(request: MathWorkRequest) {
    const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
    return decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result;
  }
  function measured(id: string, value: number): MathGeometryOutcome {
    return { id, documentId: DOCUMENT_ID, generation: 1, status: 'value', kind: 'real', value, unit: 'mm3',
      representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
  }

  it('計算部が原文を読み直した式は、下書きの保存式と一致する', () => {
    const parameter = draft(part([definition('def-1', '箱1体積')]), 'def-1');
    const result = calculate({ identity, source: parameter.value.source, notation: 'text', angleUnit: 'degree',
      coefficients: [{ id: mathGeometryCoefficientId('def-1'), label: '箱1体積', decimal: '24000' }] });
    expect(result.definition).toEqual(parameter.value.mathDefinition);
  });

  it.each([24000, 0.1 + 0.2])('文書へ加えると、測った値 %s をそのまま係数の値として評価する', async (value) => {
    const base = part([definition('def-1', '箱1体積')]);
    const parameter = draft(base, 'def-1', { value });
    const document: PartDocument = { ...base, parameters: [parameter] };
    const context: DocumentMathContext = { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
      client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity, result: calculate(request) }) },
      geometry: new Map([['def-1', measured('def-1', value)]]) };
    const result = await evaluateDocumentMath(document, context);
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    // The recomputation writes back exactly what the draft already holds for the same measured value.
    expect(result.document.parameters[0].value).toEqual(parameter.value);
    expect(result.analysis.geometryDerived).toEqual(new Map([['箱1体積の値', ['def-1']]]));
    // Geometry-derived: handed on as its decimal only, never with an exact original (§4(e)).
    const coefficient = result.analysis.mathCoefficients?.get('箱1体積の値');
    expect(coefficient).toMatchObject({ label: '箱1体積の値' });
    expect(coefficient).not.toHaveProperty('exactExpression');
  });
});
