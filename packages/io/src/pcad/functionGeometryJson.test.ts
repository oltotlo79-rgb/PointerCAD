import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createFunctionCurve, FUNCTION_DEFINITION_FORMAT, type FunctionDefinition } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readSketch } from './codecs/sketch.js';

const number = (value: number) => ({ source: String(value), display: String(value), value });
const definition: FunctionDefinition = {
  format: FUNCTION_DEFINITION_FORMAT,
  bounds: { X: { min: number(-2), max: number(2) }, Y: { min: number(-1), max: number(3) }, Z: { min: number(-1), max: number(1) } },
  tolerance: number(0.001),
  formula: { kind: 'coordinate-curve', independent: 'X', outputs: {
    Y: { format: 'pointercad-math/1', source: 'X^2', inputNotation: 'text', angleUnit: 'radian',
      expression: { kind: 'operation', operation: 'power', operands: [{ kind: 'symbol', reference: { role: 'axis', name: 'X' } }, { kind: 'number', decimal: '2' }] } },
    Z: { format: 'pointercad-math/1', source: '0', inputNotation: 'text', angleUnit: 'radian', expression: { kind: 'number', decimal: '0' } },
  } },
};
function fixture() {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  return { ...document, sketches: [{ ...sketch, features: [createFunctionCurve(sketch, definition)] }] };
}
function read(input: unknown) {
  const sketch = fixture().sketches[0];
  return readSketch({ ...sketch, features: [{ ...sketch.features[0], definition: input }] }, 'document.sketches[0]');
}

describe('関数の原式と必須XYZ範囲を通常文書で保存する', () => {
  it('XYZ関数を作図面のローカル座標へ読み替える不正な参照を拒否する', () => {
    const sketch = fixture().sketches[0];
    const result = readSketch({ ...sketch, features: [{ ...sketch.features[0], planeId: 'plane-xy' }] }, 'document.sketches[0]');
    expect(result.ok).toBe(false);
  });
  it('文書JSONを往復しても原式・6境界・精度が残り、描画点列は保存しない', () => {
    const document = fixture(), text = serializeDocument(document), result = parseDocument(text);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.document).toEqual(document);
    expect(text).not.toContain('components'); expect(text).not.toContain('maximumChordErrorBound');
    expect(result.document.sketches[0].features[0]).not.toBe(document.sketches[0].features[0]);
  });
  it.each(['X', 'Y', 'Z'] as const)('%sの範囲を省略すると読み込まない', axis => {
    const result = read({ ...definition, bounds: { ...definition.bounds, [axis]: undefined } });
    expect(result.ok).toBe(false);
  });
  it.each((['X', 'Y', 'Z'] as const).flatMap(axis => (['min', 'max'] as const).map(endpoint => ({ axis, endpoint }))))(
    '$axis.$endpointを省略すると読み込まない', ({ axis, endpoint }) => {
      expect(read({ ...definition, bounds: { ...definition.bounds, [axis]: { ...definition.bounds[axis], [endpoint]: undefined } } }).ok).toBe(false);
    });
  it.each([Infinity, -Infinity, NaN])('非有限の境界%sを拒否する', value => {
    expect(read({ ...definition, bounds: { ...definition.bounds, Z: { min: number(0), max: number(value) } } }).ok).toBe(false);
  });
  it.each([0, -1])('逆順・幅ゼロの範囲%sを拒否する', max => {
    expect(read({ ...definition, bounds: { ...definition.bounds, Z: { min: number(0), max: number(max) } } }).ok).toBe(false);
  });
  it('独立変数に指定していないYを出力の式で使えない', () => {
    const source = definition.formula;
    if (source.kind !== 'coordinate-curve' || source.independent !== 'X') throw new Error('Expected coordinate curve');
    expect(read({ ...definition, formula: { ...source, outputs: { ...source.outputs, Y: {
      ...source.outputs.Y, source: 'Y', expression: { kind: 'symbol', reference: { role: 'axis', name: 'Y' } },
    } } } }).ok).toBe(false);
  });
});
