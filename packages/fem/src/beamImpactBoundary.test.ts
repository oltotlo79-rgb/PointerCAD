import { describe, expect, it } from 'vitest';
import { bucklingFixture } from './buckling.testSupport.js';
import type { BeamImpactInput } from './beamImpactModel.js';
import { decodeBeamImpact, impactOutputSteps } from './beamImpactResults.js';
import { translateBeamImpact } from './beamImpactTranslation.js';

// Root review r131 boundary regressions. Each case is a statically derived arithmetic or shape path that the frozen
// ts-r1 files accept; the successors must refuse the wrong value and keep the legitimate one.
const HASH = 'b'.repeat(64);

function impactFixture(segments = 2, timeStepS = 1e-5): BeamImpactInput {
  return {
    schema: 'pointercad-beam-impact/1', geometry: bucklingFixture({ segments }).geometry,
    supports: [{ nodeId: 'node-0', restrained: [true, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'node-1', velocityMPerS: [0.01, 0, 0] }],
    contacts: [{ nodeId: 'node-1', directionUnit: [1, 0, 0], gapM: 0.001 }],
    contactStiffnessNPerM: 1e7,
    history: { timeStepS, stepCount: 10, outputEvery: 5 },
  };
}

/** Self-consistent raw result shape (not a dynamics claim) with selectable energies. */
function rawResult(input: BeamImpactInput, energy = 0.5, initialEnergy = 0.5): Record<string, unknown> {
  const { plan } = translateBeamImpact(input);
  const steps = impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery);
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const h = plan.impact.timeStepS;
  return {
    schema: 'pointercad-oofem-impact-result/1',
    samples: steps.map(step => ({
      step, timeS: step === 0 ? 0 : h * step, energyJ: step === 0 ? initialEnergy : energy,
      nodes: original.map((node, index) => ({ number: node.number, displacementM: [0, 0, 0], rotationRad: [0, 0, 0],
        velocityMPerS: plan.impact.initialVelocity[index].slice(0, 3), angularVelocityRadPerS: [0, 0, 0] })),
      contacts: plan.impact.contacts.map(contact => ({ gapM: contact.gapM, intervalForceN: step === 0 ? null : 0,
        impulseNs: step === 0 ? null : 0 })),
    })),
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    initialEnergyJ: initialEnergy, maximumEnergyBalanceError: 0, maximumMomentumResidual: 0, factorizationsUsed: 10,
    contactPeaks: plan.impact.contacts.map(() => ({ intervalForceN: 0, timeS: h, totalImpulseNs: 0 })),
  };
}
const isRecord = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
function sample(raw: Record<string, unknown>, index: number): Record<string, unknown> {
  const rows = raw.samples;
  if (!Array.isArray(rows) || !isRecord(rows[index])) throw new Error('fixture');
  return rows[index];
}
function entry(value: unknown, index: number): Record<string, unknown> {
  if (!Array.isArray(value) || !isRecord(value[index])) throw new Error('fixture');
  return value[index];
}

describe('impact translation shape boundaries', () => {
  it('refuses a sparse velocity vector instead of skipping the hole', () => {
    const sparse = new Array<number>(3);
    sparse[0] = 0.01;
    sparse[2] = 0;
    expect(() => translateBeamImpact({ ...impactFixture(), initialVelocities: [{ nodeId: 'node-1', velocityMPerS: sparse }] }))
      .toThrow('impact-size');
  });

  it('refuses a sparse support mask instead of reading the hole as unrestrained', () => {
    const mask = new Array<boolean>(6);
    for (let axis = 0; axis < 5; axis += 1) mask[axis] = true;
    expect(() => translateBeamImpact({ ...impactFixture(), supports: [{ nodeId: 'node-0', restrained: mask }] }))
      .toThrow('impact-supports');
  });

  it('refuses a required field that is only inherited', () => {
    const history: unknown = Object.create({ timeStepS: 1e-5 });
    if (!isRecord(history)) throw new Error('fixture');
    history.stepCount = 10;
    history.outputEvery = 5;
    history.unexpected = 1;
    expect(() => translateBeamImpact({ ...impactFixture(), history })).toThrow('impact-shape');
  });

  it.each([1e306, 1e-200])('refuses h = %s whose step coefficients or total duration are not representable', timeStepS => {
    expect(() => translateBeamImpact(impactFixture(2, timeStepS))).toThrow('impact-step: time step coefficients or total duration');
  });

  it('interpolates opposite extreme endpoint velocities without forming an overflowing difference', () => {
    const input: BeamImpactInput = { ...impactFixture(2),
      supports: [{ nodeId: 'node-0', restrained: [false, true, true, true, true, true] }],
      initialVelocities: [{ nodeId: 'node-0', velocityMPerS: [-1e308, 0, 0] }, { nodeId: 'node-1', velocityMPerS: [1e308, 0, 0] }] };
    const { plan } = translateBeamImpact(input);
    expect(plan.impact.initialVelocity.every(row => row.every(Number.isFinite))).toBe(true);
    expect(plan.impact.initialVelocity[2][0]).toBe(0);
    expect(plan.impact.initialVelocity[0][0]).toBe(-1e308);
    expect(plan.impact.initialVelocity[1][0]).toBe(1e308);
  });
});

describe('impact decoder arithmetic boundaries', () => {
  it('rejects a 70 % energy error at large scale and accepts equal large energies', () => {
    const input = impactFixture();
    expect(() => decodeBeamImpact(rawResult(input, 1.7e308, 1e308), input, HASH)).toThrow('impact-result');
    expect(decodeBeamImpact(rawResult(input, 1.7e308, 1.7e308), input, HASH).initialEnergyJ).toBe(1.7e308);
  });

  it('rejects an infinite impulse even when it equals h * force in floating point', () => {
    const input = impactFixture(2, 10);
    const raw = rawResult(input);
    const contact = entry(sample(raw, 1).contacts, 0);
    contact.intervalForceN = 1e308;
    contact.impulseNs = Number.POSITIVE_INFINITY;
    expect(10 * 1e308).toBe(Number.POSITIVE_INFINITY);
    expect(() => decodeBeamImpact(raw, input, HASH)).toThrow('impact-result: invalid interval force or impulse');
  });

  it('rejects a forged gap when the plain dot product of a huge displacement overflows', () => {
    const input: BeamImpactInput = { ...impactFixture(), contacts: [{ nodeId: 'node-1', directionUnit: [0.6, 0.8, 0], gapM: 0.001 }] };
    const raw = rawResult(input);
    entry(sample(raw, 1).nodes, 1).displacementM = [1.7e308, 1.7e308, 0];
    entry(sample(raw, 1).contacts, 0).gapM = 0;
    expect(() => decodeBeamImpact(raw, input, HASH)).toThrow('impact-result: contact gap differs');
  });

  it('accepts the exact gap of a huge displacement computed without overflow', () => {
    const input = impactFixture();
    const raw = rawResult(input);
    entry(sample(raw, 1).nodes, 1).displacementM = [1e308, 0, 0];
    entry(sample(raw, 1).contacts, 0).gapM = 0.001 - 1e308;
    expect(decodeBeamImpact(raw, input, HASH).samples[1].contacts[0].gapM).toBe(0.001 - 1e308);
  });
});
