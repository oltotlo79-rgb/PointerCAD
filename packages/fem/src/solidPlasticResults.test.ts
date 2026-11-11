import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSolidPlasticPlan, SOLID_PLASTIC_LIMITS, SOLID_PLASTIC_PLAN_SCHEMA, type SolidPlasticPlan } from './solidPlastic.js';
import { readSolidPlasticNative, SOLID_PLASTIC_METHOD, SOLID_PLASTIC_RESULT_SCHEMA,
  SOLID_PLASTIC_SCOPE } from './solidPlasticResults.js';

/**
 * Benchmark constants stated for this test only, not a
 * material specification: E 200000 MPa, nu 0.3, sigma0 250 MPa, H 2000 MPa. Simple shear gamma_xy = load factor.
 */
const E = 200000;
const NU = 0.3;
const SIG0 = 250;
const H = 2000;
const G = E / (2 * (1 + NU));
function plan(): SolidPlasticPlan {
  return readSolidPlasticPlan({ schema: SOLID_PLASTIC_PLAN_SCHEMA, units: 'N-mm-MPa',
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [[0, 1, 2, 3]],
    material: { youngMPa: E, poisson: NU, yieldStressMPa: SIG0, hardeningModulusMPa: H,
      source: { kind: 'user-supplied', reference: 'Test benchmark constants, not a material specification' } },
    prescribedMm: [
      { node: 0, dof: 'x', valueMm: 0 }, { node: 0, dof: 'y', valueMm: 0 }, { node: 0, dof: 'z', valueMm: 0 },
      { node: 1, dof: 'x', valueMm: 0 }, { node: 1, dof: 'y', valueMm: 0.5 }, { node: 1, dof: 'z', valueMm: 0 },
      { node: 2, dof: 'x', valueMm: 0.5 }, { node: 2, dof: 'y', valueMm: 0 }, { node: 2, dof: 'z', valueMm: 0 },
      { node: 3, dof: 'x', valueMm: 0 }, { node: 3, dof: 'y', valueMm: 0 }],
    forcesN: [], loadFactor: [0, 1e-3, 3e-3, 0], stepsPerSegment: 1 });
}
/** Independent closed-form J2 pure shear with linear isotropic hardening, written from the yield law. */
function shearReference(gammas: readonly number[]) {
  let gp = 0;
  let kappa = 0;
  return gammas.map(gamma => {
    const trial = G * (gamma - gp);
    const f = Math.sqrt(3) * Math.abs(trial) - (SIG0 + H * kappa);
    let tau = trial;
    if (f > 0) {
      const dk = f / (3 * G + H);
      const sign = trial > 0 ? 1 : -1;
      gp += sign * Math.sqrt(3) * dk;
      kappa += dk;
      tau = trial - sign * Math.sqrt(3) * G * dk;
    }
    return { gamma, tau, gp };
  });
}
/** Protocol-shaped runner output built from the reference: a shape fixture, explicitly not a native oracle. */
function raw(): Record<string, unknown> {
  const p = plan();
  const states = shearReference(p.loadFactor.slice(1));
  return { schema: SOLID_PLASTIC_RESULT_SCHEMA, method: SOLID_PLASTIC_METHOD, scope: SOLID_PLASTIC_SCOPE,
    structuralCertification: false,
    records: states.map((s, index) => ({ step: index + 1, loadFactor: s.gamma,
      displacementMm: [[0, 0, 0], [0, 0.5 * s.gamma, 0], [0.5 * s.gamma, 0, 0], [0, 0, 0]],
      elements: [{ stressMPa: [0, 0, 0, 0, 0, s.tau], strain: [0, 0, 0, 0, 0, s.gamma], plasticStrain: [0, 0, 0, 0, 0, s.gp] }],
      freeResidualRatio: 0 })),
    yielded: true };
}
function withRecord(index: number, change: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const base = raw();
  const records = (base.records as readonly Record<string, unknown>[]).map(r => ({ ...r }));
  records[index] = { ...records[index], ...change };
  return { ...base, records };
}

describe('independent shear expectations (stated before any native run)', () => {
  it('distinguishes elastic, plastic and unloaded states with residual plastic shear', () => {
    const [elastic, plastic, unloaded] = shearReference([1e-3, 3e-3, 0]);
    expect(elastic.gp).toBe(0);
    expect(elastic.tau).toBeCloseTo(G * 1e-3, 9);
    // Consistency at the plastic state: sqrt(3) tau = sigma0 + H * gamma_p / sqrt(3).
    expect(Math.abs(Math.sqrt(3) * plastic.tau - (SIG0 + H * plastic.gp / Math.sqrt(3)))).toBeLessThan(1e-9);
    expect(plastic.gp).toBeGreaterThan(0);
    // Unloading to zero total shear is elastic and leaves the plastic shear and tau = -G gamma_p.
    expect(unloaded.gp).toBe(plastic.gp);
    expect(Math.abs(unloaded.tau + G * plastic.gp)).toBeLessThan(1e-9);
    expect(Math.sqrt(3) * Math.abs(unloaded.tau)).toBeLessThan(SIG0 + H * plastic.gp / Math.sqrt(3));
  });
});

describe('strict solid-plastic result reader', () => {
  it('accepts the protocol-shaped fixture and keeps the residual plastic shear', () => {
    const read = readSolidPlasticNative(raw(), plan());
    expect(read.records).toHaveLength(3);
    expect(read.yielded).toBe(true);
    expect(read.records[2].elements[0].plasticStrain[5]).toBeGreaterThan(0);
  });

  it('refuses every deviation instead of repairing it', () => {
    const base = raw();
    const cases: readonly (readonly [string, unknown, string])[] = [
      ['not an object', null, 'result must be an object'],
      ['extra field', { ...base, warnings: [] }, 'must have exactly the fields'],
      ['wrong schema', { ...base, schema: 'pointercad-oofem-solid-plastic-result/2' }, 'unsupported result schema'],
      ['wrong method', { ...base, method: 'local-return-mapping' }, 'unexpected method'],
      ['old current-only force normalization', { ...base, method: 'oofem-misesmat-htype0-ltrspace-staticstructural/1' }, 'unexpected method'],
      ['certification claim', { ...base, structuralCertification: true }, 'structuralCertification must be false'],
      ['missing record', { ...base, records: (base.records as unknown[]).slice(0, 2) }, 'records must have exactly 3 entries'],
      ['wrong step', withRecord(1, { step: 3 }), 'records[1].step must be 2'],
      ['wrong knot', withRecord(1, { loadFactor: 2e-3 }), 'loadFactor differs from the plan knot'],
      ['moved prescribed node', withRecord(0, { displacementMm: [[0, 0, 0], [0, 1, 0], [5e-4, 0, 0], [0, 0, 0]] }),
        'differs from the prescribed value'],
      ['NaN stress', withRecord(0, { elements: [{ stressMPa: [0, 0, 0, 0, 0, Number.NaN], strain: [0, 0, 0, 0, 0, 1e-3],
        plasticStrain: [0, 0, 0, 0, 0, 0] }] }), 'stressMPa[5] must be a finite number'],
      ['residual above bound', withRecord(2, { freeResidualRatio: 2e-8 }), 'freeResidualRatio exceeds 1e-8'],
      ['false yielded flag', { ...base, yielded: false }, 'yielded must state'],
      // candidate3: the decoded result is held to the declared small-strain scope independently of the runner.
      ['strain above scope', withRecord(0, { elements: [{ stressMPa: [0, 0, 0, 0, 0, 1], strain: [0.0500001, 0, 0, 0, 0, 1e-3],
        plasticStrain: [0, 0, 0, 0, 0, 0] }] }), 'strain exceeds 0.05 (small-strain scope)'],
    ];
    for (const [label, value, message] of cases) {
      expect(() => readSolidPlasticNative(value, plan()), label).toThrow(message);
    }
    expect(readSolidPlasticNative(withRecord(2, { freeResidualRatio: 0.5e-8 }), plan()).records[2].freeResidualRatio).toBe(0.5e-8);
  });
});

describe('production Python free-force normalization', () => {
  it('runs independent accepted-history, unloading and nonconvergence regressions on the actual wrapper', () => {
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL('./solidPlasticForceBalance.harness.mjs', import.meta.url))], { encoding: 'utf8', timeout: 10_000 });
    expect(output.trim()).toBe('solid-plastic-force-balance: 7 independent cases passed');
  });
});

describe('TS/Python contract parity (source text of the fixed runner)', () => {
  const source = readFileSync(new URL('./solidPlasticAnalysis.py', import.meta.url), 'utf8');
  it('uses the same schemas, method, scope and limits', () => {
    expect(source).toContain(`PLAN_SCHEMA = '${SOLID_PLASTIC_PLAN_SCHEMA}'`);
    expect(source).toContain(`RESULT_SCHEMA = '${SOLID_PLASTIC_RESULT_SCHEMA}'`);
    expect(source).toContain(`'${SOLID_PLASTIC_METHOD}'`);
    expect(source).toContain(`'${SOLID_PLASTIC_SCOPE}'`);
    const L = SOLID_PLASTIC_LIMITS;
    expect(source).toContain(`MAXIMUM_NODES, MAXIMUM_ELEMENTS, MAXIMUM_KNOTS = ${L.maximumNodes}, ${L.maximumElements}, ${L.maximumKnots}`);
    expect(source).toContain(`MAXIMUM_STEPS_PER_SEGMENT, MAXIMUM_STEPS, MAXIMUM_RECORDED_STATES = ${L.maximumStepsPerSegment}, `
      + `${L.maximumSteps}, ${L.maximumRecordedStates}`);
    expect(source).toContain(`MAXIMUM_STRAIN = ${L.maximumStrain}`);
  });
  it('emits exactly the record and element fields the reader requires', () => {
    for (const field of ["'step'", "'loadFactor'", "'displacementMm'", "'elements'", "'freeResidualRatio'",
      "'stressMPa'", "'strain'", "'plasticStrain'", "'structuralCertification': False"]) {
      expect(source, field).toContain(field);
    }
  });
});
