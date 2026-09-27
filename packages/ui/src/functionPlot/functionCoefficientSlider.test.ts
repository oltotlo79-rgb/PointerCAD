import { expressionValueFromNumber as number } from '@pointercad/expression';
import { MATH_INPUT_FORMAT, type StoredMathExpression } from '@pointercad/expression/math/contracts';
import { createEmptyPartDocument, createPrimitiveFeature, DEFAULT_MATH_GEOMETRY_TOLERANCE, FUNCTION_DEFINITION_FORMAT,
  mathGeometryParameterDraft, type FunctionDefinition, type MathGeometryDefinition, type Parameter } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { applyFunctionCoefficientSlider, coefficientSliderRange, functionCoefficientParameters,
  initialCoefficientSliderRange } from './functionCoefficientSlider.js';

function fixture() {
  const base = createEmptyPartDocument();
  const sphere = createPrimitiveFeature(base, 'sphere');
  const document = { ...base, parameters: [{ name: 'r', mathId: 'coefficient:1', unit: 'none' as const,
    description: '共通の係数', value: number(3) }], solids: [{ ...sphere, shape: { kind: 'sphere' as const,
    radius: { source: 'r*2', value: 6, display: '6' } } }] };
  useAppStore.getState().applyDocument(document);
  return { documentId: document.id, documentVersion: useAppStore.getState().documentVersion,
    coefficientId: 'coefficient:1', range: { minimum: 0, maximum: 100 }, gesture: 'drag-one' };
}

beforeEach(() => { useAppStore.setState(createInitialDocumentState()); });
afterEach(() => { vi.restoreAllMocks(); });

describe('関数係数の1ドラッグと文書への反映', () => {
  it('50回の変更を1段へまとめ、他の形状も追従し、Undoで元の式と係数名へ戻す', () => {
    const input = fixture(), before = useAppStore.getState().document;
    const past = useAppStore.getState().undoStack.past.length;
    for (let value = 4; value <= 53; value += 1) {
      expect(applyFunctionCoefficientSlider({ ...input, value }).ok).toBe(true);
    }
    const state = useAppStore.getState(), sphere = state.document.solids[0];
    expect(state.undoStack.past).toHaveLength(past + 1);
    expect(state.document.parameters[0]).toMatchObject({ name: 'r', mathId: 'coefficient:1', description: '共通の係数', value: { value: 53 } });
    if (sphere.kind !== 'primitive' || sphere.shape.kind !== 'sphere') throw new Error('Missing sphere');
    expect(sphere.shape.radius).toMatchObject({ source: 'r*2', value: 106 });
    state.undo();
    expect(useAppStore.getState().document).toBe(before);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document.parameters[0].value.value).toBe(53);
  });

  it('ドラッグ中の長い停止は分割せず、次のドラッグとUndoの後は別の操作にする', () => {
    const input = fixture();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    applyFunctionCoefficientSlider({ ...input, value: 10 });
    vi.mocked(Date.now).mockReturnValue(60_000);
    applyFunctionCoefficientSlider({ ...input, value: 20 });
    applyFunctionCoefficientSlider({ ...input, gesture: 'drag-two', value: 30 });
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.parameters[0].value.value).toBe(20);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.parameters[0].value.value).toBe(3);
    expect(applyFunctionCoefficientSlider({ ...input, value: 40 }).ok).toBe(false);
  });

  it.each([NaN, Infinity, -1, 101])('範囲外または非有限の%sは文書も履歴も変えない', value => {
    const input = fixture(), state = useAppStore.getState();
    expect(applyFunctionCoefficientSlider({ ...input, value }).ok).toBe(false);
    expect(useAppStore.getState()).toBe(state);
  });

  it('文書を開き直した後の古いイベントと削除済み係数を拒否する', () => {
    const input = fixture();
    expect(applyFunctionCoefficientSlider({ ...input, coefficientId: 'gone', value: 10 }).ok).toBe(false);
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    const state = useAppStore.getState();
    expect(applyFunctionCoefficientSlider({ ...input, value: 10 }).ok).toBe(false);
    expect(useAppStore.getState()).toBe(state);
  });
});

describe('係数の有限範囲', () => {
  it.each([['', '1'], ['0', ''], ['3', '2'], ['1', '1'], ['0', 'Infinity'], ['-1e308', '1e308']])('不正な%s〜%sを拒否する', (min, max) => {
    expect(coefficientSliderRange(min, max)).toBeNull();
  });
  it.each([0, -10, 10, Number.MAX_VALUE, -Number.MAX_VALUE])('現在値%sを含む有限の初期範囲を作る', value => {
    const range = initialCoefficientSliderRange(value);
    expect(coefficientSliderRange(String(range.minimum), String(range.maximum))).toEqual(range);
    expect(value).toBeGreaterThanOrEqual(range.minimum);
    expect(value).toBeLessThanOrEqual(range.maximum);
  });
});

const DERIVED_ID = 'coefficient:derived-r', PLAIN_ID = 'coefficient:plain-a';

function coefficientReference(id: string, label: string): StoredMathExpression {
  return { format: MATH_INPUT_FORMAT, source: `coef(${JSON.stringify(label)})`, inputNotation: 'text', angleUnit: 'degree',
    expression: { kind: 'symbol', reference: { role: 'coefficient', id, label } } };
}

/**
 * GR-18b: R's own formula is `coef("G")` (`mathGeometryParameterDraft`, GR-03b), so R is geometry-derived
 * (GR-04) even though the plot formula below only ever reads R by its own coefficient ID, `coef("R")` — the
 * same two-step reference the real editor builds (measured value → coefficient → plot). A is an ordinary
 * coefficient with no such formula, for contrast.
 */
function geometryDerivedFixture() {
  const base = createEmptyPartDocument();
  const geometryDefinition: MathGeometryDefinition = { id: 'g1', documentId: base.id, name: 'G',
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE,
    quantity: { kind: 'length', curve: { kind: 'sketch-curve', sketchId: 'sketch-x', featureId: 'line-x' } } };
  const withGeometry = { ...base, mathGeometry: [geometryDefinition] };
  const draft = mathGeometryParameterDraft(withGeometry, 'g1', { name: 'R', value: 2, unit: 'mm', description: '' });
  if (!draft.ok) throw new Error(draft.message);
  const derived: Parameter = { ...draft.parameter, mathId: DERIVED_ID };
  const plain: Parameter = { name: 'A', mathId: PLAIN_ID, unit: 'none', description: '', value: number(2.5) };
  const document = { ...withGeometry, parameters: [derived, plain] };
  const formula: FunctionDefinition['formula'] = { kind: 'coordinate-curve', independent: 'X',
    outputs: { Y: coefficientReference(DERIVED_ID, 'R'), Z: coefficientReference(PLAIN_ID, 'A') } };
  const range = { min: number(-4), max: number(4) };
  const definition: FunctionDefinition = { format: FUNCTION_DEFINITION_FORMAT,
    bounds: { X: range, Y: range, Z: range }, tolerance: number(0.05), formula };
  return { document, definition };
}

describe('図形由来の係数はつまみに出さず、書込みも断る(GR-18b)', () => {
  it('つまみの一覧(functionCoefficientParameters)は図形由来の係数Rを除き、図形由来でない係数Aだけを返す', () => {
    const { document, definition } = geometryDerivedFixture();
    expect(functionCoefficientParameters(document, definition).map(parameter => parameter.name)).toEqual(['A']);
  });

  it('式にRを使わなければ、Rが図形由来でも一覧には無関係として出さない', () => {
    const { document, definition } = geometryDerivedFixture();
    const withoutR: FunctionDefinition = { ...definition, formula: { kind: 'coordinate-curve', independent: 'X',
      outputs: { Y: coefficientReference(PLAIN_ID, 'A'), Z: coefficientReference(PLAIN_ID, 'A') } } };
    expect(functionCoefficientParameters(document, withoutR).map(parameter => parameter.name)).toEqual(['A']);
  });

  it('図形由来の係数へつまみを適用すると理由付きで断り、文書もUndo段も変えない', () => {
    const { document } = geometryDerivedFixture();
    useAppStore.getState().applyDocument(document);
    const state = useAppStore.getState(), past = state.undoStack.past.length;
    const result = applyFunctionCoefficientSlider({ documentId: document.id, documentVersion: state.documentVersion,
      coefficientId: DERIVED_ID, gesture: 'drag-derived', value: 5, range: { minimum: 0, maximum: 10 } });
    expect(result).toEqual({ ok: false, message: t('mathGeometry.functionSlider.derived') });
    expect(useAppStore.getState()).toBe(state);
    expect(useAppStore.getState().undoStack.past).toHaveLength(past);
  });

  it('図形由来でない係数Aへのつまみは今どおり動き、文書へ反映する', () => {
    const { document } = geometryDerivedFixture();
    useAppStore.getState().applyDocument(document);
    const state = useAppStore.getState();
    const result = applyFunctionCoefficientSlider({ documentId: document.id, documentVersion: state.documentVersion,
      coefficientId: PLAIN_ID, gesture: 'drag-plain', value: 5, range: { minimum: 0, maximum: 10 } });
    expect(result.ok).toBe(true);
    expect(useAppStore.getState().document.parameters.find(parameter => parameter.mathId === PLAIN_ID)?.value.value).toBe(5);
  });
});
