import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEM_PROTOCOL, type FemReply } from './protocol.js';
import { finiteInput, finiteNative } from './solidFiniteTransport.testSupport.js';
import { decodeSolidFinite } from './solidFiniteResults.js';
import { solidFiniteInputSha256 } from './solidFiniteTranslation.js';
import { SOLID_FINITE_KIND } from './solidFiniteBinding.js';
const calls = vi.hoisted(() => ({ finite: vi.fn() }));
// Worker dispatch/closure test only; this does not replace or certify the native runtime.
vi.mock('./offlineBrowser.js', () => ({ analyzeSolidFiniteInBrowser: calls.finite }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); calls.finite.mockReset(); });
const input = finiteInput();
const request = { protocol: FEM_PROTOCOL, kind: 'analyze-solid-finite-j2',
  identity: { documentId: 'doc', revision: 3, generation: 1, requestId: 'finite-1' }, input };
async function scope() {
  const replies: FemReply[] = [];
  const worker: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (value: FemReply) => void; close: () => void } = {
    onmessage: null, postMessage: value => { replies.push(value); }, close: vi.fn() };
  vi.stubGlobal('self', worker);
  await import('./worker.js');
  return { worker, replies, send: (value: unknown) => { worker.onmessage?.(new MessageEvent<unknown>('message', { data: value })); } };
}
describe('finite one-shot Worker dispatch', () => {
  it('routes only the finite input and closes after one completed reply', async () => {
    const result = { kind: SOLID_FINITE_KIND, result: await decodeSolidFinite(finiteNative(), input, await solidFiniteInputSha256(input)) };
    calls.finite.mockResolvedValue(result);
    const s = await scope(); s.send(request);
    await vi.waitFor(() => { expect(s.worker.close).toHaveBeenCalledTimes(1); });
    expect(calls.finite).toHaveBeenCalledTimes(1); expect(calls.finite.mock.calls[0][0]).toEqual(input);
    expect(s.replies).toEqual([{ protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result }]);
    s.send(request); expect(calls.finite).toHaveBeenCalledTimes(1); expect(s.worker.close).toHaveBeenCalledTimes(1);
  });
  it('a thrown native/decoder failure is never published as a completed result', async () => {
    calls.finite.mockImplementation((_input, notify: (phase: string) => void) => {
      notify('solving'); return Promise.reject(new Error('finite-equilibrium: rejected commit'));
    });
    const s = await scope(); s.send(request);
    await vi.waitFor(() => { expect(s.worker.close).toHaveBeenCalledTimes(1); });
    expect(s.replies.map(reply => reply.kind)).toEqual(['phase', 'failure']);
    expect(s.replies[1]).toMatchObject({ failure: { code: 'solver-failed', message: 'finite-equilibrium: rejected commit' } });
  });
  it('a second request during the first call closes without reusing runtime or publishing stale completion', async () => {
    let reject: ((reason: Error) => void) | undefined;
    calls.finite.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const s = await scope(); s.send(request); s.send(request);
    expect(s.worker.close).toHaveBeenCalledTimes(1); expect(calls.finite).toHaveBeenCalledTimes(1);
    reject?.(new Error('first computation ended'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(s.replies).toEqual([]); expect(s.worker.close).toHaveBeenCalledTimes(1);
  });
  it('refuses a mismatched request before calling the offline boundary', async () => {
    const s = await scope(); s.send({ ...request, identity: { ...request.identity, revision: 99 } });
    expect(calls.finite).not.toHaveBeenCalled(); expect(s.worker.close).toHaveBeenCalledTimes(1);
  });
});
