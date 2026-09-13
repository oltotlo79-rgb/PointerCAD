import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createFunctionSurface, type FunctionDefinition } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readSolidFeature } from './codecs/solid.js';

const number = (value: number) => ({ source: String(value), display: String(value), value });
const definition: FunctionDefinition = { format: 'pointercad-function/1',
  bounds: { X: { min: number(-2), max: number(2) }, Y: { min: number(-3), max: number(3) }, Z: { min: number(-1), max: number(4) } },
  tolerance: number(0.001), formula: { kind: 'coordinate-surface', output: 'Z', expression: {
    format: 'pointercad-math/1', source: 'X^2', inputNotation: 'text', angleUnit: 'degree', expression: {
      kind: 'operation', operation: 'power', operands: [{ kind: 'symbol', reference: { role: 'axis', name: 'X' } }, { kind: 'number', decimal: '2' }],
    },
  } },
};
function fixture() {
  const document = createEmptyPartDocument();
  return { ...document, solids: [createFunctionSurface(document, definition)] };
}
const read = (input: unknown) => readSolidFeature({ ...fixture().solids[0], definition: input }, 'document.solids[0]');

describe('関数曲面の原式・XYZ範囲・角度・精度を保存する', () => {
  it('通常文書で保存往復し、派生した面やキャッシュ鍵を保存しない', () => {
    const document = fixture(), text = serializeDocument(document), result = parseDocument(text);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.document).toEqual(document);
    expect(text).not.toContain('triangles'); expect(text).not.toContain('inputSignature'); expect(text).not.toContain('vertices');
    expect(result.document.solids[0]).not.toBe(document.solids[0]);
  });
  it.each((['X', 'Y', 'Z'] as const).flatMap(axis => (['min', 'max'] as const).map(endpoint => ({ axis, endpoint }))))(
    '$axis.$endpointが無ければ面の式が正しくても読み込まない', ({ axis, endpoint }) => {
      expect(read({ ...definition, bounds: { ...definition.bounds, [axis]: { ...definition.bounds[axis], [endpoint]: undefined } } }).ok).toBe(false);
    });
  it.each([Infinity, -Infinity, NaN])('非有限の境界%sで面を作らない', value => {
    expect(read({ ...definition, bounds: { ...definition.bounds, Z: { min: number(-1), max: number(value) } } }).ok).toBe(false);
  });
  it.each([-1, -2])('同値または逆転した境界%sを拒否する', max => {
    expect(read({ ...definition, bounds: { ...definition.bounds, Z: { min: number(-1), max: number(max) } } }).ok).toBe(false);
  });
  it('曲線の定義を曲面へ読み替えず、読む側と書く側の両方が拒否する', () => {
    if (definition.formula.kind !== 'coordinate-surface') throw new Error('Expected explicit surface');
    const bad: FunctionDefinition = { ...definition, formula: { kind: 'implicit-curve', fixedAxis: 'Z', fixedCoordinate: number(0),
      expression: definition.formula.expression } };
    expect(read(bad).ok).toBe(false);
    const document = fixture(); expect(() => serializeDocument({ ...document, solids: [{ ...document.solids[0], definition: bad }] })).toThrow();
  });
  it('出力軸Zを独立した入力として使う循環式を拒否する', () => {
    if (definition.formula.kind !== 'coordinate-surface') throw new Error('Expected explicit surface');
    expect(read({ ...definition, formula: { ...definition.formula, expression: { ...definition.formula.expression,
      source: 'Z', expression: { kind: 'symbol', reference: { role: 'axis', name: 'Z' } } } } }).ok).toBe(false);
  });
  it('U/Vの範囲は全XYZ境界の代わりにならない', () => {
    const formula: FunctionDefinition['formula'] = { kind: 'parametric-surface', U: { min: number(0), max: number(1) }, V: { min: number(0), max: number(1) },
      outputs: { X: { format: 'pointercad-math/1', source: 'U', inputNotation: 'text', angleUnit: 'radian', expression: { kind: 'symbol', reference: { role: 'parameter', name: 'U' } } },
        Y: { format: 'pointercad-math/1', source: 'V', inputNotation: 'text', angleUnit: 'radian', expression: { kind: 'symbol', reference: { role: 'parameter', name: 'V' } } },
        Z: { format: 'pointercad-math/1', source: '0', inputNotation: 'text', angleUnit: 'radian', expression: { kind: 'number', decimal: '0' } } } };
    expect(read({ ...definition, formula }).ok).toBe(true);
    expect(read({ ...definition, formula, bounds: { ...definition.bounds, Z: undefined } }).ok).toBe(false);
  });
});
