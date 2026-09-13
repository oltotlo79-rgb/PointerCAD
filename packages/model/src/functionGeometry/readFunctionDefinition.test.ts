import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateExpression, type StoredMathExpression } from '@pointercad/expression';
import {
  createFunctionMathSource,
  createMathBackend,
  readFunctionMathSource,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';


import type { MathAxis, MathParameter } from '@pointercad/expression/math/contracts';
import { FunctionDefinitionProblem, readFunctionDefinition, type FunctionDefinitionReader } from './readFunctionDefinition.js';
import { FUNCTION_DEFINITION_FORMAT } from './functionDefinitionTypes.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'axis-named-coefficient', label: 'X' }, { id: 'pi-named-coefficient', label: 'pi' }];
function math(source: string, axes: readonly MathAxis[] = [], parameters: readonly MathParameter[] = []): StoredMathExpression {
  return createFunctionMathSource(source, 'text', 'degree', { axes, parameters, coefficients }, backend);
}
const reader: FunctionDefinitionReader = {
  scalar(input, field) {
    const source = typeof input === 'string' ? input : input !== null && typeof input === 'object' && 'source' in input ? input.source : undefined;
    if (typeof source !== 'string') throw new FunctionDefinitionProblem(field, '式を入力してください。');
    const result = evaluateExpression(source);
    if (!result.ok) throw new FunctionDefinitionProblem(field, result.error.message);
    return result.value;
  },
  math(input, _field, scope) { return readFunctionMathSource(input, { ...scope, coefficients }, backend); },
};
function inputs(formula: unknown) {
  return { format: FUNCTION_DEFINITION_FORMAT,
    bounds: { X: { min: '-2in', max: '2in' }, Y: { min: '-10', max: '10' }, Z: { min: '-1', max: '1' } },
    formula, tolerance: '0.01' };
}
function formulas() {
  return [
    { kind: 'coordinate-curve', independent: 'X', outputs: { Y: math('X^2', ['X']), Z: math('0', ['X']) } },
    { kind: 'parametric-curve', outputs: { X: math('cos(T)', [], ['T']), Y: math('sin(T)', [], ['T']), Z: math('T/360', [], ['T']) }, T: { min: '0', max: '720' } },
    { kind: 'implicit-curve', fixedAxis: 'Z', fixedCoordinate: '0', expression: math('X^2+Y^2-4', ['X', 'Y']) },
    { kind: 'coordinate-surface', output: 'Z', expression: math('X^2+Y^2', ['X', 'Y']) },
    { kind: 'parametric-surface', outputs: { X: math('cos(U)*cos(V)', [], ['U', 'V']), Y: math('sin(U)*cos(V)', [], ['U', 'V']), Z: math('sin(V)', [], ['U', 'V']) },
      U: { min: '0', max: '360' }, V: { min: '-90', max: '90' } },
    { kind: 'implicit-surface', expression: math('X^2+Y^2+Z^2-4', ['X', 'Y', 'Z']) },
  ];
}

describe('関数全6形式の定義とXYZ必須範囲（ADD-3）', () => {
  it.each([0, 1, 2, 3, 4, 5])('形式%sを原式・角度・XYZ全6端点とともに往復する', (index) => {
    const value = readFunctionDefinition(inputs(formulas()[index]), reader);
    expect(value.bounds.X.min.value).toBe(-50.8); expect(value.bounds.X.max.value).toBe(50.8);
    expect(value.bounds.X.min.source).toBe('-2in');
    expect(value.bounds.Y).toMatchObject({ min: { value: -10 }, max: { value: 10 } });
    expect(value.bounds.Z).toMatchObject({ min: { value: -1 }, max: { value: 1 } });
    expect(readFunctionDefinition(JSON.parse(JSON.stringify(value)), reader)).toEqual(value);
  });

  it.each(['X', 'Y', 'Z'] as const)('%s軸を固定座標や媒介範囲で代用できない', (axis) => {
    const value = inputs(formulas()[1]), { [axis]: omitted, ...remaining } = value.bounds;
    expect(omitted).toBeDefined();
    expect(() => readFunctionDefinition({ ...value, bounds: remaining }, reader)).toThrow('不足');
  });

  it.each(['min', 'max'] as const)('1軸の%sだけが未入力でも開始しない', (field) => {
    const value = inputs(formulas()[0]);
    expect(() => readFunctionDefinition({ ...value, bounds: { ...value.bounds, Z: { ...value.bounds.Z, [field]: '' } } }, reader)).toThrow();
  });

  it.each(['1/0', 'sqrt(-1)', '-2', '-1'])('上端%sが非有限・非実数・逆転・同値なら拒否する', (max) => {
    const value = inputs(formulas()[2]);
    expect(() => readFunctionDefinition({ ...value, bounds: { ...value.bounds, Z: { min: '-1', max } } }, reader)).toThrow();
  });

  it('座標式の出力を自分自身へ依存させず、同名係数は軸と区別して保持する', () => {
    const valid = inputs({ kind: 'coordinate-curve', independent: 'X',
      outputs: { Y: math('coef("X")+X+coef("pi")+pi', ['X']), Z: math('0', ['X']) } });
    const definition = readFunctionDefinition(valid, reader);
    expect(definition.formula).toEqual(valid.formula);
    const cycle = inputs({ kind: 'coordinate-curve', independent: 'X', outputs: { Y: math('Y+X', ['X', 'Y']), Z: math('0', ['X']) } });
    expect(() => readFunctionDefinition(cycle, reader)).toThrow();
  });

  it('XYZとT/U/Vを交換した保存ASTや、同じラベルの別係数IDを使わない', () => {
    const original = math('X', ['X']);
    const changed = { ...original, expression: { kind: 'symbol', reference: { role: 'parameter', name: 'T' } } };
    expect(() => readFunctionDefinition(inputs({ kind: 'coordinate-curve', independent: 'X', outputs: { Y: changed, Z: math('0', ['X']) } }), reader)).toThrow();
    const named = math('coef("X")', ['X']);
    const wrongId = { ...named, expression: { kind: 'symbol', reference: { role: 'coefficient', id: 'missing', label: 'X' } } };
    expect(() => readFunctionDefinition(inputs({ kind: 'coordinate-curve', independent: 'X', outputs: { Y: wrongId, Z: math('0', ['X']) } }), reader)).toThrow();
  });

  it('媒介範囲の欠落・同値・逆転をXYZの範囲で補完しない', () => {
    const formula = formulas()[1];
    for (const T of [undefined, { min: '1', max: '1' }, { min: '2', max: '1' }]) {
      expect(() => readFunctionDefinition(inputs({ ...formula, T }), reader)).toThrow();
    }
  });

  it('未知の形式・余分な出力軸・ゼロ精度を既定値で補完しない', () => {
    expect(() => readFunctionDefinition(inputs({ kind: 'unknown' }), reader)).toThrow('形式');
    expect(() => readFunctionDefinition(inputs({ kind: 'coordinate-curve', independent: 'X',
      outputs: { X: math('X', ['X']), Y: math('X', ['X']), Z: math('0', ['X']) } }), reader)).toThrow('未対応');
    expect(() => readFunctionDefinition({ ...inputs(formulas()[5]), tolerance: '0' }, reader)).toThrow('精度');
  });
});
