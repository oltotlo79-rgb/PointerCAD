import { describe, expect, it } from 'vitest';
import type { Vector3 } from './analysisModel.js';
import { impactElementEndForces } from './beamImpactInterior.js';
import { impactMemberResponse } from './beamImpactMemberResponse.js';
import type { BeamImpactInput, BeamImpactResult } from './beamImpactModel.js';
import { decodeBeamImpact, impactOutputSteps } from './beamImpactResults.js';
import { impactInputSha256, translateBeamImpact } from './beamImpactTranslation.js';

// Hand constants (SI): L = 2 m, E = 200 GPa, G = 80 GPa, A = 2e-4 m2, Iy = 3e-9 m4, Iz = 5e-9 m4, J = 4e-9 m4.
const E = 200e9, G = 80e9, A = 2e-4, IY = 3e-9, IZ = 5e-9, J = 4e-9, L = 2;
const evidence = { kind: 'user-supplied', reference: 'Hand-derived element end force cases',
  condition: 'Explicit isotropic elastic constants; no capacity claim' } as const;

function input(options: { segments?: number; alongY?: boolean; outputEvery?: number } = {}): BeamImpactInput {
  return {
    schema: 'pointercad-beam-impact/1',
    geometry: {
      schema: 'pointercad-beam/2', id: 'interior-cases', revision: 2,
      source: { documentId: 'interior', documentRevision: 1, geometryRevision: 'two-metre-member' },
      units: 'N-m', modal: { modeCount: 1, segmentsPerMember: options.segments ?? 1 },
      nodes: [{ id: 'a', position: [0, 0, 0] }, { id: 'b', position: options.alongY ? [0, L, 0] : [L, 0, 0] }],
      members: [{ id: 'm', componentId: 'c', occurrencePath: ['c'], startNodeId: 'a', endNodeId: 'b',
        materialId: 'steel', sectionId: 'section', localYHint: options.alongY ? [0, 0, 1] : [0, 1, 0] }],
      materials: [{ id: 'steel', youngModulus: E, shearModulus: G, densityKgM3: 7850, source: evidence }],
      sections: [{ id: 'section', area: A, iy: IY, iz: IZ, torsionConstant: J, shearFactor: 0.8333333333333334, source: evidence }],
      constraints: [], loads: [],
    },
    supports: [{ nodeId: 'a', restrained: [true, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'b', velocityMPerS: [0.01, 0, 0] }],
    contacts: [{ nodeId: 'b', directionUnit: [1, 0, 0], gapM: 1 }],
    contactStiffnessNPerM: 1e7,
    history: { timeStepS: 1e-5, stepCount: 4, outputEvery: options.outputEvery ?? 1 },
  };
}

/** Independent Euler-Bernoulli 12 x 12 local stiffness (no shear deformation), DOFs [u v w tx ty tz] per end. It is the
 * test's own closed form, standing in for the native block in this protocol fixture; it is exact for the cubic static
 * fields used below, so K u reproduces their section forces at every element end. */
function localStiffness(length: number): number[][] {
  const k = Array.from({ length: 12 }, () => new Array<number>(12).fill(0));
  const put = (i: number, j: number, value: number): void => { k[i][j] += value; if (i !== j) k[j][i] += value; };
  const axial = E * A / length, torsion = G * J / length;
  put(0, 0, axial); put(6, 6, axial); put(0, 6, -axial);
  put(3, 3, torsion); put(9, 9, torsion); put(3, 9, -torsion);
  // Bending in the x-y plane (v, theta_z) with Iz and in the x-z plane (w, theta_y) with Iy (theta_y = -w').
  for (const [v, t, inertia, sign] of [[1, 5, IZ, 1], [2, 4, IY, -1]] as const) {
    const c = E * inertia / length ** 3;
    put(v, v, 12 * c); put(v + 6, v + 6, 12 * c); put(v, v + 6, -12 * c);
    put(t, t, 4 * c * length ** 2); put(t + 6, t + 6, 4 * c * length ** 2); put(t, t + 6, 2 * c * length ** 2);
    put(v, t, sign * 6 * c * length); put(v, t + 6, sign * 6 * c * length);
    put(v + 6, t, -sign * 6 * c * length); put(v + 6, t + 6, -sign * 6 * c * length);
  }
  return k;
}
function globalBlock(frame: { readonly x: Vector3; readonly y: Vector3; readonly z: Vector3 }, length: number): number[][] {
  const r = [frame.x, frame.y, frame.z];
  const t = Array.from({ length: 12 }, (_, i) => Array.from({ length: 12 }, (_, j) =>
    Math.floor(i / 3) === Math.floor(j / 3) ? r[i % 3][j % 3] : 0));
  const k = localStiffness(length);
  return t.map((_, i) => t.map((__, j) => {
    let sum = 0;
    for (let p = 0; p < 12; p += 1) for (let q = 0; q < 12; q += 1) sum += t[p][i] * k[p][q] * t[q][j];
    return sum;
  }));
}
type Field = (s: number) => { readonly u: Vector3; readonly theta: Vector3 };
/** Protocol reply: every mesh node follows `field` (s = distance from the start along the member, global vectors)
 * at every step after rest; the decoder still checks rest, supports, gaps and the original-node equality. */
async function decoded(source: BeamImpactInput, field: Field, change: (raw: Record<string, unknown>) => void = () => {}):
Promise<BeamImpactResult> {
  const { plan } = translateBeamImpact(source);
  const h = plan.impact.timeStepS;
  const start = plan.nodes[0].positionM;
  const distance = (p: Vector3): number => Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]);
  const state = (index: number, step: number) => step === 0 ? { u: [0, 0, 0] as Vector3, theta: [0, 0, 0] as Vector3 }
    : field(distance(plan.nodes[index].positionM));
  const raw: Record<string, unknown> = {
    schema: 'pointercad-oofem-impact-result/1',
    samples: impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery).map(step => ({
      step, timeS: step === 0 ? 0 : h * step, energyJ: 0.5,
      nodes: plan.nodes.slice(0, plan.originalNodeCount).map((node, index) => ({ number: node.number,
        displacementM: state(index, step).u, rotationRad: state(index, step).theta,
        velocityMPerS: step === 0 ? plan.impact.initialVelocity[index].slice(0, 3) : [0, 0, 0], angularVelocityRadPerS: [0, 0, 0] })),
      contacts: plan.impact.contacts.map(contact => ({ gapM: contact.gapM - state(contact.node - 1, step).u[0],
        intervalForceN: step === 0 ? null : 0, impulseNs: step === 0 ? null : 0 })),
      mesh: plan.nodes.map((node, index) => ({ number: node.number, displacementM: state(index, step).u,
        rotationRad: state(index, step).theta })),
    })),
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    initialEnergyJ: 0.5, maximumEnergyBalanceError: 0, maximumMomentumResidual: 0, factorizationsUsed: 4,
    contactPeaks: plan.impact.contacts.map(() => ({ intervalForceN: 0, timeS: h, totalImpulseNs: 0 })),
    elements: plan.members.map(member => ({ number: member.number, nodes: [...member.nodes],
      globalStiffness: globalBlock(member.frame, member.frame.lengthM) })),
  };
  change(raw);
  return decodeBeamImpact(raw, source, await impactInputSha256(source));
}
function near(actual: number, expected: number, relative = 1e-9): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(relative * Math.max(Math.abs(expected), 1e-30));
}
const small = (value: number, reference: number): void => expect(Math.abs(value)).toBeLessThanOrEqual(1e-9 * reference);
const along = (scale: number): Vector3 => [scale, 0, 0];

describe('element end forces from the solver mesh response (hand-derived static fields)', () => {
  it('axial and torsion: N = E A delta / L and T = G J phi / L at both ends of every element', async () => {
    const source = input({ segments: 2 });
    const delta = 1e-4, phi = 1e-3;
    const result = await decoded(source, s => ({ u: along(delta * s / L), theta: along(phi * s / L) }));
    if (result.interior === undefined) throw new Error('expected the mesh fields');
    expect(result.interior.elements.map(element => [element.memberId, element.segment])).toEqual([['m', 0], ['m', 1]]);
    for (const element of impactElementEndForces(result.interior)) {
      for (const end of [element.start[2], element.end[2]]) {
        near(end[0], E * A * delta / L);
        near(end[3], G * J * phi / L);
        [end[1], end[2], end[4], end[5]].forEach(value => small(value, E * A * delta / L));
      }
      // Rest at time 0: exactly zero.
      [...element.start[0], ...element.end[0]].forEach(value => expect(Math.abs(value)).toBe(0));
    }
  });

  it('cantilever tip load P along y: V = P everywhere and M_z(x) = P (L - x) at every element end, P L at the root', async () => {
    const source = input({ segments: 4 });
    const P = 3;
    // v(x) = P x^2 (3L - x) / (6 E Iz), theta_z = v' = P x (2L - x) / (2 E Iz).
    const result = await decoded(source, s => ({ u: [0, P * s * s * (3 * L - s) / (6 * E * IZ), 0],
      theta: [0, 0, P * s * (2 * L - s) / (2 * E * IZ)] }));
    if (result.interior === undefined) throw new Error('expected the mesh fields');
    const forces = impactElementEndForces(result.interior);
    forces.forEach((element, index) => {
      const x0 = index * L / 4, x1 = (index + 1) * L / 4;
      near(element.start[1][1], P);
      near(element.end[1][1], P);
      near(element.start[1][5], P * (L - x0));
      if (index < 3) near(element.end[1][5], P * (L - x1)); else small(element.end[1][5], P * L);
    });
    near(forces[0].start[1][5], P * L);
    // The 181 member mean is only P L / 2: the root moment is twice the mean.
    near(impactMemberResponse(result, source).members[0].meanMomentZNm.values[1], P * L / 2);
  });

  it('double curvature: the member mean is zero while the end moments are +-6 E Iz delta / L^2', async () => {
    for (const segments of [1, 4]) {
      const source = input({ segments });
      const delta = 1e-3;
      // Guided tip: v = delta (3 x^2 L - 2 x^3) / L^3, theta_z = 6 delta (x L - x^2) / L^3, zero at both ends.
      const result = await decoded(source, s => ({ u: [0, delta * (3 * s * s * L - 2 * s ** 3) / L ** 3, 0],
        theta: [0, 0, 6 * delta * (s * L - s * s) / L ** 3] }));
      if (result.interior === undefined) throw new Error('expected the mesh fields');
      const forces = impactElementEndForces(result.interior);
      const end = 6 * E * IZ * delta / L ** 2;
      near(forces[0].start[1][5], end);
      near(forces[forces.length - 1].end[1][5], -end);
      forces.forEach(element => near(element.start[1][1], 12 * E * IZ * delta / L ** 3));
      small(impactMemberResponse(result, source).members[0].meanMomentZNm.values[1], end);
    }
  });

  it('rotated member (along +y, hint +z): the axial force is still E A delta / L in the element frame', async () => {
    const source = input({ alongY: true, segments: 2 });
    const delta = 1e-4;
    const result = await decoded(source, s => ({ u: [0, delta * s / L, 0], theta: [0, 0, 0] }));
    if (result.interior === undefined) throw new Error('expected the mesh fields');
    expect(result.interior.elements[0].frame.x).toEqual([0, 1, 0]);
    for (const element of impactElementEndForces(result.interior)) {
      near(element.start[1][0], E * A * delta / L);
      near(element.end[1][0], E * A * delta / L);
    }
  });

  it('values exist only at the emitted samples (outputEvery 2), never between them', async () => {
    const source = input({ outputEvery: 2 });
    const result = await decoded(source, s => ({ u: along(1e-4 * s / L), theta: along(0) }));
    if (result.interior === undefined) throw new Error('expected the mesh fields');
    expect(result.samples.map(sample => sample.step)).toEqual([0, 2, 4]);
    expect(impactElementEndForces(result.interior)[0].start).toHaveLength(3);
  });
});

describe('refusal of missing, foreign or corrupt mesh data; unchanged replies without it', () => {
  const field: Field = s => ({ u: along(1e-4 * s / L), theta: along(0) });
  it('a reply without the mesh fields decodes exactly as before, with no interior', async () => {
    const result = await decoded(input(), field, raw => {
      delete raw.elements;
      for (const sample of raw.samples as Record<string, unknown>[]) delete sample.mesh;
    });
    expect(Object.hasOwn(result, 'interior')).toBe(false);
  });

  it.each([
    ['elements without mesh', (raw: Record<string, unknown>) => {
      for (const sample of raw.samples as Record<string, unknown>[]) delete sample.mesh;
    }, 'impact-result'],
    ['mesh without elements', (raw: Record<string, unknown>) => { delete raw.elements; }, 'impact-result'],
    ['a block of another element length (foreign)', (raw: Record<string, unknown>) => {
      (raw.elements as Record<string, unknown>[])[0].globalStiffness = globalBlock({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, 1);
    }, 'does not belong to this element geometry'],
    ['a non-finite block entry', (raw: Record<string, unknown>) => {
      ((raw.elements as Record<string, unknown>[])[0].globalStiffness as number[][])[0][0] = Number.NaN;
    }, 'finite 12 x 12'],
    ['an asymmetric block', (raw: Record<string, unknown>) => {
      ((raw.elements as Record<string, unknown>[])[0].globalStiffness as number[][])[0][1] += 1e3;
    }, 'not symmetric'],
    ['an original mesh row that differs from the node response', (raw: Record<string, unknown>) => {
      const sample = (raw.samples as Record<string, unknown>[])[2];
      (sample.mesh as Record<string, unknown>[])[1] = { number: 2, displacementM: [5e-5, 0, 1e-6], rotationRad: [0, 0, 0] };
    }, 'differs from the original-node response'],
    ['a missing mesh node', (raw: Record<string, unknown>) => {
      ((raw.samples as Record<string, unknown>[])[1].mesh as unknown[]).pop();
    }, 'every mesh node'],
    ['a renumbered element', (raw: Record<string, unknown>) => {
      (raw.elements as Record<string, unknown>[])[0].number = 7;
    }, 'identity differs'],
  ] as const)('refuses %s', async (_label, change, message) => {
    await expect(decoded(input(), field, change)).rejects.toThrow(message);
  });
});
