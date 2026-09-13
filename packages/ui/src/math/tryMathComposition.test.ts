import { beforeEach, describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { createPointFeature, absoluteCoordinate, appendFeature, replaceSketch, prepareDocumentMathIdentity } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { acceptNumericMath } from '../sketch/numericMathValues.js';
import { applySolidCommit } from '../sketch/commitToStore.js';
import { deriveSpringValue } from '../solid/springExpressions.js';
import { tryMathComposition } from './tryMathComposition.js';

beforeEach(() => { useAppStore.setState(createInitialDocumentState()); });
function largeMath(): ExpressionValue {
  const source = '10^308';
  return { source, value: 1e308, display: '1e308', mathDefinition: { format: 'pointercad-math/1', source,
    inputNotation: 'text', angleUnit: 'degree', expression: { kind: 'operation', operation: 'power', operands: [
      { kind: 'number', decimal: '10' }, { kind: 'number', decimal: '308' },
    ] } } };
}

describe('派生数式の失敗を操作の確定前に返す', () => {
  it('有限のピッチから全長があふれるばねを作っても文書・選択・Undoを変更しない', () => {
    const store = useAppStore.getState(), point = createPointFeature(store.sketch, absoluteCoordinate(0, 0, 0));
    store.applyDocument(replaceSketch(store.document, appendFeature(store.sketch, point)));
    useAppStore.getState().setSelection([point.id]);
    const before = useAppStore.getState().document;
    const pitch = acceptNumericMath(largeMath(), prepareDocumentMathIdentity(before), []);
    expect(applySolidCommit({ kind: 'solid', tool: 'spring', step: 'springLength',
      values: { springPitch: pitch, springTurns: expressionValueFromNumber(4) }, flags: {}, springDerived: 'length' })).toBe(false);
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().selection).toEqual([point.id]);
    expect(useAppStore.getState().shapeErrorMessage).toContain('有限');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(store.document);
  });

  it('プロパティと同じ導出処理の数学的な失敗を理由付きで返す', () => {
    expect(tryMathComposition(() => deriveSpringValue(largeMath(), expressionValueFromNumber(4), '*'))).toMatchObject({ ok: false });
    const valid = tryMathComposition(() => deriveSpringValue(largeMath(), expressionValueFromNumber(2), '/'));
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.value.value).toBe(5e307);
  });

  it('予期しない実装例外を数式エラーとして隠さない', () => {
    const failure = new Error('Unexpected implementation failure');
    expect(() => tryMathComposition(() => { throw failure; })).toThrow(failure);
  });
});
