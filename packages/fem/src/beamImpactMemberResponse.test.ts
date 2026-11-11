import { describe, expect, it } from 'vitest';
import type { Vector3 } from './analysisModel.js';
import { IMPACT_MEMBER_UNASSESSED, impactMemberResponse, impactMemberResponseMatches } from './beamImpactMemberResponse.js';
import type { BeamImpactInput, BeamImpactResult } from './beamImpactModel.js';
import { decodeBeamImpact, impactOutputSteps } from './beamImpactResults.js';
import { impactInputSha256, translateBeamImpact } from './beamImpactTranslation.js';

// Hand-chosen constants: L = 2 m, E = 200 GPa, G = 80 GPa (nu 0.25), A = 2e-4 m2, Iy = 3e-9 m4, Iz = 5e-9 m4, J = 4e-9 m4.
const E = 200e9, G = 80e9, A = 2e-4, IY = 3e-9, IZ = 5e-9, J = 4e-9, L = 2;
const evidence = { kind: 'user-supplied', reference: 'Hand-derived member-mean resultant cases',
  condition: 'Explicit isotropic elastic constants; no capacity claim' } as const;

function input(options: { segments?: number; hint?: Vector3; millimetres?: boolean; gapM?: number } = {}): BeamImpactInput {
  const unit = options.millimetres ? 1000 : 1;
  return {
    schema: 'pointercad-beam-impact/1',
    geometry: {
      schema: 'pointercad-beam/2', id: 'member-mean-cases', revision: 3,
      source: { documentId: 'member-mean', documentRevision: 1, geometryRevision: 'two-metre-member' },
      units: options.millimetres ? 'N-mm' : 'N-m', modal: { modeCount: 1, segmentsPerMember: options.segments ?? 1 },
      nodes: [{ id: 'a', position: [0, 0, 0] }, { id: 'b', position: [L * unit, 0, 0] }],
      members: [{ id: 'm', componentId: 'c', occurrencePath: ['c'], startNodeId: 'a', endNodeId: 'b',
        materialId: 'steel', sectionId: 'section', localYHint: options.hint ?? [0, 1, 0] }],
      materials: [{ id: 'steel', youngModulus: E / unit ** 2, shearModulus: G / unit ** 2, densityKgM3: 7850, source: evidence }],
      sections: [{ id: 'section', area: A * unit ** 2, iy: IY * unit ** 4, iz: IZ * unit ** 4, torsionConstant: J * unit ** 4,
        shearFactor: 0.8333333333333334, source: evidence }],
      constraints: [], loads: [],
    },
    supports: [{ nodeId: 'a', restrained: [true, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'b', velocityMPerS: [0.01, 0, 0] }],
    contacts: [{ nodeId: 'b', directionUnit: [1, 0, 0], gapM: options.gapM ?? 1 }],
    contactStiffnessNPerM: 1e7,
    history: { timeStepS: 1e-5, stepCount: 4, outputEvery: 1 },
  };
}
interface EndState { readonly u: Vector3; readonly theta: Vector3 }
const rest: EndState = { u: [0, 0, 0], theta: [0, 0, 0] };

/** Protocol-only reply with prescribed tip responses (not a numerical oracle of the solver). The strict decoder still
 * checks rest at t = 0, supports, gaps from displacements, energy and peaks. */
async function decoded(source: BeamImpactInput, tip: (step: number) => EndState): Promise<BeamImpactResult> {
  const { plan } = translateBeamImpact(source);
  const h = plan.impact.timeStepS;
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  return decodeBeamImpact({
    schema: 'pointercad-oofem-impact-result/1',
    samples: impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery).map(step => {
      const state = step === 0 ? rest : tip(step);
      return { step, timeS: step === 0 ? 0 : h * step, energyJ: 0.5,
        nodes: original.map((node, index) => ({ number: node.number,
          displacementM: node.id === 'b' ? state.u : [0, 0, 0], rotationRad: node.id === 'b' ? state.theta : [0, 0, 0],
          velocityMPerS: step === 0 ? plan.impact.initialVelocity[index].slice(0, 3) : [0, 0, 0],
          angularVelocityRadPerS: [0, 0, 0] })),
        contacts: plan.impact.contacts.map(contact => ({ gapM: contact.gapM - state.u[0],
          intervalForceN: step === 0 ? null : 0, impulseNs: step === 0 ? null : 0 })) };
    }),
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    initialEnergyJ: 0.5, maximumEnergyBalanceError: 0, maximumMomentumResidual: 0, factorizationsUsed: 4,
    contactPeaks: plan.impact.contacts.map(() => ({ intervalForceN: 0, timeS: h, totalImpulseNs: 0 })),
  }, source, await impactInputSha256(source));
}
function near(actual: number, expected: number, relative = 1e-12): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(relative * Math.max(Math.abs(expected), 1e-30));
}
const zero = (value: number): void => expect(Math.abs(value)).toBe(0);
/** The same tip state at every step after rest; step 0 is rest by the decoder contract. */
const constant = (state: EndState) => (): EndState => state;

describe('member-mean section resultants of the impact response (hand-derived beam solutions)', () => {
  it('axial: tip extension 1e-4 m on L = 2 m gives strain 5e-5, stress 10 MPa and force 2000 N, tension positive', async () => {
    const source = input();
    const set = impactMemberResponse(await decoded(source, constant({ u: [1e-4, 0, 0], theta: [0, 0, 0] })), source);
    expect(set.measure).toBe('member-mean-linear-section-resultants-from-sampled-end-responses/1');
    const [member] = set.members;
    near(member.lengthM, 2);
    near(member.axialStrain.values[2], 5e-5);
    near(member.axialStressPa.values[2], 1e7);
    near(member.axialForceN.values[2], 2000);
    zero(member.axialStrain.values[0]);
    [member.meanTorqueNm, member.meanMomentYNm, member.meanMomentZNm].forEach(item => item.values.forEach(zero));
    const compressed = impactMemberResponse(await decoded(source, constant({ u: [-1e-4, 0, 0], theta: [0, 0, 0] })), source);
    near(compressed.members[0].axialStressPa.minimum.value, -1e7);
    expect(compressed.members[0].axialStressPa.minimum.sample).toBe(1);
  });

  it('torsion: tip twist 1e-3 rad about the axis gives T = G J phi / L = 0.16 N m', async () => {
    const source = input();
    const [member] = impactMemberResponse(await decoded(source, constant({ u: [0, 0, 0], theta: [1e-3, 0, 0] })), source).members;
    near(member.meanTorqueNm.maximum.value, 0.16);
    [member.axialStrain, member.meanMomentYNm, member.meanMomentZNm].forEach(item => item.values.forEach(zero));
  });

  it('pure bending about z: the tip state of a 1 N m end moment (theta = ML/EI, w = ML2/2EI) gives the mean 1 N m', async () => {
    const source = input();
    // Iz = 5e-9 m4: theta = 1 * 2 / (200e9 * 5e-9) = 2e-3 rad, w = 1 * 4 / (2 * 1000) = 2e-3 m towards +y.
    const [member] = impactMemberResponse(await decoded(source, constant({ u: [0, 2e-3, 0], theta: [0, 0, 2e-3] })), source).members;
    near(member.meanMomentZNm.maximum.value, 1);
    member.meanMomentYNm.values.forEach(zero);
    member.axialStrain.values.forEach(zero);
  });

  it('cantilever tip load +z of 3 N: theta_y = -PL2/2EIy gives the true mean -PL/2 = -3 N m of M(x) = -P(L - x)', async () => {
    const source = input();
    // Iy = 3e-9 m4: theta_y = -3 * 4 / (2 * 600) = -0.01 rad, w = 3 * 8 / (3 * 600) m.
    const [member] = impactMemberResponse(await decoded(source, constant({ u: [0, 0, 24 / 1800], theta: [0, -0.01, 0] })), source).members;
    near(member.meanMomentYNm.minimum.value, -3);
    member.meanMomentZNm.values.forEach(zero);
  });

  it('double curvature (guided tip, theta = 0) has a zero mean moment although the end moments are not zero', async () => {
    const source = input({ segments: 4 });
    const result = await decoded(source, constant({ u: [0, 1e-3, 0], theta: [0, 0, 0] }));
    expect(result.meshElements).toBe(4);
    const set = impactMemberResponse(result, source);
    set.members[0].meanMomentZNm.values.forEach(zero);
    // The end values (6 E Iz w / L2 here) are not recovered: they are listed as unassessed, never shown as zero.
    expect(Object.keys(set.unassessed)).toEqual(['end-and-interior-section-forces', 'bending-fibre-stress',
      'torsional-shear-stress', 'transverse-shear', 'combined-or-equivalent-stress', 'yield-check']);
    expect(set.unassessed).toBe(IMPACT_MEMBER_UNASSESSED);
  });

  it('orientation follows localYHint: with hint +z the local axes are y = +z, z = x cross y = -y', async () => {
    const source = input({ hint: [0, 0, 1] });
    const [member] = impactMemberResponse(await decoded(source, constant({ u: [0, 2e-3, 0], theta: [0, 0, 2e-3] })), source).members;
    expect(member.frame.x).toEqual([1, 0, 0]);
    expect(member.frame.y).toEqual([0, 0, 1]);
    expect(member.frame.z.map(value => value + 0)).toEqual([0, -1, 0]);
    // The global +z rotation is now a rotation about local +y, so Iy = 3e-9 m4 carries it:
    // E Iy theta / L = 200e9 * 3e-9 * 2e-3 / 2 = 0.6 N m about local y, and nothing about local z.
    near(member.meanMomentYNm.maximum.value, 0.6);
    member.meanMomentZNm.values.forEach(zero);
  });

  it('N-mm input gives the same SI values as N-m input', async () => {
    const source = input({ millimetres: true });
    expect(source.geometry.units).toBe('N-mm');
    const [member] = impactMemberResponse(await decoded(source, constant({ u: [1e-4, 0, 0], theta: [1e-3, 0, 2e-3] })), source).members;
    near(member.lengthM, 2);
    near(member.youngPa, E);
    near(member.axialForceN.maximum.value, 2000, 1e-9);
    near(member.meanTorqueNm.maximum.value, 0.16, 1e-9);
    near(member.meanMomentZNm.maximum.value, 1, 1e-9);
  });

  it('zero motion: every value is exactly zero and every extreme sits at sample 0, time 0', async () => {
    const source = input();
    const [member] = impactMemberResponse(await decoded(source, constant(rest)), source).members;
    for (const item of [member.axialStrain, member.axialStressPa, member.axialForceN, member.meanTorqueNm,
      member.meanMomentYNm, member.meanMomentZNm]) {
      item.values.forEach(zero);
      expect([item.maximum.sample, item.maximum.timeS, item.minimum.sample, item.minimum.timeS]).toEqual([0, 0, 0, 0]);
    }
  });
});

describe('rejection and content binding', () => {
  it('rejects a result of another input, a non-finite reply and a derived overflow', async () => {
    const source = input();
    const result = await decoded(source, constant({ u: [1e-4, 0, 0], theta: [0, 0, 0] }));
    expect(() => impactMemberResponse(result, input({ gapM: 2 }))).toThrow('impact-member: result does not match its input');
    const nonfinite = { ...result, samples: result.samples.map((sample, index) => index !== 2 ? sample
      : { ...sample, nodes: sample.nodes.map(node => node.nodeId !== 'b' ? node : { ...node, rotationRad: [Number.NaN, 0, 0] as Vector3 }) }) };
    expect(() => impactMemberResponse(nonfinite, source)).toThrow('impact-member: result does not match its input');
    // 1e308 m is a finite decoded displacement; E times the strain 5e307 overflows.
    const huge = await decoded(input({ gapM: 0 }), step => ({ u: [step === 3 ? 1e308 : 0, 0, 0], theta: [0, 0, 0] }));
    expect(() => impactMemberResponse(huge, input({ gapM: 0 }))).toThrow('impact-member: non-finite axial stress');
  });

  it('binds the derived set to its own result content', async () => {
    const source = input();
    const first = await decoded(source, constant({ u: [1e-4, 0, 0], theta: [0, 0, 0] }));
    const second = await decoded(source, constant({ u: [2e-4, 0, 0], theta: [0, 0, 0] }));
    const set = impactMemberResponse(first, source);
    expect(impactMemberResponseMatches(set, first)).toBe(true);
    expect(impactMemberResponseMatches(set, structuredClone(first))).toBe(true);
    expect(impactMemberResponseMatches(set, second)).toBe(false);
    expect(impactMemberResponseMatches(null, first)).toBe(false);
    expect(impactMemberResponseMatches(set, { ...first, analysisRevision: first.analysisRevision + 1 })).toBe(false);
    const [member] = set.members;
    for (const changed of [
      { ...member, meanTorqueNm: { ...member.meanTorqueNm, values: member.meanTorqueNm.values.map((value, index) => index === 2 ? 1 : value) } },
      { ...member, axialForceN: { ...member.axialForceN, maximum: { ...member.axialForceN.maximum, sample: 3 } } },
      { ...member, areaM2: member.areaM2 * 2 },
    ]) expect(impactMemberResponseMatches({ ...set, members: [changed] }, first)).toBe(false);
  });
});
