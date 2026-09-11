import { describe, expect, it } from 'vitest';
import { expectWithinBudget } from '@pointercad/test-utils';
import { calculateStrength, type StrengthCalculationInput } from './strengthCalculation.js';

const beam: StrengthCalculationInput = {
  calculation: { kind: 'beam', section: 'rectangle', support: 'cantilever' },
  sources: new Map([['width', '10'], ['height', '10'], ['length', '100'], ['force', '10'],
    ['youngModulus', '205000'], ['yieldStress', '245'], ['safetyFactor', '3']]),
  parameters: [], lengthUnit: 'mm',
};
function result(input: StrengthCalculationInput, key: string): number {
  const read = calculateStrength(input);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error(read.message);
  const value = read.value.results.get(key);
  expect(value).toBeDefined();
  if (!value) throw new Error(key);
  return value.value;
}
function withSource(input: StrengthCalculationInput, key: string, value: string): StrengthCalculationInput {
  return { ...input, sources: new Map([...input.sources, [key, value]]) };
}

describe('P11b exact strength formulas and quantity boundaries', () => {
  it('最初の強度計算を10ms以内で行い、任意精度の結果も保持する', () => {
    const started = performance.now(); const calculated = calculateStrength(beam); const elapsed = performance.now() - started;
    console.log(`[実測] 簡易強度計算の初回: ${elapsed.toFixed(3)}ms / 上限10ms`);
    expectWithinBudget(elapsed, 10, '簡易強度計算の初回'); expect(calculated.ok).toBe(true);
    if (!calculated.ok) throw new Error(calculated.message);
    expect(calculated.value.results.get('stress')?.exact).toBe('6');
  });
  it('matches independent cantilever moment, stress and displacement without requiring shear modulus', () => {
    expect(result(beam, 'moment')).toBe(1000);
    expect(result(beam, 'stress')).toBe(6);
    expect(result(beam, 'deflection')).toBeCloseTo(10 * 100 ** 3 / (3 * 205000 * (10 * 10 ** 3 / 12)), 12);
    expect(result(beam, 'actualSafetyFactor')).toBeCloseTo(245 / 6, 12);
    expect(result(beam, 'reserveFactor')).toBeCloseTo(245 / 18, 12);
  });
  it('central load on two supports gives one quarter stress and one sixteenth deflection', () => {
    const supported: StrengthCalculationInput = { ...beam, calculation: { kind: 'beam', section: 'rectangle', support: 'simply-supported' } };
    expect(result(supported, 'stress')).toBe(result(beam, 'stress') / 4);
    expect(result(supported, 'deflection')).toBeCloseTo(result(beam, 'deflection') / 16, 12);
  });
  it('the specified factor changes reserve, while actual factor and geometry response stay unchanged', () => {
    const changed = withSource(beam, 'safetyFactor', '3/2');
    expect(result(changed, 'reserveFactor')).toBeCloseTo(result(beam, 'reserveFactor') * 2, 12);
    expect(result(changed, 'actualSafetyFactor')).toBe(result(beam, 'actualSafetyFactor'));
    expect(result(changed, 'deflection')).toBe(result(beam, 'deflection'));
  });
  it('does not let a rounded section modulus change the exact 6MPa boundary assessment', () => {
    const boundary = withSource(beam, 'yieldStress', '18');
    const passed = calculateStrength(boundary);
    expect(passed.ok && passed.value.meetsSpecifiedFactor).toBe(true);
    expect(result(boundary, 'reserveFactor')).toBe(1);
    const below = calculateStrength(withSource(boundary, 'yieldStress', '18-1e-30'));
    expect(below.ok && below.value.meetsSpecifiedFactor).toBe(false);
  });
  it('converts entered kN and GPa exactly', () => {
    const changed = withSource(withSource(beam, 'force', '1/100 kN'), 'youngModulus', '205 GPa');
    expect(result(changed, 'stress')).toBe(result(beam, 'stress'));
    expect(result(changed, 'deflection')).toBe(result(beam, 'deflection'));
  });
  it('retains tiny positive differences before any double boundary', () => {
    const source = '(100000000000000000001-100000000000000000000)*10';
    expect(result(withSource(beam, 'force', source), 'stress')).toBe(6);
  });
  it.each(['0', '-1', '1/0', '1e999', '2mm', '1in'])('rejects invalid force %s', source => {
    const read = calculateStrength(withSource(beam, 'force', source));
    expect(read).toMatchObject({ ok: false, field: 'force' });
  });
  it('rejects a zero-wall tube and a wall as large as the radius', () => {
    const tube: StrengthCalculationInput = { ...beam, calculation: { kind: 'beam', section: 'tube', support: 'cantilever' },
      sources: new Map([...beam.sources, ['diameter', '10'], ['thickness', '0']]) };
    expect(calculateStrength(tube)).toMatchObject({ ok: false, field: 'thickness' });
    expect(calculateStrength(withSource(tube, 'thickness', '5'))).toMatchObject({ ok: false, field: 'thickness' });
  });
  it('uses the independently verified M10 nominal area, with no E or G input', () => {
    const bolt: StrengthCalculationInput = { ...beam, calculation: { kind: 'bolt' }, sources: new Map([
      ['force', '10000'], ['tensileArea', '58'], ['yieldStress', '245'], ['safetyFactor', '3'],
    ]) };
    expect(result(bolt, 'stress')).toBeCloseTo(10000 / 58, 12);
  });
  it('evaluates shaft torsion with von Mises and radians, using zero inner diameter', () => {
    const shaft: StrengthCalculationInput = { ...beam, calculation: { kind: 'shaft' }, sources: new Map([
      ['outerDiameter', '20'], ['innerDiameter', '0'], ['length', '500'], ['torque', '100 N*m'],
      ['shearModulus', '79000'], ['yieldStress', '245'], ['safetyFactor', '3'],
    ]) };
    expect(result(shaft, 'polarMoment')).toBeCloseTo(Math.PI * 20 ** 4 / 32, 8);
    expect(result(shaft, 'twist')).toBeCloseTo(100000 * 500 / (79000 * Math.PI * 20 ** 4 / 32), 12);
    expect(result(shaft, 'allowableStress')).toBeCloseTo(245 / (Math.sqrt(3) * 3), 12);
    expect(calculateStrength(withSource(shaft, 'innerDiameter', '20'))).toMatchObject({ ok: false, field: 'innerDiameter' });
  });
});
