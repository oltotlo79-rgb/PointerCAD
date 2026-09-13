import { expressionValueFromNumber as number } from '@pointercad/expression';
import { createEmptyPartDocument, createPrimitiveFeature } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyFunctionCoefficientSlider, coefficientSliderRange, initialCoefficientSliderRange } from './functionCoefficientSlider.js';

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
