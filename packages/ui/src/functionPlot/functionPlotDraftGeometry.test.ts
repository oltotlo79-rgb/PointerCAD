/**
 * GR-18c (`scratchpad/claude/plans/geomref-plan.md` §5.2 GR-18b's report to GR-18c;
 * `scratchpad/claude/instructions/w16a-gr18c-functionplot-geometry.md`): `evaluateFunctionPlotDraft`'s own
 * `prepareDocumentMathEnvironment` context carried no `geometry` (`DocumentMathContext.geometry`, GR-04), so
 * `evaluateDocumentMath` treated the document's geometry-derived coefficient as still 計算待ち and returned
 * `ok:false` for the WHOLE document, leaving `environment.coefficients` empty. Reproduced before the fix
 * (`scratchpad/claude/agents/w16a-gr18c-functionplot-geometry/progress.md`, 09:06): `coef("A")+X`, `coef("R")+X`
 * and `floor(coef("R"))+X` all failed identically with the generic
 * "数式の長さや使えない文字を確認してください。" parser message — an ordinary coefficient (A) sharing the
 * document with an unresolved geometry-derived one (R) failed exactly like R itself, and GR-06b's own check
 * (`checkGeometryDerivedFunctionOperations`) never even ran because the field failed to parse first.
 *
 * The fix: `evaluateFunctionPlotDraft` takes an optional resolved `geometry` (the same
 * `ReadonlyMap<string, MathGeometryOutcome>` `MathExpressionDialog.tsx` obtains via `mathGeometryInputsFor` /
 * `waitForMathEditorGeometry`) and threads it into `prepareDocumentMathEnvironment`'s context. Every caller
 * (`FunctionPlotDialog.tsx`, `functionPointDraft.ts`, `functionSectionDraft.ts`) now waits for it first, the
 * same way `MathExpressionDialog.tsx` already does for the structured math editor.
 *
 * This file evaluates real formulas through the real math backend (`realClient`, no hand-built AST like
 * `functionPlotGeometryDerived.test.ts` was forced to use before this fix) for a document holding both a
 * geometry-derived coefficient R (built with `mathGeometryParameterDraft`, exactly as "この値の係数を作る"
 * does) and an ordinary coefficient A, proving the fix end to end.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { createMathBackend, executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createEmptyPartDocument, DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryOperationMessage,
  mathGeometryPendingMessage, mathGeometryParameterDraft, type MathGeometryDefinition, type MathGeometryOutcome,
  type Parameter, type PartDocument } from '@pointercad/model';
import { editFunctionField, evaluateFunctionPlotDraft, functionPlotDraft, type FunctionPlotDraft } from './functionPlotDraft.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });

const realClient = (): Pick<MathWorkerClient, 'evaluate'> => ({ evaluate: request => Promise.resolve({
  status: 'result', identity: request.identity,
  result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(item => item.id)), declaredIds: new Set() }).result }) });

function filled(): FunctionPlotDraft {
  const draft = functionPlotDraft(), scalar = (source: string) => ({ source, angleUnit: 'degree' as const });
  return { ...draft, scalars: { ...draft.scalars, 'X.min': scalar('-2'), 'X.max': scalar('2'),
    'Y.min': scalar('-4'), 'Y.max': scalar('4'), 'Z.min': scalar('-1'), 'Z.max': scalar('1') } };
}
function withOutput(source: string): FunctionPlotDraft {
  const draft = filled();
  return { ...draft, outputs: { ...draft.outputs, Y: editFunctionField(draft.outputs.Y, source) } };
}

const DEFINITION_ID = 'g1';
/**
 * A document with an ordinary coefficient A and a geometry-derived coefficient R (`coef("G")`, built like
 * "この値の係数を作る"), so both kinds share one document exactly as GR-18b's report describes.
 */
function documentWithOrdinaryAndDerivedCoefficients(): PartDocument {
  const base = createEmptyPartDocument();
  const geometryDefinition: MathGeometryDefinition = { id: DEFINITION_ID, documentId: base.id, name: 'G',
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE,
    quantity: { kind: 'length', curve: { kind: 'sketch-curve', sketchId: 'sketch-x', featureId: 'line-x' } } };
  const withGeometry = { ...base, mathGeometry: [geometryDefinition] };
  const draft = mathGeometryParameterDraft(withGeometry, DEFINITION_ID, { name: 'R', value: 20, unit: 'mm', description: '' });
  if (!draft.ok) throw new Error(draft.message);
  const r: Parameter = { ...draft.parameter, mathId: 'coefficient:derived-r' };
  const a: Parameter = { name: 'A', value: expressionValueFromNumber(5), unit: 'mm', description: '' };
  return { ...withGeometry, parameters: [a, r] };
}
function resolvedGeometry(documentId: string, value = 20): ReadonlyMap<string, MathGeometryOutcome> {
  return new Map([[DEFINITION_ID, { id: DEFINITION_ID, documentId, generation: 1, status: 'value' as const, kind: 'real' as const,
    value, unit: 'mm' as const, representation: 'geometry-double' as const, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }]]);
}

describe('evaluateFunctionPlotDraftへ現在の図形の文脈を渡す(GR-18c)', () => {
  it('coef("A")+Xは図形由来の係数Rが同じ文書にあっても、Aが普通の係数として使える(修正前は文書全体が計算待ち扱いで失敗した)', async () => {
    const document = documentWithOrdinaryAndDerivedCoefficients();
    const result = await evaluateFunctionPlotDraft(document, 1, withOutput('coef("A")+X'), realClient(),
      new AbortController().signal, () => true, resolvedGeometry(document.id));
    if (!result.ok) throw new Error(`Expected coef("A")+X to succeed once R's geometry is supplied: ${JSON.stringify([...result.fields])}`);
    expect(result.definition.formula).toMatchObject({ kind: 'coordinate-curve', outputs: { Y: { source: 'coef("A")+X' } } });
  });

  it('coef("R")+Xは連続な演算だけでRを使うため、実際の計算部でも小数の値だけで確定する(図形由来の係数の連続な式の確定)', async () => {
    const document = documentWithOrdinaryAndDerivedCoefficients();
    const result = await evaluateFunctionPlotDraft(document, 1, withOutput('coef("R")+X'), realClient(),
      new AbortController().signal, () => true, resolvedGeometry(document.id));
    if (!result.ok) throw new Error(`Expected coef("R")+X to succeed: ${JSON.stringify([...result.fields])}`);
    expect(result.definition.formula).toMatchObject({ kind: 'coordinate-curve', outputs: { Y: { source: 'coef("R")+X' } } });
  });

  it('floor(coef("R"))+Xは図形由来の係数Rをfloorへ渡すため、実際の計算部でも確定前にGR-06bの理由で断る(不連続な演算の確定前の拒否)', async () => {
    const document = documentWithOrdinaryAndDerivedCoefficients();
    const result = await evaluateFunctionPlotDraft(document, 1, withOutput('floor(coef("R"))+X'), realClient(),
      new AbortController().signal, () => true, resolvedGeometry(document.id));
    if (result.ok) throw new Error('Expected the geometry-derived operation to be refused');
    expect(result.fields.get('Y')).toBe(mathGeometryOperationMessage('floor'));
    expect([...result.fields.keys()]).toEqual(['Y']);
  });

  it('Gの測定値がまだgeometryに無い間は、欄ごとの構文の誤りではなく計算待ちの一つの理由を返す(計算待ちの表示)', async () => {
    const document = documentWithOrdinaryAndDerivedCoefficients();
    const result = await evaluateFunctionPlotDraft(document, 1, withOutput('coef("A")+X'), realClient(),
      new AbortController().signal, () => true, new Map());
    if (result.ok) throw new Error('Expected the still-pending measurement to block confirmation');
    expect(result.fields.get('form')).toBe(mathGeometryPendingMessage('G'));
    expect([...result.fields.keys()]).toEqual(['form']);
  });

  it('文書が計算の途中で切り替わったら(isCurrentが偽になったら)、古い図形の値を使った成功を返さず取消にする(文書が変わった後の古い結果の破棄)', async () => {
    const document = documentWithOrdinaryAndDerivedCoefficients();
    const client = realClient();
    let live = true;
    const flippingClient: Pick<MathWorkerClient, 'evaluate'> = { evaluate: async (request, timeoutMs, signal) => {
      const result = await client.evaluate(request, timeoutMs, signal);
      live = false; // the document changes the instant the first field's worker reply arrives
      return result;
    } };
    const result = await evaluateFunctionPlotDraft(document, 1, withOutput('coef("R")+X'), flippingClient,
      new AbortController().signal, () => live, resolvedGeometry(document.id));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cancelled).toBe(true);
  });

  it('図形由来の係数が無い文書では、geometryを渡しても渡さなくても従来どおり確定する', async () => {
    const draft = withOutput('floor(X)');
    const withoutGeometry = await evaluateFunctionPlotDraft(createEmptyPartDocument(), 1, draft, realClient(), new AbortController().signal, () => true);
    const withEmptyGeometry = await evaluateFunctionPlotDraft(createEmptyPartDocument(), 1, draft, realClient(), new AbortController().signal, () => true, new Map());
    if (!withoutGeometry.ok) throw new Error(JSON.stringify([...withoutGeometry.fields]));
    if (!withEmptyGeometry.ok) throw new Error(JSON.stringify([...withEmptyGeometry.fields]));
    expect(withoutGeometry.definition.formula).toMatchObject({ kind: 'coordinate-curve', outputs: { Y: { source: 'floor(X)' } } });
    expect(withEmptyGeometry.definition.formula).toMatchObject({ kind: 'coordinate-curve', outputs: { Y: { source: 'floor(X)' } } });
  });
});
