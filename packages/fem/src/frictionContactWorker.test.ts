import { afterEach, describe, expect, it, vi } from 'vitest';
import { bucklingFixture } from './buckling.testSupport.js';
import { FEM_PROTOCOL } from './protocol.js';
import { decodeFrictionContact } from './frictionContactResults.js';
import { frictionContactInputSha256 } from './frictionContactBinding.js';
import type * as Offline from './offlineBrowser.js';
vi.mock('./offlineBrowser.js', async importOriginal => ({
  ...await importOriginal<typeof Offline>(), analyzeFrictionContactInBrowser: vi.fn(),
}));
import { analyzeFrictionContactInBrowser } from './offlineBrowser.js';

function input() {
  const base = bucklingFixture({ segments: 1 });
  return { schema: 'pointercad-beam-friction-contact/1', geometry: base.geometry, supports: base.supports,
    contacts: [{ kind: 'node-plane', id: 'floor', nodeId: 'node-1', normal: [0, 0, 1], gapM: 0 }],
    friction: { floor: .3 }, stepLoads: [[{ id: 'load', kind: 'nodal', nodeId: 'node-1', force: [2, 0, 0], moment: [0, 0, 0] }]] };
}
function gateway() {
  const replies: unknown[] = [], close = vi.fn();
  const worker: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (v: unknown) => void; close: () => void } = {
    onmessage: null, postMessage: value => replies.push(value), close,
  };
  vi.stubGlobal('self', worker);
  return { worker, replies, close };
}
function request() {
  const value = input();
  return { protocol: FEM_PROTOCOL, kind: 'analyze-beam-friction-contact',
    identity: { documentId: value.geometry.source.documentId, revision: value.geometry.revision, generation: 1, requestId: 'fem-1' },
    input: value, solverOptions: { solver: 'newton', iterationLimit: 64 } };
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });
describe('friction one-shot Worker dispatch (mock browser)', () => {
  it('dispatches input and options once, emits phase/result and closes once', async () => {
    const g = gateway(), browser = vi.mocked(analyzeFrictionContactInBrowser);
    const value = input(), options = { solver: 'newton' as const, iterationLimit: 64 };
    const numeric = { kind: 'pointercad-internal-friction-contact-candidate', solver: 'newton', iterationLimit: 64,
      freeDofs: 6, states: [{ step: 0, iterations: 1, forceScaleN: 10, gapScaleM: 1e-5,
        equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0, frictionConeExcess: 0, slipLawResidual: 0,
        nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
          { number: 2, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] }],
        contacts: [{ id: 'floor', state: 'stick', frictionCoefficient: .3, normalReactionN: 10, gapM: 0,
          frictionForceN: [-2, 0, 0], slipIncrementM: [0, 0, 0], accumulatedSlipM: [0, 0, 0], slipPathLengthM: 0, dissipatedWorkJ: 0 }] }] };
    const result = decodeFrictionContact(numeric, value, await frictionContactInputSha256(value), options);
    browser.mockImplementation((_input, _options, notify) => {
      notify('solving'); return Promise.resolve(result);
    });
    await import('./worker.js'); g.worker.onmessage?.(new MessageEvent('message', { data: request() }));
    await vi.waitFor(() => expect(g.close).toHaveBeenCalledOnce());
    expect(browser).toHaveBeenCalledOnce();
    expect(browser.mock.calls[0][0]).toEqual(request().input);
    expect(browser.mock.calls[0][1]).toEqual(request().solverOptions);
    expect(g.replies).toMatchObject([{ kind: 'phase', phase: 'solving' }, { kind: 'result' }]);
  });
  it('rejects invalid or foreign input before invoking the browser or its assets', async () => {
    const g = gateway(), browser = vi.mocked(analyzeFrictionContactInBrowser);
    await import('./worker.js'); const r = request();
    g.worker.onmessage?.(new MessageEvent('message', { data: { ...r, identity: { ...r.identity, documentId: 'foreign' } } }));
    g.worker.onmessage?.(new MessageEvent('message', { data: r }));
    expect(browser).not.toHaveBeenCalled(); expect(g.close).toHaveBeenCalledOnce();
  });
  it('rejects a second message without starting a second solver', async () => {
    const g = gateway(), browser = vi.mocked(analyzeFrictionContactInBrowser);
    let rejectFirst: (reason?: unknown) => void = () => { throw new Error('not dispatched'); };
    browser.mockImplementation(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    await import('./worker.js'); g.worker.onmessage?.(new MessageEvent('message', { data: request() }));
    g.worker.onmessage?.(new MessageEvent('message', { data: request() }));
    expect(browser).toHaveBeenCalledOnce(); expect(g.close).toHaveBeenCalledOnce();
    rejectFirst(new Error('late solver failure'));
    await expect(browser.mock.results[0].value).rejects.toThrow('late solver failure');
    await Promise.resolve(); await Promise.resolve();
    expect(g.close).toHaveBeenCalledOnce(); expect(g.replies).toEqual([]);
  });
  it('classifies a solver rejection and closes once', async () => {
    const g = gateway(), browser = vi.mocked(analyzeFrictionContactInBrowser);
    browser.mockImplementation((_input, _options, notify) => { notify('solving'); return Promise.reject(new Error('friction-failed')); });
    await import('./worker.js'); g.worker.onmessage?.(new MessageEvent('message', { data: request() }));
    await vi.waitFor(() => expect(g.close).toHaveBeenCalledOnce());
    expect(g.replies).toMatchObject([{ kind: 'phase', phase: 'solving' }, { kind: 'failure', failure: { code: 'solver-failed' } }]);
  });
});
