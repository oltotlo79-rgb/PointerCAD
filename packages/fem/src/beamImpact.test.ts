import { describe, expect, it } from 'vitest';
import { bucklingFixture } from './buckling.testSupport.js';
import { translateBeamBuckling } from './bucklingTranslation.js';
import { BEAM_IMPACT_SCOPE, type BeamImpactInput } from './beamImpactModel.js';
import { decodeBeamImpact, impactOutputSteps } from './beamImpactResults.js';
import { impactInputSha256, translateBeamImpact } from './beamImpactTranslation.js';

const HASH = 'a'.repeat(64);

/** Cantilever along x (node-0 clamped, node-1 free), unloaded unrestrained geometry from the buckling fixture. */
function impactFixture(segments = 2): BeamImpactInput {
  const geometry = bucklingFixture({ segments }).geometry;
  return {
    schema: 'pointercad-beam-impact/1', geometry,
    supports: [{ nodeId: 'node-0', restrained: [true, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'node-1', velocityMPerS: [0.01, 0, 0] }],
    contacts: [{ nodeId: 'node-1', directionUnit: [1, 0, 0], gapM: 0.001 }],
    contactStiffnessNPerM: 1e7,
    history: { timeStepS: 1e-5, stepCount: 10, outputEvery: 5 },
  };
}

/** A self-consistent raw result shape (not a dynamics claim): rest displacement, constant velocity and energy. */
function rawResult(input: BeamImpactInput): Record<string, unknown> {
  const { plan } = translateBeamImpact(input);
  const steps = impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery);
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const h = plan.impact.timeStepS;
  return {
    schema: 'pointercad-oofem-impact-result/1',
    samples: steps.map(step => ({
      step, timeS: step === 0 ? 0 : h * step, energyJ: 0.5,
      nodes: original.map((node, index) => ({ number: node.number, displacementM: [0, 0, 0], rotationRad: [0, 0, 0],
        velocityMPerS: plan.impact.initialVelocity[index].slice(0, 3), angularVelocityRadPerS: [0, 0, 0] })),
      contacts: plan.impact.contacts.map(contact => ({ gapM: contact.gapM, intervalForceN: step === 0 ? null : 0,
        impulseNs: step === 0 ? null : h * 0 })),
    })),
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    initialEnergyJ: 0.5, maximumEnergyBalanceError: 0, maximumMomentumResidual: 0, factorizationsUsed: 10,
    contactPeaks: plan.impact.contacts.map(() => ({ intervalForceN: 0, timeS: h, totalImpulseNs: 0 })),
  };
}

describe('beam impact translation (elastic frictionless normal fixed-plane contact, zero external load)', () => {
  it('builds a zero-load plan with explicit supports, contacts at original nodes and no load field', () => {
    const { input, plan } = translateBeamImpact(impactFixture());
    expect(plan.schema).toBe('pointercad-oofem-impact-plan/1');
    expect(plan.nodes.every(node => !('load' in node))).toBe(true);
    expect(plan.nodes[0].restrained).toEqual([true, true, true, true, true, true]);
    expect(plan.nodes.slice(1).every(node => node.restrained.every(value => !value))).toBe(true);
    expect(plan.impact.contacts).toEqual([{ node: 2, directionUnit: [1, 0, 0], gapM: 0.001 }]);
    expect(plan.impact.contactStiffnessNPerM).toBe(1e7);
    expect(input.schema).toBe('pointercad-beam-impact/1');
    expect(BEAM_IMPACT_SCOPE).toBe('elastic-frictionless-normal-fixed-plane');
  });

  it('interpolates initial translations linearly to interior refinement nodes and starts rotations at rest', () => {
    const { plan } = translateBeamImpact(impactFixture(4));
    expect(plan.originalNodeCount).toBe(2);
    expect(plan.nodes.length).toBe(5);
    const velocity = new Map(plan.nodes.map((node, index) => [node.number, plan.impact.initialVelocity[index]]));
    expect(velocity.get(1)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(velocity.get(2)).toEqual([0.01, 0, 0, 0, 0, 0]);
    for (const node of plan.nodes.slice(2)) {
      const fraction = node.positionM[0] / plan.nodes[1].positionM[0];
      const row = velocity.get(node.number);
      if (row === undefined || typeof row[0] !== 'number') throw new Error('initial velocity fixture row');
      expect(Math.abs(row[0] - 0.01 * fraction)).toBeLessThanOrEqual(1e-18);
      expect(row.slice(1)).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('leaves the modal-based buckling translation and its zero-load refusal unchanged (no dummy load)', () => {
    const buckling = bucklingFixture({ segments: 2 });
    const before = JSON.stringify(translateBeamBuckling(buckling).plan);
    translateBeamImpact(impactFixture());
    expect(JSON.stringify(translateBeamBuckling(buckling).plan)).toBe(before);
    const unloaded = { ...buckling, referenceLoads: [] };
    expect(() => translateBeamBuckling(unloaded)).toThrow('buckling-load: zero reference load');
  });

  it.each([
    ['impact-load', (input: BeamImpactInput) => ({ ...input, geometry: { ...input.geometry,
      loads: [{ id: 'l', kind: 'nodal', nodeId: 'node-1', force: [1, 0, 0], moment: [0, 0, 0] }] } })],
    ['impact-velocity: a restrained', (input: BeamImpactInput) => ({ ...input,
      initialVelocities: [{ nodeId: 'node-0', velocityMPerS: [1, 0, 0] }] })],
    ['impact-velocity: every initial velocity is zero', (input: BeamImpactInput) => ({ ...input,
      initialVelocities: [{ nodeId: 'node-1', velocityMPerS: [0, 0, 0] }] })],
    ['impact-velocity: duplicate', (input: BeamImpactInput) => ({ ...input,
      initialVelocities: [...input.initialVelocities, ...input.initialVelocities] })],
    ['impact-velocity: unknown', (input: BeamImpactInput) => ({ ...input,
      initialVelocities: [{ nodeId: 'nowhere', velocityMPerS: [1, 0, 0] }] })],
    ['impact-number', (input: BeamImpactInput) => ({ ...input,
      initialVelocities: [{ nodeId: 'node-1', velocityMPerS: [Number.NaN, 0, 0] }] })],
    ['impact-contact: direction must be a unit vector', (input: BeamImpactInput) => ({ ...input,
      contacts: [{ nodeId: 'node-1', directionUnit: [2, 0, 0], gapM: 0 }] })],
    ['impact-contact: the initial gap must be nonnegative', (input: BeamImpactInput) => ({ ...input,
      contacts: [{ nodeId: 'node-1', directionUnit: [1, 0, 0], gapM: -1e-9 }] })],
    ['impact-contact: the contact direction is fully restrained', (input: BeamImpactInput) => ({ ...input,
      contacts: [{ nodeId: 'node-0', directionUnit: [1, 0, 0], gapM: 0 }] })],
    ['impact-size: contacts', (input: BeamImpactInput) => ({ ...input, contacts: [] })],
    ['impact-stiffness', (input: BeamImpactInput) => ({ ...input, contactStiffnessNPerM: 0 })],
    ['impact-step', (input: BeamImpactInput) => ({ ...input, history: { timeStepS: 1e-5, stepCount: 4001, outputEvery: 100 } })],
    ['impact-step: at most 101 output samples', (input: BeamImpactInput) => ({ ...input,
      history: { timeStepS: 1e-5, stepCount: 4000, outputEvery: 1 } })],
    ['impact-step', (input: BeamImpactInput) => ({ ...input, history: { timeStepS: 1e-5, stepCount: 10.5, outputEvery: 1 } })],
    ['impact-shape', (input: BeamImpactInput) => ({ ...input, extra: true })],
    ['impact-schema', (input: BeamImpactInput) => ({ ...input, schema: 'pointercad-beam-transient/1' })],
    ['impact-supports', (input: BeamImpactInput) => ({ ...input,
      supports: [{ nodeId: 'node-0', restrained: [false, false, false, false, false, false] }] })],
  ] as const)('refuses %s', (message, change) => {
    expect(() => translateBeamImpact(change(impactFixture()))).toThrow(message);
  });

  it('hashes the translated input deterministically', async () => {
    expect(await impactInputSha256(impactFixture())).toBe(await impactInputSha256(impactFixture()));
    expect(await impactInputSha256(impactFixture())).not.toBe(await impactInputSha256({ ...impactFixture(), contactStiffnessNPerM: 2e7 }));
  });
});

describe('beam impact result decoder', () => {
  it('decodes a self-consistent result with the documented scope and identity', () => {
    const input = impactFixture();
    const result = decodeBeamImpact(rawResult(input), input, HASH);
    expect(result.kind).toBe('oofem-beam-impact-3d');
    expect(result.scope).toBe(BEAM_IMPACT_SCOPE);
    expect(result.nativeImpactSolver).toBe(false);
    expect(result.structuralCertification).toBe(false);
    expect(result.samples.map(sample => sample.step)).toEqual([0, 5, 10]);
    expect(result.samples[0].contacts[0]).toEqual({ nodeId: 'node-1', gapM: 0.001, intervalForceN: null, impulseNs: null });
    expect(result.samples[2].nodes.map(node => node.nodeId)).toEqual(['node-0', 'node-1']);
  });

  const mutate = (change: (raw: Record<string, unknown>) => void): Record<string, unknown> => {
    const raw = structuredClone(rawResult(impactFixture()));
    change(raw);
    return raw;
  };
  const samples = (raw: Record<string, unknown>): Record<string, unknown>[] => {
    const value = raw.samples;
    if (!Array.isArray(value)) throw new Error('fixture');
    return value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object');
  };
  const first = <T>(value: unknown, guard: (item: unknown) => item is T): T => {
    if (!Array.isArray(value) || !guard(value[0])) throw new Error('fixture');
    return value[0];
  };
  const isRecord = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);

  it.each([
    ['energy drift above 1e-8', (raw: Record<string, unknown>) => { samples(raw)[2].energyJ = 0.5 * (1 + 3e-8); }],
    ['impulse differs from h * force', (raw: Record<string, unknown>) => { first(samples(raw)[1].contacts, isRecord).impulseNs = 1e-12; }],
    ['gap inconsistent with displacement', (raw: Record<string, unknown>) => { first(samples(raw)[1].contacts, isRecord).gapM = 0.002; }],
    ['nonzero response on a clamp', (raw: Record<string, unknown>) => { first(samples(raw)[1].nodes, isRecord).displacementM = [1e-9, 0, 0]; }],
    ['initial velocity differs from the input', (raw: Record<string, unknown>) => {
      const nodes = samples(raw)[0].nodes;
      if (Array.isArray(nodes) && isRecord(nodes[1])) nodes[1].velocityMPerS = [0.02, 0, 0];
    }],
    ['off-grid sample time', (raw: Record<string, unknown>) => { samples(raw)[1].timeS = 5.000001e-5; }],
    ['balance above 1e-8', (raw: Record<string, unknown>) => { raw.maximumMomentumResidual = 2e-8; }],
    ['extra result field', (raw: Record<string, unknown>) => { raw.extra = 1; }],
    ['negative force', (raw: Record<string, unknown>) => {
      const contact = first(samples(raw)[1].contacts, isRecord);
      contact.intervalForceN = -1; contact.impulseNs = -1e-5;
    }],
    ['peak below a sample', (raw: Record<string, unknown>) => {
      const contact = first(samples(raw)[1].contacts, isRecord);
      contact.intervalForceN = 2; contact.impulseNs = 1e-5 * 2;
    }],
  ] as const)('rejects %s', (_name, change) => {
    const input = impactFixture();
    expect(() => decodeBeamImpact(mutate(change), input, HASH)).toThrow('impact-result');
  });

  it('rejects a malformed input digest', () => {
    const input = impactFixture();
    expect(() => decodeBeamImpact(rawResult(input), input, 'not-a-hash')).toThrow('impact-result');
  });
});
