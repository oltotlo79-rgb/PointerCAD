import { decodeBeamImpact, impactInputSha256, impactOutputSteps, translateBeamImpact, type BeamImpactInput,
  type BeamImpactResult, type FemWorkerPort } from '@pointercad/fem';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { requireBeamSession } from './beam.testSupport.js';
import { contactUiFixture } from './beamContact.testSupport.js';
import { BeamImpactResults } from './BeamImpactResults.js';
import { beamDisplayNumber } from './BeamResults.js';
import { editBeamSession, type BeamEdit, type BeamSession } from './beamSession.js';

// task184: sampled element end forces through the public lifecycle (attachment, session, panel component). The reply is
// a PROTOCOL fixture built with this test's own closed-form Euler-Bernoulli block, not a native result; the native
// producer is checked separately in packages/fem/src/beamImpactNativeInterior.test.ts.
// @pointercad/fem does not export its Vector3 type; this is the same readonly triple.
type Vector3 = readonly [number, number, number];
class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  request: Parameters<FemWorkerPort['postMessage']>[0] | null = null;
  terminated = 0;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.request = request; }
  terminate(): void { this.terminated += 1; }
}
let attachment: BeamAttachment | null = null;
beforeEach(resetTestStore);
afterEach(() => { attachment?.dispose(); attachment = null; resetTestStore(); });

function impactSession(): { readonly fixture: ReturnType<typeof contactUiFixture>; readonly session: BeamSession } {
  const fixture = contactUiFixture();
  const edits: readonly BeamEdit[] = [
    { kind: 'analysis-type', value: 'impact' },
    { kind: 'value', id: fixture.member.id, field: 'endFz', source: '0' },
    { kind: 'contact-value', index: 0, field: 'normalZ', source: '-2' },
    { kind: 'impact-velocity', nodeId: fixture.member.endNodeId, axis: 2, source: '-2' },
    { kind: 'impact-value', field: 'contactStiffness', source: '10000000' },
    { kind: 'impact-value', field: 'timeStep', source: '0.01ms' },
    { kind: 'impact-value', field: 'stepCount', source: '200' },
    { kind: 'impact-value', field: 'outputEvery', source: '2' },
  ];
  return { fixture, session: edits.reduce(editBeamSession, fixture.session) };
}
async function running() {
  const { fixture, session } = impactSession(), ports: Port[] = [];
  useAppStore.setState({ ...fixture.state, beamSession: session });
  attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
  useAppStore.getState().reviewBeam();
  expect(requireBeamSession().errorKey).toBeNull();
  useAppStore.getState().runBeam();
  await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
  const port = ports[0], request = port.request;
  if (request?.kind !== 'analyze-beam-impact-3d') throw new Error('Expected an impact request');
  return { fixture, port, request, input: request.input };
}

/** SI constants of the single member from the request input (documented unit contract of analysisModel.ts). */
function constants(input: BeamImpactInput) {
  const scale = input.geometry.units === 'N-mm' ? 0.001 : 1;
  const [member] = input.geometry.members;
  const material = input.geometry.materials.find(row => row.id === member.materialId);
  const section = input.geometry.sections.find(row => row.id === member.sectionId);
  if (material === undefined || section === undefined) throw new Error('missing material or section');
  return { youngPa: material.youngModulus / scale ** 2, areaM2: section.area * scale ** 2,
    iyM4: section.iy * scale ** 4, izM4: section.iz * scale ** 4 };
}
/** Closed-form Euler-Bernoulli global block of one element (axial plus both bending planes; torsion is not exercised). */
function block(frame: { readonly x: Vector3; readonly y: Vector3; readonly z: Vector3 }, length: number,
  c: ReturnType<typeof constants>): number[][] {
  const k = Array.from({ length: 12 }, () => new Array<number>(12).fill(0));
  const put = (i: number, j: number, value: number): void => { k[i][j] += value; if (i !== j) k[j][i] += value; };
  const axial = c.youngPa * c.areaM2 / length;
  put(0, 0, axial); put(6, 6, axial); put(0, 6, -axial);
  put(3, 3, 1); put(9, 9, 1); put(3, 9, -1);
  for (const [v, t, inertia, sign] of [[1, 5, c.izM4, 1], [2, 4, c.iyM4, -1]] as const) {
    const e = c.youngPa * inertia / length ** 3;
    put(v, v, 12 * e); put(v + 6, v + 6, 12 * e); put(v, v + 6, -12 * e);
    put(t, t, 4 * e * length ** 2); put(t + 6, t + 6, 4 * e * length ** 2); put(t, t + 6, 2 * e * length ** 2);
    put(v, t, sign * 6 * e * length); put(v, t + 6, sign * 6 * e * length);
    put(v + 6, t, -sign * 6 * e * length); put(v + 6, t + 6, -sign * 6 * e * length);
  }
  const r = [frame.x, frame.y, frame.z];
  const rot = (i: number, j: number): number => Math.floor(i / 3) === Math.floor(j / 3) ? r[i % 3][j % 3] : 0;
  return k.map((_, i) => k.map((__, j) => {
    let sum = 0;
    for (let p = 0; p < 12; p += 1) for (let q = 0; q < 12; q += 1) sum += rot(p, i) * k[p][q] * rot(q, j);
    return sum;
  }));
}
/** Double curvature (guided far end) of the whole member along its local y: v(s) = d (3 s^2 L - 2 s^3) / L^3 and
 * theta_z(s) = 6 d (s L - s^2) / L^3, zero rotation at both original ends. `mesh` false gives the old reply format. */
async function guidedReply(source: BeamImpactInput, delta: number, mesh: boolean,
  origin: 'clamped-start' | 'first-plan-node' = 'clamped-start'): Promise<BeamImpactResult> {
  const { plan } = translateBeamImpact(source);
  const h = plan.impact.timeStepS;
  const [first] = plan.members;
  const { y, z } = first.frame;
  // The clamped member start is the origin of s, not plan.nodes[0]: plan nodes are numbered by sorted id, so
  // '<member>-end' precedes '<member>-start' and plan.nodes[0] is the free end (task043, ui-batch-1).
  // 'first-plan-node' only reproduces that refused old fixture for the regression below.
  const clamped = plan.nodes[first.nodes[0] - 1];
  if (origin === 'clamped-start' && !clamped.restrained.every(Boolean)) {
    throw new Error('fixture: the member start must be the clamped support');
  }
  const start = (origin === 'clamped-start' ? clamped : plan.nodes[0]).positionM;
  const total = plan.members.reduce((sum, member) => sum + member.frame.lengthM, 0);
  const state = (index: number, step: number): { u: Vector3; theta: Vector3 } => {
    if (step === 0) return { u: [0, 0, 0], theta: [0, 0, 0] };
    const p = plan.nodes[index].positionM;
    const s = Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]);
    const v = delta * (3 * s * s * total - 2 * s ** 3) / total ** 3, theta = 6 * delta * (s * total - s * s) / total ** 3;
    return { u: [v * y[0], v * y[1], v * y[2]], theta: [theta * z[0], theta * z[1], theta * z[2]] };
  };
  const c = constants(source);
  const samples = impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery).map(step => ({
    step, timeS: step === 0 ? 0 : h * step, energyJ: 0.5,
    nodes: plan.nodes.slice(0, plan.originalNodeCount).map((node, index) => ({ number: node.number,
      displacementM: state(index, step).u, rotationRad: state(index, step).theta,
      velocityMPerS: step === 0 ? plan.impact.initialVelocity[index].slice(0, 3) : [0, 0, 0], angularVelocityRadPerS: [0, 0, 0] })),
    contacts: plan.impact.contacts.map(contact => {
      const u = state(contact.node - 1, step).u;
      return { gapM: contact.gapM - (contact.directionUnit[0] * u[0] + contact.directionUnit[1] * u[1] + contact.directionUnit[2] * u[2]),
        intervalForceN: step === 0 ? null : 0, impulseNs: step === 0 ? null : 0 };
    }),
    ...(mesh ? { mesh: plan.nodes.map((node, index) => ({ number: node.number, displacementM: state(index, step).u,
      rotationRad: state(index, step).theta })) } : {}),
  }));
  // Independent support proof of this fixture (not the decoder): every restrained DOF of every plan node is 0.
  if (origin === 'clamped-start') {
    for (const step of impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery)) {
      plan.nodes.forEach((node, index) => {
        const { u, theta } = state(index, step);
        const values = [...u, ...theta];
        if (node.restrained.some((fixed, axis) => fixed && values[axis] !== 0)) throw new Error('fixture: displaced support');
      });
    }
  }
  return decodeBeamImpact({
    schema: 'pointercad-oofem-impact-result/1', samples,
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    initialEnergyJ: 0.5, maximumEnergyBalanceError: 0, maximumMomentumResidual: 0, factorizationsUsed: 1,
    contactPeaks: plan.impact.contacts.map(() => ({ intervalForceN: 0, timeS: h, totalImpulseNs: 0 })),
    ...(mesh ? { elements: plan.members.map(member => ({ number: member.number, nodes: [...member.nodes],
      globalStiffness: block(member.frame, member.frame.lengthM, c) })) } : {}),
  }, source, await impactInputSha256(source));
}
const resultEvent = (request: { readonly protocol: unknown; readonly identity: unknown }, result: BeamImpactResult) =>
  new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } });
function cell(html: string, element: number, end: 'start' | 'end', axis: number): string {
  const row = html.split('<tr').find(part => part.includes(`data-beam-impact-element="${element}"`)
    && part.includes(`data-beam-impact-end="${end}"`));
  const match = row?.match(new RegExp(`data-beam-impact-force="${axis}">([^<]*)<`, 'u'));
  if (match === null || match === undefined) throw new Error(`no force cell ${element}/${end}/${axis}`);
  return match[1];
}

describe('sampled element end forces in the public impact lifecycle', () => {
  it('shows signed SI end moments of double curvature (+-6 E Iz d / L^2) while the 182 member mean is zero', async () => {
    const { port, request, input } = await running();
    const delta = 1e-4;
    port.onmessage?.(resultEvent(request, await guidedReply(input, delta, true)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    const session = requireBeamSession();
    if (session.result?.kind !== 'oofem-beam-impact-3d' || session.impactMembers === null) throw new Error('Expected members');
    const { plan } = translateBeamImpact(input);
    const length = plan.members.reduce((sum, member) => sum + member.frame.lengthM, 0);
    const c = constants(input);
    const end = 6 * c.youngPa * c.izM4 * delta / length ** 2;
    // The node-chord member mean (182) is exactly zero: both original end rotations are zero.
    session.impactMembers.members[0].meanMomentZNm.values.forEach(value => expect(Math.abs(value)).toBe(0));
    const html = renderToStaticMarkup(createElement(BeamImpactResults, { result: session.result, members: session.impactMembers }));
    const last = plan.members.length;
    // Mz is column 5; the member start carries +6EId/L^2 and the member end -6EId/L^2 (right-hand, local z).
    expect(cell(html, 1, 'start', 5)).toBe(beamDisplayNumber(end));
    expect(cell(html, last, 'end', 5)).toBe(beamDisplayNumber(-end));
    expect(cell(html, 1, 'start', 1)).toBe(beamDisplayNumber(12 * c.youngPa * c.izM4 * delta / length ** 3));
    // Location and time: station of the last element end is the member length; the first emitted sample after rest.
    expect(html).toContain(`(${beamDisplayNumber(length)} m)`);
    expect(html).toContain(`${beamDisplayNumber(session.result.samples[1].timeS * 1000)} ms`);
    expect(html).toContain('data-testid="beam-impact-end-forces-limits"');
    expect(html).not.toContain('data-beam-impact-unassessed="end-and-interior-section-forces"');
    expect(html).toContain('data-beam-impact-unassessed="yield-check"');
    expect(html.indexOf('data-testid="beam-impact-strength-not-assessed"'))
      .toBeLessThan(html.indexOf('data-testid="beam-impact-end-forces"'));
  });

  it('an old-format reply shows no element end forces and keeps the end-force row unassessed', async () => {
    const { port, request, input } = await running();
    port.onmessage?.(resultEvent(request, await guidedReply(input, 1e-4, false)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    const session = requireBeamSession();
    if (session.result?.kind !== 'oofem-beam-impact-3d') throw new Error('Expected an impact result');
    expect(Object.hasOwn(session.result, 'interior')).toBe(false);
    const html = renderToStaticMarkup(createElement(BeamImpactResults, { result: session.result, members: session.impactMembers }));
    expect(html).not.toContain('beam-impact-end-forces');
    expect(html).toContain('data-beam-impact-unassessed="end-and-interior-section-forces"');
  });

  it.each(['cancel', 'edit-velocity', 'close'] as const)('a late completion after %s publishes no end-force result', async reason => {
    const { fixture, port, request, input } = await running();
    const late = port.onmessage;
    const result = await guidedReply(input, 1e-4, true);
    if (reason === 'cancel') useAppStore.getState().cancelBeam();
    if (reason === 'edit-velocity') useAppStore.getState().editBeam({ kind: 'impact-velocity', nodeId: fixture.member.endNodeId, axis: 2, source: '-3' });
    if (reason === 'close') useAppStore.getState().closeBeam();
    const after = useAppStore.getState().beamSession;
    late?.(resultEvent(request, result));
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().beamSession).toBe(after);
    expect(after?.result ?? null).toBeNull();
  });

  it('the double-curvature fixture is clamped at the member start; the old first-plan-node origin is refused', async () => {
    const { fixture, input } = await running();
    const { plan } = translateBeamImpact(input);
    // Plan nodes are numbered by sorted id: '<member>-end' precedes '<member>-start', so plan.nodes[0] is the free end.
    expect(plan.nodes[0].id).toBe(fixture.member.endNodeId);
    expect(plan.nodes[0].restrained).toEqual([false, false, false, false, false, false]);
    const start = plan.nodes[plan.members[0].nodes[0] - 1];
    expect([start.id, start.restrained]).toEqual([fixture.member.startNodeId, [true, true, true, true, true, true]]);
    // The real ui-batch-1 failure: the product decoder keeps refusing a displaced support (not weakened).
    await expect(guidedReply(input, 1e-4, true, 'first-plan-node'))
      .rejects.toThrow('impact-result: response violates a prescribed support');
    const result = await guidedReply(input, 1e-4, true);
    for (const sample of result.samples) {
      const node = sample.nodes.find(row => row.nodeId === fixture.member.startNodeId);
      if (node === undefined) throw new Error('the clamped start must be sampled');
      expect([...node.displacementM, ...node.rotationRad].map(Math.abs)).toEqual([0, 0, 0, 0, 0, 0]);
    }
    // The free end carries the prescribed guided translation d = 0.1 mm and (to rounding) no rotation once moving.
    const tip = result.samples[1].nodes.find(row => row.nodeId === fixture.member.endNodeId);
    if (tip === undefined) throw new Error('the free end must be sampled');
    expect(Math.abs(Math.hypot(...tip.displacementM) - 1e-4)).toBeLessThanOrEqual(1e-15);
    expect(Math.max(...tip.rotationRad.map(Math.abs))).toBeLessThanOrEqual(1e-12);
  });

  it('a reply decoded for another input (foreign) fails and shows nothing', async () => {
    const { port, request, input } = await running();
    const other: BeamImpactInput = { ...input, contacts: input.contacts.map(contact => ({ ...contact, gapM: 0.0001 })) };
    port.onmessage?.(resultEvent(request, await guidedReply(other, 1e-4, true)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('failed'));
    expect(requireBeamSession().result).toBeNull();
  });

  it('an edit after completion clears the displayed result, and so the end forces', async () => {
    const { fixture, port, request, input } = await running();
    port.onmessage?.(resultEvent(request, await guidedReply(input, 1e-4, true)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    useAppStore.getState().editBeam({ kind: 'impact-velocity', nodeId: fixture.member.endNodeId, axis: 2, source: '-3' });
    expect([requireBeamSession().result, requireBeamSession().impactMembers]).toEqual([null, null]);
  });
});
