import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isRequest, isReply, type FemRequest } from './protocol.js';
import { decodeSolidFinite } from './solidFiniteResults.js';
import { SOLID_FINITE_KIND, decodeSolidFiniteWireResult, isSolidFiniteWireResult } from './solidFiniteBinding.js';
import { solidFiniteInputSha256 } from './solidFiniteTranslation.js';
import { finiteInput, finiteNative } from './solidFiniteTransport.testSupport.js';

const identity = { documentId: 'doc', revision: 3, generation: 1, requestId: 'finite-1' };
const request = () => ({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-finite-j2', identity, input: finiteInput() });
async function wire() {
  const input = finiteInput();
  return { kind: SOLID_FINITE_KIND, result: await decodeSolidFinite(finiteNative(), input, await solidFiniteInputSha256(input)) };
}
function port() {
  const sent: FemRequest[] = [];
  let terminations = 0;
  const worker: FemWorkerPort = { postMessage: value => { sent.push(value); }, terminate: () => { terminations++; },
    onmessage: null, onerror: null, onmessageerror: null };
  const reply = (result: unknown): void => { worker.onmessage?.(new MessageEvent<unknown>('message', { data: {
    protocol: FEM_PROTOCOL, kind: 'result', identity: sent[0].identity, result } })); };
  return { worker, sent, reply, terminations: () => terminations };
}

describe('finite J2 wire transport; synthetic records, no native execution', () => {
  it('admits only a validated plan bound to the request identity', () => {
    expect(isRequest(request())).toBe(true);
    expect(isRequest({ ...request(), identity: { ...identity, revision: 4 } })).toBe(false);
    expect(isRequest({ ...request(), input: { ...finiteInput(), plan: { ...finiteInput().plan, steps: 0 } } })).toBe(false);
    expect(isRequest({ ...request(), python: 'arbitrary source' })).toBe(false);
  });
  it('keeps kindless W34 records out of the result union and preserves wrapped numerical values', async () => {
    const result = await wire();
    const reply = { protocol: FEM_PROTOCOL, kind: 'result', identity, result };
    expect(isReply(reply)).toBe(true);
    expect(isReply({ ...reply, result: result.result })).toBe(false);
    const decoded = await decodeSolidFiniteWireResult(result, finiteInput(), result.result.inputSha256);
    expect(decoded).toEqual(result);
    expect(decoded.result.records[0].elements[0].P[0]).toBe(200);
  });
  it.each(['partial', 'refused', 'retained', 'failed', 'extra', 'numeric'] as const)('refuses %s numerical replies', async failure => {
    const result = await wire();
    const changed = failure === 'partial' ? { ...result.result, records: [] }
      : failure === 'refused' ? { ...result.result, refusedCommits: [{}] }
      : failure === 'retained' ? { ...result.result, retainedNativeAnalyses: 2 }
      : failure === 'failed' ? { status: 'failed', records: result.result.records }
      : failure === 'extra' ? { ...result.result, completed: true }
      : { ...result.result, records: [{ ...result.result.records[0], freeResidualRatio: 1 }] };
    expect(isSolidFiniteWireResult({ ...result, result: changed })).toBe(false);
  });
  it.each(['digest', 'revision', 'plan'] as const)('client refuses a reply for another %s', async changed => {
    const p = port(), client = new FemClient(() => p.worker), result = await wire();
    const promise = client.analyzeSolidFinite(finiteInput());
    const input = result.result.input;
    const wrong = changed === 'digest' ? { ...result.result, inputSha256: '0'.repeat(64) }
      : { ...result.result, input: changed === 'revision' ? { ...input, source: { ...input.source, revision: 4 } }
        : { ...input, plan: { ...input.plan, material: { ...input.plan.material, youngMPa: 190000 } } } };
    p.reply({ ...result, result: wrong });
    expect(await promise).toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    expect(p.terminations()).toBe(1);
  });
  it('accepts a matching result and terminates its Worker', async () => {
    const p = port(), client = new FemClient(() => p.worker), result = await wire();
    const promise = client.analyzeSolidFinite(finiteInput());
    expect(p.sent[0].kind).toBe('analyze-solid-finite-j2');
    p.reply(result);
    expect(await promise).toMatchObject({ kind: 'result', result });
    expect(p.terminations()).toBe(1); expect(p.worker.onmessage).toBeNull();
  });
  it.each(['abort', 'disposed', 'superseded'] as const)('keeps existing %s semantics and cannot revive a late result', async reason => {
    const p = port(), client = new FemClient(() => p.worker), result = await wire(), abort = new AbortController();
    const promise = client.analyzeSolidFinite(finiteInput(), { signal: abort.signal });
    const old = p.worker.onmessage;
    if (reason === 'abort') abort.abort();
    else if (reason === 'disposed') client.dispose();
    else await expect(client.analyzeSolidFinite({})).rejects.toThrow();
    old?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: p.sent[0].identity, result } }));
    expect(await promise).toMatchObject({ kind: 'cancelled', reason }); expect(p.terminations()).toBe(1);
  });
  it('supersedes CAD preparation using the same client owner before finite dispatch', async () => {
    const p = port(), client = new FemClient(() => p.worker), lease = client.beginSolidContactPreparation();
    const promise = client.analyzeSolidFinite(finiteInput());
    expect(lease.cancellation()).toBe('superseded');
    lease.release(); expect(p.terminations()).toBe(0);
    client.dispose(); expect(await promise).toMatchObject({ kind: 'cancelled', reason: 'disposed' });
  });
});
