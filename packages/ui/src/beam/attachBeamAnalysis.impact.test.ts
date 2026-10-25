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
import { impactPlaneContact } from './prepareBeamAnalysis.js';

/** Same port double as attachBeamAnalysis.contact.test.ts (FemWorkerPort of the fem client). */
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

/** The contact form as an impact: the free end moves at -2 m/s along Z towards a fixed plane 0.5 mm below it, so the
 * node-to-plane direction is -Z, entered unnormalized as 0,0,-2; start fully restrained; no load. */
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

/** Reviews and starts the impact; the FEM request is posted asynchronously (as in the contact lifecycle test). */
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

/** Protocol fixture, not a dynamics claim (like contactResultFor): counts, node numbers, sample steps and the
 * normalization length come from the real translation of the exact request input, and the real decoder binds it to
 * that input and its digest. One contact peak of 120 N with 0.0012 N·s at the first output after time 0, and a
 * penetration of 0.1 mm there, so every displayed column has a distinct nonzero value. */
async function impactResultFor(source: BeamImpactInput): Promise<BeamImpactResult> {
  const { plan } = translateBeamImpact(source);
  const h = plan.impact.timeStepS;
  const steps = impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery);
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const peakStep = steps[1];
  const peakImpulseNs = h * 120;
  // Protocol data obey g = gap - n.u and impulse = h.F; this is not a dynamics reference.
  const displacement = (number: number, step: number): readonly [number, number, number] => {
    const contact = plan.impact.contacts.find(candidate => candidate.node === number);
    if (step !== peakStep || contact === undefined) return [0, 0, 0];
    const travel = contact.gapM + 0.0001;
    return [contact.directionUnit[0] * travel, contact.directionUnit[1] * travel, contact.directionUnit[2] * travel];
  };
  return decodeBeamImpact({
    schema: 'pointercad-oofem-impact-result/1',
    samples: steps.map(step => ({
      step, timeS: step === 0 ? 0 : h * step, energyJ: 0.5,
      nodes: original.map((node, index) => ({ number: node.number, displacementM: displacement(node.number, step), rotationRad: [0, 0, 0],
        velocityMPerS: plan.impact.initialVelocity[index].slice(0, 3), angularVelocityRadPerS: [0, 0, 0] })),
      contacts: plan.impact.contacts.map(contact => ({ gapM: step === peakStep ? -0.0001 : contact.gapM,
        intervalForceN: step === 0 ? null : step === peakStep ? 120 : 0,
        impulseNs: step === 0 ? null : step === peakStep ? peakImpulseNs : 0 })),
    })),
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    initialEnergyJ: 0.5, maximumEnergyBalanceError: 5e-9, maximumMomentumResidual: 0, factorizationsUsed: 1,
    contactPeaks: plan.impact.contacts.map(() => ({ intervalForceN: 120, timeS: h * peakStep, totalImpulseNs: peakImpulseNs })),
  }, source, await impactInputSha256(source));
}
const resultEvent = (request: { readonly protocol: unknown; readonly identity: unknown }, result: BeamImpactResult) =>
  new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } });

describe('impact plane conversion for the solver route', () => {
  it('scales the saved direction to unit length without flipping it and converts the gap mm -> m once', () => {
    expect(impactPlaneContact({ id: 'p', nodeId: 'n', normal: [0, 0, -2], gapMm: 0.5 }))
      .toEqual({ nodeId: 'n', gapM: 0.0005, directionUnit: [0, 0, -1] });
    const tilted = impactPlaneContact({ id: 'p', nodeId: 'n', normal: [0, -3, 4], gapMm: 1500 });
    expect(tilted.gapM).toBe(1.5);
    expect(tilted.directionUnit[1]).toBeCloseTo(-0.6, 15);
    expect(tilted.directionUnit[2]).toBeCloseTo(0.8, 15);
    expect(Math.abs(Math.hypot(...tilted.directionUnit) - 1)).toBeLessThanOrEqual(1e-12);
  });
});

describe('impact analysis in the owned product lifecycle (protocol fixtures)', () => {
  it('sends the reviewed input with the node-to-plane direction normalized (sign kept) and the gap in m', async () => {
    const { request, input, fixture } = await running();
    expect(request.kind).toBe('analyze-beam-impact-3d');
    expect(input.contacts).toEqual([{ nodeId: fixture.member.endNodeId, directionUnit: [0, 0, -1], gapM: 0.0005 }]);
    expect(input.initialVelocities).toEqual([{ nodeId: fixture.member.endNodeId, velocityMPerS: [0, 0, -2] }]);
    expect(input.supports).toEqual([{ nodeId: fixture.member.startNodeId, restrained: [true, true, true, true, true, true] }]);
    expect(input.contactStiffnessNPerM).toBe(10000000);
    expect([input.history.stepCount, input.history.outputEvery]).toEqual([200, 2]);
    expect(input.history.timeStepS).toBeCloseTo(1e-5, 18);
  });

  it('publishes the bound result, releases the worker and shows force, impulse, gap, time and energy', async () => {
    const { port, request, input, fixture } = await running();
    port.onmessage?.(resultEvent(request, await impactResultFor(input)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    const result = requireBeamSession().result;
    if (result?.kind !== 'oofem-beam-impact-3d') throw new Error('Expected an impact result');
    expect(port.terminated).toBe(1);
    expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
    // .ts test file (no JSX): the view is rendered through createElement with the accepted session result.
    const html = renderToStaticMarkup(createElement(BeamImpactResults, { result }));
    const peak = result.contactPeaks[0];
    expect(peak.intervalForceN).toBe(120);
    expect(peak.totalImpulseNs).toBeCloseTo(0.0012, 15);
    expect(result.samples[1].contacts[0].gapM).toBe(-0.0001);
    expect(result.samples[1].nodes.find(node => node.nodeId === fixture.member.endNodeId)?.displacementM[2])
      .toBeCloseTo(-0.0006, 15);
    expect(result.maximumEnergyBalanceError).toBe(5e-9);
    const lastTimeS = result.samples[result.samples.length - 1].timeS;
    for (const value of [peak.intervalForceN, peak.totalImpulseNs, peak.timeS * 1000, -0.1, lastTimeS * 1000,
      result.initialEnergyJ, result.maximumEnergyBalanceError]) {
      expect(html, String(value)).toContain(beamDisplayNumber(value));
    }
    expect(html).toContain(`data-beam-impact-contact="${fixture.member.endNodeId}"`);
    expect(html).toContain('data-testid="beam-impact-not-certified"');
    // task175: the scope and the unassessed strength are always stated before the numbers; this protocol result is not
    // beyond the linearisation warning threshold, which is not a strength pass either.
    expect(html).toContain('data-testid="beam-impact-applicability"');
    expect(html).toContain('data-testid="beam-impact-strength-not-assessed"');
    expect(html).not.toContain('data-testid="beam-impact-linearization-warning"');
    expect(html.indexOf('data-testid="beam-impact-strength-not-assessed"'))
      .toBeLessThan(html.indexOf('data-beam-impact-value="duration"'));
    // The same accepted result with one sampled rotation of 0.2 rad is marked; the strength note stays and the numbers
    // stay visible for inspection.
    const rotationRad: [number, number, number] = [0, 0.2, 0];
    const turned = { ...result, samples: result.samples.map((sample, index) => index !== 1 ? sample
      : { ...sample, nodes: sample.nodes.map(node => ({ ...node, rotationRad })) }) };
    const marked = renderToStaticMarkup(createElement(BeamImpactResults, { result: turned }));
    expect(marked).toContain('data-testid="beam-impact-linearization-warning"');
    expect(marked).toContain('data-testid="beam-impact-strength-not-assessed"');
    expect(marked).toContain(beamDisplayNumber(peak.intervalForceN));
    expect(marked).toContain(beamDisplayNumber(0.2));
  });

  // Generic ownership is already asserted for contact at attachBeamAnalysis.contact.test.ts:91-109 (cancel, edits,
  // close); these cases add the impact-specific link: the impact request, its edits and its decoded result.
  it.each(['cancel', 'edit-velocity', 'edit-plane-gap', 'edit-step-count', 'close'] as const)(
    'a later impact completion after %s cannot publish a result', async reason => {
      const { fixture, port, request, input } = await running();
      const late = port.onmessage;
      const result = await impactResultFor(input);
      if (reason === 'cancel') useAppStore.getState().cancelBeam();
      if (reason === 'edit-velocity') useAppStore.getState().editBeam({ kind: 'impact-velocity', nodeId: fixture.member.endNodeId, axis: 2, source: '-3' });
      if (reason === 'edit-plane-gap') useAppStore.getState().editBeam({ kind: 'contact-value', index: 0, field: 'gap', source: '0.4' });
      if (reason === 'edit-step-count') useAppStore.getState().editBeam({ kind: 'impact-value', field: 'stepCount', source: '100' });
      if (reason === 'close') useAppStore.getState().closeBeam();
      expect(port.terminated).toBe(1);
      const after = useAppStore.getState().beamSession;
      late?.(resultEvent(request, result));
      await Promise.resolve();
      await Promise.resolve();
      expect(useAppStore.getState().beamSession).toBe(after);
      expect(after?.result ?? null).toBeNull();
      expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
    });

  it('refuses a result decoded for another plane gap (wrong input) through the failure path', async () => {
    const { port, request, input } = await running();
    const other: BeamImpactInput = { ...input, contacts: input.contacts.map(contact => ({ ...contact, gapM: 0.0001 })) };
    port.onmessage?.(resultEvent(request, await impactResultFor(other)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('failed'));
    const session = requireBeamSession();
    expect([session.errorKey, session.result]).toEqual(['beam.error.runtime', null]);
    expect(session.diagnostic).toContain('invalid-protocol');
    expect(port.terminated).toBe(1);
  });
});
