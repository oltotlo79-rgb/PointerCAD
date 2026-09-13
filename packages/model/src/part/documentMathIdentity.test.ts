import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createEmptyPartDocument } from './createPartDocument.js';
import { prepareDocumentMathIdentity } from './documentMathIdentity.js';
import { addParameter, removeParameter } from '../parameters/parameterTable.js';
import { affectsShape } from './documentChange.js';
import type { Parameter } from '../parameters/types.js';

const row = (name: string): Parameter => ({ name, unit: 'mm', description: '', value: expressionValueFromNumber(1) });
describe('削除後も数学係数の発行済みIDを再利用しない', () => {
  it('発行済み番号だけの変更で形状を再計算しない', () => {
    const document = createEmptyPartDocument();
    expect(affectsShape(document, { ...document, mathParameterSerial: 10 })).toBe(false);
  });
  it('最後の係数を消して保存用に複製しても次の追加が別IDになる', () => {
    const original = { ...createEmptyPartDocument(), parameters: [row('A'), row('B')] };
    const first = prepareDocumentMathIdentity(original);
    const removed = structuredClone({ ...first, parameters: removeParameter(first.parameters, 'B') });
    const next = prepareDocumentMathIdentity({ ...removed, parameters: addParameter(removed.parameters, row('C'), removed.mathParameterSerial) });
    expect(first.parameters.map(parameter => parameter.mathId)).toEqual(['coefficient:1', 'coefficient:2']);
    expect(next.parameters.map(parameter => parameter.mathId)).toEqual(['coefficient:1', 'coefficient:3']);
    expect(original).not.toHaveProperty('mathParameterSerial');
    expect(prepareDocumentMathIdentity(next)).toBe(next);
  });
  it('全係数を消した文書も発行済み番号を保持する', () => {
    const document = { ...createEmptyPartDocument(), mathParameterSerial: 10 };
    const next = prepareDocumentMathIdentity({ ...document, parameters: addParameter([], row('A'), document.mathParameterSerial) });
    expect(next.parameters[0].mathId).toBe('coefficient:11');
  });
  it.each([-1, 1.5, Infinity, NaN])('不正な発行番号%jでは編集結果を作らない', mathParameterSerial => {
    expect(() => prepareDocumentMathIdentity({ ...createEmptyPartDocument(), mathParameterSerial })).toThrow();
  });
});
