import { describe, expect, it } from 'vitest';
import type { Parameter } from '../parameters/types.js';
import { readStrengthInputs, type StrengthInputField } from './strengthInputs.js';

const parameter = (name: string, source: string, unit: Parameter['unit'] = 'none'): Parameter => ({ name, value: { source, value: 0, display: '0' }, unit, description: '' });
function read(source: string, quantity: StrengthInputField['quantity'], parameters: readonly Parameter[] = []) {
  const result = readStrengthInputs([{ name: 'input', source, quantity }], parameters, 'mm');
  if (!result.ok) throw new Error(result.message);
  return result.values.get('input')?.canonical.value;
}

describe('強度計算の量と式の入力境界', () => {
  it.each([
    ['100N', 'force', 100], ['1/10 kN', 'force', 100], ['205 GPa', 'stress', 205000],
    ['1000000 Pa', 'stress', 1], ['1000kPa', 'stress', 1], ['2N·m', 'torque', 2000],
    ['2 N*mm', 'torque', 2], ['0.1kN*m', 'torque', 100000], ['1in', 'length', 25.4],
  ] satisfies readonly (readonly [string, StrengthInputField['quantity'], number])[])('%sを共通単位へ換算する', (source, quantity, value) => {
    expect(read(source, quantity)).toBe(value);
  });
  it('Nというパラメータと、数の後の単位Nを混同しない', () => {
    const parameters = [parameter('N', '7'), parameter('荷重N', '11')];
    expect(read('N', 'force', parameters)).toBe(7);
    expect(read('2*N', 'force', parameters)).toBe(14);
    expect(read('荷重N', 'force', parameters)).toBe(11);
    expect(read('100N', 'force', parameters)).toBe(100);
    expect(read('(N)N', 'force', parameters)).toBe(7);
  });
  it('パラメータ間の大きい数の差を倍精度で消さない', () => {
    const parameters = [parameter('大', '100000000000000000000'), parameter('小差', '大+1'), parameter('力', '(小差-大)*10')];
    expect(read('力', 'force', parameters)).toBe(10);
  });
  it.each(['mm', 'degree'] satisfies readonly Parameter['unit'][])('%sのパラメータを力として使わない', unit => {
    expect(readStrengthInputs([{ name: 'force', source: '寸法', quantity: 'force' }], [parameter('寸法', '10', unit)], 'mm')).toMatchObject({ ok: false, field: 'force' });
  });
  it('循環するパラメータは計算できた値として扱わない', () => {
    const parameters = [parameter('a', 'b'), parameter('b', 'a')];
    expect(readStrengthInputs([{ name: 'force', source: 'a', quantity: 'force' }], parameters, 'mm')).toMatchObject({ ok: false, field: 'force' });
  });
  it.each(['', '1'.repeat(4097), 'NaN', 'sqrt(-1)', '1 GPa'])('不正な力の式を拒否する', source => {
    expect(readStrengthInputs([{ name: 'force', source, quantity: 'force' }], [], 'mm')).toMatchObject({ ok: false, field: 'force' });
  });
  it('同じ入力欄の二重指定を先に拒否する', () => {
    const field: StrengthInputField = { name: 'force', source: '10', quantity: 'force' };
    expect(readStrengthInputs([field, field], [], 'mm')).toMatchObject({ ok: false, field: 'force' });
  });
  it('inch表示の単位なし寸法と明示mmを区別する', () => {
    const result = readStrengthInputs([{ name: 'inch', source: '1/2', quantity: 'length' }, { name: 'mm', source: '1/2 mm', quantity: 'length' }], [], 'inch');
    if (!result.ok) throw new Error(result.message);
    expect(result.values.get('inch')?.canonical.value).toBe(12.7);
    expect(result.values.get('mm')?.canonical.value).toBe(0.5);
  });
});
