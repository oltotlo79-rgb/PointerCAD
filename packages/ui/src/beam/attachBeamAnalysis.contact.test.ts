import type { BeamContactAnalysisResult, FemWorkerPort } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { requireBeamSession } from './beam.testSupport.js';
import { contactResultFor, contactUiFixture, type ContactStateFixture } from './beamContact.testSupport.js';
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

/** Reviews and starts the contact form of beamContact.testSupport.ts with the stated initial gap (mm text). */
async function running(gap: string) {
  const fixture = contactUiFixture(), ports: Port[] = [];
  const session = editBeamSession(fixture.session, { kind: 'contact-value', index: 0, field: 'gap', source: gap });
  useAppStore.setState({ ...fixture.state, beamSession: session });
  attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
  useAppStore.getState().reviewBeam();
  expect(requireBeamSession().errorKey).toBeNull();
  useAppStore.getState().runBeam();
  await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
  const port = ports[0], request = port.request;
  if (request?.kind !== 'analyze-beam-contact-3d') throw new Error('Expected a contact request');
  return { fixture, port, ports, request, input: request.input };
}
const resultEvent = (request: { readonly protocol: unknown; readonly identity: unknown }, result: BeamContactAnalysisResult) =>
  new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } });
// Hand derivation for the 2000 mm flat bar (E = 208 GPa, A = 300 mm2) under 1 N along its axis: u = F L / (E A) in m.
const axial = 1 * 2 / (208e9 * 300e-6);
/** Gap 0: factor 1 pushes the free end onto the plane (closed, 1 N, no motion); factor -1 pulls it away (open). */
const touching: readonly ContactStateFixture[] = [
  { end: [0, 0, 0], state: 'closed', reactionN: 1, gapM: 0 },
  { end: [0, 0, axial], state: 'open', reactionN: 0, gapM: axial },
];

describe('contact analysis in the owned product lifecycle (protocol fixtures)', () => {
  it('sends the CAD-derived contact input with the gap converted once from mm to m', async () => {
    const { request, input, fixture } = await running('0.5');
    expect(request.kind).toBe('analyze-beam-contact-3d');
    expect(input.geometry.nodes).toEqual([
      { id: 'beam-member-1-start', position: [25, 3, 0] }, { id: 'beam-member-1-end', position: [25, 3, 2000] }]);
    expect(input.contacts).toEqual([{ kind: 'node-plane', id: 'contact-1', nodeId: fixture.member.endNodeId,
      normal: [0, 0, 1], gapM: 0.0005 }]);
    expect(input.loadFactors).toEqual([1, -1]);
    expect(input.supports).toEqual([{ nodeId: fixture.member.startNodeId, restrained: [true, true, true, true, true, true] }]);
    expect(input.referenceLoads.map(load => [load.nodeId, load.force])).toEqual([[fixture.member.endNodeId, [0, 0, -1]]]);
  });

  it('publishes an accepted result per load state and releases the worker', async () => {
    const { port, request, input, fixture } = await running('0');
    port.onmessage?.(resultEvent(request, await contactResultFor(input, touching, fixture.member.endNodeId)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    const result = requireBeamSession().result;
    if (result?.kind !== 'oofem-beam-contact-3d') throw new Error('Expected a contact result');
    // Canonical plan order, independent of this result: analysisTranslation.ts numbers nodes after sorting ids by code
    // unit, and the buckling/contact translations keep it, so 'beam-member-1-end' precedes 'beam-member-1-start'.
    expect(fixture.member.endNodeId < fixture.member.startNodeId).toBe(true);
    expect(result.nodeIds).toEqual([fixture.member.endNodeId, fixture.member.startNodeId]);
    expect(result.states.map(state => [state.loadFactor, state.contacts[0].state, state.contacts[0].normalReactionN]))
      .toEqual([[1, 'closed', 1], [-1, 'open', 0]]);
    // Node rows follow nodeIds; read them by id, never by a presumed position.
    const endAt = result.nodeIds.indexOf(fixture.member.endNodeId);
    const startAt = result.nodeIds.indexOf(fixture.member.startNodeId);
    expect(result.states[1].nodes[endAt].displacementM).toEqual([0, 0, axial]);
    expect(result.states[1].nodes[startAt].displacementM).toEqual([0, 0, 0]);
    expect(port.terminated).toBe(1);
    expect(attachment?.statistics()).toEqual({ created: 1, terminated: 1, live: 0 });
  });

  it('keeps the run when only the displayed load state changes', async () => {
    const { port, request, input, fixture } = await running('0');
    useAppStore.getState().editBeam({ kind: 'contact-view', state: 1 });
    expect(port.terminated).toBe(0);
    port.onmessage?.(resultEvent(request, await contactResultFor(input, touching, fixture.member.endNodeId)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
    expect(requireBeamSession().contactView).toEqual({ state: 1 });
  });

  it.each(['cancel', 'edit-gap', 'edit-load', 'remove-contact', 'close'] as const)(
    'a later completion after %s cannot publish a result', async reason => {
      const { fixture, port, request, input } = await running('0');
      const late = port.onmessage;
      const result = await contactResultFor(input, touching, fixture.member.endNodeId);
      if (reason === 'cancel') useAppStore.getState().cancelBeam();
      if (reason === 'edit-gap') useAppStore.getState().editBeam({ kind: 'contact-value', index: 0, field: 'gap', source: '0.1' });
      if (reason === 'edit-load') useAppStore.getState().editBeam({ kind: 'value', id: fixture.member.id, field: 'endFz', source: '-2' });
      if (reason === 'remove-contact') useAppStore.getState().editBeam({ kind: 'contact-remove', index: 0 });
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

  it('refuses a result decoded for a different gap through the existing failure path', async () => {
    const { port, request, input, fixture } = await running('0');
    // Same identity, but the result belongs to another input (gap 0.1 mm): the client rejects the association.
    const other = { ...input, contacts: input.contacts.map(contact => ({ ...contact, gapM: 0.0001 })) };
    port.onmessage?.(resultEvent(request, await contactResultFor(other, [
      { end: [0, 0, 0], state: 'open', reactionN: 0, gapM: 0.0001 },
      { end: [0, 0, axial], state: 'open', reactionN: 0, gapM: 0.0001 + axial },
    ], fixture.member.endNodeId)));
    await vi.waitFor(() => expect(requireBeamSession().status).toBe('failed'));
    const session = requireBeamSession();
    expect([session.errorKey, session.result]).toEqual(['beam.error.runtime', null]);
    expect(session.diagnostic).toContain('invalid-protocol');
    expect(port.terminated).toBe(1);
  });

  it('refuses to start when the reviewed form no longer prepares (pair against its own orientation)', () => {
    const fixture = contactUiFixture(), ports: Port[] = [];
    // A node pair from the end node to the start node must point from A towards B (here -Z); +Z is refused.
    let session = editBeamSession(fixture.session, { kind: 'contact-kind', index: 0, value: 'node-pair' });
    session = editBeamSession(session, { kind: 'contact-node', index: 0, end: 'b', nodeId: fixture.member.startNodeId });
    useAppStore.setState({ ...fixture.state, beamSession: session });
    attachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
    useAppStore.getState().reviewBeam();
    const reviewed = requireBeamSession();
    expect([reviewed.reviewed, reviewed.errorKey]).toEqual([null, 'beam.error.model']);
    expect(reviewed.diagnostic).toContain('contact-orientation');
    useAppStore.getState().runBeam();
    expect(requireBeamSession().errorKey).toBe('beam.error.review');
    expect(ports).toHaveLength(0);
  });
});
