import { describe, expect, it } from 'vitest';
import { comparePlasticBar, PLASTIC_BAR_PLAN_SCHEMA, plasticBarHardeningTable, plasticBarReference, plasticBarSchedule,
  readPlasticBarPlan, type PlasticBarPlan } from './plasticBar.js';

type PlasticBarHardeningTable = NonNullable<ReturnType<typeof plasticBarHardeningTable>>;

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
  it('normalizes a negative-zero displacement to positive zero', () => {
    const read = readPlasticBarPlan(plan({ endDisplacementM: [-0, 0.001] }));
    expect(Object.is(read.endDisplacementM[0], -0)).toBe(false);
    expect(Object.is(read.endDisplacementM[0], 0)).toBe(true);
  });

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

// Yield plateau (explicit input only). Expected values: exact rationals of an independent Fraction oracle written
// from the law sigmaY = sigma0 (kappa <= kp), sigma0 + H (kappa - kp) (owner rev53 oracle53.py, built on the rev52
// oracle), rounded once to double; not product output. Inputs are illustrative user values, not a grade.
const plateauMaterial = { ...material, plateauPlasticStrain: 0.01 };
const plateauKnots = [0, 0.005, 0.02, 0.019, -0.005, 0];
const plateauPlan = (overrides: Partial<Record<string, unknown>> = {}): unknown =>
  plan({ material: plateauMaterial, endDisplacementM: plateauKnots, ...overrides });

describe('yield plateau then linear isotropic hardening (exact-rational oracle)', () => {
  it('plateau, leaving the plateau, elastic unload, reverse yield and re-yield in one step per segment', () => {
    const samples = plasticBarReference(readPlasticBarPlan(plateauPlan()));
    const S = 250e6, Ey = 1.25e-3;
    // [stress, plastic strain, kappa]; exact: 250e6, 3/800 | 27e9/101, 377/20200 | 6.8e9/101, 377/20200 |
    // -3178e9/10201, -7023/2040200, 83177/2040200 | 324823e9/1030301, -324823/206060200, 8785377/206060200
    const expected = [
      [250000000, 0.00375, 0.00375],
      [267326732.67326733, 0.018663366336633663, 0.018663366336633663],
      [67326732.67326732, 0.018663366336633663, 0.018663366336633663],
      [-311538084.50151944, -0.0034423095774924026, 0.04076904225075973],
      [315270003.62030125, -0.0015763500181015062, 0.042635001810150626],
    ];
    expect(samples).toHaveLength(expected.length);
    samples.forEach((sample, index) => {
      const [stress, plastic, kappa] = expected[index];
      close(sample.stressPa, stress, S);
      close(sample.plasticStrain, plastic, Ey);
      close(sample.cumulativePlasticStrain, kappa, Ey);
      close(sample.axialForceN, stress * 1e-4, S * 1e-4);
      // The state lies on the current yield surface whenever it has just yielded.
      if (index !== 2) close(Math.abs(sample.stressPa), sample.yieldStressPa, S);
    });
    // Step 1 ends on the plateau, so the yield stress is exactly sigma0 although kappa > 0.
    expect(samples[0].yieldStressPa).toBe(250e6);
    // Without the plateau the same plan hardens from first yield: 250e6 + 2e9 * 750e6 / 202e9 = 257.43 MPa at step 1.
    const linear = plasticBarReference(readPlasticBarPlan(plan({ endDisplacementM: plateauKnots })));
    close(linear[0].stressPa, 257425742.57425743, S);
  });

  it('gives the same knot states with three steps per segment and an elastic unload inside a segment', () => {
    const samples = plasticBarReference(readPlasticBarPlan(plateauPlan({ stepsPerSegment: 3 })));
    const S = 250e6, Ey = 1.25e-3;
    expect(samples).toHaveLength(15);
    // Steps 1-4 stay on the plateau (kappa 7/800 < kp); step 5 crosses kp inside the step: 26e9/101, 277/20200.
    for (const index of [0, 1, 2, 3]) close(samples[index].stressPa, 250e6, S);
    close(samples[3].cumulativePlasticStrain, 0.00875, Ey);
    close(samples[4].stressPa, 257425742.57425743, S);
    close(samples[4].cumulativePlasticStrain, 0.013712871287128713, Ey);
    // Knot states equal the one-step run: 27e9/101 at 0.02, -3178e9/10201 at -0.005, 324823e9/1030301 at 0.
    close(samples[5].stressPa, 267326732.67326733, S);
    close(samples[11].stressPa, -311538084.50151944, S);
    close(samples[14].stressPa, 315270003.62030125, S);
    // Step 13 (strain -1/300) is elastic after the reversal: 667e9/30603 with unchanged plastic strain.
    close(samples[12].stressPa, 21795248.831813876, S);
    close(samples[12].plasticStrain, -0.0034423095774924026, Ey);
  });

  it('a plateau that is never left reproduces the perfectly plastic law exactly', () => {
    const knots = [0, 2.5e-3, 0];
    const long = plasticBarReference(readPlasticBarPlan(plan({ material: { ...material, plateauPlasticStrain: 0.05 },
      endDisplacementM: knots })));
    const perfect = plasticBarReference(readPlasticBarPlan(plan({ material: { ...material, hardeningModulusPa: 0 },
      endDisplacementM: knots })));
    expect(long.map(s => [s.stressPa, s.plasticStrain, s.cumulativePlasticStrain]))
      .toEqual(perfect.map(s => [s.stressPa, s.plasticStrain, s.cumulativePlasticStrain]));
  });

  it('keeps a plan without the field byte-identical and builds the exact htype 1 table only with it', () => {
    const legacy = readPlasticBarPlan(plan());
    expect(Object.keys(legacy.material)).toEqual(['youngPa', 'poisson', 'yieldStressPa', 'hardeningModulusPa', 'source']);
    expect(JSON.stringify(legacy)).toBe(JSON.stringify(plan()));
    expect(plasticBarHardeningTable(legacy)).toBeNull();
    const read = readPlasticBarPlan(plateauPlan());
    expect(read.material.plateauPlasticStrain).toBe(0.01);
    // Total variation 0.005 + 0.015 + 0.001 + 0.024 + 0.005 = 0.05 m over 1 m; kmax = 0.01 + 2 * 0.05 = 0.11.
    const table = plasticBarHardeningTable(read);
    expect(table?.plasticStrain[0]).toBe(0);
    expect(table?.plasticStrain[1]).toBe(0.01);
    close(table?.plasticStrain[2] ?? Number.NaN, 0.11, 0.11);
    expect(table?.yieldStressPa.slice(0, 2)).toEqual([250e6, 250e6]);
    close(table?.yieldStressPa[2] ?? Number.NaN, 450e6, 250e6);
    // The last table entry is never reached (MisesMat stops beyond it and returns 0 exactly at it).
    for (const steps of [1, 3, 200]) {
      const reached = Math.max(...plasticBarReference(readPlasticBarPlan(plateauPlan({ stepsPerSegment: steps })))
        .map(s => s.cumulativePlasticStrain));
      expect(reached).toBeLessThan((table?.plasticStrain[2] ?? 0) / 2);
    }
  });

  // rev55 boundary cases. Expected values are hand arithmetic on the decimal inputs (kmax = kp + 2 max(kp, TV)).
  const tableFor = (knots: readonly number[], kp: number, lengthM = 1): PlasticBarHardeningTable | null => {
    const base = readPlasticBarPlan(plateauPlan());
    return plasticBarHardeningTable({ ...base, lengthM, endDisplacementM: knots,
      material: { ...base.material, plateauPlasticStrain: kp } });
  };
  const strictlyAbove = (table: PlasticBarHardeningTable | null, kp: number, tv: number): number => {
    const kmax = table?.plasticStrain[2] ?? Number.NaN;
    expect(table?.plasticStrain[1]).toBe(kp);
    expect(kmax).toBeGreaterThan(kp);
    expect(kmax).toBeGreaterThan(tv);
    expect(Number.isFinite(kmax) && Number.isFinite(table?.yieldStressPa[2] ?? Number.NaN)).toBe(true);
    return kmax;
  };

  it('keeps kmax above kp when the strain variation is zero, underflows or is far below one ulp of kp', () => {
    // All knots 0 (the reader refuses equal knots; built directly): TV = 0, kmax = 0.01 + 2 * 0.01 = 0.03,
    // last stress = 250 MPa + 2 GPa * 0.02 = 290 MPa.
    const zero = tableFor([0, 0], 0.01);
    close(strictlyAbove(zero, 0.01, 0), 0.03, 0.03, 1e-15);
    close(zero?.yieldStressPa[2] ?? Number.NaN, 290e6, 250e6, 1e-15);
    // Accepted by the reader: 5e-324 m over 500 m underflows to TV = 0 in doubles, so the same table as above.
    const under = plasticBarHardeningTable(readPlasticBarPlan(plateauPlan({ lengthM: 500,
      endDisplacementM: [0, Number.MIN_VALUE] })));
    expect(under?.plasticStrain).toEqual(zero?.plasticStrain);
    // TV = 1e-20 is below half an ulp of 0.01 (about 8.7e-19), so the earlier kp + 2 TV rounded back to kp exactly.
    expect(0.01 + 2 * 1e-20).toBe(0.01);
    const tiny = plasticBarHardeningTable(readPlasticBarPlan(plateauPlan({ endDisplacementM: [0, 1e-20] })));
    close(strictlyAbove(tiny, 0.01, 1e-20), 0.03, 0.03, 1e-15);
    // Smallest positive plateau: kmax = 3 * 5e-324 exactly, still above kp.
    expect(strictlyAbove(tableFor([0, 0], Number.MIN_VALUE), Number.MIN_VALUE, 0)).toBe(3 * Number.MIN_VALUE);
  });

  it('keeps the earlier table bits when TV >= kp and lifts kmax to 3 kp when TV < kp, also on reversed paths', () => {
    const earlier = (knots: readonly number[], kp: number): number =>
      kp + 2 * (knots.slice(1).reduce((sum, u, index) => sum + Math.abs(u - knots[index]), 0) / 1);
    // Normal path of plateauPlan: TV = 0.05 >= kp = 0.01, kmax = 0.11 (unchanged numbers).
    const normal = tableFor(plateauKnots, 0.01);
    expect(strictlyAbove(normal, 0.01, 0.05)).toBe(earlier(plateauKnots, 0.01));
    // Reversed path 0 -> 2 -> -1 -> 3 -> 0 mm: TV = 2 + 3 + 4 + 3 = 12 mm over 1 m = 0.012.
    const reversed = [0, 0.002, -0.001, 0.003, 0];
    const above = tableFor(reversed, 0.005);
    expect(strictlyAbove(above, 0.005, 0.012)).toBe(earlier(reversed, 0.005));
    close(above?.plasticStrain[2] ?? Number.NaN, 0.029, 0.029, 1e-15);
    const below = tableFor(reversed, 0.02);
    close(strictlyAbove(below, 0.02, 0.012), 0.06, 0.06, 1e-15);
    close(below?.yieldStressPa[2] ?? Number.NaN, 330e6, 250e6, 1e-15);
    // TV = kp exactly (0 -> 10 mm): kmax = 0.03 by either branch.
    close(strictlyAbove(tableFor([0, 0.01], 0.01), 0.01, 0.01), 0.03, 0.03, 1e-15);
    // The reached cumulative plastic strain of the reversed path stays below the lifted kmax.
    const read = readPlasticBarPlan(plateauPlan({ endDisplacementM: reversed,
      material: { ...plateauMaterial, plateauPlasticStrain: 0.02 } }));
    const reached = Math.max(...plasticBarReference(read).map(s => s.cumulativePlasticStrain));
    expect(reached).toBeLessThanOrEqual(0.012);
    expect(reached).toBeLessThan(plasticBarHardeningTable(read)?.plasticStrain[2] ?? 0);
  });

  it('refuses a plateau plan whose last table stress is not finite and leaves the linear law unchecked', () => {
    // TV = 0.05 + 5 * 0.1 = 0.55, kmax - kp = 1.1: 1e308 * 1.1 is finite, the largest double times 1.1 is not.
    const swings = [0, 0.05, -0.05, 0.05, -0.05, 0.05, -0.05];
    const finite = readPlasticBarPlan(plateauPlan({ endDisplacementM: swings,
      material: { ...plateauMaterial, hardeningModulusPa: 1e308 } }));
    close(plasticBarHardeningTable(finite)?.yieldStressPa[2] ?? Number.NaN, 1.1e308, 1.1e308, 1e-14);
    expect(() => readPlasticBarPlan(plateauPlan({ endDisplacementM: swings,
      material: { ...plateauMaterial, hardeningModulusPa: Number.MAX_VALUE } })))
      .toThrow('plastic-bar: the plateau hardening table must be finite (material.hardeningModulusPa is too large)');
    const linear = readPlasticBarPlan(plan({ endDisplacementM: swings,
      material: { ...material, hardeningModulusPa: Number.MAX_VALUE } }));
    expect(linear.material.hardeningModulusPa).toBe(Number.MAX_VALUE);
    expect(plasticBarHardeningTable(linear)).toBeNull();
  });

  it.each([
    ['zero plateau (omit the field instead)', 0, 'material.plateauPlasticStrain must be positive'],
    ['negative plateau', -1e-3, 'material.plateauPlasticStrain must be positive'],
    ['plateau beyond small strain', 0.06, 'material.plateauPlasticStrain must not exceed 0.05'],
    ['non-finite plateau', Number.POSITIVE_INFINITY, 'material.plateauPlasticStrain must be a finite number'],
    ['percent text', '1%', 'material.plateauPlasticStrain must be a finite number'],
  ] as const)('rejects %s', (_name, value, message) => {
    expect(() => readPlasticBarPlan(plan({ material: { ...material, plateauPlasticStrain: value } }))).toThrow(message);
  });

  it('rejects an unknown extra material field next to the plateau', () => {
    expect(() => readPlasticBarPlan(plan({ material: { ...plateauMaterial, plateauEndStrain: 0.02 } })))
      .toThrow('material must have exactly the fields');
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
