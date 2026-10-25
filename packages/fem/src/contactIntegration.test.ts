import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { contactPivotLimit, type BeamContactDefinition, type BeamContactInput } from './contactModel.js';
import { contactResultMatches, decodeBeamContact, isBeamContactResult } from './contactResults.js';
import { contactInputSha256, translateBeamContact } from './contactTranslation.js';
import { FEM_PROTOCOL, isReply, isRequest, type FemRequest } from './protocol.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';

/** Existing validated geometry: node-0 fully restrained, node-1 free along the member axis only (transient fixture). */
function contactInput(contacts: readonly BeamContactDefinition[], loadFactors: readonly number[] = [1]): BeamContactInput {
  const { geometry, supports, referenceLoads } = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]));
  return { schema: 'pointercad-beam-contact/1', geometry, supports, referenceLoads, contacts, loadFactors };
}
const stop = (normal: readonly [number, number, number]): BeamContactDefinition =>
  ({ kind: 'node-plane', id: 'stop', nodeId: 'node-1', normal, gapM: 1e-3 });

describe('contact translation: exactly the plan beamContact.validate_contact_plan accepts', () => {
  it('drops the buckling node id/fixed and modal fields, maps CAD nodes to solver nodes and keeps every row', () => {
    const { plan, momentLengthM, nodeIds } = translateBeamContact(contactInput([stop([-1, 0, 0])]));
    expect(Object.keys(plan).sort()).toEqual(['contacts', 'loadFactors', 'materials', 'members', 'nodes',
      'originalNodeCount', 'schema', 'sections']);
    for (const node of plan.nodes) expect(Object.keys(node).sort()).toEqual(['load', 'number', 'positionM', 'restrained']);
    expect(nodeIds).toEqual(['node-0', 'node-1']);
    expect(plan.contacts).toEqual([{ id: 'stop', kind: 'node-plane', node: plan.nodes[1]?.number, normal: [-1, 0, 0], gapM: 1e-3 }]);
    expect(momentLengthM).toBe(Math.max(...plan.members.map(member => member.frame.lengthM)));
    expect(momentLengthM).toBeGreaterThan(0);
  });

  it('refuses a reversed pair orientation and opposing stops through the same public entry', () => {
    const { plan } = translateBeamContact(contactInput([stop([-1, 0, 0])]));
    const a = plan.nodes[0]?.positionM ?? [0, 0, 0], b = plan.nodes[1]?.positionM ?? [0, 0, 0];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const reversed: readonly [number, number, number] = [(a[0] - b[0]) / length, (a[1] - b[1]) / length, (a[2] - b[2]) / length];
    expect(() => translateBeamContact(contactInput([{ kind: 'node-pair', id: 'tie', nodeIdA: 'node-0', nodeIdB: 'node-1',
      normal: reversed, gapM: 0.01 }]))).toThrow(/^contact-orientation/u);
    expect(() => translateBeamContact(contactInput([stop([1, 0, 0]), { ...stop([-1, 0, 0]), id: 'other' }])))
      .toThrow(/^contact-two-sided/u);
    expect(() => translateBeamContact({ ...contactInput([stop([-1, 0, 0])]), extra: 1 })).toThrow(/^contact-shape/u);
    // Unknown runtime data with holes (built without delete) is refused as a shape error, never a TypeError.
    const holes = <T,>(first: T): T[] => { const items = new Array<T>(2); items[1] = first; return items; };
    expect(() => translateBeamContact({ ...contactInput([stop([-1, 0, 0])]), contacts: holes(stop([-1, 0, 0])) }))
      .toThrow(/^contact-shape/u);
    expect(() => translateBeamContact({ ...contactInput([stop([-1, 0, 0])]), loadFactors: holes(1) })).toThrow(/^contact-shape/u);
    const sparseNormal = new Array<number>(3);
    sparseNormal[0] = -1;
    sparseNormal[2] = 0;
    expect(() => translateBeamContact({ ...contactInput([stop([-1, 0, 0])]), contacts: [{ ...stop([-1, 0, 0]), normal: sparseNormal }] }))
      .toThrow(/^contact-number/u);
  });
});

describe('protocol and result binding of analyze-beam-contact-3d', () => {
  const input = contactInput([stop([-1, 0, 0])]);
  const identity = { documentId: input.geometry.source.documentId, revision: input.geometry.revision, generation: 1, requestId: 'fem-1' };
  const { plan, momentLengthM } = translateBeamContact(input);
  /** A complete numeric result of the plan's shape: node-0 at rest, node-1 moved along its free axis only. */
  const raw = (node0: readonly number[] = [0, 0, 0]) => ({ schema: 'pointercad-oofem-contact-result/1',
    method: 'murty-least-index-lcp-on-native-beam3d-stiffness', freeDofs: 1, meshNodes: plan.nodes.length,
    meshElements: plan.members.length, momentLengthM, pivotLimit: contactPivotLimit(1), states: [{
      loadFactor: 1, pivots: 1, nodes: [{ number: plan.nodes[0]?.number, displacementM: node0, rotationRad: [0, 0, 0] },
        { number: plan.nodes[1]?.number, displacementM: [1e-3, 0, 0], rotationRad: [0, 0, 0] }],
      contacts: [{ id: 'stop', state: 'closed', normalReactionN: 300, gapM: 0 }], forceScaleN: 1000, gapScaleM: 1e-2,
      equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0 }] });

  it('accepts only a request bound to the geometry identity with exactly four keys', () => {
    const request: FemRequest = { protocol: FEM_PROTOCOL, kind: 'analyze-beam-contact-3d', identity, input };
    expect(isRequest(request)).toBe(true);
    expect(isRequest({ ...request, identity: { ...identity, revision: identity.revision + 1 } })).toBe(false);
    expect(isRequest({ ...request, extra: 1 })).toBe(false);
    expect(isRequest({ ...request, input: { ...input, contacts: [] } })).toBe(false);
  });

  it('binds the numeric result to the exact input and digest, and rejects stale or foreign results', async () => {
    const hash = await contactInputSha256(input);
    const result = decodeBeamContact(raw(), input, hash);
    expect(result).toMatchObject({ kind: 'oofem-beam-contact-3d', nativeContactSolver: false, structuralCertification: false,
      analysisId: input.geometry.id, inputSha256: hash, nodeIds: ['node-0', 'node-1'] });
    expect(isBeamContactResult(result)).toBe(true);
    expect(contactResultMatches(result, input, hash)).toBe(true);
    expect(contactResultMatches(result, input, '0'.repeat(64))).toBe(false);
    // A result computed for another input (other gap) carries that input's digest, never this one.
    const other = contactInput([{ ...stop([-1, 0, 0]), gapM: 2e-3 }]);
    expect(contactResultMatches(result, other, await contactInputSha256(other))).toBe(false);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity, result })).toBe(true);
    // A restrained component that moved is a broken support, not a contact result.
    expect(() => decodeBeamContact(raw([1e-6, 0, 0]), input, hash)).toThrow(/prescribed support/u);
  });

  it('runs through FemClient with the existing cancellation and stale-identity guards', async () => {
    const hash = await contactInputSha256(input);
    const result = decodeBeamContact(raw(), input, hash);
    const ports: { readonly port: FemWorkerPort; readonly sent: FemRequest[] }[] = [];
    const client = new FemClient(() => {
      const sent: FemRequest[] = [];
      const port: FemWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
        postMessage: message => { sent.push(message); }, terminate: () => undefined };
      ports.push({ port, sent });
      return port;
    });
    const completed = client.analyzeContact(input);
    const first = ports[0];
    expect(first?.sent[0]?.kind).toBe('analyze-beam-contact-3d');
    const sentIdentity = first?.sent[0]?.identity;
    first?.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: sentIdentity, result } }));
    await expect(completed).resolves.toMatchObject({ kind: 'result' });

    const aborted = new AbortController();
    const cancelled = client.analyzeContact(input, { signal: aborted.signal });
    aborted.abort();
    await expect(cancelled).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });

    const stale = client.analyzeContact(input);
    const third = ports[2];
    third?.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
      identity: { ...third.sent[0]?.identity, requestId: 'fem-0' }, result } }));
    await expect(stale).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    client.dispose();
  });
});
