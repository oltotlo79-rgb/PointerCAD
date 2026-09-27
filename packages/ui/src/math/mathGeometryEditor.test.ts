import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, DEFAULT_MATH_GEOMETRY_TOLERANCE,
  mathGeometryCoefficientId, mathGeometryCycleMessage, mathGeometryOperationMessage, mathGeometryOrderMessage,
  mathGeometryTooDeepMessage, prepareDocumentMathIdentity,
  type DocumentMathContext, type MathGeometryDefinition, type MathGeometryOutcome, type MathGeometryValueUnit,
  type Parameter, type PartDocument } from '@pointercad/model';
import { expressionValueFromNumber, type AngleUnit, type ExpressionValue } from '@pointercad/expression';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, formatMathText, MATH_INPUT_FORMAT, type MathNode } from '@pointercad/expression/math/contracts';
import { createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import { applyParameterMath, type ParameterMathTarget } from '../parameters/ParameterMathDialog.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { MathExpressionDialog } from './MathExpressionDialog.js';
import { mathGeometryEditorCandidate, mathGeometryEditorNotices, mathGeometryEditorProblem,
  prepareDocumentMathEditor, prepareDocumentMathEnvironment, waitForMathEditorGeometry } from './prepareDocumentMathEditor.js';

const backend = createMathBackend();
const tolerance = DEFAULT_MATH_GEOMETRY_TOLERANCE;
function row(name: string, source = '10'): Parameter {
  return { name, value: { source, value: 999, display: '999' }, unit: 'mm', description: '' };
}
function reference(id = 'g', label = '体積'): MathNode {
  return { kind: 'symbol', reference: { role: 'coefficient', id: mathGeometryCoefficientId(id), label } };
}
function value(expression: MathNode, angleUnit: AngleUnit = 'degree'): ExpressionValue {
  const source = formatMathText(expression, CANDIDATE_MATH_BY_ID);
  return { source, value: 999, display: '999', mathDefinition: {
    format: MATH_INPUT_FORMAT, source, inputNotation: 'text', angleUnit, expression,
  } };
}
function definition(id = 'g', name = '体積', featureId = 'box-1'): MathGeometryDefinition {
  return { id, name, documentId: 'part-1', tolerance, quantity: { kind: 'volume', body: { kind: 'body', featureId } } };
}
function box(document: PartDocument, source = '20'): PartDocument {
  return appendSolid(document, { ...createPrimitiveFeature(document, 'box'),
    shape: { kind: 'box', sizeX: row('x', source).value, sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } });
}
function part(): PartDocument {
  return prepareDocumentMathIdentity({ ...box(createEmptyPartDocument()), parameters: [row('P'), row('Q', '7')], mathGeometry: [definition()] });
}
function measured(document: PartDocument, id = 'g', amount = 24000, unit: MathGeometryValueUnit = 'mm3'): MathGeometryOutcome {
  return { id, documentId: document.id, generation: 1, status: 'value', kind: 'real', value: amount, unit,
    representation: 'geometry-double', tolerance };
}
function inputs(document: PartDocument, amount = 24000): ReadonlyMap<string, MathGeometryOutcome> {
  return new Map((document.mathGeometry ?? []).map(item => [item.id, measured(document, item.id, amount)]));
}
function context(document: PartDocument, geometry = inputs(document)) {
  const evaluate = vi.fn<DocumentMathContext['client']['evaluate']>(request => Promise.resolve({ status: 'result', identity: request.identity,
    result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
      { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(item => item.id)), declaredIds: new Set() }).result }));
  return { client: { evaluate }, identity: { documentId: document.id, documentVersion: useAppStore.getState().documentVersion },
    isCurrent: () => true, geometry };
}
function open(document: PartDocument, current = true): ParameterMathTarget {
  useAppStore.getState().applyDocument(document, { undoable: false });
  useAppStore.setState({ requestedGeneration: 1, completedGeneration: current ? 1 : 0, recomputeCancelled: false,
    mathGeometryResult: current ? { document, generation: 1, evaluated: true, outcomes: inputs(document) } : null });
  return { document, documentVersion: useAppStore.getState().documentVersion, parameter: document.parameters[0] };
}
function group(result: Awaited<ReturnType<typeof prepareDocumentMathEnvironment>>) {
  return result.groups.find(item => item.label === t('mathGeometry.palette.group'));
}
beforeEach(resetTestStore);
afterEach(() => vi.restoreAllMocks());

describe('GR-17 図形の測定値を係数入力へ渡す', () => {
  it('群の説明に測定値・内部単位・量を示し、挿入した式を測定値として計算できる', async () => {
    const document = part(), before = JSON.stringify(document), channel = context(document);
    const result = await prepareDocumentMathEditor(document, document.parameters[0].value, channel, 'P', true);
    expect(result.groups.map(item => item.label)).toEqual([t('math.coefficients'), '図形の測定値', t('math.constants')]);
    const choice = group(result)?.choices[0];
    expect(choice?.meaning).toBe('体積 = 24000 mm³（図形から測定・体積）');
    expect(result.coefficients.find(item => item.id === 'math-geometry:g')).toEqual({ id: 'math-geometry:g', label: '体積', decimal: '24000' });
    const completion = await channel.client.evaluate({ identity: { ...channel.identity, editorId: 'test', inputRevision: 1 },
      source: choice?.template ?? '', notation: 'latex', angleUnit: 'degree', coefficients: result.coefficients }, 1000);
    expect(completion.status === 'result' && completion.result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 24000 });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('係数以外の入力には測定値の群と直接の係数入力を渡さない', async () => {
    const document = part();
    const result = await prepareDocumentMathEnvironment(document, context(document));
    expect(group(result)).toBeUndefined();
    expect(result.coefficients.some(item => item.id.startsWith('math-geometry:'))).toBe(false);
  });

  it('未解決・真偽・別文書・未計算の値は候補にしない', async () => {
    const document = { ...part(), mathGeometry: ['missing', 'boolean', 'foreign', 'pending'].map(id => definition(id, id)) };
    const geometry = new Map<string, MathGeometryOutcome>([
      ['missing', { id: 'missing', documentId: document.id, generation: 1, status: 'unresolved', reason: 'missing-reference', message: 'missing' }],
      ['boolean', { id: 'boolean', documentId: document.id, generation: 1, status: 'value', kind: 'boolean', value: true, representation: 'geometry-double', tolerance }],
      ['foreign', { ...measured(document, 'foreign'), documentId: 'different' }],
    ]);
    const result = await prepareDocumentMathEnvironment(document, context(document, geometry), 'P', true);
    expect(group(result)?.choices).toEqual([]);
    expect(result.coefficients.map(item => item.label)).toEqual(['Q']);
  });

  it('同名で解決できない測定値と係数を混同しない', async () => {
    const document = { ...part(), mathGeometry: [definition('g', 'Q')] };
    const result = await prepareDocumentMathEnvironment(document, context(document), 'P', true);
    expect(group(result)?.choices).toEqual([]);
    expect(result.coefficients).toHaveLength(1);
    expect(result.coefficients[0].label).toBe('Q');
  });

  it('自分と依存係数が作った形を測る定義を候補にしない', async () => {
    const initial = part();
    const document = { ...box(initial, 'Q'), parameters: [initial.parameters[0], { ...initial.parameters[1], value: row('Q', 'P*2').value }],
      mathGeometry: [definition(), definition('self', '自分の体積', 'box-2')] };
    const result = await prepareDocumentMathEnvironment(document, context(document), 'P', true);
    expect(group(result)?.choices.map(item => item.label)).toEqual(['体積']);
    expect(result.coefficients.map(item => item.label)).toEqual(['体積']);
  });

  it('図形を経由して自分へ戻る係数も候補から除き、修正できる', async () => {
    const initial = part();
    const document = { ...box(box(initial, 'P'), 'Q'), parameters: [initial.parameters[0], { ...initial.parameters[1], value: value(reference('self', '自分の体積')) }],
      mathGeometry: [definition(), definition('self', '自分の体積', 'box-2'), definition('indirect', '次の体積', 'box-3')] };
    const result = await prepareDocumentMathEnvironment(document, context(document), 'P', true);
    expect(group(result)?.choices.map(item => item.label)).toEqual(['体積']);
    expect(result.coefficientProblem).toBeNull();
    expect(result.coefficients.map(item => item.label)).toEqual(['体積']);
  });

  it('同じ係数配列で形の値が変わっても再評価し、図形由来の原式を厳密値として渡さない', async () => {
    const initial = part(), document = { ...initial, parameters: [{ ...initial.parameters[0], value: value(reference()) }, initial.parameters[1]] };
    for (const amount of [24000, 48000]) {
      const channel = context(document, inputs(document, amount));
      const result = await prepareDocumentMathEnvironment(document, channel);
      expect(channel.client.evaluate).toHaveBeenCalledTimes(1);
      expect(result.coefficientProblem).toBeNull();
      expect(result.coefficients[0]).toEqual({ id: document.parameters[0].mathId, label: 'P', decimal: String(amount) });
    }
    expect(document.parameters[0].value.value).toBe(999);
  });

  it('循環は定義名・係数名・形の名前を示して適用前に断る', async () => {
    const initial = part();
    const document = { ...box(initial, 'P'), mathGeometry: [definition('g', '体積', 'box-2')] };
    const target = open(document), channel = context(document), before = useAppStore.getState().undoStack;
    expect(await applyParameterMath(target, value(reference()), document, channel)).toEqual({ ok: false,
      message: mathGeometryCycleMessage('P', '体積', document.solids[1].name) });
    expect(channel.client.evaluate).not.toHaveBeenCalled();
    expect(useAppStore.getState().undoStack).toBe(before);
  });

  it('測る形が後ろにある場合は移動先を示して断る', async () => {
    const base = createEmptyPartDocument();
    const document = prepareDocumentMathIdentity({ ...box(box(base, 'P')), parameters: [row('P')], mathGeometry: [definition('g', '体積', 'box-2')] });
    const target = open(document), channel = context(document);
    expect(await applyParameterMath(target, value(reference()), document, channel)).toEqual({ ok: false,
      message: mathGeometryOrderMessage(document.solids[0].name, document.solids[1].name, '体積', 'P') });
    expect(channel.client.evaluate).not.toHaveBeenCalled();
  });

  it('9段の参照を既存の上限の理由で断る', () => {
    let document = createEmptyPartDocument();
    const parameters: Parameter[] = [], definitions: MathGeometryDefinition[] = [];
    for (let index = 1; index <= 9; index += 1) {
      document = box(document, index === 1 ? '20' : `P${String(index - 1)}`);
      const id = `g${String(index)}`, name = `体積${String(index)}`;
      definitions.push(definition(id, name, `box-${String(index)}`));
      parameters.push({ ...row(`P${String(index)}`), value: value(reference(id, name)) });
    }
    expect(mathGeometryEditorProblem({ ...document, parameters, mathGeometry: definitions })).toBe(mathGeometryTooDeepMessage());
  });

  it('floorは数値が出せる式でも適用せず、演算の理由を返す', async () => {
    const document = part(), target = open(document), channel = context(document);
    const refused = value({ kind: 'operation', operation: 'floor', operands: [reference()] });
    expect(mathGeometryEditorProblem(mathGeometryEditorCandidate(document, 'P', refused))).toBe(mathGeometryOperationMessage('floor'));
    expect(await applyParameterMath(target, refused, document, channel)).toEqual({ ok: false, message: mathGeometryOperationMessage('floor') });
    expect(channel.client.evaluate).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBe(document);
  });

  it('変更により他の係数のfloorが図形由来になる場合も拒否する', () => {
    const initial = part(), id = initial.parameters[0].mathId;
    if (id === undefined) throw new Error('missing parameter identity');
    const document = { ...initial, parameters: [initial.parameters[0], { ...initial.parameters[1], value: value({ kind: 'operation', operation: 'floor',
      operands: [{ kind: 'symbol', reference: { role: 'coefficient', id, label: 'P' } }] }) }] };
    expect(mathGeometryEditorProblem(mathGeometryEditorCandidate(document, 'P', value(reference())))).toBe(mathGeometryOperationMessage('floor'));
  });

  it('現在でない間は計算中を通知し、取消後に古い測定値で数式計算を始めない', async () => {
    const document = part(); open(document, false);
    const abort = new AbortController(), pending = vi.fn(), channel = context(document);
    const preparation = waitForMathEditorGeometry(document, abort.signal, () => true, pending)
      .then(geometry => prepareDocumentMathEditor(document, document.parameters[0].value, { ...channel, geometry }, 'P', true));
    const rejection = expect(preparation).rejects.toThrow(t('math.operation.cancelled'));
    expect(pending).toHaveBeenCalledOnce();
    expect(channel.client.evaluate).not.toHaveBeenCalled();
    abort.abort(); await rejection;
    expect(channel.client.evaluate).not.toHaveBeenCalled();
  });

  it('現在の値を待つ画面は計算中の説明を出し、数式の適用ボタンを出さない', () => {
    const document = part(), target = open(document, false);
    const html = renderToStaticMarkup(createElement(MathExpressionDialog, {
      document, documentVersion: target.documentVersion, initialValue: target.parameter.value, unitLabel: 'mm',
      geometry: { coefficientName: 'P', unit: 'mm' }, isCurrent: () => true, onClose: () => undefined,
      onApply: () => Promise.resolve({ ok: true as const }),
    }));
    expect(html).toContain(t('mathGeometry.editor.pending'));
    expect(html).not.toContain(t('math.apply'));
    expect(html).toContain(t('math.cancel'));
  });

  it('計算が終わると現在の値で準備を続ける', async () => {
    const document = part(); open(document, false);
    const pending = vi.fn(), abort = new AbortController();
    const preparation = waitForMathEditorGeometry(document, abort.signal, () => true, pending);
    const outcomes = inputs(document, 48000);
    useAppStore.setState({ completedGeneration: 1, mathGeometryResult: { document, generation: 1, evaluated: true, outcomes } });
    expect(await preparation).toBe(outcomes);
    expect(pending).toHaveBeenCalledOnce();
  });

  it('形の計算の中止は理由付きで終了し、待ち続けない', async () => {
    const document = part(); open(document, false);
    const abort = new AbortController(), preparation = waitForMathEditorGeometry(document, abort.signal, () => true, () => undefined);
    const rejection = expect(preparation).rejects.toThrow(t('mathGeometry.status.cancelled'));
    useAppStore.setState({ recomputeCancelled: true });
    await rejection;
  });

  it('現在でない測定値では適用の再評価も開始しない', async () => {
    const document = part(), target = open(document, false), channel = context(document);
    expect(await applyParameterMath(target, value(reference()), document, channel)).toEqual({ ok: false, message: t('mathGeometry.editor.pending') });
    expect(channel.client.evaluate).not.toHaveBeenCalled();
  });

  it('適用の再評価中に世代が変わったら文書を公開しない', async () => {
    const document = part(), target = open(document), channel = context(document);
    const applying = applyParameterMath(target, value(reference()), document, channel);
    useAppStore.setState({ requestedGeneration: 2 });
    expect(await applying).toEqual({ ok: false, message: t('math.operation.cancelled') });
    expect(useAppStore.getState().document).toBe(document);
  });

  it('適用は現在の値を再評価し、原式を保存してUndo1回で完全に戻る', async () => {
    const document = part(), target = open(document), channel = context(document);
    const before = useAppStore.getState().undoStack.past.length;
    expect(await applyParameterMath(target, value(reference()), document, channel)).toEqual({ ok: true });
    const next = useAppStore.getState();
    expect(next.document.parameters[0].value.value).toBe(24000);
    expect(next.document.parameters[0].value.mathDefinition?.source).toBe('coef("体積")');
    expect(next.undoStack.past).toHaveLength(before + 1);
    expect(next.document.mathGeometry).toEqual(document.mathGeometry);
    next.undo();
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().undoStack.past).toHaveLength(before);
  });

  it('測定値1つの面積・体積を長さ係数に入れると単位の注意を出し、受理は妨げない', () => {
    const document = part(), scalar = value(reference()).mathDefinition;
    if (scalar === undefined) throw new Error('missing definition');
    expect(mathGeometryEditorNotices(document, { coefficientName: 'P', unit: 'mm' }, scalar, inputs(document)))
      .toEqual([t('mathGeometry.editor.unitMismatch').replace('{unit}', 'mm³')]);
    expect(mathGeometryEditorProblem(mathGeometryEditorCandidate(document, 'P', value(reference())))).toBeNull();
    expect(mathGeometryEditorNotices(document, { coefficientName: 'P', unit: 'none' }, scalar, inputs(document))).toEqual([]);
  });

  it('角度の設定が異なるときだけ注意し、測定値を換算しない', () => {
    const document = part(), scalar = value(reference(), 'degree').mathDefinition;
    if (scalar === undefined) throw new Error('missing definition');
    const geometry = new Map([['g', measured(document, 'g', Math.PI / 3, 'radian')]]);
    expect(mathGeometryEditorNotices(document, { coefficientName: 'P', unit: 'none' }, scalar, geometry))
      .toEqual([t('mathGeometry.editor.angleUnitMismatch').replace('{unit}', t('mathGeometry.unit.radian'))]);
    expect(mathGeometryEditorNotices(document, { coefficientName: 'P', unit: 'none' }, { ...scalar, angleUnit: 'radian' }, geometry)).toEqual([]);
    expect(geometry.get('g')).toMatchObject({ value: Math.PI / 3, unit: 'radian' });
  });
});
