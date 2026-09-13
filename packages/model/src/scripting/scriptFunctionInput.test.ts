import { describe, expect, it } from 'vitest';
import { readSerializedScriptCommand } from './commandValidation.js';
import { validateScriptReferences } from './commandReferences.js';
import { SCRIPT_LIMITS } from './scriptTypes.js';
const bounds = { X: ['-2', '2'], Y: ['-2', '2'], Z: ['-2', '2'] };
const formula = { kind: 'coordinate-curve', independent: 'X', outputs: { Y: 'sin(X)', Z: '0' } };
const definition = { bounds, tolerance: '0.01', formula };
function read(input: unknown, kind = 'function.curve') {
  return readSerializedScriptCommand(JSON.stringify({
    kind, resultId: 'run:1', callStack: 'at user-script.js:1:1',
    fields: kind === 'function.curve' ? { sketch: 'existing', definition: input } : { definition: input }
  }), 'run', SCRIPT_LIMITS.commandBytes);
}
describe('自動作図の関数は全XYZ範囲と構文を境界で確認する', () => {
  it.each([
    ['curve', formula],
    ['curve', { kind: 'parametric-curve', T: ['0', '360'], outputs: { X: 'cos(T)', Y: 'sin(T)', Z: '0' } }],
    ['curve', { kind: 'implicit-curve', fixedAxis: 'Z', fixedCoordinate: '0', expression: 'X^2+Y^2-1' }],
    ['surface', { kind: 'coordinate-surface', output: 'Z', expression: 'X*Y' }],
    ['surface', { kind: 'parametric-surface', U: ['-1', '1'], V: ['-1', '1'], outputs: { X: 'U', Y: 'V', Z: 'U*V' } }],
    ['surface', { kind: 'implicit-surface', expression: 'X^2+Y^2+Z^2-1' }],
  ])('%sの式を変えずに受理し、再度境界を通しても同じ定義となる', (geometry, form) => {
    const result = read({ ...definition, formula: form }, `function.${geometry}`);
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(result.reason);
    expect(result.command.fields).toMatchObject({ definition: { angleUnit: 'degree', formula: form } });
    const copied = readSerializedScriptCommand(JSON.stringify(result.command), 'run', SCRIPT_LIMITS.commandBytes);
    expect(copied).toMatchObject({ ok: true, command: result.command });
    expect(read({ ...definition, formula: form }, `function.${geometry === 'curve' ? 'surface' : 'curve'}`).ok).toBe(false);
  });
  it.each(['X', 'Y', 'Z'])('%sの範囲を省略すると無制限描画を受理しない', axis => {
    expect(read({ ...definition, bounds: Object.fromEntries(Object.entries(bounds).filter(([key]) => key !== axis)) }).ok).toBe(false);
  });
  it.each([
    { ...definition, angleUnit: null }, { ...definition, angleUnit: 'gradian' },
    { ...definition, bounds: { ...bounds, X: [-2, 2] } },
    { ...definition, bounds: { ...bounds, X: ['-2', '2', '3'] } },
    { ...definition, tolerance: Infinity }, { ...definition, tolerance: '' },
    { ...definition, tolerance: '1'.repeat(4097) },
    { ...definition, formula: { ...formula, outputs: { ...formula.outputs, X: '0' } } },
    { ...definition, formula: { ...formula, outputs: { Y: 'X' } } },
    { ...definition, formula: { ...formula, unsafe: true } },
    { ...definition, bounds: { ...bounds, T: ['0', '1'] } },
  ])('不正な入力%#は命令を返さない', input => { expect(read(input).ok).toBe(false); });
  it('ラジアンを保持し、曲線は指定スケッチに属する辺として後続へ渡す', () => {
    const parsed = read({ ...definition, angleUnit: 'radian' });
    if (!parsed.ok)
      throw new Error(parsed.reason);
    expect(parsed.command.fields).toMatchObject({ definition: { angleUnit: 'radian' } });
    expect(validateScriptReferences([parsed.command], new Map([['existing', { kind: 'sketch', sketch: null }]]), 'run')).toEqual({ ok: true });
    expect(validateScriptReferences([parsed.command], new Map([['existing', { kind: 'solid', sketch: null }]]), 'run')).toMatchObject({ ok: false, reason: 'kind' });
    expect(validateScriptReferences([parsed.command], new Map(), 'run')).toMatchObject({ ok: false });
  });
});
