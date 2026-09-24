/**
 * GR-08 (`scratchpad/claude/plans/geomref-plan.md` §4(b), §5.2 GR-08): renaming a math-geometry definition
 * relabels every formula that reads it, with its ID unchanged, as one validated document; a coefficient
 * rename accepts formulas that read measured values and refuses a measured value's name. The real math
 * engine runs every request; no shape kernel is needed because a rename never changes a shape (§10.303).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { collectMathCoefficients, evaluateExpression, mathScalarExpression, type ExpressionValue,
  type StoredMathExpression } from '@pointercad/expression';
import { createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import type { MathWorkRequest } from '@pointercad/expression/math/client';

import { synchronizeConfigurations, type Configuration } from './configurations.js';
import { createEmptyPartDocument } from './createPartDocument.js';
import { affectsShape } from './documentChange.js';
import type { DocumentMathContext } from './evaluateDocumentMath.js';
import { renameDocumentMathGeometry } from './renameDocumentMathGeometry.js';
import { renameDocumentMathParameter } from './renameDocumentMathParameter.js';
import type { PartDocument } from './types.js';
import { setUnresolvedMathProblem } from './unresolvedMathProblems.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import type { Parameter } from '../parameters/types.js';
import { mathGeometryPendingMessage, mathGeometryUnresolvedMessage } from '../measure/mathGeometryCoefficients.js';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId } from '../measure/mathGeometryIdentity.js';
import type { MathGeometryDefinition, MathGeometryOutcome } from '../measure/mathGeometryTypes.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });

const DOCUMENT_ID = createEmptyPartDocument().id;
const identity = { documentId: DOCUMENT_ID, documentVersion: 1, editorId: 'test', inputRevision: 1 };
type Coefficient = MathWorkRequest['coefficients'][number];

function calculate(request: MathWorkRequest) {
  const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)),
    declaredIds: new Set((request.declarations ?? request.definition?.declarations)?.map(value => value.id)) }).result;
}
/** What the coefficient editor offers while a formula is typed: the measured value G and two coefficients. */
const G: Coefficient = { id: mathGeometryCoefficientId('g1'), label: 'G', decimal: '20' };
const A: Coefficient = { id: 'coefficient:1', label: 'A', decimal: '3' };
const P: Coefficient = { id: 'coefficient:2', label: 'P', decimal: '40' };
const RENAMED = { role: 'coefficient', id: 'math-geometry:g1', label: '箱1体積' } as const;

/** A saved formula exactly as the editor stores it (typed as text, optionally kept as LaTeX), with its accepted value. */
function math(source: string, coefficients: readonly Coefficient[] = [G], notation: 'text' | 'latex' = 'text'): ExpressionValue {
  const result = calculate({ identity, source, notation: 'text', angleUnit: 'degree', coefficients,
    ...(notation === 'latex' ? { presentationNotation: 'latex' as const } : {}) });
  const accepted = mathScalarExpression(result);
  if (!accepted.ok) throw new Error(accepted.message);
  if (notation === 'text') return accepted.value;
  if (result.presentation == null) throw new Error(`Expected a LaTeX presentation: ${source}`);
  return { ...accepted.value, source: result.presentation.source, mathDefinition: result.presentation };
}
function legacy(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function stored(value: StoredMathExpression | undefined): StoredMathExpression {
  if (value === undefined) throw new Error('Expected a stored formula');
  return value;
}
function labelsOf(value: ExpressionValue) {
  return collectMathCoefficients(stored(value.mathDefinition).expression);
}
/**
 * A relabelled formula is re-formatted by the math engine (its exact spelling is the formatter's, e.g.
 * `Multiply(coef("箱1体積"),2)`); what must hold is that the text equals its stored definition's and shows
 * every `present` label and no `absent` one.
 */
function expectText(source: string | undefined, definition: StoredMathExpression | undefined,
  present: readonly string[], absent: readonly string[]): void {
  expect(source).toBe(stored(definition).source);
  for (const label of present) expect(source).toContain(`coef(${JSON.stringify(label)})`);
  for (const label of absent) expect(source).not.toContain(`coef(${JSON.stringify(label)})`);
}
function row(name: string, value: ExpressionValue, mathId?: string): Parameter {
  return { name, value, ...(mathId === undefined ? {} : { mathId }), unit: 'mm', description: '' };
}
function definition(id: string, name: string): MathGeometryDefinition {
  return { id, documentId: DOCUMENT_ID, name, quantity: { kind: 'volume', body: { kind: 'body', featureId: 'box-1' } },
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}
/** A part with `parameters` and the definitions (optionally a sketch point whose X is `x`); the active configuration mirrors the table. */
function part(parameters: readonly Parameter[], definitions: readonly MathGeometryDefinition[] = [definition('g1', 'G')],
  x?: ExpressionValue): PartDocument {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  const base: PartDocument = { ...document, parameters, mathGeometry: definitions };
  return synchronizeConfigurations(x === undefined ? base
    : { ...base, sketches: [{ ...sketch, features: [createPointFeature(sketch, { ...absoluteCoordinate(0, 0, 0), x })] }] });
}
function pointX(document: PartDocument): ExpressionValue {
  const point = document.sketches[0].features[0];
  if (point.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('Expected an absolute point');
  return point.at.x;
}
function measured(id: string, value: number): MathGeometryOutcome {
  return { id, documentId: DOCUMENT_ID, generation: 3, status: 'value', kind: 'real', value, unit: 'mm3',
    representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}
/** The real engine behind a recording client; G = 20 is this document's current measured value unless `changes` say otherwise. */
function run(document: PartDocument, changes: Partial<DocumentMathContext> = {}) {
  const requests: MathWorkRequest[] = [];
  const context: DocumentMathContext = { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    geometry: new Map([['g1', measured('g1', 20)]]),
    client: { evaluate: request => {
      requests.push(request);
      return Promise.resolve({ status: 'result', identity: request.identity, result: calculate(request) });
    } }, ...changes };
  return { requests, context };
}
const renameRequests = (requests: readonly MathWorkRequest[]) => requests.filter(request => request.renameCoefficient !== undefined);

describe('図形の測定値の名前の変更(renameDocumentMathGeometry)', () => {
  it('係数・構成・未解決の式のラベルを新しい名前へ変え、識別番号・量・比べる幅と値は保つ', async () => {
    const doubled = math('coef("G")*2'), tripled = math('coef("G")*3');
    const base = part([row('P', doubled, 'coefficient:2')]);
    const other: Configuration = { id: 'configuration-2', name: '別案', values: { P: tripled.source },
      mathDefinitions: { P: stored(tripled.mathDefinition) } };
    const declarations = [{ id: 'symbol:a', label: 'a_1', meaning: '未知の長さ', type: 'real' as const }];
    const saved = calculate({ identity, source: 'coef("G")+a_1', notation: 'text', angleUnit: 'degree', coefficients: [G], declarations });
    if (saved.definition === null) throw new Error('Expected the unresolved formula');
    const original = setUnresolvedMathProblem({ ...base, configurations: [...base.configurations, other] },
      { id: 'math-problem:g', name: '図形の式', status: 'unresolved', definition: saved.definition });
    const before = JSON.stringify(original);
    const { requests, context } = run(original);

    const result = await renameDocumentMathGeometry(original, 'g1', '箱1体積', context);
    if (!result.ok) throw new Error(result.message);
    const renamed = result.document;

    expect(renamed.mathGeometry).toEqual([{ ...definition('g1', 'G'), name: '箱1体積' }]);
    const coefficient = renamed.parameters[0];
    expect(coefficient).toMatchObject({ name: 'P', mathId: 'coefficient:2', value: { value: 40 } });
    expect(labelsOf(coefficient.value)).toEqual([RENAMED]);
    expectText(coefficient.value.source, coefficient.value.mathDefinition, ['箱1体積'], ['G']);
    const [active, alternative] = renamed.configurations;
    expect(active.mathDefinitions?.P).toEqual(coefficient.value.mathDefinition);
    expect(active.values.P).toBe(coefficient.value.source);
    expect(collectMathCoefficients(stored(alternative.mathDefinitions?.P).expression)).toEqual([RENAMED]);
    expect(Object.keys(alternative.values)).toEqual(['P']);
    expectText(alternative.values.P, alternative.mathDefinitions?.P, ['箱1体積'], ['G']);
    expect(alternative.values.P).not.toBe(active.values.P);
    const problem = renamed.unresolvedMathProblems?.[0];
    expect(problem).toMatchObject({ id: 'math-problem:g', name: '図形の式', status: 'unresolved', definition: { declarations } });
    expect(collectMathCoefficients(stored(problem?.definition).expression)).toEqual([RENAMED]);
    expectText(problem?.definition.source, problem?.definition, ['箱1体積'], ['G']);
    expect(problem?.definition.source).toContain('a_1');
    // One relabel request per distinct formula (the active configuration shares the coefficient's formula).
    expect(renameRequests(requests).map(request => request.renameCoefficient)).toEqual(
      Array.from({ length: 3 }, () => ({ id: 'math-geometry:g1', label: '箱1体積' })));
    expect(JSON.stringify(original)).toBe(before);
  });

  it('LaTeX で保存した係数の式も入力方式を保って名前を変え、値は変わらない', async () => {
    const original = part([row('P', math('coef("G")*2', [G], 'latex'), 'coefficient:2')]);
    const result = await renameDocumentMathGeometry(original, 'g1', '箱1体積', run(original).context);
    if (!result.ok) throw new Error(result.message);
    const value = result.document.parameters[0].value;
    expect(value.mathDefinition?.inputNotation).toBe('latex');
    expect(labelsOf(value)).toEqual([RENAMED]);
    expect(value.source).toBe(value.mathDefinition?.source);
    expect(value.source).toContain('箱1体積');
    expect(value.value).toBe(40);
  });

  it.each([
    ['係数と同じ名前', 'P', 'duplicateName'],
    ['別の図形の測定値と同じ名前', 'H', 'duplicateName'],
    ['数字で始まる名前', '1体積', 'startsWithDigit'],
    ['計算に使う言葉', 'sqrt', 'reserved'],
    ['前後に空白のある名前', ' 体積', 'whitespace'],
    ['129文字の名前', 'a'.repeat(129), 'tooLong'],
    ['空の名前', '', 'empty'],
  ] as const)('%s(%j)は数学計算部へ送らず %s で断り、文書を変えない', async (_case, name, reason) => {
    const original = part([row('P', math('coef("G")*2'), 'coefficient:2')], [definition('g1', 'G'), definition('g2', 'H')]);
    const before = JSON.stringify(original);
    const { requests, context } = run(original);
    const result = await renameDocumentMathGeometry(original, 'g1', name, context);
    expect(result).toEqual({ ok: false, cancelled: false, reason, message: '図形の測定値の新しい名前が不正、または既に使われています。' });
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('今と同じ名前なら元の文書そのものを返し、数学計算部へ送らない(再計算も Undo も増えない)', async () => {
    const original = part([row('P', math('coef("G")*2'), 'coefficient:2')]);
    const { requests, context } = run(original);
    const result = await renameDocumentMathGeometry(original, 'g1', 'G', context);
    if (!result.ok) throw new Error(result.message);
    expect(result.document).toBe(original);
    expect(affectsShape(original, result.document)).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['存在しない識別番号', [definition('g1', 'G')], 'missing'],
    ['2つの定義が同じ識別番号', [definition('g1', 'G'), definition('g1', 'H')], 'g1'],
  ] as const)('%s は notFound で断る', async (_case, definitions, id) => {
    const original = part([], definitions);
    const { requests, context } = run(original);
    expect(await renameDocumentMathGeometry(original, id, '箱1体積', context)).toEqual(
      { ok: false, cancelled: false, reason: 'notFound', message: '名前を変える図形の測定値がありません。' });
    expect(requests).toHaveLength(0);
  });

  it.each(['始める前に中止', '改名の依頼中に中止', '改名の依頼中に別の文書へ切替', '別の文書の文脈'] as const)(
    '%s なら文書を返さず、元の文書も変えない', async mode => {
      const original = part([row('P', math('coef("G")*2'), 'coefficient:2')]);
      const before = JSON.stringify(original);
      const controller = new AbortController();
      let current = true;
      if (mode === '始める前に中止') controller.abort();
      const { context } = run(original, {
        signal: controller.signal, isCurrent: () => current,
        ...(mode === '別の文書の文脈' ? { identity: { documentId: 'another-part', documentVersion: 1 } } : {}),
        client: { evaluate: request => {
          if (mode === '改名の依頼中に中止') controller.abort();
          if (mode === '改名の依頼中に別の文書へ切替') current = false;
          return Promise.resolve({ status: 'result', identity: request.identity, result: calculate(request) });
        } },
      });
      const result = await renameDocumentMathGeometry(original, 'g1', '箱1体積', context);
      expect(result).toEqual({ ok: false, cancelled: true, reason: 'cancelled', message: '図形の測定値の名前の変更を中止しました。' });
      expect(result).not.toHaveProperty('document');
      expect(JSON.stringify(original)).toBe(before);
    });

  const missing: MathGeometryOutcome = { id: 'g1', documentId: DOCUMENT_ID, generation: 3, status: 'unresolved',
    reason: 'missing-reference', message: '参照する現在の図形を確認できません。参照先を選び直してください。' };
  it.each([
    ['測った値がまだ無い(計算待ち)', new Map<string, MathGeometryOutcome>(), mathGeometryPendingMessage('箱1体積')],
    ['参照先が見つからず測れない', new Map([['g1', missing]]), mathGeometryUnresolvedMessage('箱1体積', 'P', missing.message)],
  ])('%s文書は、名前を変えた文書全体の検証(context.geometry)で断り、文書を返さない', async (_case, geometry, message) => {
    const original = part([row('P', math('coef("G")*2'), 'coefficient:2')]);
    const result = await renameDocumentMathGeometry(original, 'g1', '箱1体積', run(original, { geometry }).context);
    expect(result).toEqual({ ok: false, cancelled: false, reason: 'invalidDocument', message });
  });

  it('今の名前と違う古いラベルで読んでいる式があれば、数学計算部へ送らず unverifiedReference で断る', async () => {
    const original = part([row('P', math('coef("古い名前")*2', [{ ...G, label: '古い名前' }]), 'coefficient:2')]);
    const { requests, context } = run(original);
    expect(await renameDocumentMathGeometry(original, 'g1', '箱1体積', context)).toEqual(
      { ok: false, cancelled: false, reason: 'unverifiedReference', message: '保存された式の参照先を確認できません。' });
    expect(requests).toHaveLength(0);
  });

  it('名前の変更は形と値を変えないが、定義の変更として再計算の対象になる(§4(b)、§10.303)', async () => {
    const original = part([row('P', math('coef("G")*2'), 'coefficient:2')], undefined, math('coef("P")+1', [P]));
    const result = await renameDocumentMathGeometry(original, 'g1', '箱1体積', run(original).context);
    if (!result.ok) throw new Error(result.message);
    const renamed = result.document;
    expect(pointX(renamed)).toMatchObject({ source: 'coef("P")+1', value: 41 });
    expect(renamed.sketches).toEqual(original.sketches);
    expect(renamed.solids).toEqual(original.solids);
    expect(renamed.references).toEqual(original.references);
    expect(renamed.parameters.map(parameter => parameter.value.value)).toEqual([40]);
    expect(affectsShape(original, renamed)).toBe(true);
  });
});

describe('係数の改名と図形の測定値(renameDocumentMathParameter)', () => {
  const table = () => part([row('A', legacy('3'), 'coefficient:1'), row('P', math('coef("G")*2+coef("A")', [G, A]), 'coefficient:2')]);

  it('図形の測定値を読む式でも係数を改名でき、測定値のラベルと識別番号は変わらない', async () => {
    const original = table();
    const before = JSON.stringify(original);
    const { requests, context } = run(original);
    const result = await renameDocumentMathParameter(original, 'A', '幅', context);
    if (!result.ok) throw new Error(result.message);
    const value = result.document.parameters[1].value;
    expect(result.document.parameters.map(parameter => parameter.name)).toEqual(['幅', 'P']);
    expect(labelsOf(value)).toEqual([
      { role: 'coefficient', id: 'math-geometry:g1', label: 'G' },
      { role: 'coefficient', id: 'coefficient:1', label: '幅' },
    ]);
    expect(value.value).toBe(43);
    expectText(value.source, value.mathDefinition, ['G', '幅'], ['A']);
    expect(result.document.mathGeometry).toEqual(original.mathGeometry);
    expect(renameRequests(requests).map(request => request.coefficients)).toEqual([
      [{ id: 'math-geometry:g1', label: 'G', decimal: '0' }, { id: 'coefficient:1', label: 'A', decimal: '0' }],
    ]);
    // The whole renamed document was then evaluated with the caller's measured value G = 20.
    expect(requests.some(request => request.coefficients.some(coefficient =>
      coefficient.id === 'math-geometry:g1' && coefficient.decimal === '20'))).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('最後の文書全体の評価には context.geometry がそのまま渡り、測った値が無ければその理由で断る', async () => {
    const original = table();
    const result = await renameDocumentMathParameter(original, 'A', '幅', run(original, { geometry: undefined }).context);
    expect(result).toEqual({ ok: false, cancelled: false, message: mathGeometryPendingMessage('G') });
  });

  it('係数の改名先が図形の測定値の名前なら、数学計算部へ送らずに断り文書を変えない', async () => {
    const original = table();
    const before = JSON.stringify(original);
    const { requests, context } = run(original);
    const result = await renameDocumentMathParameter(original, 'A', 'G', context);
    expect(result).toEqual({ ok: false, cancelled: false, message: '係数の新しい名前が不正、または既に使われています。' });
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('図形の測定値を古いラベルで読む式は、係数の改名でも参照先を確認できないとして断る', async () => {
    const original = part([row('A', legacy('3'), 'coefficient:1'),
      row('P', math('coef("古い名前")*2+coef("A")', [{ ...G, label: '古い名前' }, A]), 'coefficient:2')]);
    const { requests, context } = run(original);
    expect(await renameDocumentMathParameter(original, 'A', '幅', context)).toEqual(
      { ok: false, cancelled: false, message: '保存された係数の参照先を確認できません。' });
    expect(requests).toHaveLength(0);
  });

  it('図形の測定値の名前を変えた文書でも、それを読む式を含む係数の改名が続けて通る', async () => {
    const original = table();
    const geometryRenamed = await renameDocumentMathGeometry(original, 'g1', '箱1体積', run(original).context);
    if (!geometryRenamed.ok) throw new Error(geometryRenamed.message);
    const renamed = await renameDocumentMathParameter(geometryRenamed.document, 'A', '幅', run(geometryRenamed.document).context);
    if (!renamed.ok) throw new Error(renamed.message);
    const value = renamed.document.parameters[1].value;
    expect(value.value).toBe(43);
    expect(labelsOf(value)).toEqual([RENAMED, { role: 'coefficient', id: 'coefficient:1', label: '幅' }]);
    expectText(value.source, value.mathDefinition, ['箱1体積', '幅'], ['G', 'A']);
  });
});
