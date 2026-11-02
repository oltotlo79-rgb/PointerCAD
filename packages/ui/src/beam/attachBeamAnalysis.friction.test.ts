import { decodeFrictionContact, frictionContactInputSha256, isFrictionContactResult, translateBeamFrictionContact,
  type BeamFrictionContactInput, type FemWorkerPort } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { contactUiFixture } from './beamContact.testSupport.js';
import { editBeamSession } from './beamSession.js';

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
/** Structurally valid synthetic open-state reply, not a solver or physical oracle. */
async function validReply(input: BeamFrictionContactInput) {
  const translated = translateBeamFrictionContact(input), options = { solver: 'newton' as const, iterationLimit: 64 };
  const plan = translated.plan;
  const raw = { kind: 'pointercad-internal-friction-contact-candidate', ...options,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(fixed => !fixed).length, 0),
    states: translated.loads.map((_, step) => ({ step, iterations: 1, forceScaleN: 1, gapScaleM: 1,
      equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0, frictionConeExcess: 0, slipLawResidual: 0,
      nodes: plan.nodes.slice(0, plan.originalNodeCount).map(node => ({ number: node.number,
        displacementM: [0, 0, 0], rotationRad: [0, 0, 0] })),
      contacts: plan.contacts.map(contact => ({ id: contact.id, state: 'open', frictionCoefficient: translated.friction[contact.id],
        normalReactionN: 0, gapM: 0, frictionForceN: [0, 0, 0], slipIncrementM: [0, 0, 0], accumulatedSlipM: [0, 0, 0],
        slipPathLengthM: 0, dissipatedWorkJ: 0 })) })) };
  const result = decodeFrictionContact(raw, input, await frictionContactInputSha256(input), options);
  expect(isFrictionContactResult(result)).toBe(true);
  return result;
}
describe('friction worker lifecycle', () => {
  it.each(['cancel', 'revision', 'source', 'current'] as const)('handles a valid dedicated reply after %s', async mode => {
    const fixture = contactUiFixture();
    let session = editBeamSession(fixture.session, { kind: 'analysis-type', value: 'friction' });
    session = editBeamSession(session, { kind: 'friction-coefficient', contactId: 'contact-1', source: '0.3' });
    useAppStore.setState({ ...fixture.state, beamSession: session });
    const ports: Port[] = [];
    attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
    useAppStore.getState().reviewBeam();
    useAppStore.getState().runBeam();
    await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
    const port = ports[0], request = port.request;
    if (request?.kind !== 'analyze-beam-friction-contact') throw new Error('friction request required');
    expect(request.solverOptions).toEqual({ solver: 'newton', iterationLimit: 64 });
    const result = await validReply(request.input);
    const late = port.onmessage;
    if (mode === 'cancel') useAppStore.getState().cancelBeam();
    if (mode === 'revision') useAppStore.getState().editBeam({ kind: 'friction-coefficient', contactId: 'contact-1', source: '0.4' });
    if (mode === 'source') useAppStore.setState(state => ({ documentVersion: state.documentVersion + 1 }));
    late?.(new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } }));
    if (mode === 'current') await vi.waitFor(() => expect(useAppStore.getState().beamSession?.result).toEqual(result));
    else expect(useAppStore.getState().beamSession?.result).toBeNull();
    expect(port.terminated).toBe(1);
  });
});
