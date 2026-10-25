import { describe, expect, it } from 'vitest';
import { comparePlasticBar, PLASTIC_BAR_PLAN_SCHEMA, plasticBarReference, plasticBarSchedule, readPlasticBarPlan,
  type PlasticBarPlan } from './plasticBar.js';

/** Relative closeness against an explicit scale; all expected values below are hand-derived before execution. */
function close(actual: number, expected: number, scale: number, tolerance = 1e-12): void {
  expect(Math.abs(actual - expected) / scale, `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}
// Illustrative user-supplied values (not a grade claim): E = 200 GPa, sigma0 = 250 MPa, H = 2 GPa, L = 1 m, A = 1 cm2.
const material = { youngPa: 200e9, poisson: 0.3, yieldStressPa: 250e6, hardeningModulusPa: 2e9,
  source: { kind: 'user-supplied', reference: 'Numerical example entered by the user for a uniaxial test' } };
const plan = (overrides: Partial<Record<string, unknown>> = {}): unknown => ({ schema: PLASTIC_BAR_PLAN_SCHEMA,
  lengthM: 1, areaM2: 1e-4, material, endDisplacementM: [0, 2.5e-3, 0, -2.5e-3, 0], stepsPerSegment: 1, ...overrides });

describe('uniaxial J2 plasticity with linear isotropic hardening (hand-derived return mapping)', () => {
  it('load past yield, elastic unload, reverse yield on the hardened surface, elastic reload', () => {
    const samples = plasticBarReference(readPlasticBarPlan(plan()));
    expect(samples.map(s => s.step)).toEqual([1, 2, 3, 4]);
    const S = 250e6, Ey = 1.25e-3;
    // 1. eps = 2.5e-3: trial 500 MPa, f = 250 MPa, dk = 250e6 / 202e9 = 1.2376237623762376e-3,
    //    stress = 250e6 + 2e9 dk = 252.47524752475247 MPa.
    close(samples[0].stressPa, 252475247.52475247, S);
    close(samples[0].plasticStrain, 1.2376237623762376e-3, Ey);
    close(samples[0].axialForceN, 25247.52475247525, S * 1e-4);
    // 2. back to eps = 0: trial -247.52 MPa, |trial| < sigmaY 252.48 MPa, so elastic; plastic strain stays.
    close(samples[1].stressPa, -247524752.47524753, S);
    close(samples[1].plasticStrain, 1.2376237623762376e-3, Ey);
    // 3. eps = -2.5e-3: trial -747.52 MPa, f = 495.0495 MPa, dk = 2.4507401235173021e-3,
    //    kappa = 3.6883638858935397e-3, plastic strain = -1.2131163611410645e-3, stress = -(250e6 + 2e9 kappa).
    close(samples[2].stressPa, -257376727.77178708, S);
    close(samples[2].plasticStrain, -1.2131163611410645e-3, Ey);
    close(samples[2].cumulativePlasticStrain, 0.0036883638858935396, Ey);
    close(samples[2].yieldStressPa, 257376727.77178708, S);
    // 4. back to eps = 0: trial 242.62 MPa < 257.38 MPa: elastic, the reversed plastic strain remains.
    close(samples[3].stressPa, 242623272.2282129, S);
    close(samples[3].plasticStrain, -1.2131163611410645e-3, Ey);
    // The residual stress at zero end displacement is never zero after yielding (the bar is displacement-held).
    expect(Math.abs(samples[3].stressPa)).toBeGreaterThan(2e8);
  });

  it('perfect plasticity (H = 0): stress is capped at sigma0 and the unloading point sits exactly on the surface', () => {
    const samples = plasticBarReference(readPlasticBarPlan(plan({ material: { ...material, hardeningModulusPa: 0 },
      endDisplacementM: [0, 2.5e-3, 0] })));
    close(samples[0].stressPa, 250e6, 250e6);
    close(samples[0].plasticStrain, 1.25e-3, 1.25e-3);
    close(samples[1].stressPa, -250e6, 250e6, 1e-9);
    close(samples[1].plasticStrain, 1.25e-3, 1.25e-3, 1e-9);
  });

  it('stays elastic below yield: stress = E strain and no plastic strain, also through many steps', () => {
    const samples = plasticBarReference(readPlasticBarPlan(plan({ endDisplacementM: [0, 1e-3, -1e-3], stepsPerSegment: 7 })));
    for (const s of samples) {
      close(s.stressPa, 200e9 * s.strain, 250e6);
      expect(s.plasticStrain).toBe(0);
    }
  });

  it('is path independent of the step count for monotonic loading with linear hardening (exact closed form)', () => {
    const one = plasticBarReference(readPlasticBarPlan(plan({ endDisplacementM: [0, 4e-3] })));
    const many = plasticBarReference(readPlasticBarPlan(plan({ endDisplacementM: [0, 4e-3], stepsPerSegment: 50 })));
    // sigma = sigma0 + H (E eps - sigma0) / (E + H) = 250e6 + 2e9 * 550e6 / 202e9 = 255.44554455445544 MPa
    close(one[0].stressPa, 255445544.55445543, 250e6);
    close(many[many.length - 1].stressPa, 255445544.55445543, 250e6, 1e-12);
  });
});

describe('plan validation and the native step schedule', () => {
  it('schedules equal increments with exact knots at segment ends', () => {
    expect(plasticBarSchedule(readPlasticBarPlan(plan({ endDisplacementM: [0, 2e-3, 0], stepsPerSegment: 4 }))))
      .toEqual([5e-4, 1e-3, 1.5e-3, 2e-3, 1.5e-3, 1e-3, 5e-4, 0]);
  });

  it.each([
    ['schema', { schema: 'pointercad-oofem-plastic-bar-plan/0' }, 'unsupported plan schema'],
    ['extra field', { extra: 1 }, 'exactly the fields'],
    ['zero length', { lengthM: 0 }, 'lengthM must be positive'],
    ['infinite area', { areaM2: Infinity }, 'areaM2 must be a finite number'],
    ['negative hardening', { material: { ...material, hardeningModulusPa: -1 } }, 'softening is not supported'],
    ['yield above E', { material: { ...material, yieldStressPa: 300e9 } }, 'yield strain < 1'],
    ['poisson 0.5', { material: { ...material, poisson: 0.5 } }, 'poisson must be in [0, 0.5)'],
    ['grade-derived source', { material: { ...material, source: { kind: 'catalog-grade', reference: 'SS400' } } }, 'user-supplied'],
    ['empty reference', { material: { ...material, source: { kind: 'user-supplied', reference: ' ' } } }, 'non-empty statement'],
    ['first knot not zero', { endDisplacementM: [1e-4, 2e-3] }, 'first end-displacement knot must be 0'],
    ['repeated knot', { endDisplacementM: [0, 1e-3, 1e-3] }, 'consecutive end-displacement knots must differ'],
    ['non-finite knot', { endDisplacementM: [0, Number.NaN] }, 'endDisplacementM[1] must be a finite number'],
    ['large strain', { endDisplacementM: [0, 0.06] }, 'small-strain formulation'],
    ['fractional steps', { stepsPerSegment: 1.5 }, 'stepsPerSegment must be an integer'],
    ['too many steps', { endDisplacementM: [0, 1e-3, 0, 1e-3, 0, 1e-3, 0, 1e-3, 0, 1e-3, 0, 1e-3], stepsPerSegment: 200 }, 'at most 2000 steps'],
  ] as const)('rejects %s', (_name, overrides, message) => {
    expect(() => readPlasticBarPlan(plan(overrides))).toThrow(message);
  });

  it('rejects a sparse knot array that Array.map would silently skip', () => {
    const sparse: number[] = [0];
    sparse[2] = 1e-3;
    expect(() => readPlasticBarPlan(plan({ endDisplacementM: sparse }))).toThrow('must not have holes');
  });
});

describe('native comparison helper', () => {
  it('reports zero difference for the reference itself and detects a perturbed stress', () => {
    const p: PlasticBarPlan = readPlasticBarPlan(plan());
    const ref = plasticBarReference(p);
    expect(comparePlasticBar(ref, ref, p)).toEqual({ stress: 0, plasticStrain: 0, force: 0, displacement: 0 });
    const perturbed = ref.map((s, i) => i === 2 ? { ...s, stressPa: s.stressPa + 2.5e6 } : s);
    close(comparePlasticBar(perturbed, ref, p).stress, 0.01, 1);
    expect(() => comparePlasticBar(ref.slice(1), ref, p)).toThrow('sample counts differ');
  });
});
