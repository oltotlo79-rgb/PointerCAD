import { decodeBeamImpact, impactInputSha256, impactMemberResponseMatches, impactOutputSteps, translateBeamImpact,
  type BeamImpactInput, type BeamImpactResult, type FemWorkerPort } from '@pointercad/fem';
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

// task182: the member-mean resultants of an accepted impact result travel with the session (derived once by the
// attachment from the exact request input), are cleared on every invalidation and are displayed only when bound to the
// displayed result. Same port double and impact form as attachBeamAnalysis.impact.test.ts.
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

/** SI member data read directly from the request input with the documented unit contract (analysisModel.ts: moduli
 * N/length^2, J length^4; N-mm means length in mm). Used only for the hand expectations below. */
function memberData(input: BeamImpactInput) {
  const scale = input.geometry.units === 'N-mm' ? 0.001 : 1;
  const [member] = input.geometry.members;
  const position = (id: string) => {
    const node = input.geometry.nodes.find(candidate => candidate.id === id);
    if (node === undefined) throw new Error('missing node');
    return node.position.map(value => value * scale);
  };
  const a = position(member.startNodeId), b = position(member.endNodeId);
  const lengthM = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const axis: [number, number, number] = [(b[0] - a[0]) / lengthM, (b[1] - a[1]) / lengthM, (b[2] - a[2]) / lengthM];
  const material = input.geometry.materials.find(candidate => candidate.id === member.materialId);
  const section = input.geometry.sections.find(candidate => candidate.id === member.sectionId);
  if (material === undefined || section === undefined) throw new Error('missing material or section');
  return { member, lengthM, axis, youngPa: material.youngModulus / scale ** 2, shearPa: material.shearModulus / scale ** 2,
    areaM2: section.area * scale ** 2, torsionM4: section.torsionConstant * scale ** 4 };
}

/** Protocol fixture (not a dynamics reference): at the first output after time 0 the free end has moved `axialM` along
 * the member axis and twisted `twistRad` about it, on top of the 0.1 mm penetration of the plane. The real decoder
 * binds it to the exact input and digest, so gaps follow g = gap - n.u and impulses h.F. */
async function impactResultFor(source: BeamImpactInput, axialM: number, twistRad: number): Promise<BeamImpactResult> {
  const { plan } = translateBeamImpact(source);
  const h = plan.impact.timeStepS;
  const steps = impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery);
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const peakStep = steps[1];
  const { axis, member } = memberData(source);
  const [contact] = plan.impact.contacts;
  const travel = contact.gapM + 0.0001;
  const endNumber = original.find(node => node.id === member.endNodeId)?.number;
  const displacement = (number: number, step: number): [number, number, number] => step !== peakStep || number !== endNumber
    ? [0, 0, 0] : [contact.directionUnit[0] * travel + axis[0] * axialM, contact.directionUnit[1] * travel + axis[1] * axialM,
      contact.directionUnit[2] * travel + axis[2] * axialM];
  const rotation = (number: number, step: number): [number, number, number] => step !== peakStep || number !== endNumber
    ? [0, 0, 0] : [axis[0] * twistRad, axis[1] * twistRad, axis[2] * twistRad];
  const gap = (step: number): number => {
    if (step !== peakStep) return contact.gapM;
    const u = displacement(contact.node, step);
    return contact.gapM - (contact.directionUnit[0] * u[0] + contact.directionUnit[1] * u[1] + contact.directionUnit[2] * u[2]);
  };
  return decodeBeamImpact({
    schema: 'pointercad-oofem-impact-result/1',
    samples: steps.map(step => ({
      step, timeS: step === 0 ? 0 : h * step, energyJ: 0.5,
      nodes: original.map((node, index) => ({ number: node.number, displacementM: displacement(node.number, step),
        rotationRad: rotation(node.number, step), velocityMPerS: plan.impact.initialVelocity[index].slice(0, 3),
        angularVelocityRadPerS: [0, 0, 0] })),
      contacts: plan.impact.contacts.map(() => ({ gapM: gap(step), intervalForceN: step === 0 ? null : step === peakStep ? 120 : 0,
        impulseNs: step === 0 ? null : step === peakStep ? h * 120 : 0 })),
    })),
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    initialEnergyJ: 0.5, maximumEnergyBalanceError: 5e-9, maximumMomentumResidual: 0, factorizationsUsed: 1,
    contactPeaks: plan.impact.contacts.map(() => ({ intervalForceN: 120, timeS: h * peakStep, totalImpulseNs: h * 120 })),
  }, source, await impactInputSha256(source));
}
const resultEvent = (request: { readonly protocol: unknown; readonly identity: unknown }, result: BeamImpactResult) =>
  new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } });
function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(1e-9 * Math.abs(expected));
}

describe('impact member-mean resultants in the session lifecycle', () => {
  it('derives the set once from the accepted result and its exact input, with the hand values E du/L and G J phi/L', async () => {
    const { port, request, input } = await running();
    // 1 mm exceeds the 0.6 mm plane travel, so the peak sample is tensile whatever the member direction is.
    const axialM = 1e-3, twistRad = 1e-4;
    port.onmessage?.(resultEvent(request, await impactResultFor(input, axialM, twistRad)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    const session = requireBeamSession();
    if (session.result?.kind !== 'oofem-beam-impact-3d' || session.impactMembers === null) throw new Error('Expected impact members');
    expect(impactMemberResponseMatches(session.impactMembers, session.result)).toBe(true);
    const data = memberData(input);
    const [member] = session.impactMembers.members;
    expect(member.memberId).toBe(data.member.id);
    // The plane travel (gap + 0.1 mm along the unit plane direction n) also stretches the member by its share n . x.
    const [plane] = input.contacts;
    const travelAlongAxis = (plane.gapM + 0.0001) * (plane.directionUnit[0] * data.axis[0]
      + plane.directionUnit[1] * data.axis[1] + plane.directionUnit[2] * data.axis[2]);
    const strain = (axialM + travelAlongAxis) / data.lengthM;
    expect(strain).toBeGreaterThan(0);
    // Only the first output after time 0 is displaced: that is the maximum; time 0 (rest) is the minimum, value 0.
    near(member.axialStressPa.maximum.value, data.youngPa * strain);
    near(member.axialForceN.maximum.value, data.youngPa * data.areaM2 * strain);
    const torque = data.shearPa * data.torsionM4 * twistRad / data.lengthM;
    near(member.meanTorqueNm.maximum.value, torque);
    expect(member.axialStressPa.maximum.timeS).toBe(session.result.samples[1].timeS);
    expect([member.axialStressPa.minimum.sample, member.axialStressPa.minimum.value]).toEqual([0, 0]);
    // A twist about the axis bends nothing: both mean moments stay zero up to rounding of the projected frame.
    [...member.meanMomentYNm.values, ...member.meanMomentZNm.values]
      .forEach(value => expect(Math.abs(value)).toBeLessThanOrEqual(1e-9 * torque));
    const html = renderToStaticMarkup(createElement(BeamImpactResults, { result: session.result, members: session.impactMembers }));
    expect(html).toContain(`data-beam-impact-member="${data.member.id}"`);
    expect(html).toContain(beamDisplayNumber(member.axialStressPa.maximum.value));
    expect(html).toContain(beamDisplayNumber(member.meanTorqueNm.maximum.value));
    for (const key of ['end-and-interior-section-forces', 'bending-fibre-stress', 'torsional-shear-stress', 'transverse-shear',
      'combined-or-equivalent-stress', 'yield-check']) expect(html).toContain(`data-beam-impact-unassessed="${key}"`);
    // The retained notes stay before the member numbers.
    expect(html.indexOf('data-testid="beam-impact-strength-not-assessed"')).toBeLessThan(html.indexOf('data-testid="beam-impact-members"'));
    expect(html.indexOf('data-testid="beam-impact-members-limits"')).toBeLessThan(html.indexOf('data-beam-impact-member='));
    // Without a bound set nothing about members is shown (the 175 view is unchanged).
    expect(renderToStaticMarkup(createElement(BeamImpactResults, { result: session.result }))).not.toContain('beam-impact-members');
  });

  it('a set derived from another result is not bound to the displayed one', async () => {
    const { port, request, input } = await running();
    port.onmessage?.(resultEvent(request, await impactResultFor(input, 2e-6, 0)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    const session = requireBeamSession();
    if (session.result?.kind !== 'oofem-beam-impact-3d') throw new Error('Expected an impact result');
    const other = await impactResultFor(input, 3e-6, 0);
    expect([other.inputSha256, other.analysisRevision]).toEqual([session.result.inputSha256, session.result.analysisRevision]);
    expect(impactMemberResponseMatches(session.impactMembers, other)).toBe(false);
  });

  it.each(['edit-velocity', 'review', 'cancel', 'run-again'] as const)('%s clears the derived set', async reason => {
    const { fixture, port, request, input } = await running();
    port.onmessage?.(resultEvent(request, await impactResultFor(input, 2e-6, 1e-4)));
    await vi.waitFor(() => expect(requireBeamSession().impactMembers).not.toBeNull());
    if (reason === 'edit-velocity') useAppStore.getState().editBeam({ kind: 'impact-velocity', nodeId: fixture.member.endNodeId, axis: 2, source: '-3' });
    if (reason === 'review') useAppStore.getState().reviewBeam();
    if (reason === 'cancel') useAppStore.getState().cancelBeam();
    if (reason === 'run-again') useAppStore.getState().runBeam();
    const session = requireBeamSession();
    expect([session.result, session.impactMembers]).toEqual([null, null]);
  });

  it.each(['cancel', 'edit-plane-gap', 'close'] as const)('a late completion after %s publishes no derived set', async reason => {
    const { port, request, input } = await running();
    const late = port.onmessage;
    const result = await impactResultFor(input, 2e-6, 1e-4);
    if (reason === 'cancel') useAppStore.getState().cancelBeam();
    if (reason === 'edit-plane-gap') useAppStore.getState().editBeam({ kind: 'contact-value', index: 0, field: 'gap', source: '0.4' });
    if (reason === 'close') useAppStore.getState().closeBeam();
    const after = useAppStore.getState().beamSession;
    late?.(resultEvent(request, result));
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().beamSession).toBe(after);
    expect(after?.impactMembers ?? null).toBeNull();
  });

  it('a reply decoded for another input (foreign) fails without a derived set', async () => {
    const { port, request, input } = await running();
    const other: BeamImpactInput = { ...input, contacts: input.contacts.map(contact => ({ ...contact, gapM: 0.0001 })) };
    port.onmessage?.(resultEvent(request, await impactResultFor(other, 2e-6, 0)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('failed'));
    const session = requireBeamSession();
    expect([session.errorKey, session.result, session.impactMembers]).toEqual(['beam.error.runtime', null, null]);
  });

  it('a non-finite derived value fails the run instead of publishing the result', async () => {
    const { port, request, input } = await running();
    // 1e300 m along the axis is a finite decoded displacement; E times the strain overflows in the derivation.
    port.onmessage?.(resultEvent(request, await impactResultFor(input, 1e300, 0)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('failed'));
    const session = requireBeamSession();
    expect([session.errorKey, session.result, session.impactMembers]).toEqual(['beam.error.runtime', null, null]);
    expect(session.diagnostic).toContain('impact-member: non-finite');
  });
});
