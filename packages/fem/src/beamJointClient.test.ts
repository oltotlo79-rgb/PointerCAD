import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isRequest, type FemRequest } from './protocol.js';
import { beamJointContactInputSha256, decodeBeamJointContact } from './beamJointContact.js';
import { jointTestInput, jointTestRaw } from './beamJointContact.testSupport.js';

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

describe('mixed connector result ownership', () => {
  it('accepts the independent simultaneous load split on exactly one validated request', async () => {
    const source = jointTestInput(), result = decodeBeamJointContact(jointTestRaw(), source, await beamJointContactInputSha256(source));
    const { client, workers } = rig(), complete = client.analyzeJointContact(source), worker = workers[0], request = worker.sent[0];
    expect(workers).toHaveLength(1);
    expect(request.kind).toBe('analyze-beam-joint-contact');
    expect(isRequest(request)).toBe(true);
    expect(isRequest({ ...request, identity: { ...request.identity, revision: request.identity.revision + 1 } })).toBe(false);
    worker.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
    await expect(complete).resolves.toMatchObject({ kind: 'result', result });
    expect(worker.terminated).toBe(1);
    client.dispose();
  });
  it.each(['bolt', 'weld'] as const)('refuses a stale %s digest even with the current worker identity', async family => {
    const source = jointTestInput(), result = decodeBeamJointContact(jointTestRaw(), source, await beamJointContactInputSha256(source));
    const changed = family === 'bolt' ? { ...source, bolts: [{ ...source.bolts[0], areaM2: .002 }] }
      : { ...source, welds: [{ ...source.welds[0], thicknessM: .5 }] };
    const { client, workers } = rig(), complete = client.analyzeJointContact(changed), worker = workers[0];
    worker.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: worker.sent[0].identity, result } }));
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    expect(worker.terminated).toBe(1);
    client.dispose();
  });
  it('terminates superseded and aborted mixed requests and ignores a captured late valid result', async () => {
    const source = jointTestInput(), result = decodeBeamJointContact(jointTestRaw(), source, await beamJointContactInputSha256(source));
    const { client, workers } = rig(), first = client.analyzeJointContact(source), old = workers[0], late = old.port.onmessage;
    const controller = new AbortController(), second = client.analyzeJointContact(source, { signal: controller.signal });
    await expect(first).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    late?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: old.sent[0].identity, result } }));
    controller.abort();
    await expect(second).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(workers.map(worker => worker.terminated)).toEqual([1, 1]);
    client.dispose();
  });
  it('rejects a combined envelope with a single-family force substituted', async () => {
    const source = jointTestInput(), decoded = decodeBeamJointContact(jointTestRaw(), source, await beamJointContactInputSha256(source));
    const result = { ...decoded, states: decoded.states.map(state => ({ ...state,
      bolts: state.bolts.map(bolt => ({ ...bolt, axialForceN: 500 })) })) };
    const { client, workers } = rig(), complete = client.analyzeJointContact(source), worker = workers[0];
    worker.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: worker.sent[0].identity, result } }));
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    expect(worker.terminated).toBe(1);
    client.dispose();
  });
});
