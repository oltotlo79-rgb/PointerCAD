import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isRequest, type FemRequest } from './protocol.js';
import { beamBoltContactInputSha256, decodeBeamBoltContact, type BeamBoltContactInput } from './beamBoltContact.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';

function input(): BeamBoltContactInput {
  const { geometry, supports, referenceLoads } = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]));
  return { schema: 'pointercad-bolt-contact/1', contact: { schema: 'pointercad-beam-contact/1', geometry, supports,
    referenceLoads, contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'node-1', normal: [-1, 0, 0], gapM: 0.001 }],
    loadFactors: [1] }, bolts: [{ id: 'bolt', nodeIdA: 'node-0', nodeIdB: 'node-1', youngPa: 210e9, areaM2: 0.001 }] };
}
function rig() {
  const workers: { port: FemWorkerPort; sent: FemRequest[]; terminated: number }[] = [];
  const client = new FemClient(() => {
    const sent: FemRequest[] = [];
    const entry = { sent, terminated: 0, port: {
      postMessage: (request: FemRequest) => { sent.push(request); }, terminate: () => { entry.terminated += 1; },
      onmessage: null, onerror: null, onmessageerror: null,
    } as FemWorkerPort };
    workers.push(entry); return entry.port;
  });
  return { client, workers };
}
async function response(source: BeamBoltContactInput) {
  const u = 1000 / 420e6;
  return decodeBeamBoltContact({ schema: 'pointercad-bolt-contact-result/1',
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: 1, meshNodes: 2, meshElements: 1, momentLengthM: 1, pivotLimit: 20,
      states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1000, gapScaleM: .001, equilibriumResidual: 0,
        penetration: 0, tension: 0, complementarity: 0,
        nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
          { number: 2, displacementM: [u, 0, 0], rotationRad: [0, 0, 0] }],
        contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .001 - u }] }] },
    states: [{ loadFactor: 1, bolts: [{ id: 'bolt', extensionM: u, axialForceN: 500,
      forceOnAN: [500, 0, 0], forceOnBN: [-500, 0, 0] }] }] }, source, await beamBoltContactInputSha256(source));
}
describe('bolt contact uses the existing owned worker lifecycle', () => {
  it('sends a validated request and accepts only the bound coupled result', async () => {
    const source = input(), result = await response(source), { client, workers } = rig();
    const complete = client.analyzeBoltContact(source), worker = workers[0], request = worker.sent[0];
    expect(request.kind).toBe('analyze-beam-bolt-contact'); expect(isRequest(request)).toBe(true);
    expect(isRequest({ ...request, identity: { ...request.identity, revision: request.identity.revision + 1 } })).toBe(false);
    worker.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
    await expect(complete).resolves.toMatchObject({ kind: 'result', result: { kind: 'oofem-beam-axial-bolt-contact' } });
    expect(worker.terminated).toBe(1); client.dispose();
  });
  it('terminates superseded and aborted requests and ignores a saved late reply callback', async () => {
    const source = input(), result = await response(source), { client, workers } = rig();
    const first = client.analyzeBoltContact(source), old = workers[0], late = old.port.onmessage;
    const controller = new AbortController(), second = client.analyzeBoltContact(source, { signal: controller.signal });
    await expect(first).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    late?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: old.sent[0].identity, result } }));
    controller.abort(); await expect(second).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(workers.map(worker => worker.terminated)).toEqual([1, 1]); client.dispose();
  });
  it('refuses a stale bolt-property digest even with the current worker identity', async () => {
    const source = input(), result = await response(source), { client, workers } = rig();
    const changed = { ...source, bolts: [{ ...source.bolts[0], areaM2: .002 }] };
    const complete = client.analyzeBoltContact(changed), worker = workers[0];
    worker.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: worker.sent[0].identity, result } }));
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    client.dispose();
  });
});
