import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isRequest, isReply, type FemRequest, type FemReply } from './protocol.js';
import { modalFixture } from './modal.testSupport.js';
import { decodeBeamWeldSpanContact, beamWeldSpanContactInputSha256, type BeamWeldSpanContactInput } from './beamWeldSpanContact.js';
import { WELD_SPAN_CONTACT_ASSETS } from './beamWeldSpanAssets.js';
import { FEM_ASSETS } from './assets.js';
import { analyzeWeldSpanContactInBrowser } from './offlineBrowser.js';
import type * as ImportedOfflineBrowserTypes from './offlineBrowser.js';
vi.mock('./offlineBrowser.js', async importOriginal => ({ ...await importOriginal<typeof ImportedOfflineBrowserTypes>(), analyzeWeldSpanContactInBrowser: vi.fn() }));

function input(segments = 1): BeamWeldSpanContactInput {
  const base = modalFixture({ free: true, modes: 1, segments });
  return { schema: 'pointercad-weld-span/1', contact: { schema: 'pointercad-beam-contact/1',
    geometry: { ...base, nodes: [0, 2, 0, 2].map((x, i) => ({ id: `n${i}`, position: [x, 0, 0] })),
      members: ['a', 'b'].map((id, i) => ({ ...base.members[0], id, componentId: id, occurrencePath: [id],
        startNodeId: `n${2*i}`, endNodeId: `n${2*i+1}` })),
      materials: [{ ...base.materials[0], youngModulus: 1000, shearModulus: 400, densityKgM3: 1 }],
      sections: [{ ...base.sections[0], area: 1, iy: .1, iz: .1, torsionConstant: .1, shearFactor: 1 }] },
    supports: [0, 1, 2, 3].map(i => ({ nodeId: `n${i}`, restrained: [i%2 === 0, true, true, true, true, true] })),
    referenceLoads: [{ id: 'load', kind: 'nodal', nodeId: 'n3', force: [1, 0, 0], moment: [0, 0, 0] }],
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'n3', normal: [-1, 0, 0], gapM: .01 }], loadFactors: [1] },
    patches: [{ id: 'layer', centerM: [1, 0, 0], normal: [0, 1, 0], along: [1, 0, 0], widthM: 2, lengthM: 1,
      thicknessM: .2, youngPa: 1000, poisson: .25, first: { kind: 'member-span', memberId: 'a' },
      second: { kind: 'member-span', memberId: 'b' } }] };
}
/** Independent axial coupled-system fractions, not kernel output or a native execution record.
 * K=500,C=4000/3 (one element); two-element K/C are the explicit 2x2 integral matrices. */
function raw(segments = 1) {
  const displacements = segments === 1 ? [0, 8/9500, 0, 11/9500] : [0, 76/97000, 0, 118/97000, 47/97000, 50/97000];
  const force = segments === 1 ? 12/19 : 48/97;
  const nodal = segments === 1 ? [4/19, 8/19, 0, 0] : [1/97, 29/97, 0, 0, 18/97, 0];
  const opposite = segments === 1 ? [0, 0, -4/19, -8/19] : [0, 0, -1/97, -29/97, 0, -18/97];
  const rows = displacements.map((x, i) => ({ number: i+1, displacementM: [x, 0, 0], rotationRad: [0, 0, 0] }));
  return { schema: 'pointercad-weld-span-result/1',
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: segments === 1 ? 2 : 14, meshNodes: displacements.length, meshElements: 2*segments,
      momentLengthM: 2/segments, pivotLimit: 20,
      states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1, gapScaleM: .01, equilibriumResidual: 0,
        penetration: 0, tension: 0, complementarity: 0, nodes: structuredClone(rows.slice(0, 4)),
        contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .01-displacements[3] }] }] },
    states: [{ loadFactor: 1, meshNodes: rows, welds: [{ id: 'layer',
      first: nodal.map(f => [f, 0, 0, 0, 0, 0]), second: opposite.map(f => [f, 0, 0, 0, 0, 0]),
      forceOnFirstN: [force, 0, 0], momentAtCenterNm: [0, 0, 0], energyJ: segments === 1 ? 3/45125 : 159/2352250,
      structuralCertification: false }] }] };
}
type Mutable<T> = { -readonly [P in keyof T]: Mutable<T[P]> };
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
const response = async (value: BeamWeldSpanContactInput, segments = 1) => decodeBeamWeldSpanContact(raw(segments), value, await beamWeldSpanContactInputSha256(value));
function reply(worker: ReturnType<typeof rig>['workers'][number], result: unknown, identity = worker.sent[0].identity) {
  worker.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity, result } }));
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('dedicated span client, protocol, asset and Worker pure connections', () => {
  it.each([1, 2])('accepts only a fully bound independent %i-element response', async segments => {
    const value = input(segments), result = await response(value, segments), { client, workers } = rig();
    const complete = client.analyzeWeldSpanContact(value), w = workers[0], request = w.sent[0];
    expect(request.kind).toBe('analyze-beam-weld-span-contact'); expect(isRequest(request)).toBe(true);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result })).toBe(true);
    expect(isRequest({ ...request, identity: { ...request.identity, revision: request.identity.revision+1 } })).toBe(false);
    expect(isRequest({ ...request, identity: { ...request.identity, documentId: 'other' } })).toBe(false);
    expect(isRequest({ ...request, extra: true })).toBe(false);
    reply(w, result);
    await expect(complete).resolves.toMatchObject({ kind: 'result', result: { kind: 'oofem-beam-weld-span-contact', inputSha256: result.inputSha256 } });
    expect(w.terminated).toBe(1); client.dispose();
  });
  it('captures input and identity before awaiting the digest', async () => {
    const value = input(2), owned = structuredClone(value), result = await response(owned, 2), { client, workers } = rig();
    const complete = client.analyzeWeldSpanContact(value), w = workers[0];
    Object.assign(value.contact.geometry, { revision: 999 }); Object.assign(value.patches[0], { thicknessM: .3 });
    expect(w.sent[0]).toMatchObject({ identity: { revision: owned.contact.geometry.revision }, input: owned });
    reply(w, result); await expect(complete).resolves.toMatchObject({ kind: 'result' }); client.dispose();
  });
  it('refuses invalid input without creating a Worker', async () => {
    const value = input(), { client, workers } = rig(); Object.assign(value, { schema: 'old' });
    await expect(client.analyzeWeldSpanContact(value)).rejects.toThrow(); expect(workers).toHaveLength(0); client.dispose();
  });
  it.each(['requestId', 'generation', 'revision', 'documentId'] as const)('rejects another %s in the reply identity', async field => {
    const value = input(), result = await response(value), { client, workers } = rig(), complete = client.analyzeWeldSpanContact(value), w = workers[0];
    const identity = { ...w.sent[0].identity };
    if (field === 'revision' || field === 'generation') identity[field]++;
    else identity[field] = 'other';
    reply(w, result, identity); await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    expect(w.terminated).toBe(1); client.dispose();
  });
  it.each(['hash', 'source', 'internal', 'energy', 'extra', 'old-kind'] as const)('rejects %s result corruption', async reason => {
    const value = input(2), decoded = await response(value, 2), { client, workers } = rig();
    const result = JSON.parse(JSON.stringify(decoded)) as Mutable<typeof decoded>;
    if (reason === 'hash') Object.assign(result, { inputSha256: 'b'.repeat(64) });
    else if (reason === 'source') Object.assign(result.contact.source, { documentId: 'other' });
    else if (reason === 'internal') result.states[0].meshNodes.pop();
    else if (reason === 'energy') result.states[0].welds[0].energyJ *= 2;
    else if (reason === 'extra') Object.assign(result, { extra: 0 });
    else Object.assign(result, { kind: 'oofem-beam-weld-layer-contact' });
    const complete = client.analyzeWeldSpanContact(value); reply(workers[0], result);
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } }); client.dispose();
  });
  it('keeps supersede, abort and late-response ownership', async () => {
    const value = input(), result = await response(value), { client, workers } = rig();
    const first = client.analyzeWeldSpanContact(value), late = workers[0].port.onmessage;
    const controller = new AbortController(), second = client.analyzeWeldSpanContact(value, { signal: controller.signal });
    await expect(first).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    late?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: workers[0].sent[0].identity, result } }));
    controller.abort(); await expect(second).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(workers.map(w => w.terminated)).toEqual([1, 1]); client.dispose();
  });
  it('cannot accept an asynchronous match after dispose', async () => {
    const value = input(2), result = await response(value, 2), { client, workers } = rig();
    const complete = client.analyzeWeldSpanContact(value); reply(workers[0], result); client.dispose();
    await expect(complete).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    expect(workers[0].terminated).toBe(1);
    await expect(client.analyzeWeldSpanContact(value)).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    expect(workers).toHaveLength(1);
  });
  it.each(['total', 'solve'] as const)('retains the existing %s deadline and Worker termination', async where => {
    vi.useFakeTimers(); const { client, workers } = rig(), complete = client.analyzeWeldSpanContact(input()), w = workers[0];
    if (where === 'solve') w.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'phase', identity: w.sent[0].identity, phase: 'solving' } }));
    await vi.advanceTimersByTimeAsync(where === 'total' ? 180_000 : 60_000);
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'deadline' } });
    expect(w.terminated).toBe(1); client.dispose();
  });
  it('fixes three source-derived descriptors without changing the legacy inventory or pretending physical files exist', () => {
    const sources: Record<string, string> = { 'beamWeldSpanBase.py': 'beamContact.py', 'beamWeldSpan.py': 'beamWeldSpan.py', 'beamWeldSpanContact.py': 'beamWeldSpanContact.py' };
    expect(WELD_SPAN_CONTACT_ASSETS.map(p => p.file)).toEqual(Object.keys(sources));
    for (const pin of WELD_SPAN_CONTACT_ASSETS) {
      const bytes = readFileSync(new URL('./'+sources[pin.file], import.meta.url));
      expect(pin.bytes).toBe(bytes.length); expect(pin.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    const old = FEM_ASSETS.map(p => ({ ...p })), selected = [...FEM_ASSETS.filter(p => p.file !== 'beamContact.py'), ...WELD_SPAN_CONTACT_ASSETS];
    expect(new Set(selected.map(p => p.file)).size).toBe(selected.length);
    expect(new Set<string>(selected.map(p => p.file)).has('beamContact.py')).toBe(false);
    expect(FEM_ASSETS).toEqual(old);
    expect(FEM_ASSETS.find(p => p.file === 'beamContact.py')?.sha256).toBe('917def52a0b14e620ba497bb56eaa28e2ba546b664429bfb0c4704d71cb00562');
  });
  it('dispatches the actual Worker dedicated branch and preserves its identity/close lifecycle (mock browser boundary)', async () => {
    const value = input(), result = await response(value), identity = { documentId: value.contact.geometry.source.documentId,
      revision: value.contact.geometry.revision, generation: 1, requestId: 'span-worker' }, replies: FemReply[] = [];
    const surface: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage(reply: FemReply): void; close: () => void } = {
      onmessage: null, postMessage: message => { replies.push(message); }, close: vi.fn() };
    vi.stubGlobal('self', surface);
    vi.mocked(analyzeWeldSpanContactInBrowser).mockImplementation((_value, notify) => { notify('solving'); return Promise.resolve(result); });
    await import('./worker.js');
    surface.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'analyze-beam-weld-span-contact', identity, input: value } }));
    await vi.waitFor(() => { expect(surface.close).toHaveBeenCalledTimes(1); });
    expect(analyzeWeldSpanContactInBrowser).toHaveBeenCalledExactlyOnceWith(value, expect.any(Function));
    expect(replies).toEqual([{ protocol: FEM_PROTOCOL, kind: 'phase', identity, phase: 'solving' }, { protocol: FEM_PROTOCOL, kind: 'result', identity, result }]);
  });
});
