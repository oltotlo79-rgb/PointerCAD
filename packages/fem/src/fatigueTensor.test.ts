import { describe, expect, it } from 'vitest';
import { analyzeFatigue } from './fatigue.js';
import type { FatigueResult } from './fatigueModel.js';
import { analyzeProportionalTensorFatigue, proportionalTensorFatigueInput, validateProportionalTensorFatigueInput,
  type FatigueTensorConversion } from './fatigueTensor.js';

/* Every expected value is derived by hand from the stated method: s(t) = factor(t) x sign x vonMises(reference), with the
 * sign of the principal stress of largest |value| (tension on an exact tie), and the existing scalar rainflow/Miner path
 * with N = Nref (Sref / S) ** m. The curve is a test-only relation (range, 100 MPa, 2e6 cycles, m = 3), not a material. */
const source = { kind: 'user-supplied', reference: 'Test-only relation; not a material value', condition: 'Hand-derived example' } as const;
const curve = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'curve', unit: 'MPa',
  stressDefinition: 'range', meanStressAssumption: 'mean-independent', referenceStressMpa: 100, referenceCycles: 2e6, slope: 3,
  cutoffStressMpa: null, source, ...overrides });
type Six = readonly [number, number, number, number, number, number];
const reference = ([xx, yy, zz, yz, xz, xy]: Six, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ unit: 'MPa', components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy', xx, yy, zz, yz, xz, xy, ...overrides });
const history = (tensor: Record<string, unknown>, loadFactors: unknown, sequence = 'once', repeats = 1,
  overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: 'h1', reference: tensor, loadFactors, sequence, repeats, source, ...overrides });
const input = (histories: readonly Record<string, unknown>[], curveValue: Record<string, unknown> = curve()): Record<string, unknown> =>
  ({ schema: 'pointercad-fatigue-proportional-tensor/1', method: 'proportional-elastic-signed-von-mises-absolute-largest-principal/1',
    curve: curveValue, histories });
const scalar = (stressMpa: readonly number[], sequence = 'once', repeats = 1, curveValue: Record<string, unknown> = curve()) =>
  ({ schema: 'pointercad-fatigue/1', curve: curveValue, histories: [{ id: 'h1', unit: 'MPa', stressMpa, sequence, repeats, source }] });
const near = (actual: number | undefined, expected: number): void => {
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(1e-12 * Math.abs(expected));
};
const refusal = (value: unknown): readonly [string, string] | null => {
  const analysis = analyzeProportionalTensorFatigue(value);
  return analysis.ok ? null : [analysis.code, analysis.path];
};
/** The public conversion of one reference (factors [0, 1]); the principal stresses are only reachable through it. */
const conversionOf = (tensor: Six): FatigueTensorConversion => {
  const converted = proportionalTensorFatigueInput(input([history(reference(tensor), [0, 1])]));
  if (!converted.ok) throw new Error(`${converted.code} at ${converted.path}`);
  const conversion = converted.conversions[0];
  if (conversion === undefined) throw new Error('no conversion');
  return conversion;
};
/** The scalar stresses the conversion hands to the existing reader. */
const stressesOf = (value: unknown): readonly number[] => {
  const checked = validateProportionalTensorFatigueInput(value);
  if (!checked.ok) throw new Error(`${checked.code} at ${checked.path}`);
  return checked.input.histories[0]?.stressMpa ?? [];
};
/** R D R^T for a rotation R (rows) and a diagonal D, as [xx, yy, zz, yz, xz, xy]. */
function rotated(rotation: readonly (readonly number[])[], diagonal: readonly [number, number, number]): Six {
  const entry = (i: number, j: number): number => diagonal.reduce((sum, value, k) =>
    sum + (rotation[i]?.[k] ?? Number.NaN) * value * (rotation[j]?.[k] ?? Number.NaN), 0);
  return [entry(0, 0), entry(1, 1), entry(2, 2), entry(1, 2), entry(0, 2), entry(0, 1)];
}
// Rz(30 deg) x Rx(45 deg): a general rotation with no principal axis on a coordinate axis.
const c30 = Math.sqrt(3) / 2, s30 = 0.5, c45 = Math.SQRT1_2, s45 = Math.SQRT1_2;
const ROTATION = [[c30, -s30 * c45, s30 * s45], [s30, c30 * c45, -c30 * s45], [0, s45, c45]] as const;

describe('principal stresses of the reference, through the public conversion (closed form)', () => {
  // Largest |component| 1, so the internal unit scaling is the identity and the 12-digit tolerances are on unit values.
  it('returns the diagonal of a diagonal tensor, descending', () => {
    const { principalStressesMpa } = conversionOf([0.5, 1, -0.25, 0, 0, 0]);
    [1, 0.5, -0.25].forEach((value, index) => { expect(principalStressesMpa[index]).toBeCloseTo(value, 12); });
  });
  it('returns +tau, 0, -tau for pure shear', () => {
    const { principalStressesMpa } = conversionOf([0, 0, 0, 0, 0, 1]);
    [1, 0, -1].forEach((value, index) => { expect(principalStressesMpa[index]).toBeCloseTo(value, 12); });
  });
  it('returns the same values for a rotated diagonal tensor', () => {
    const { principalStressesMpa } = conversionOf(rotated(ROTATION, [1, 0.25, -0.5]));
    [1, 0.25, -0.5].forEach((value, index) => { expect(principalStressesMpa[index]).toBeCloseTo(value, 12); });
  });
  it('has no principal directions for a hydrostatic tensor (refused at the reference)', () => {
    expect(refusal(input([history(reference([1, 1, 1, 0, 0, 0]), [0, 1])]))).toEqual(['fatigue-tensor-hydrostatic', 'histories[0].reference']);
  });
  it('never defaults a missing or undefined component to zero', () => {
    const missing = { unit: 'MPa', components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy', xx: 100, yy: 0, zz: 0, yz: 0, xz: 0 };
    expect(refusal(input([history(missing, [0, 1])]))).toEqual(['fatigue-tensor-shape', 'histories[0].reference']);
    expect(refusal(input([history(reference([100, 0, 0, 0, 0, 0], { xy: undefined }), [0, 1])])))
      .toEqual(['fatigue-tensor-number', 'histories[0].reference.xy']);
  });
});

describe('proportional tensor loading on the existing scalar path', () => {
  it('uniaxial tension and compression give exactly the scalar analysis of factor x stress', () => {
    const tension = analyzeProportionalTensorFatigue(input([history(reference([100, 0, 0, 0, 0, 0]), [0, 1, 0, -0.5, 1])]));
    expect(tension.ok && tension.result).toEqual(scalarResult(scalar([0, 100, 0, -50, 100])));
    const compression = analyzeProportionalTensorFatigue(input([history(reference([-80, 0, 0, 0, 0, 0]), [0.5, -1, 1])]));
    expect(compression.ok && compression.result).toEqual(scalarResult(scalar([-40, 80, -80])));
    expect(compression.ok && compression.conversions[0]?.signedEquivalentReferenceMpa).toBe(-80);
  });

  it('pure shear: equivalent sqrt(3) tau on the tension tie-break, the factor sign reverses it, known-cycle damage', () => {
    const tau = 10, equivalent = Math.sqrt(3) * tau;
    const analysis = analyzeProportionalTensorFatigue(input([history(reference([0, 0, 0, 0, 0, tau]), [-1, 1], 'repeated-periodic', 1000)]));
    if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
    const conversion = analysis.conversions[0];
    expect(conversion?.signTie).toBe(true);
    expect(conversion?.signedEquivalentReferenceMpa).toBeCloseTo(equivalent, 12);
    // Factors -1, 1 -> -sqrt(3) tau, +sqrt(3) tau: one closed cycle of range 2 sqrt(3) tau per period, mean 0.
    const cycles = analysis.result.histories[0]?.cycles ?? [];
    expect(cycles.map(cycle => cycle.count)).toEqual([0.5, 0.5]);
    for (const cycle of cycles) {
      expect(cycle.rangeMpa).toBeCloseTo(2 * equivalent, 12);
      expect(cycle.meanMpa).toBeCloseTo(0, 12);
    }
    const damage = 1000 * (2 * equivalent / 100) ** 3 / 2e6;
    near(analysis.result.damage, damage);
    expect(analysis.result.life.kind).toBe('finite');
    if (analysis.result.life.kind !== 'finite') throw new Error('Expected finite life');
    near(analysis.result.life.spectrumRepetitions, 1 / damage);
  });

  it('a rotated copy of the same reference tensor gives the same equivalent, sign and life', () => {
    const diagonal = [120, 30, -40] as const;
    const plain = analyzeProportionalTensorFatigue(input([history(reference([...diagonal, 0, 0, 0]), [0, 1, 0])]));
    const turned = analyzeProportionalTensorFatigue(input([history(reference(rotated(ROTATION, diagonal)), [0, 1, 0])]));
    if (!plain.ok || !turned.ok) throw new Error('refused');
    // von Mises of diag(120, 30, -40): sqrt((90^2 + 70^2 + 160^2) / 2) = sqrt(19300); the largest |principal| is +120.
    expect(plain.conversions[0]?.signedEquivalentReferenceMpa).toBeCloseTo(Math.sqrt(19300), 12);
    expect(turned.conversions[0]?.signedEquivalentReferenceMpa).toBeCloseTo(Math.sqrt(19300), 10);
    near(turned.result.damage, plain.result.damage);
  });

  it('takes the sign of a dominant compressive principal stress and keeps a negative factor', () => {
    // diag(-100, 20, 0): von Mises sqrt((120^2 + 20^2 + 100^2) / 2) = sqrt(12400), largest |principal| is -100.
    const conversion = conversionOf([-100, 20, 0, 0, 0, 0]);
    expect(conversion.signedEquivalentReferenceMpa).toBeCloseTo(-Math.sqrt(12400), 12);
    expect(conversion.signTie).toBe(false);
    // Factor -1 on a negative equivalent: +sqrt(12400) at the second sample.
    expect(stressesOf(input([history(reference([-100, 20, 0, 0, 0, 0]), [0, -1])]))[1]).toBeCloseTo(Math.sqrt(12400), 12);
  });

  it('keeps the curve mean-stress semantics: a negative-factor half cycle is refused by a fully-reversed-only curve', () => {
    expect(refusal(input([history(reference([100, 0, 0, 0, 0, 0]), [0, -1])], curve({ meanStressAssumption: 'fully-reversed-only' }))))
      .toEqual(['fatigue-mean', 'histories[0].cycles[0]']);
    const accepted = analyzeProportionalTensorFatigue(input([history(reference([100, 0, 0, 0, 0, 0]), [0, -1])]));
    near(accepted.ok ? accepted.result.damage : undefined, 0.5 / 2e6);
  });

  it('refuses a zero and a hydrostatic reference instead of reporting no damage', () => {
    expect(refusal(input([history(reference([0, 0, 0, 0, 0, 0]), [0, 1])]))).toEqual(['fatigue-tensor-zero-reference', 'histories[0].reference']);
    expect(refusal(input([history(reference([50, 50, 50, 0, 0, 0]), [0, 1])]))).toEqual(['fatigue-tensor-hydrostatic', 'histories[0].reference']);
  });
});

describe('rounding boundaries (a defined load never becomes zero stress; overflows stay refused)', () => {
  const tiny = Number.MIN_VALUE;
  it('keeps the smallest nonzero uniaxial reference exactly (no rounding to zero)', () => {
    const conversion = conversionOf([tiny, 0, 0, 0, 0, 0]);
    expect(conversion.vonMisesReferenceMpa).toBe(tiny);
    expect(conversion.signedEquivalentReferenceMpa).toBe(tiny);
    // The two equal principal stresses carry a small relative error of the closed form; times MIN_VALUE it is lost.
    const [largest, middle, smallest] = conversion.principalStressesMpa;
    expect(largest).toBe(tiny);
    expect(Math.abs(middle)).toBe(0);
    expect(Math.abs(smallest)).toBe(0);
    expect(stressesOf(input([history(reference([-tiny, 0, 0, 0, 0, 0]), [0, 1, -1])]))).toEqual([0, -tiny, tiny]);
  });
  it('keeps the smallest pure shear reference nonzero: sqrt(3) x MIN_VALUE rounds to 2 x MIN_VALUE', () => {
    const conversion = conversionOf([0, 0, 0, 0, 0, tiny]);
    expect(conversion.signTie).toBe(true);
    expect(conversion.signedEquivalentReferenceMpa).toBe(2 * tiny);
  });
  it('refuses a small reference whose deviatoric part is below the hydrostatic tolerance', () => {
    // xx = yy = zz = 1e-300 with xy = MIN_VALUE: relative deviatoric part about 5e-24, far below 1e-12.
    expect(refusal(input([history(reference([1e-300, 1e-300, 1e-300, 0, 0, tiny]), [0, 1])])))
      .toEqual(['fatigue-tensor-hydrostatic', 'histories[0].reference']);
  });
  it('refuses a nonzero factor whose equivalent stress rounds to zero, at that factor', () => {
    // 0.5 x MIN_VALUE is the exact half-way value and rounds to the even neighbour 0; 1 x MIN_VALUE stays MIN_VALUE.
    expect(refusal(input([history(reference([0.5, 0, 0, 0, 0, 0]), [0, 1, tiny])])))
      .toEqual(['fatigue-tensor-underflow', 'histories[0].loadFactors[2]']);
    expect(refusal(input([history(reference([0.5, 0, 0, 0, 0, 0]), [0, -tiny])])))
      .toEqual(['fatigue-tensor-underflow', 'histories[0].loadFactors[1]']);
    expect(stressesOf(input([history(reference([1, 0, 0, 0, 0, 0]), [0, tiny])]))).toEqual([0, tiny]);
  });
  it('keeps a zero factor legitimate (negative zero becomes zero stress)', () => {
    const stresses = stressesOf(input([history(reference([100, 0, 0, 0, 0, 0]), [-0, 1, 0])]));
    expect(stresses).toHaveLength(3);
    expect(stresses[0]).toBe(0);
    expect(stresses[2]).toBe(0);
  });
  it('refuses finite and infinite overflow of factor x equivalent at that factor', () => {
    expect(refusal(input([history(reference([100, 0, 0, 0, 0, 0]), [0, 101])])))
      .toEqual(['fatigue-tensor-bound', 'histories[0].loadFactors[1]']);
    expect(refusal(input([history(reference([100, 0, 0, 0, 0, 0]), [0, -Number.MAX_VALUE])])))
      .toEqual(['fatigue-tensor-bound', 'histories[0].loadFactors[1]']);
    expect(stressesOf(input([history(reference([100, 0, 0, 0, 0, 0]), [0, 100])]))).toEqual([0, 10000]);
  });
});

describe('strict input contract (tensor checks first, then the exact scalar codes and paths)', () => {
  const uniaxial = reference([100, 0, 0, 0, 0, 0]);
  const holes = new Array<number>(2);
  holes[1] = 1;
  it.each([
    ['extra top-level key', { ...input([history(uniaxial, [0, 1])]), extra: 1 }, 'fatigue-tensor-shape', '$'],
    ['schema', { ...input([history(uniaxial, [0, 1])]), schema: 'pointercad-fatigue/1' }, 'fatigue-tensor-schema', 'schema'],
    ['method', { ...input([history(uniaxial, [0, 1])]), method: 'critical-plane' }, 'fatigue-tensor-method', 'method'],
    ['unknown component key', input([history(reference([100, 0, 0, 0, 0, 0], { yx: 0 }), [0, 1])]), 'fatigue-tensor-shape', 'histories[0].reference'],
    ['engineering shear convention', input([history(reference([100, 0, 0, 0, 0, 0], { components: 'engineering-shear' }), [0, 1])]),
      'fatigue-tensor-convention', 'histories[0].reference.components'],
    ['unit', input([history(reference([100, 0, 0, 0, 0, 0], { unit: 'Pa' }), [0, 1])]), 'fatigue-tensor-unit', 'histories[0].reference.unit'],
    ['non-finite component', input([history(reference([100, 0, 0, 0, 0, Number.NaN]), [0, 1])]), 'fatigue-tensor-number', 'histories[0].reference.xy'],
    ['component out of bound', input([history(reference([10001, 0, 0, 0, 0, 0]), [0, 1])]), 'fatigue-tensor-bound', 'histories[0].reference.xx'],
    ['factor hole', input([history(uniaxial, holes)]), 'fatigue-tensor-shape', 'histories[0].loadFactors'],
    ['infinite factor', input([history(uniaxial, [0, Number.POSITIVE_INFINITY])]), 'fatigue-tensor-number', 'histories[0].loadFactors[1]'],
    ['no factor', input([history(uniaxial, [])]), 'fatigue-tensor-history', 'histories[0].loadFactors'],
    ['invalid curve slope', input([history(uniaxial, [0, 1])], curve({ slope: 0 })), 'fatigue-bound', 'curve.slope'],
    ['invalid mean assumption', input([history(uniaxial, [0, 1])], curve({ meanStressAssumption: 'goodman' })),
      'fatigue-mean-assumption', 'curve.meanStressAssumption'],
    ['once repeated', input([history(uniaxial, [0, 1], 'once', 2)]), 'fatigue-repeats', 'histories[0].repeats'],
  ])('%s', (_label, value, code, path) => {
    expect(refusal(value)).toEqual([code, path]);
  });

  it('does not mutate frozen input', () => {
    const value = Object.freeze(input([Object.freeze(history(Object.freeze(reference([0, 0, 0, 0, 0, 10])), Object.freeze([-1, 1]),
      'repeated-periodic', 3))], Object.freeze(curve())));
    const before = JSON.stringify(value);
    expect(analyzeProportionalTensorFatigue(value).ok).toBe(true);
    expect(JSON.stringify(value)).toBe(before);
  });
});

/** The existing scalar analysis of the hand-built history (the reference the tensor path must equal exactly). */
function scalarResult(value: unknown): FatigueResult {
  const analysis = analyzeFatigue(value);
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  return analysis.result;
}
