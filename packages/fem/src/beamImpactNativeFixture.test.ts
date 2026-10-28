import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BeamImpactInput } from './beamImpactModel.js';
import { beamImpactResultMatches } from './beamImpactBinding.js';
import { decodeBeamImpact } from './beamImpactResults.js';
import { impactInputSha256, translateBeamImpact } from './beamImpactTranslation.js';

// Exact bytes exported by the pinned deployed Pyodide/OOFEM run, not a synthetic rawResult helper.
const fixtureBytes = readFileSync(new URL('./fixtures/beamImpactNativeFixture.json', import.meta.url));
const parsedFixture: unknown = JSON.parse(fixtureBytes.toString('utf8'));
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('native fixture record');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('native fixture array');
  return value;
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('native fixture number');
  return value;
}
const fixture = record(parsedFixture);
interface NativeCase { readonly label: string; readonly plan: Record<string, unknown>; readonly raw: Record<string, unknown> }
const nativeCases: NativeCase[] = [
  { label: 'original native axial', plan: record(fixture.plan), raw: record(fixture.result) },
  ...array(fixture.refinements).map(value => {
    const row = record(value);
    return { label: `native step divided by ${numeric(row.divisor)}`, plan: record(row.plan), raw: record(row.result) };
  }),
  { label: 'native no contact', plan: record(record(fixture.noContact).plan), raw: record(record(fixture.noContact).result) },
];
const YOUNG = 210e9;
const SHEAR = YOUNG / 2.6;
// u is binary64 unit roundoff. Literal 2.6, forming G=E/2.6 and E/(2G) give at most gamma(3)
// relative error at 1+nu. Multiplication by2 is exact and subtraction1 is exact by Sterbenz (ratio near1.3).
// The independent physical literal0.3 contributes at most0.3u. This bound is not fitted to observed output.
const UNIT_ROUNDOFF = Number.EPSILON / 2;
const GAMMA_THREE = 3 * UNIT_ROUNDOFF / (1 - 3 * UNIT_ROUNDOFF);
const POISSON_ROUNDOFF_BOUND = 1.3 * GAMMA_THREE + 0.3 * UNIT_ROUNDOFF;
const materialEvidence = { kind: 'user-supplied', reference: 'Pinned native one-element axial benchmark',
  condition: 'Explicit isotropic elastic constants; no capacity or general impact claim' } as const;

/** Independent legitimate geometry, not the ordinary modal fixture's different area and inertias.
 * Sorted native-1/native-2 ids correspond exactly to native node numbers 1/2. */
function inputFor(plan: Record<string, unknown>): BeamImpactInput {
  const impact = record(plan.impact);
  const contact = record(array(impact.contacts)[0]);
  return {
    schema: 'pointercad-beam-impact/1',
    geometry: {
      schema: 'pointercad-beam/2', id: 'native-axial-impact', revision: 1,
      source: { documentId: 'native-axial-benchmark', documentRevision: 1, geometryRevision: 'explicit-one-metre-member' },
      units: 'N-m', modal: { modeCount: 1, segmentsPerMember: 1 },
      nodes: [{ id: 'native-1', position: [0, 0, 0] }, { id: 'native-2', position: [1, 0, 0] }],
      members: [{ id: 'native-member', componentId: 'native-component', occurrencePath: ['native-component'],
        startNodeId: 'native-1', endNodeId: 'native-2', materialId: 'steel', sectionId: 'explicit-section', localYHint: [0, 1, 0] }],
      materials: [{ id: 'steel', youngModulus: YOUNG, shearModulus: SHEAR, densityKgM3: 7850, source: materialEvidence }],
      sections: [{ id: 'explicit-section', area: 1e-4, iy: 1e-9, iz: 1e-9, torsionConstant: 2e-9,
        shearFactor: 0.8333333333333334, source: materialEvidence }],
      constraints: [], loads: [],
    },
    supports: [{ nodeId: 'native-1', restrained: [true, true, true, true, true, true] },
      { nodeId: 'native-2', restrained: [false, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'native-2', velocityMPerS: [0.01, 0, 0] }],
    contacts: [{ nodeId: 'native-2', directionUnit: [1, 0, 0], gapM: numeric(contact.gapM) }],
    contactStiffnessNPerM: 21e6,
    history: { timeStepS: numeric(impact.timeStepS), stepCount: numeric(impact.stepCount), outputEvery: numeric(impact.outputEvery) },
  };
}

describe('actual deployed native impact output at the TypeScript boundary', () => {
  it('retains the exact actual native fixture and program/runtime provenance', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex'))
      .toBe('1274f2e9ea76294e6e5516b969e6c95ee9f75323be92c250268119ae39b9acc7');
    expect(fixture.schema).toBe('pcad-native-impact-fixture/1');
    expect(nativeCases.map(row => row.label)).toEqual([
      'original native axial', 'native step divided by 2', 'native step divided by 4', 'native no contact',
    ]);
    expect(fixture.provenance).toEqual({
      runtimeManifestSha256: '2ea752fc302fd73778e1d7397d733ca5e8a54b18b1755f1ebe29d40d7c343fea',
      pyodideVersion: '0.29.3', numpyVersion: '2.2.5', oofemVersion: '3.1.dev5+g214b161ed',
      programSha256: {
        analysis: 'fb018e816acb212e8b1b0caf510b5a644d22d87bc1c18643f13688b7accfc0af',
        impact: '5ba11f6ed1205ce347fccf524bf1d07f30fb3ba04c9123d77613ac920fd1d302',
        test: '0f9ff4a72fab41e39e65cd07aeef650e78e6906de5bc11da65a8df19009ab014',
        extension: 'a4bcabc979a61ad44e51fce2e059cdd834eb4283911871626dc99e7ed632a1e3',
      },
    });
  });

  it.each(nativeCases)('maps the entire physical plan for $label with only explicit ID metadata removed', row => {
    const { plan } = translateBeamImpact(inputFor(row.plan));
    const nativeMaterial = record(array(row.plan.materials)[0]);
    const derivedPoisson = YOUNG / (2 * SHEAR) - 1;
    expect(plan.materials[0].poisson).toBe(derivedPoisson);
    expect(nativeMaterial.poisson).toBe(0.3);
    // Every other physical plan field stays exact; only this independently bounded derived value may differ.
    expect(Math.abs(derivedPoisson - numeric(nativeMaterial.poisson))).toBeLessThanOrEqual(POISSON_ROUNDOFF_BOUND);
    expect({
      schema: plan.schema, normalizationLengthM: plan.normalizationLengthM, originalNodeCount: plan.originalNodeCount,
      nodes: plan.nodes.map(({ number, positionM, restrained }) => ({ number, positionM, restrained })),
      materials: plan.materials, sections: plan.sections,
      members: plan.members.map(({ number, nodes, material, section, frame }) => ({ number, nodes, material, section, frame })),
      impact: plan.impact,
    }).toEqual({ ...row.plan, materials: [{ ...nativeMaterial, poisson: derivedPoisson }] });
  });

  it.each(nativeCases)('decodes and input-binds the actual $label response without manufacturing numbers', async row => {
    const input = inputFor(row.plan);
    const hash = await impactInputSha256(input);
    const result = decodeBeamImpact(row.raw, input, hash);
    expect(beamImpactResultMatches(result, input, hash)).toBe(true);
    expect(result.inputSha256).toBe(hash);
    expect(result.freeDofs).toBe(1);
    expect(result.meshNodes).toBe(2);
    expect(result.meshElements).toBe(1);
    expect(result.samples.map(sample => sample.step)).toEqual(array(row.raw.samples).map(sample => record(sample).step));
    expect(result.samples.map(sample => sample.energyJ)).toEqual(array(row.raw.samples).map(sample => record(sample).energyJ));
    expect(result.samples.map(sample => sample.nodes.map(node => node.displacementM)))
      .toEqual(array(row.raw.samples).map(sample => array(record(sample).nodes).map(node => record(node).displacementM)));
    expect(result.contactPeaks.map(peak => peak.totalImpulseNs))
      .toEqual(array(row.raw.contactPeaks).map(peak => record(peak).totalImpulseNs));
    expect(result.nativeImpactSolver).toBe(false);
    expect(result.structuralCertification).toBe(false);
  });

  it('rejects a finite forged energy using conservation rather than merely a finite-number check', () => {
    const row = nativeCases[0];
    const input = inputFor(row.plan);
    const raw = structuredClone(row.raw);
    const sample = record(array(raw.samples)[1]);
    sample.energyJ = numeric(sample.energyJ) * 1.7;
    expect(Number.isFinite(sample.energyJ)).toBe(true);
    expect(() => decodeBeamImpact(raw, input, 'a'.repeat(64))).toThrow('invalid sample step, time, energy or counts');
  });

  it('rejects a valid-shaped foreign digest and physically different geometry for the real response', async () => {
    const row = nativeCases[0];
    const input = inputFor(row.plan);
    const hash = await impactInputSha256(input);
    const result = decodeBeamImpact(row.raw, input, hash);
    const foreignHash = hash === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    expect(beamImpactResultMatches({ ...result, inputSha256: foreignHash }, input, hash)).toBe(false);
    const foreign: BeamImpactInput = { ...input, geometry: { ...input.geometry,
      nodes: [input.geometry.nodes[0], { ...input.geometry.nodes[1], position: [2, 0, 0] }] } };
    expect(() => decodeBeamImpact(row.raw, foreign, hash)).toThrow('invalid metadata, balances or sample count');
    expect(beamImpactResultMatches(result, foreign, hash)).toBe(false);
  });

  it('keeps decimated native impulses bound to the adjacent integrator step, not the saved-sample spacing', () => {
    const row = nativeCases[2];
    const input = inputFor(row.plan);
    expect(input.history.outputEvery).toBe(4);
    const raw = structuredClone(row.raw);
    const sample = record(array(raw.samples)[1]);
    const contact = record(array(sample.contacts)[0]);
    const force = numeric(contact.intervalForceN);
    expect(force).toBeGreaterThan(0);
    expect(contact.impulseNs).toBe(input.history.timeStepS * force);
    contact.impulseNs = input.history.timeStepS * input.history.outputEvery * force;
    expect(() => decodeBeamImpact(raw, input, 'a'.repeat(64))).toThrow('invalid interval force or impulse');
  });
});

/* Independent beam-formula benchmark of the ACTUAL native Beam3d K and M (task020, I1). An oblique two-metre cantilever
 * with unequal Iy/Iz, translated by translateBeamImpact, is run in a separate Node process (pinned Pyodide, NumPy and
 * OOFEM wheel) through the exact runPython source of beamImpactRuntime.ts; the matrices of the same native extraction
 * are then checked against closed-form cantilever compliance, rigid-body kinetic energies and the Euler-Bernoulli first
 * frequency in beamImpactNativeMatrices.test.py. The input numbers below are the only source of the expectations. */
const benchEvidence = { kind: 'user-supplied', reference: 'Explicit oblique cantilever benchmark constants',
  condition: 'Isotropic elastic constants for a beam-formula check; no capacity or general impact claim' } as const;
const BENCH = { youngPa: 210e9, shearPa: 80e9, densityKgM3: 7850, areaM2: 6e-4, iyM4: 2e-8, izM4: 8e-8, torsionM4: 3e-8,
  shearFactor: 5 / 6, startM: [0, 0, 0], endM: [1.2, 1.6, 0], localYHint: [-0.48, 0.36, 0.8],
  tipVelocityMPerS: [-0.0048, 0.0036, 0.008] } as const;
function obliqueInput(segmentsPerMember: number): BeamImpactInput {
  return {
    schema: 'pointercad-beam-impact/1',
    geometry: {
      schema: 'pointercad-beam/2', id: 'native-oblique-impact', revision: 1,
      source: { documentId: 'native-oblique-benchmark', documentRevision: 1, geometryRevision: 'explicit-two-metre-member' },
      units: 'N-m', modal: { modeCount: 1, segmentsPerMember },
      nodes: [{ id: 'oblique-1', position: [...BENCH.startM] }, { id: 'oblique-2', position: [...BENCH.endM] }],
      members: [{ id: 'oblique-member', componentId: 'oblique-component', occurrencePath: ['oblique-component'],
        startNodeId: 'oblique-1', endNodeId: 'oblique-2', materialId: 'steel', sectionId: 'unequal-section',
        localYHint: [...BENCH.localYHint] }],
      materials: [{ id: 'steel', youngModulus: BENCH.youngPa, shearModulus: BENCH.shearPa, densityKgM3: BENCH.densityKgM3,
        source: benchEvidence }],
      sections: [{ id: 'unequal-section', area: BENCH.areaM2, iy: BENCH.iyM4, iz: BENCH.izM4, torsionConstant: BENCH.torsionM4,
        shearFactor: BENCH.shearFactor, source: benchEvidence }],
      constraints: [], loads: [],
    },
    supports: [{ nodeId: 'oblique-1', restrained: [true, true, true, true, true, true] }],
    // 0.01 m/s along the local y axis (the hint): bending in the local x-y plane only.
    initialVelocities: [{ nodeId: 'oblique-2', velocityMPerS: [...BENCH.tipVelocityMPerS] }],
    // A plane facing local z = x cross y, 1 mm away: the in-plane motion never reaches it.
    contacts: [{ nodeId: 'oblique-2', directionUnit: [0.64, -0.48, 0.6], gapM: 1e-3 }],
    contactStiffnessNPerM: 21e6,
    history: { timeStepS: 1.5e-4, stepCount: 400, outputEvery: 4 },
  };
}

describe('actual native Beam3d K and M against beam formulas (oblique cantilever, separate pinned runtime)', () => {
  it('runs the exact impact runtime source and the independent compliance, mass and frequency benchmark', async () => {
    const one = translateBeamImpact(obliqueInput(1));
    const eight = translateBeamImpact(obliqueInput(8));
    const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('./beamImpactNativeMatrices.harness.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 55_000, maxBuffer: 16 * 1024 * 1024,
      input: JSON.stringify({ plans: { one: one.plan, eight: eight.plan }, constants: BENCH }),
    });
    const reply = record(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
    expect(reply.report).toEqual(['beam-impact-native-matrices: 36 independent checks passed']);
    const hash = await impactInputSha256(one.input);
    const result = decodeBeamImpact(reply.raw, one.input, hash);
    expect(beamImpactResultMatches(result, one.input, hash)).toBe(true);
    expect([result.freeDofs, result.meshNodes, result.meshElements]).toEqual([6, 2, 1]);
    // Bounding-box diagonal of (0,0,0)-(1.2,1.6,0): 2 m up to the rounding of the decimal coordinates.
    expect(Math.abs(result.normalizationLengthM - 2)).toBeLessThanOrEqual(4 * Number.EPSILON);
    const tip = result.samples[0]?.nodes.find(node => node.nodeId === 'oblique-2');
    // The translated and decoded initial state: the input velocity in m/s on the global axes, zero displacement.
    expect(tip?.velocityMPerS).toEqual([...BENCH.tipVelocityMPerS]);
    expect(tip?.displacementM).toEqual([0, 0, 0]);
    expect(result.contactPeaks.map(peak => peak.totalImpulseNs)).toEqual([0]);
    for (const sample of result.samples) expect(Math.abs((sample.contacts[0]?.gapM ?? Number.NaN) - 1e-3)).toBeLessThanOrEqual(1e-12);
  });
});

describe('current native nonzero axial contact (independent midpoint oracle)', () => {
  it('requires positive force and impulse from current runtime, and rejects altered balances', async () => {
    // 旧fixtureから採るのはplanの物理入力だけ。旧raw結果を期待値に使用しない。
    const input = inputFor(record(fixture.plan));
    const prepared = translateBeamImpact(input);
    const stdout = execFileSync(process.execPath,
      [fileURLToPath(new URL('./beamImpactNativeAxial.harness.mjs', import.meta.url))], {
        encoding: 'utf8', timeout: 55_000, maxBuffer: 16 * 1024 * 1024,
        input: JSON.stringify(prepared.plan),
      });
    const reply = record(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
    const hash = await impactInputSha256(prepared.input);
    const result = decodeBeamImpact(reply.raw, prepared.input, hash);
    const peak = result.contactPeaks[0];
    expect(peak.intervalForceN).toBeGreaterThan(0);
    expect(peak.totalImpulseNs).toBeGreaterThan(0);

    // E/rho/A/L/v0/kcだけから、接触中の1自由度midpoint閉形式を導く。
    const mass = 7850 * 1e-4 / 3, stiffness = 210e9 * 1e-4, contactStiffness = 21e6;
    const speed = 0.01, h = input.history.timeStepS;
    const omega = Math.sqrt((stiffness + contactStiffness) / mass);
    const theta = 2 * Math.atan(omega * h / 2), scaleU = speed / omega;
    const energy = mass * speed * speed / 2;
    const near = (actual: number, expected: number, tolerance: number, scale: number): void => {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(Math.abs(expected), scale));
    };
    expect(input.contacts[0].gapM).toBe(0);
    expect(input.history.stepCount).toBe(30);
    expect(input.history.outputEvery).toBe(1);
    expect(result.samples).toHaveLength(31);
    let expectedImpulse = 0, expectedPeak = 0, expectedPeakStep = 0;
    for (const sample of result.samples) {
      const n = sample.step, u = scaleU * Math.sin(n * theta), v = speed * Math.cos(n * theta);
      expect(u).toBeGreaterThanOrEqual(0);
      const tip = sample.nodes.find(node => node.nodeId === 'native-2');
      if (tip === undefined) throw new Error('Current native axial tip is missing');
      near(tip.displacementM[0], u, 1e-9, scaleU);
      near(tip.velocityMPerS[0], v, 1e-9, speed);
      near(sample.energyJ, energy, 1e-10, energy);
      near(sample.contacts[0].gapM, -u, 1e-9, scaleU);
      near(mass * tip.velocityMPerS[0] ** 2 / 2
        + (stiffness + contactStiffness) * tip.displacementM[0] ** 2 / 2, energy, 1e-10, energy);
      if (n === 0) continue;
      const prior = scaleU * Math.sin((n - 1) * theta);
      const force = contactStiffness * (prior + u) / 2;
      const contact = sample.contacts[0];
      if (contact.intervalForceN === null || contact.impulseNs === null) throw new Error('Current interval force is missing');
      near(contact.intervalForceN, force, 1e-9, contactStiffness * scaleU);
      near(contact.impulseNs, h * force, 1e-9, h * contactStiffness * scaleU);
      const priorTip = result.samples[n - 1].nodes.find(node => node.nodeId === 'native-2');
      if (priorTip === undefined) throw new Error('Prior native axial tip is missing');
      const terms = [mass * (tip.velocityMPerS[0] - priorTip.velocityMPerS[0]) / h,
        stiffness * (tip.displacementM[0] + priorTip.displacementM[0]) / 2, contact.intervalForceN];
      expect(Math.abs(terms.reduce((sum, value) => sum + value, 0)))
        .toBeLessThanOrEqual(1e-8 * terms.reduce((sum, value) => sum + Math.abs(value), 0));
      expectedImpulse += h * force;
      if (force > expectedPeak) { expectedPeak = force; expectedPeakStep = n; }
    }
    near(peak.intervalForceN, expectedPeak, 1e-9, expectedPeak);
    near(peak.totalImpulseNs, expectedImpulse, 1e-9, expectedImpulse);
    expect(peak.timeS).toBe(expectedPeakStep * h);
    const badEnergy = structuredClone(record(reply.raw));
    record(array(badEnergy.samples)[2]).energyJ = energy * (1 + 3e-8);
    expect(() => decodeBeamImpact(badEnergy, input, hash)).toThrow();
    const badMomentum = structuredClone(record(reply.raw));
    badMomentum.maximumMomentumResidual = 2e-8;
    expect(() => decodeBeamImpact(badMomentum, input, hash)).toThrow();
  });
});
