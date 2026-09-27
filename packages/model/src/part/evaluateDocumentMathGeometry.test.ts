/**
 * GR-04 (`scratchpad/claude/plans/geomref-plan.md` §4(e), §5.2): measured math-geometry values enter
 * `evaluateDocumentMath` through the real math engine, as decimal-only coefficients, without disturbing
 * the exact originals of every other coefficient.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateExpression, evaluateExpressionExact, mathScalarExpression, type ExpressionValue } from '@pointercad/expression';
import { createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import type { MathWorkRequest } from '@pointercad/expression/math/client';

import { createEmptyPartDocument } from './createPartDocument.js';
import { evaluateDocumentMath, evaluatedDocumentMathValue, type DocumentMathContext, type DocumentMathResult } from './evaluateDocumentMath.js';
import type { PartDocument } from './types.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import { analyzeParameters } from '../parameters/parameterTable.js';
import { knownMathParameterEvaluation } from '../parameters/mathParameterEvaluation.js';
import type { Parameter } from '../parameters/types.js';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId } from '../measure/mathGeometryIdentity.js';
import { mathGeometryBooleanMessage, mathGeometryOperationMessage, mathGeometryOutsideCoefficientMessage,
  mathGeometryPendingMessage, mathGeometryReferenceMismatchMessage, mathGeometryUnresolvedMessage,
} from '../measure/mathGeometryCoefficients.js';
import type { MathGeometryDefinition, MathGeometryOutcome } from '../measure/mathGeometryTypes.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });

const DOCUMENT_ID = createEmptyPartDocument().id;
const identity = { documentId: DOCUMENT_ID, documentVersion: 1, editorId: 'test', inputRevision: 1 };
type Coefficient = MathWorkRequest['coefficients'][number];

function calculate(request: MathWorkRequest) {
  const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result;
}
/** What the coefficient editor offers for the measured value G while a formula is typed (value irrelevant). */
const G: Coefficient = { id: mathGeometryCoefficientId('g1'), label: 'G', decimal: '20' };
const coefficientP: Coefficient = { id: 'coefficient:1', label: 'P', decimal: '40' };
/** A saved formula with its accepted value, produced by the real engine exactly as the editor would. */
function math(source: string, coefficients: readonly Coefficient[] = [G]): ExpressionValue {
  const result = mathScalarExpression(calculate({ identity, source, notation: 'text', angleUnit: 'degree', coefficients }));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
/** A saved formula whose value does not matter because evaluation must refuse it before the engine runs. */
function formula(source: string, coefficients: readonly Coefficient[] = [G]): ExpressionValue {
  const definition = calculate({ identity, source, notation: 'text', angleUnit: 'degree', coefficients }).definition;
  if (definition === null) throw new Error(`Expected a parsed definition: ${source}`);
  return { source: definition.source, value: 0, display: '0', mathDefinition: definition };
}
function legacy(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
/** A legacy formula naming another coefficient; its cached value is stale on purpose and must be recomputed. */
function legacyUsing(source: string): ExpressionValue {
  return { ...legacy('0'), source };
}
function row(name: string, value: ExpressionValue, mathId?: string): Parameter {
  return { name, value, ...(mathId === undefined ? {} : { mathId }), unit: 'mm', description: '' };
}
function definition(id: string, name: string): MathGeometryDefinition {
  return { id, documentId: DOCUMENT_ID, name, quantity: { kind: 'volume', body: { kind: 'body', featureId: 'box-1' } },
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}
function part(parameters: readonly Parameter[], definitions: readonly MathGeometryDefinition[] = [definition('g1', 'G')],
  x?: ExpressionValue): PartDocument {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  const base: PartDocument = { ...document, parameters, mathGeometry: definitions };
  if (x === undefined) return base;
  return { ...base, sketches: [{ ...sketch, features: [createPointFeature(sketch, { ...absoluteCoordinate(0, 0, 0), x })] }] };
}
function measured(id: string, value: number): MathGeometryOutcome {
  return { id, documentId: DOCUMENT_ID, generation: 3, status: 'value', kind: 'real', value, unit: 'mm',
    representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}
function geometryOf(...outcomes: readonly MathGeometryOutcome[]): ReadonlyMap<string, MathGeometryOutcome> {
  return new Map(outcomes.map(outcome => [outcome.id, outcome]));
}
/** The real engine behind a recording client, as in `evaluateDocumentMath.test.ts`. */
function run(document: PartDocument, changes: Partial<DocumentMathContext> = {}) {
  const requests: MathWorkRequest[] = [];
  const context: DocumentMathContext = { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    client: { evaluate: request => {
      requests.push(request);
      return Promise.resolve({ status: 'result', identity: request.identity, result: calculate(request) });
    } }, ...changes };
  return { requests, result: evaluateDocumentMath(document, context) };
}
function transient(result: DocumentMathResult) {
  if (result.ok || result.recompute === undefined) throw new Error(`Expected a transient recomputation: ${JSON.stringify(result)}`);
  return result.recompute;
}
function messageOf(result: DocumentMathResult, ownerId: string): string | undefined {
  return result.ok ? undefined : result.failures.find(failure => failure.ownerId === ownerId)?.message;
}
function pointOf(document: PartDocument) {
  const point = document.sketches[0].features[0];
  if (point.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('Expected an absolute point');
  return { id: point.id, x: point.at.x };
}

describe('測った値を係数の式へ渡す(値・十進表記・厳密値なし)', () => {
  it('G=20 から P=coef(G)*2=40 を decimal "40"・exactExpression なしで作り、P を使う座標へ渡す', async () => {
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1')], undefined, math('coef("P")+1', [coefficientP]));
    const { requests, result: pending } = run(document, { geometry: geometryOf(measured('g1', 20)) });
    const result = await pending;
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(result.document.parameters[0].value.value).toBe(40);
    expect(pointOf(result.document).x.value).toBe(41);
    const coefficient = result.analysis.mathCoefficients?.get('P');
    expect(coefficient).toEqual({ id: 'coefficient:1', label: 'P', decimal: '40' });
    expect(coefficient).not.toHaveProperty('exactExpression');
    expect(result.analysis.geometryDerived).toEqual(new Map([['P', ['g1']]]));
    // Both requests carry decimal-only inputs: the measured value under its reserved ID, then P itself.
    expect(requests.map(request => request.coefficients)).toEqual([
      [{ id: 'math-geometry:g1', label: 'G', decimal: '20' }],
      [{ id: 'coefficient:1', label: 'P', decimal: '40' }],
    ]);
  });

  it('図形由来でない係数(1/3)は原式を保ち、同じ文書でも図形由来の係数だけが厳密値を持たない', async () => {
    const document = part([
      row('A', legacy('1/3'), 'coefficient:1'),
      row('B', math('coef("A")*3', [{ id: 'coefficient:1', label: 'A', decimal: '0.3333333333333333' }]), 'coefficient:2'),
      row('P', math('coef("G")*2'), 'coefficient:3'),
    ]);
    const result = await run(document, { geometry: geometryOf(measured('g1', 20)) }).result;
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(result.analysis.mathCoefficients?.get('A')?.exactExpression).toEqual({ kind: 'operation', operation: 'divide',
      operands: [{ kind: 'number', decimal: '1' }, { kind: 'number', decimal: '3' }] });
    expect(result.document.parameters[1].value.value).toBe(1);
    expect(result.analysis.mathCoefficients?.get('B')?.exactExpression).toEqual({ kind: 'number', decimal: '1' });
    expect(result.analysis.mathCoefficients?.get('P')).not.toHaveProperty('exactExpression');
    expect(result.analysis.geometryDerived).toEqual(new Map([['P', ['g1']]]));
  });

  it.each([[1e-7, '1e-7'], [1.5e21, '1.5e+21']] as const)('指数表記の最短十進 %s をそのまま数学計算部へ渡す', async (value, decimal) => {
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1')]);
    const { requests, result: pending } = run(document, { geometry: geometryOf(measured('g1', value)) });
    const result = await pending;
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(requests[0].coefficients).toEqual([{ id: 'math-geometry:g1', label: 'G', decimal }]);
    expect(result.document.parameters[0].value.value).toBe(value * 2);
  });

  it('係数を経由しても図形由来が推移し(数式・旧式)、図形由来でない係数は従来どおり', async () => {
    const document = part([
      row('P', math('coef("G")*2'), 'coefficient:1'),
      row('Q', math('coef("P")+1', [coefficientP]), 'coefficient:2'),
      row('R', legacyUsing('P*3'), 'coefficient:3'),
      row('S', legacy('1/3'), 'coefficient:4'),
    ]);
    const result = await run(document, { geometry: geometryOf(measured('g1', 20)) }).result;
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(result.document.parameters.map(parameter => parameter.value.value)).toEqual([40, 41, 120, 1 / 3]);
    for (const name of ['P', 'Q', 'R']) expect(result.analysis.mathCoefficients?.get(name), name).not.toHaveProperty('exactExpression');
    expect(result.analysis.mathCoefficients?.get('S')?.exactExpression).toBeDefined();
    expect(result.analysis.geometryDerived).toEqual(new Map([['P', ['g1']], ['Q', ['g1']], ['R', ['g1']]]));
  });

  it('旧式の計算でも測った値から有理数を作り直さない(図形由来でない同じ計算は従来どおり有理数へ戻る)', async () => {
    const document = part([
      row('P', math('coef("G")'), 'coefficient:1'),
      row('R', legacyUsing('P/3*3'), 'coefficient:2'),
      row('S', legacy('1/3*3'), 'coefficient:3'),
    ]);
    const result = await run(document, { geometry: geometryOf(measured('g1', 1)) }).result;
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    // The plain decimal evaluation of the same legacy formula, i.e. what R must carry (not the rational 1).
    const plain = evaluateExpressionExact('P/3*3', { variables: new Map([['P', 1]]), exactVariables: new Map([['P', '1']]) });
    if (!plain.ok) throw new Error(plain.error.message);
    expect(plain.value.exact).not.toBe('1');
    expect(result.analysis.exactVariables.get('R')).toBe(plain.value.exact);
    expect(result.analysis.exactVariables.get('S')).toBe('1');
    expect(result.document.parameters.map(parameter => parameter.value.value)).toEqual([1, 1, 1]);
  });

  it('同じ文書でも測った値が変われば新しい値で評価し直し、座標の確認済みの値も入れ替える', async () => {
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1')], undefined, math('coef("P")+1', [coefficientP]));
    const first = await run(document, { geometry: geometryOf(measured('g1', 20)) }).result;
    expect(first.ok).toBe(true);
    expect(evaluatedDocumentMathValue(document, pointOf(document).x)?.value).toBe(41);
    const second = await run(document, { geometry: geometryOf(measured('g1', 25)) }).result;
    if (!second.ok) throw new Error(JSON.stringify(second.failures));
    expect(second.document.parameters[0].value.value).toBe(50);
    expect(evaluatedDocumentMathValue(document, pointOf(document).x)?.value).toBe(51);
  });
});

describe('値が使えないときは理由付きで失敗し、古い値や別の値で代用しない', () => {
  it('値が無い間は計算待ち: 理由・pendingGeometry・利用先の invalidInputs を返し、数学計算部へ送らない', async () => {
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1')], undefined, math('coef("P")+1', [coefficientP]));
    const { requests, result: pending } = run(document);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, cancelled: false });
    const recompute = transient(result);
    expect(recompute.pendingGeometry).toEqual(new Set(['g1']));
    expect(messageOf(result, 'P')).toBe(mathGeometryPendingMessage('G'));
    expect(recompute.analysis.failures).toEqual([{ name: 'P', message: '図形の測定値「G」を計算中です。形の計算が終わると使えます。' }]);
    expect(recompute.invalidInputs.get(pointOf(document).id)).toBe('参照する係数を計算できません: P');
    expect(recompute.analysis.geometryDerived).toEqual(new Map([['P', ['g1']]]));
    expect(requests).toHaveLength(0);
  });

  it('他の文書・他の定義の結果は現在の値として使わず計算待ちにする', async () => {
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1')]);
    for (const outcome of [{ ...measured('g1', 20), documentId: 'another-part' }, { ...measured('g1', 20), id: 'g2' }]) {
      const { requests, result } = run(document, { geometry: new Map([['g1', outcome]]) });
      expect(transient(await result).pendingGeometry).toEqual(new Set(['g1']));
      expect(requests).toHaveLength(0);
    }
  });

  it('測れない結果は定義名・係数名・測定側の理由を付けて失敗し、計算待ちには入れない', async () => {
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1')]);
    const reason = '参照する現在の図形を確認できません。参照先を選び直してください。';
    const outcome: MathGeometryOutcome = { id: 'g1', documentId: DOCUMENT_ID, generation: 3, status: 'unresolved',
      reason: 'missing-reference', message: reason };
    const result = await run(document, { geometry: geometryOf(outcome) }).result;
    expect(messageOf(result, 'P')).toBe(mathGeometryUnresolvedMessage('G', 'P', reason));
    expect(messageOf(result, 'P')).toBe(`図形の測定値「G」を測れないため、係数「P」を計算できません: ${reason}`);
    expect(transient(result).pendingGeometry.size).toBe(0);
  });

  it('平行・垂直などの真偽の結果は係数の式へ入れない', async () => {
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1')]);
    const outcome: MathGeometryOutcome = { id: 'g1', documentId: DOCUMENT_ID, generation: 3, status: 'value', kind: 'boolean',
      value: true, representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
    const { requests, result } = run(document, { geometry: geometryOf(outcome) });
    expect(messageOf(await result, 'P')).toBe(mathGeometryBooleanMessage('G'));
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['名前の違う定義', [definition('g1', 'H')], []],
    ['存在しない定義', [], []],
    ['係数と同じ名前の定義', [definition('g1', 'G')], [row('G', legacy('5'), 'coefficient:9')]],
  ] as const)('参照先の不一致(%s)は理由付きで失敗し、別の値で代用しない', async (_case, definitions, extra) => {
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1'), ...extra], definitions);
    const { requests, result: pending } = run(document, { geometry: geometryOf(measured('g1', 20)) });
    const result = await pending;
    expect(messageOf(result, 'P')).toBe(mathGeometryReferenceMismatchMessage('G'));
    expect(transient(result).pendingGeometry.size).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('座標の欄(係数の式以外)で測った値を直接使うと、Q2=U1 の理由で拒否する', async () => {
    const document = part([], undefined, math('coef("G")+1'));
    const { requests, result: pending } = run(document, { geometry: geometryOf(measured('g1', 20)) });
    const result = await pending;
    const point = pointOf(document).id;
    expect(messageOf(result, point)).toBe(mathGeometryOutsideCoefficientMessage('G'));
    expect(transient(result).invalidInputs.get(point)).toBe('図形の測定値は係数の式の中でだけ使えます: G');
    expect(requests).toHaveLength(0);
  });

  it('blocked の係数は数学計算部へ送らずその理由で失敗し、使う係数も失敗する', async () => {
    const reason = '係数「P」は図形の測定値「G」を使っていますが、その測る形「箱1」が「P」を使って作られているため循環しています。';
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1'), row('Q', math('coef("P")+1', [coefficientP]), 'coefficient:2')]);
    const { requests, result: pending } = run(document, { geometry: geometryOf(measured('g1', 20)), blocked: new Map([['P', reason]]) });
    const result = await pending;
    expect(messageOf(result, 'P')).toBe(reason);
    expect(messageOf(result, 'Q')).toBe('参照する係数を計算できません: P');
    expect(transient(result).analysis.geometryDerived).toEqual(new Map([['P', ['g1']], ['Q', ['g1']]]));
    expect(requests).toHaveLength(0);
  });

  /**
   * GR-19d (w15a's e2e finding): a plain, legacy-style formula that names a *blocked* coefficient
   * (`P`, here circular through the measured geometry) got the generic `決まっていない名前です`
   * (unknown name, `packages/expression/src/errors.ts`, code `unknownVariable`) instead of `P`'s own
   * reason, because `P` never entered the `variables`/`exactVariables` maps the legacy evaluator reads.
   * `P` is a real, defined coefficient; only a genuinely undefined name may say so.
   */
  it('blocked の係数を旧式(名前参照)の式で使うときも、決まっていない名前ではなく元の理由を示す', async () => {
    const reason = '係数「P」は図形の測定値「G」を使っていますが、その測る形「箱1」が「P」を使って作られているため循環しています。';
    const document = part([row('P', math('coef("G")*2'), 'coefficient:1'), row('R', legacyUsing('P*3'), 'coefficient:3')]);
    const { requests, result: pending } = run(document, { geometry: geometryOf(measured('g1', 20)), blocked: new Map([['P', reason]]) });
    const result = await pending;
    expect(messageOf(result, 'P')).toBe(reason);
    expect(messageOf(result, 'R')).not.toContain('決まっていない名前');
    expect(messageOf(result, 'R')).toContain(reason);
    expect(requests).toHaveLength(0);
  });

  it('図形の測定値の名前空間の識別番号を持つ係数は、不正な参照先として断る', async () => {
    const document = part([row('X', legacy('3'), 'math-geometry:x')], []);
    const result = await run(document).result;
    expect(result).toEqual({ ok: false, cancelled: false,
      failures: [{ ownerId: 'X', source: '3', message: '係数の名前または参照先が不正・重複しています。' }] });
  });
});

describe('Q4=S1: 値の境目で結果が飛ぶ演算を拒否する', () => {
  it.each([
    ['floor(coef("G"))', 'floor'], ['ceil(coef("G"))', 'ceil'], ['round(coef("G"))', 'round'],
    ['mod(coef("G"),3)', 'mod'], ['sum(coef("G")*k,k,1,3)', 'sum'],
  ])('%s は測った値があっても数学計算部へ送らず「%s」を理由に拒否する', async (source, name) => {
    const document = part([row('P', formula(source), 'coefficient:1')]);
    const { requests, result: pending } = run(document, { geometry: geometryOf(measured('g1', 20.5)) });
    const result = await pending;
    expect(messageOf(result, 'P')).toBe(mathGeometryOperationMessage(name));
    expect(transient(result).pendingGeometry.size).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('図形由来の係数を使う係数の式・座標の欄にも同じ制限が掛かり、無関係な式には掛からない', async () => {
    const document = part([
      row('P', math('coef("G")*2'), 'coefficient:1'),
      row('Q', formula('round(coef("P"))', [coefficientP]), 'coefficient:2'),
      row('A', math('floor(7/2)', []), 'coefficient:3'),
    ], undefined, formula('floor(coef("P"))', [coefficientP]));
    const result = await run(document, { geometry: geometryOf(measured('g1', 20)) }).result;
    expect(messageOf(result, 'Q')).toBe(mathGeometryOperationMessage('round'));
    expect(messageOf(result, pointOf(document).id)).toBe(mathGeometryOperationMessage('floor'));
    expect(messageOf(result, 'A')).toBeUndefined();
    expect(transient(result).document.parameters.map(parameter => parameter.value.value).slice(0, 1)).toEqual([40]);
  });
});

describe('覚え書き(§2.3-④): 図形由来の係数がある表は覚えない', () => {
  it('図形由来の係数があれば覚え書きを残さず、analyzeParameters は古い値を返さない', async () => {
    const result = await run(part([row('P', math('coef("G")*2'), 'coefficient:1')]), { geometry: geometryOf(measured('g1', 20)) }).result;
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(knownMathParameterEvaluation(result.document.parameters)).toBeUndefined();
    const analysis = analyzeParameters(result.document.parameters, []);
    expect(analysis.variables.has('P')).toBe(false);
    expect(analysis.failures).toEqual([{ name: 'P', message: 'この数式は数学計算部での再計算が必要です。' }]);
  });

  it('図形由来の係数が無い表は従来どおり覚え、analyzeParameters がその値を返す', async () => {
    const result = await run(part([row('A', math('1/3', []), 'coefficient:1')], [])).result;
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(knownMathParameterEvaluation(result.document.parameters)).toBeDefined();
    expect(result.analysis).not.toHaveProperty('geometryDerived');
    expect(analyzeParameters(result.document.parameters, []).variables.get('A')).toBe(1 / 3);
  });
});
