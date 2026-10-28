/**
 * 関数作図の下書き(`evaluateFunctionPlotDraft`)で、入力形式と演算制限を独立に検査する。
 *
 * 1. 陰関数の根の「=」(`X^2+Y^2=1`)は確定前に理由付きで拒否する。計算表には `which` の
 *    条件以外で `equal` がなく、「F=0」のFだけを描くため。`function-curve.md` /
 *    `function-surface.md` の説明と同じ意味で、黙って差へ変換しない。旧保存式を読む
 *    `resolveFunctionInputs.ts` と同じ案内を返す(`mathGeometryFunctionOperations.test.ts`)。
 *    `coef()` を使わないこの入力は、全て実際の数学計算部で解析する。
 * 2. 図形由来の係数を境界で値が跳ぶ演算に渡す場合は、確定前に
 *    `checkGeometryDerivedFunctionOperations` が拒否する。係数Rは実際の係数作成と同じ
 *    `mathGeometryParameterDraft` で `coef("G")` から作る。
 *
 * この検査を追加した当時、下書きの数学環境には現在の `geometry` が渡らず、Rの式を実際の
 * 解析で解決できなかった。その配線修正後の実計算は `functionPlotDraftGeometry.test.ts` が検査する。
 * ここでは演算の配線を独立に保つため、対象の式欄だけ `withFormulaOverride` で手組みの解析結果を
 * 返す。XYZの範囲6欄、許容誤差、変更しない出力欄は全て実際の数学計算部を通す。
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
