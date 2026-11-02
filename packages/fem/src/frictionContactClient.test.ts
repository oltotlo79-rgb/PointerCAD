import { afterEach, describe, expect, it, vi } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isReply, isRequest, type FemRequest } from './protocol.js';
import { bucklingFixture } from './buckling.testSupport.js';
import { decodeFrictionContact, type FrictionSolveOptions } from './frictionContactResults.js';
import { frictionContactInputSha256, isFrictionContactResult } from './frictionContactBinding.js';
import type { BeamFrictionContactInput } from './frictionContactTranslation.js';

function input(): BeamFrictionContactInput {
  const base = bucklingFixture({ segments: 1, millimetres: false });
  return { schema: 'pointercad-beam-friction-contact/1', geometry: base.geometry, supports: base.supports,
    contacts: [{ kind: 'node-plane', id: 'floor', nodeId: 'node-1', normal: [0, 0, 1], gapM: 0 }],
    friction: { floor: 0.3 }, stepLoads: [2, 3, 0, -3].map((x, i) => [{ id: 'load-' + i, kind: 'nodal',
      nodeId: 'node-1', force: [x, 0, 0], moment: [0, 0, 0] }]) };
}
/** Independent hand-built reader path: N=10, mu=.3, t=(-2,-3,0,+3).
 * Open movement is excluded from accumulated slip; these are mock results, not a native solve. */
function raw(solver: 'newton' | 'nsgs', limit: number) {
  const rows = [
    { state: 'stick', n: 10, t: -2, x: 0, ds: 0, acc: 0, path: 0, work: 0 },
    { state: 'slip', n: 10, t: -3, x: 1e-7, ds: 1e-7, acc: 1e-7, path: 1e-7, work: 3e-7 },
    { state: 'open', n: 0, t: 0, x: 0, ds: -1e-7, acc: 1e-7, path: 1e-7, work: 3e-7 },
    { state: 'slip', n: 10, t: 3, x: -1e-7, ds: -1e-7, acc: 0, path: 2e-7, work: 6e-7 },
  ];
  return { kind: 'pointercad-internal-friction-contact-candidate', solver, iterationLimit: limit, freeDofs: 6,
    states: rows.map((r, step) => ({ step, iterations: 2, forceScaleN: 10, gapScaleM: 1e-5,
      equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0, frictionConeExcess: 0, slipLawResidual: 0,
      nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
        { number: 2, displacementM: [r.x, 0, 0], rotationRad: [0, 0, 0] }],
      contacts: [{ id: 'floor', state: r.state, frictionCoefficient: .3, normalReactionN: r.n, gapM: 0,
        frictionForceN: [r.t, 0, 0], slipIncrementM: [r.ds, 0, 0], accumulatedSlipM: [r.acc, 0, 0],
        slipPathLengthM: r.path, dissipatedWorkJ: r.work }] })) };
}
function rig() {
  const workers: { port: FemWorkerPort; sent: FemRequest[]; terminated: number }[] = [];
  const client = new FemClient(() => {
    const sent: FemRequest[] = [];
    const entry = { sent, terminated: 0, port: { postMessage: (message: FemRequest) => { sent.push(message); },
      terminate: () => { entry.terminated++; }, onmessage: null, onerror: null, onmessageerror: null } as FemWorkerPort };
    workers.push(entry); return entry.port;
  });
  return { client, workers };
}
async function response(value: BeamFrictionContactInput, options: FrictionSolveOptions) {
  return decodeFrictionContact(raw(options.solver, options.iterationLimit), value, await frictionContactInputSha256(value), options);
}
function reply(w: ReturnType<typeof rig>['workers'][number], result: unknown, identity = w.sent[0].identity) {
  w.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity, result } }));
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('friction client and protocol (pure mock)', () => {
  it.each([['newton', 64], ['nsgs', 20000]] as const)('accepts fully bound %s result', async (solver, iterationLimit) => {
    const value = input(), options = { solver, iterationLimit }, result = await response(value, options);
    const { client, workers } = rig(), complete = client.analyzeFrictionContact(value, options), w = workers[0];
    expect(w.sent[0].kind).toBe('analyze-beam-friction-contact'); expect(isRequest(w.sent[0])).toBe(true);
    expect(isFrictionContactResult(result)).toBe(true);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity: w.sent[0].identity, result })).toBe(true);
    reply(w, result); await expect(complete).resolves.toMatchObject({ kind: 'result', result: { solver } });
    expect(w.terminated).toBe(1); client.dispose();
  });
  it('owns request, solver options and phase callback before asynchronous result', async () => {
    const value = input(), owned = structuredClone(value), options: { solver: 'newton' | 'nsgs'; iterationLimit: number } = { solver: 'newton', iterationLimit: 64 };
    const result = await response(owned, options), onPhase = vi.fn(), changed = vi.fn(), extra = { onPhase };
    const { client, workers } = rig(), complete = client.analyzeFrictionContact(value, options, extra), w = workers[0];
    Object.assign(value.geometry, { revision: 999 }); Object.assign(value.friction, { floor: .8 });
    options.solver = 'nsgs'; options.iterationLimit = 1; extra.onPhase = changed;
    expect(w.sent[0]).toMatchObject({ input: owned, solverOptions: { solver: 'newton', iterationLimit: 64 } });
    w.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'phase', identity: w.sent[0].identity, phase: 'solving' } }));
    reply(w, result); await expect(complete).resolves.toMatchObject({ kind: 'result' });
    expect(onPhase).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled(); client.dispose();
  });
  it('refuses invalid input/options and accessor without creating a Worker', async () => {
    const { client, workers } = rig();
    await expect(client.analyzeFrictionContact({ ...input(), extra: true }, { solver: 'newton', iterationLimit: 64 })).rejects.toThrow();
    await expect(client.analyzeFrictionContact(input(), { solver: 'newton', iterationLimit: NaN })).rejects.toThrow();
    const getter = vi.fn(() => 64);
    await expect(client.analyzeFrictionContact(input(), { solver: 'newton', get iterationLimit() { return getter(); } })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(workers).toHaveLength(0); client.dispose();
  });
  it('rejects missing, sparse and nonfinite input or options before Worker creation', async () => {
    const base = input(), hole = new Array<unknown>(1);
    const malformed = [
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'contacts')),
      { ...base, stepLoads: hole }, { ...base, friction: { floor: Infinity } },
      { ...base, stepLoads: [[{ ...base.stepLoads[0][0], force: [NaN, 0, 0] }]] },
    ];
    const { client, workers } = rig();
    for (const value of malformed) await expect(client.analyzeFrictionContact(value, { solver: 'newton', iterationLimit: 64 })).rejects.toThrow();
    for (const value of [{ solver: 'newton' }, { solver: 'newton', iterationLimit: 64, extra: 0 },
      { solver: 'newton', iterationLimit: Infinity }]) {
      expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-friction-contact',
        identity: { documentId: base.geometry.source.documentId, revision: base.geometry.revision, generation: 1, requestId: 'x' },
        input: base, solverOptions: value })).toBe(false);
    }
    expect(workers).toHaveLength(0); client.dispose();
  });
  it('rejects foreign document/revision, unknown fields, options and getters before dispatch', () => {
    const { client, workers } = rig(); void client.analyzeFrictionContact(input(), { solver: 'newton', iterationLimit: 64 });
    const r = workers[0].sent[0];
    expect(isRequest({ ...r, identity: { ...r.identity, documentId: 'foreign' } })).toBe(false);
    expect(isRequest({ ...r, identity: { ...r.identity, revision: r.identity.revision + 1 } })).toBe(false);
    expect(isRequest({ ...r, extra: true })).toBe(false);
    expect(isRequest({ ...r, solverOptions: { solver: 'newton', iterationLimit: 64, extra: 0 } })).toBe(false);
    const getter = vi.fn(() => 'bad');
    expect(isRequest({ ...r, get input() { return getter(); } })).toBe(false); expect(getter).not.toHaveBeenCalled();
    client.dispose();
  });
  it.each(['hash', 'source', 'revision', 'result'] as const)('rejects stale or modified %s result', async reason => {
    const value = input(), options = { solver: 'newton' as const, iterationLimit: 64 }, result = await response(value, options);
    const changed = structuredClone(result);
    if (reason === 'hash') Object.assign(changed, { inputSha256: 'b'.repeat(64) });
    if (reason === 'source') Object.assign(changed.source, { documentId: 'foreign' });
    if (reason === 'revision') Object.assign(changed, { analysisRevision: 999 });
    if (reason === 'result') Object.assign(changed.states[0].contacts[0], { frictionCoefficient: .9 });
    const { client, workers } = rig(), complete = client.analyzeFrictionContact(value, options);
    reply(workers[0], changed); await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    client.dispose();
  });
  it('refuses a foreign reply identity and does not invoke a result getter', async () => {
    const value = input(), options = { solver: 'newton' as const, iterationLimit: 64 }, result = await response(value, options);
    const getter = vi.fn(() => result.input);
    const hostile = { ...result, get input() { return getter(); } };
    expect(isFrictionContactResult(hostile)).toBe(false); expect(getter).not.toHaveBeenCalled();
    const { client, workers } = rig(), complete = client.analyzeFrictionContact(value, options), w = workers[0];
    reply(w, result, { ...w.sent[0].identity, documentId: 'foreign' });
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    expect(w.terminated).toBe(1); client.dispose();
  });
  it('ignores late phase/result after cancellation', async () => {
    const value = input(), options = { solver: 'newton' as const, iterationLimit: 64 }, result = await response(value, options);
    const { client, workers } = rig(), controller = new AbortController(), onPhase = vi.fn();
    const complete = client.analyzeFrictionContact(value, options, { signal: controller.signal, onPhase });
    const w = workers[0], late = w.port.onmessage; controller.abort();
    late?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'phase', identity: w.sent[0].identity, phase: 'solving' } }));
    late?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: w.sent[0].identity, result } }));
    await expect(complete).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(onPhase).not.toHaveBeenCalled(); expect(w.terminated).toBe(1); client.dispose();
  });
  it('ends the existing timeout once and ignores late results', async () => {
    vi.useFakeTimers(); const { client, workers } = rig();
    const complete = client.analyzeFrictionContact(input(), { solver: 'newton', iterationLimit: 64 });
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'deadline' } });
    expect(workers[0].terminated).toBe(1); client.dispose();
  });
});
