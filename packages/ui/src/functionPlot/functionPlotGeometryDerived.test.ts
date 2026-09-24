/**
 * GR-18b (`scratchpad/claude/plans/geomref-plan.md` §5.2 GR-18b, and the lead's addendum in
 * `scratchpad/claude/instructions/w8-claude-wave.md`): two independent checks inside the function-plot draft
 * editor (`evaluateFunctionPlotDraft`).
 *
 * 1. rules/06 §10.317: an implicit curve/surface written with "=" at its root (`X^2+Y^2=1`) can never be
 *    sampled (the calculation tape has no `equal` outside a `which` condition; only F in "F=0" is drawable,
 *    per the explanation `function-curve.md`/`function-surface.md`). This is refused before confirming, with
 *    the same guidance text `resolveFunctionInputs.ts` now shows for an older saved file (model test:
 *    `mathGeometryFunctionOperations.test.ts`). No `coef()` is involved, so the real math backend parses
 *    every case here exactly as a user's keystrokes would.
 *
 * 2. GR-06b's rule (a geometry-derived coefficient may not feed an operation that jumps at a value boundary)
 *    is applied to the plot's own formula before confirming, via `checkGeometryDerivedFunctionOperations`.
 *    Wiring this requires a document whose coefficient R is geometry-derived (GR-04: R's own formula is
 *    `coef("G")`, built with `mathGeometryParameterDraft` exactly as the real "この値の係数を作る" command
 *    does). `evaluateFunctionPlotDraft` never receives live geometry (`prepareDocumentMathEnvironment`'s
 *    internal context has no `geometry`; unlike `ParameterMathDialog.tsx`, GR-17, which fetches it itself via
 *    `mathGeometryInputsFor`, this file never does), so R's own formula can never resolve through the real
 *    parser here and `coef("R")` cannot be declared for parsing (a pre-existing gap outside GR-18b's stated
 *    scope: `functionPlotDraft.ts` is absent from both GR-17's and GR-18's file lists). To test the check
 *    itself in isolation from that gap, only the one formula field under test is intercepted with a hand-built
 *    parse result (`withFormulaOverride`); every other field (the six XYZ bounds, tolerance, the untouched
 *    output) still goes through the real backend exactly as a user's input would.
 */
import type { StoredMathExpression } from '@pointercad/expression';
import { CANDIDATE_MATH_BY_ID, MATH_INPUT_FORMAT, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { createEmptyPartDocument, DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryOperationMessage,
  mathGeometryParameterDraft, type MathGeometryDefinition, type Parameter, type PartDocument } from '@pointercad/model';
import { beforeAll, describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { editFunctionField, evaluateFunctionPlotDraft, functionPlotDraft, type FunctionPlotDraft } from './functionPlotDraft.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });

const realClient = (): Pick<MathWorkerClient, 'evaluate'> => ({ evaluate: request => Promise.resolve({
  status: 'result', identity: request.identity,
  result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(item => item.id)), declaredIds: new Set() }).result }) });

/**
 * Intercepts exactly one source string with a hand-built parse result; every other request goes to the real
 * backend. See the file header for why the one formula under test cannot go through the real parser here.
 */
function withFormulaOverride(source: string, expression: StoredMathExpression['expression']): Pick<MathWorkerClient, 'evaluate'> {
  const definition: StoredMathExpression = { format: MATH_INPUT_FORMAT, source, inputNotation: 'text', angleUnit: 'degree', expression };
  const real = realClient();
  return { evaluate: (request, timeoutMs, signal) => request.source === source
    ? Promise.resolve({ status: 'result' as const, identity: request.identity,
        result: { definition, evaluation: { status: 'value' as const, kind: 'function' as const, expression } } })
    : real.evaluate(request, timeoutMs, signal) };
}

function filled(): FunctionPlotDraft {
  const draft = functionPlotDraft(), scalar = (source: string) => ({ source, angleUnit: 'degree' as const });
  return { ...draft, scalars: { ...draft.scalars, 'X.min': scalar('-2'), 'X.max': scalar('2'),
    'Y.min': scalar('-4'), 'Y.max': scalar('4'), 'Z.min': scalar('-1'), 'Z.max': scalar('1') } };
}
const evaluate = (draft: FunctionPlotDraft, client: Pick<MathWorkerClient, 'evaluate'>, document = createEmptyPartDocument()) =>
  evaluateFunctionPlotDraft(document, 1, draft, client, new AbortController().signal, () => true);

describe('陰関数の根の「=」は確定前に断り、説明書のF=0のF形へ案内する(rules/06 §10.317, GR-18b)', () => {
  it('平面等式でX^2+Y^2=1のように根へ「=」を書くと、equation欄へ案内を返し黙ってF形へ書き換えない', async () => {
    const draft = filled();
    const implicitDraft: FunctionPlotDraft = { ...draft, form: 'implicit', fixedAxis: 'Z',
      equation: editFunctionField(draft.equation, 'X^2+Y^2=1'), scalars: { ...draft.scalars, fixedCoordinate: { source: '0', angleUnit: 'degree' } } };
    const result = await evaluate(implicitDraft, realClient());
    if (result.ok) throw new Error('Expected the "=" root to be refused');
    expect(result.fields.get('equation')).toBe(t('functionPlot.implicitEqualsNotSupported'));
    expect([...result.fields.keys()]).toEqual(['equation']);
  });

  it('F=0のF形(X^2+Y^2-1、根に「=」が無い)は従来どおり確定する', async () => {
    const draft = filled();
    const implicitDraft: FunctionPlotDraft = { ...draft, form: 'implicit', fixedAxis: 'Z',
      equation: editFunctionField(draft.equation, 'X^2+Y^2-1'), scalars: { ...draft.scalars, fixedCoordinate: { source: '0', angleUnit: 'degree' } } };
    const result = await evaluate(implicitDraft, realClient());
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.formula).toMatchObject({ kind: 'implicit-curve', expression: { source: 'X^2+Y^2-1' } });
  });

  it('空間等式(曲面)でも根の「=」(X^2+Y^2+Z^2=1)を同じ案内の文で断る', async () => {
    const draft = filled();
    const implicitDraft: FunctionPlotDraft = { ...draft, geometry: 'surface', form: 'implicit',
      equation: editFunctionField(draft.equation, 'X^2+Y^2+Z^2=1') };
    const result = await evaluate(implicitDraft, realClient());
    if (result.ok) throw new Error('Expected the "=" root to be refused');
    expect(result.fields.get('equation')).toBe(t('functionPlot.implicitEqualsNotSupported'));
  });

  it('空間等式のF=0のF形(X^2+Y^2+Z^2-1)は従来どおり確定する', async () => {
    const draft = filled();
    const implicitDraft: FunctionPlotDraft = { ...draft, geometry: 'surface', form: 'implicit',
      equation: editFunctionField(draft.equation, 'X^2+Y^2+Z^2-1') };
    const result = await evaluate(implicitDraft, realClient());
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.formula).toMatchObject({ kind: 'implicit-surface', expression: { source: 'X^2+Y^2+Z^2-1' } });
  });

  it('複雑な式でも根が「=」(sin(X)=cos(Y))なら断り、両辺を引いたF形(sin(X)-cos(Y))に直せば受理する', async () => {
    const draft = filled();
    const withEquals: FunctionPlotDraft = { ...draft, form: 'implicit', fixedAxis: 'Z',
      equation: editFunctionField(draft.equation, 'sin(X)=cos(Y)'), scalars: { ...draft.scalars, fixedCoordinate: { source: '0', angleUnit: 'degree' } } };
    const equalsResult = await evaluate(withEquals, realClient());
    if (equalsResult.ok) throw new Error('Expected the "=" root to be refused');
    expect(equalsResult.fields.get('equation')).toBe(t('functionPlot.implicitEqualsNotSupported'));
    const asF: FunctionPlotDraft = { ...withEquals, equation: editFunctionField(draft.equation, 'sin(X)-cos(Y)') };
    const fResult = await evaluate(asF, realClient());
    if (!fResult.ok) throw new Error(JSON.stringify([...fResult.fields]));
  });

  it('座標曲線・媒介変数曲線には根の「=」の対象欄(equation)が無いため、この検査は無関係(従来どおり確定する)', async () => {
    const draft = filled();
    const result = await evaluate({ ...draft, outputs: { ...draft.outputs, Y: editFunctionField(draft.outputs.Y, 'X^2') } }, realClient());
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.formula).toMatchObject({ kind: 'coordinate-curve' });
  });
});

const DERIVED_ID = 'coefficient:derived-r';
const R_SYMBOL: StoredMathExpression['expression'] = { kind: 'symbol', reference: { role: 'coefficient', id: DERIVED_ID, label: 'R' } };
const X_SYMBOL: StoredMathExpression['expression'] = { kind: 'symbol', reference: { role: 'axis', name: 'X' } };
const R_PLUS_X: StoredMathExpression['expression'] = { kind: 'operation', operation: 'add', operands: [R_SYMBOL, X_SYMBOL] };
const FLOOR_R_PLUS_X: StoredMathExpression['expression'] = { kind: 'operation', operation: 'add',
  operands: [{ kind: 'operation', operation: 'floor', operands: [R_SYMBOL] }, X_SYMBOL] };

/** R's own formula is `coef("G")` (built like the real "この値の係数を作る" command), so R is geometry-derived. */
function geometryDerivedDocument(): PartDocument {
  const base = createEmptyPartDocument();
  const geometryDefinition: MathGeometryDefinition = { id: 'g1', documentId: base.id, name: 'G',
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE,
    quantity: { kind: 'length', curve: { kind: 'sketch-curve', sketchId: 'sketch-x', featureId: 'line-x' } } };
  const withGeometry = { ...base, mathGeometry: [geometryDefinition] };
  const draft = mathGeometryParameterDraft(withGeometry, 'g1', { name: 'R', value: 2, unit: 'mm', description: '' });
  if (!draft.ok) throw new Error(draft.message);
  const derived: Parameter = { ...draft.parameter, mathId: DERIVED_ID };
  return { ...withGeometry, parameters: [derived] };
}

describe('関数作図の式で図形由来の係数を不連続な演算へ渡すと確定前に断る(GR-06b・GR-18b)', () => {
  it('Y=floor(coef("R"))+Xは図形由来の係数Rをfloorへ渡すため、確定前にYの欄だけへGR-06bの理由を返す', async () => {
    const document = geometryDerivedDocument(), source = 'floor(coef("R"))+X';
    const draft = filled();
    const result = await evaluate({ ...draft, outputs: { ...draft.outputs, Y: editFunctionField(draft.outputs.Y, source) } },
      withFormulaOverride(source, FLOOR_R_PLUS_X), document);
    if (result.ok) throw new Error('Expected the geometry-derived operation to be refused');
    expect(result.fields.get('Y')).toBe(mathGeometryOperationMessage('floor'));
    expect([...result.fields.keys()]).toEqual(['Y']);
  });

  it('Y=coef("R")+Xは連続な演算(add)だけでRを使うため確定でき、その式をそのまま保存する', async () => {
    const document = geometryDerivedDocument(), source = 'coef("R")+X';
    const draft = filled();
    const result = await evaluate({ ...draft, outputs: { ...draft.outputs, Y: editFunctionField(draft.outputs.Y, source) } },
      withFormulaOverride(source, R_PLUS_X), document);
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.formula).toMatchObject({ kind: 'coordinate-curve', independent: 'X', outputs: { Y: { source } } });
  });

  it('図形由来の係数が文書に無ければ、この検査は何も調べず従来どおり確定する(floor(X)自体は許可)', async () => {
    const draft = filled();
    const result = await evaluate({ ...draft, outputs: { ...draft.outputs, Y: editFunctionField(draft.outputs.Y, 'floor(X)') } }, realClient());
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.formula).toMatchObject({ kind: 'coordinate-curve', outputs: { Y: { source: 'floor(X)' } } });
  });
});
