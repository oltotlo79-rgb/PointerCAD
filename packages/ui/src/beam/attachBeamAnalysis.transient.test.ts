import {
  decodeBeamTransient, transientAxialMatches, transientInputSha256, transientLoadFactor, transientOutputSteps,
  translateBeamTransient, type BeamTransientInput, type BeamTransientResult, type FemWorkerPort,
} from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { requireBeamSession } from './beam.testSupport.js';
import { bucklingUiFixture } from './beamBuckling.testSupport.js';
import { editBeamSession, type BeamEdit, type BeamSession } from './beamSession.js';

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

/** Same explicit form as beamSession.transient.test.ts: 0.1 ms x 200 steps, every 4th step returned (51 samples). */
async function running() {
  const fixture = bucklingUiFixture(), ports: Port[] = [];
  let session: BeamSession = { ...fixture.session, analysisType: 'transient' };
  const edits: readonly BeamEdit[] = [
    { kind: 'transient-value', field: 'timeStep', source: '0.1 ms' },
    { kind: 'transient-value', field: 'stepCount', source: '200' },
    { kind: 'transient-value', field: 'outputEvery', source: '4' },
    { kind: 'transient-sample', index: 0, field: 'factor', source: '0' },
    { kind: 'transient-sample', index: 1, field: 'time', source: '2 ms' },
    { kind: 'transient-sample', index: 1, field: 'factor', source: '1' },
    { kind: 'transient-sample-add' },
    { kind: 'transient-sample', index: 2, field: 'time', source: '20 ms' },
    { kind: 'transient-sample', index: 2, field: 'factor', source: '1' },
  ];
  for (const edit of edits) session = editBeamSession(session, edit);
  useAppStore.setState({ ...fixture.state, beamSession: session });
  attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
  useAppStore.getState().reviewBeam();
  expect(requireBeamSession().errorKey).toBeNull();
  useAppStore.getState().runBeam();
  await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
  const port = ports[0], request = port.request;
  if (request?.kind !== 'analyze-beam-transient-3d') throw new Error('Expected a transient request');
  return { fixture, port, ports, request, input: request.input };
}

/** Protocol fixture (not a numerical oracle): prescribed end-node translations; the client still decodes and
 * associates it with the exact request input and digest. */
async function resultFor(input: BeamTransientInput, end: (step: number) => Vector3): Promise<BeamTransientResult> {
  const { plan } = translateBeamTransient(input);
  const steps = transientOutputSteps(input.history);
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const last = input.history.loadFactor[input.history.loadFactor.length - 1].timeS;
  const zero: Vector3 = [0, 0, 0];
  let peak = 0, peakStep = 0, peakNode = plan.nodes[0].number;
  const samples = steps.map(step => {
    const timeS = step === 0 ? 0 : input.history.timeStepS * step;
    return { timeS, loadFactor: transientLoadFactor(input.history.loadFactor, Math.min(timeS, last)),
      nodes: original.map(node => {
        const displacementM = node.id === 'beam-member-1-end' ? end(step) : zero;
        if (Math.hypot(...displacementM) > peak) { peak = Math.hypot(...displacementM); peakStep = step; peakNode = node.number; }
        return { number: node.number, displacementM, rotationRad: zero, velocityMPerS: zero,
          angularVelocityRadPerS: zero, accelerationMPerS2: zero, angularAccelerationRadPerS2: zero };
      }) };
  });
  return decodeBeamTransient({ schema: 'pointercad-oofem-transient-result/1',
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    maximumEquilibriumResidual: 0, maximumEnergyBalanceError: 0, peakDisplacementM: peak,
    peakDisplacementTimeS: peakStep === 0 ? 0 : input.history.timeStepS * peakStep, peakDisplacementSolverNode: peakNode,
    peakRotationRad: 0, peakRotationTimeS: 0, peakRotationSolverNode: plan.nodes[0].number, samples },
  input, await transientInputSha256(input));
}
const resultEvent = (request: { readonly protocol: unknown; readonly identity: unknown }, result: BeamTransientResult) =>
  new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } });
// Compressive end translation along the member (+Z, 2000 mm): -1 um at the last step, linear in the step.
const compression = (step: number): Vector3 => [0, 0, -1e-6 * step / 200];

describe('transient axial derivation in the owned product lifecycle (protocol fixtures)', () => {
  it.each([
    { kind: 'transient-damping', value: 'rayleigh' },
    { kind: 'transient-value', field: 'massCoefficientPerS', source: '2' },
    { kind: 'transient-value', field: 'stiffnessCoefficientS', source: '0.002' },
  ] as const)('clears an accepted result and derived axial response on damping edit %j', async edit => {
    const { port, request, input } = await running();
    const late = port.onmessage;
    const result = await resultFor(input, compression);
    port.onmessage?.(resultEvent(request, result));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    expect(requireBeamSession().transientAxial).not.toBeNull();
    useAppStore.getState().editBeam(edit);
    const changed = requireBeamSession();
    expect(changed.result).toBeNull();
    expect(changed.transientAxial).toBeNull();
    expect(changed.reviewed).toBeNull();
    late?.(resultEvent(request, result));
    await Promise.resolve();
    await Promise.resolve();
    expect(requireBeamSession()).toBe(changed);
    expect(requireBeamSession().result).toBeNull();
    expect(requireBeamSession().transientAxial).toBeNull();
    expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });

  it('publishes the derived member-mean axial values with an accepted transient result', async () => {
    const { port, request, input } = await running();
    expect(input.geometry.nodes).toEqual([
      { id: 'beam-member-1-start', position: [25, 3, 0] }, { id: 'beam-member-1-end', position: [25, 3, 2000] }]);
    const result = await resultFor(input, compression);
    port.onmessage?.(resultEvent(request, result));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    const session = requireBeamSession();
    if (session.result?.kind !== 'oofem-beam-transient-3d' || session.transientAxial === null) {
      throw new Error('Expected a transient result with derived axial values');
    }
    expect(transientAxialMatches(session.transientAxial, session.result)).toBe(true);
    const [member] = session.transientAxial.members;
    // Hand derivation: L = 2 m along +Z, strain = du_z / L; E in Pa = youngModulus [N/mm2] * 1e6.
    const youngPa = input.geometry.materials[0].youngModulus * 1e6;
    expect(session.transientAxial.members).toHaveLength(1);
    expect([member.startNodeId, member.endNodeId, member.lengthM]).toEqual(['beam-member-1-start', 'beam-member-1-end', 2]);
    expect(member.axis).toEqual([0, 0, 1]);
    expect(Math.abs(member.minimum.strain + 5e-7)).toBeLessThanOrEqual(5e-7 * 1e-12);
    expect(Math.abs(member.minimum.stressPa - youngPa * -5e-7)).toBeLessThanOrEqual(Math.abs(youngPa * 5e-7) * 1e-12);
    expect([member.minimum.sample, member.minimum.timeS]).toEqual([50, session.result.samples[50].timeS]);
    expect([member.maximum.sample, member.maximum.strain]).toEqual([0, 0]);
    expect(port.terminated).toBe(1);
    expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });

  it.each(['cancel', 'edit', 'close'] as const)('a later completion after %s cannot publish a result or derived values', async reason => {
    const { fixture, port, request, input } = await running();
    const late = port.onmessage;
    const result = await resultFor(input, compression);
    if (reason === 'cancel') useAppStore.getState().cancelBeam();
    if (reason === 'edit') useAppStore.getState().editBeam({ kind: 'value', id: fixture.session.members[0].id, field: 'endFz', source: '-2' });
    if (reason === 'close') useAppStore.getState().closeBeam();
    expect(port.terminated).toBe(1);
    const after = useAppStore.getState().beamSession;
    late?.(resultEvent(request, result));
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().beamSession).toBe(after);
    expect(after?.result ?? null).toBeNull();
    expect(after?.transientAxial ?? null).toBeNull();
    expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });

  it('routes a derivation error through the existing failure path and releases ownership', async () => {
    const { port, request, input } = await running();
    // Finite and accepted by the decoder (|u| = 1e300 m), but stress = E * 5e299 overflows: the derivation rejects it.
    const result = await resultFor(input, step => [0, 0, step === 0 ? 0 : 1e300]);
    port.onmessage?.(resultEvent(request, result));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('failed'));
    const session = requireBeamSession();
    expect(session.errorKey).toBe('beam.error.runtime');
    expect(session.diagnostic).toContain('transient-axial: non-finite stress');
    expect(session.result).toBeNull();
    expect(session.transientAxial).toBeNull();
    expect(port.terminated).toBe(1);
    expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });
});
