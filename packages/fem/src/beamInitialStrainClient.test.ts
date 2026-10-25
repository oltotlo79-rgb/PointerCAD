import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isRequest, type FemRequest } from './protocol.js';
import { beamJointInitialStrainInputSha256, decodeBeamJointInitialStrain } from './beamJointInitialStrain.js';
import { initialStrainTestInput as input, initialStrainTestRaw as raw } from './beamJointInitialStrain.testSupport.js';

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
describe('initial strain owned request and result', () => {
  it('accepts the nonzero zero-load shank force on one strictly bound request', async () => {
    const source = input(), result = decodeBeamJointInitialStrain(raw(), source, await beamJointInitialStrainInputSha256(source));
    const { client, workers } = rig(), complete = client.analyzeJointInitialStrain(source), worker = workers[0], request = worker.sent[0];
    expect(workers).toHaveLength(1);
    expect(request.kind).toBe('analyze-beam-joint-initial-strain');
    expect(isRequest(request)).toBe(true);
    expect(isRequest({ ...request, identity: { ...request.identity, revision: request.identity.revision+1 } })).toBe(false);
    worker.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
    await expect(complete).resolves.toMatchObject({ kind: 'result', result });
    expect(result.states[1].bolts[0].axialForceN).toBeCloseTo(140, 9);
    expect(worker.terminated).toBe(1);
    client.dispose();
  });
  it('refuses the old shortening digest even if both connector families and the worker identity agree', async () => {
    const old = input(0), result = decodeBeamJointInitialStrain(raw(0), old, await beamJointInitialStrainInputSha256(old));
    const { client, workers } = rig(), complete = client.analyzeJointInitialStrain(input()), worker = workers[0];
    worker.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: worker.sent[0].identity, result } }));
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    expect(worker.terminated).toBe(1);
    client.dispose();
  });
  it('supersedes and aborts the initial-strain solve, ignoring a captured late valid result', async () => {
    const source = input(), result = decodeBeamJointInitialStrain(raw(), source, await beamJointInitialStrainInputSha256(source));
    const { client, workers } = rig(), first = client.analyzeJointInitialStrain(source), old = workers[0], late = old.port.onmessage;
    const controller = new AbortController(), second = client.analyzeJointInitialStrain(source, { signal: controller.signal });
    await expect(first).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    late?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: old.sent[0].identity, result } }));
    controller.abort();
    await expect(second).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(workers.map(worker => worker.terminated)).toEqual([1, 1]);
    client.dispose();
  });
});
