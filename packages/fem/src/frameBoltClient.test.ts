import { afterEach, describe, expect, it, vi } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isRequest, isReply, type FemRequest } from './protocol.js';
import { decodeFrameBoltContact, frameBoltContactInputSha256, type FrameBoltContactInput } from './beamBoltContact.js';
import { axialOscillator, transientHistory } from './transient.testSupport.js';
const source = { kind: 'user-supplied', reference: 'Independent synthetic frame fixture', condition: 'Linear centroidal Timoshenko shank only' } as const;
const quantity = (role: string, value: number) => ({ role, value, source });
function input(): FrameBoltContactInput {
  const base = axialOscillator(transientHistory(1e-4, 10, [[0, 1], [10, 1]]));
  return { schema: 'pointercad-frame-bolt-contact/1', contact: { schema: 'pointercad-beam-contact/1',
    geometry: { ...base.geometry, nodes: [{ id: 'node-0', position: [0, 0, 0] }, { id: 'node-1', position: [0.1, 0, 0] }],
      materials: base.geometry.materials.map(m => ({ ...m, youngModulus: 200e9, shearModulus: 80e9 })),
      sections: base.geometry.sections.map(s => ({ ...s, area: 1e-4, iy: 1e-8, iz: 1e-8, torsionConstant: 2e-8, shearFactor: 5 / 6 })) },
    supports: [base.supports[0]], referenceLoads: base.referenceLoads,
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'node-1', normal: [1, 0, 0], gapM: 0.001 }], loadFactors: [1] },
    bolt: { id: 'frame-bolt', memberId: 'member-0', model: 'centroidal-frame-shank-explicit-end-coupling', couplingSource: source,
      shorteningM: quantity('shortening-m', 0), threadCompliance: quantity('thread-compliance-m-per-n', 0),
      headCompliance: quantity('head-compliance-m-per-n', 0), bearingCompliance: quantity('bearing-compliance-m-per-n', 0),
      section: { materialConditionId: 'synthetic', tensileArea: quantity('tensile-area-m2', 8e-5), shearArea: quantity('plain-shank-shear-area-m2', 1e-4),
        modulusY: quantity('section-modulus-y-m3', 2e-6), modulusZ: quantity('section-modulus-z-m3', 2e-6),
        fibreYM: quantity('extreme-y-m', 0.005), fibreZM: quantity('extreme-z-m', 0.005), limits: null } } };
}
/** 手計算: EA/L=200e6 N/m、F=1000 N、u=5e-6 m、U=Fu/2=.0025 J。nativeの再生ではない。 */
function raw(hash: string) {
  return { schema: 'pointercad-frame-bolt-contact-result/1', inputSha256: hash,
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: 6, meshNodes: 2, meshElements: 1, momentLengthM: 0.1, pivotLimit: 20,
      states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1000, gapScaleM: 0.001, equilibriumResidual: 0,
        penetration: 0, tension: 0, complementarity: 0,
        nodes: [{ number: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0] },
          { number: 2, displacementM: [5e-6, 0, 0], rotationRad: [0, 0, 0] }],
        contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: 0.001005 }] }] },
    states: [{ loadFactor: 1, boltId: 'frame-bolt', member: 1, forceOnAN: [1000, 0, 0], forceOnBN: [-1000, 0, 0],
      momentOnANm: [0, 0, 0], momentOnBNm: [0, 0, 0], axialForceN: 1000, shearYN: 0, shearZN: 0,
      bendingYNm: 0, bendingZNm: 0, elasticEnergyJ: 0.0025, transverseEnergyJ: 0 }] };
}


afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.doUnmock('./offlineBrowser.js'); });
function rig() {
  const workers: { port: FemWorkerPort; sent: FemRequest[]; terminated: number }[] = [];
  const client = new FemClient(() => {
    const sent: FemRequest[] = [];
    const entry: { port: FemWorkerPort; sent: FemRequest[]; terminated: number } = { sent, terminated: 0, port: {
      postMessage: request => { sent.push(request); }, terminate: () => { entry.terminated += 1; },
      onmessage: null, onerror: null, onmessageerror: null,
    } };
    workers.push(entry); return entry.port;
  });
  return { client, workers };
}
async function response(value = input()) {
  const hash = await frameBoltContactInputSha256(value);
  return decodeFrameBoltContact(raw(hash), value, hash);
}

describe('frame boltの専用requestと既存所有client', () => {
  it('正規requestと元input/hashの結果だけを採用し、元入力を所有コピーへ固定する', async () => {
    const value = input(), result = await response(value), { client, workers } = rig();
    try {
      const complete = client.analyzeFrameBoltContact(value), w = workers[0], request = w.sent[0];
      if (request.kind !== 'analyze-frame-bolt-contact') throw new Error('Missing dedicated frame request');
      expect(request.input).not.toBe(value); expect(request.input.contact.geometry).not.toBe(value.contact.geometry);
      expect(isRequest(request)).toBe(true);
      expect(isRequest({ ...request, kind: 'analyze-beam-bolt-contact' })).toBe(false);
      Object.defineProperty(value.contact.geometry, 'revision', { value: value.contact.geometry.revision + 1 });
      expect(request.input.contact.geometry.revision).toBe(result.analysisRevision);
      const reply = { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result };
      expect(isReply(reply)).toBe(true); w.port.onmessage?.(new MessageEvent('message', { data: reply }));
      const accepted = await complete;
      expect(accepted.kind).toBe('result');
      if (accepted.kind !== 'result') throw new Error('Bound result required');
      expect(accepted.result.kind).toBe('frame-bolt-contact'); expect(accepted.result.states[0].axialForceN).toBeCloseTo(1000, 8);
      expect(accepted.result.states[0].elasticEnergyJ).toBeCloseTo(0.0025, 12);
      expect(accepted.result.states[0].assessment.tension.stressPa).toBeCloseTo(12_500_000, 5);
      expect(w.terminated).toBe(1); expect(w.port.onmessage).toBeNull();
    } finally { client.dispose(); }
  });
  it.each(['hash', 'revision', 'kind', 'assessment', 'changed-input'] as const)('同じWorker identityでも%sの転用を拒否する', async reason => {
    const value = input(), result = await response(value), { client, workers } = rig();
    try {
      const changed = reason === 'changed-input' ? { ...value, bolt: { ...value.bolt,
        threadCompliance: { ...value.bolt.threadCompliance, value: 5e-9 } } } : value;
      const pending = client.analyzeFrameBoltContact(changed), w = workers[0];
      let reply: unknown = result;
      if (reason === 'hash') reply = { ...result, inputSha256: 'b'.repeat(64) };
      if (reason === 'revision') reply = { ...result, analysisRevision: result.analysisRevision + 1 };
      if (reason === 'kind') reply = { ...result, kind: 'oofem-beam-axial-bolt-contact', schema: 'pointercad-bolt-contact-result/1' };
      if (reason === 'assessment') Object.defineProperty(result.states[0].assessment.tension, 'stressPa', { value: 12_500_001 });
      w.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: w.sent[0].identity, result: reply } }));
      await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
      expect(w.terminated).toBe(1);
    } finally { client.dispose(); }
  });
  it.each(['documentId', 'revision', 'generation', 'requestId'] as const)('identityの%sを取り違えたreplyは採用しない', async key => {
    const value = input(), result = await response(value), { client, workers } = rig();
    try {
      const pending = client.analyzeFrameBoltContact(value), w = workers[0], identity = { ...w.sent[0].identity };
      if (key === 'documentId') identity.documentId += '-foreign';
      if (key === 'revision') identity.revision += 1;
      if (key === 'generation') identity.generation += 1;
      if (key === 'requestId') identity.requestId += '-foreign';
      w.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity, result } }));
      await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
      expect(w.terminated).toBe(1);
    } finally { client.dispose(); }
  });
  it('requestは別document/revisionと余剰identityを拒否する', () => {
    const value = input(), { client, workers } = rig();
    const pending = client.analyzeFrameBoltContact(value), request = workers[0].sent[0];
    try {
      expect(isRequest({ ...request, identity: { ...request.identity, documentId: 'foreign' } })).toBe(false);
      expect(isRequest({ ...request, identity: { ...request.identity, revision: request.identity.revision + 1 } })).toBe(false);
      expect(isRequest({ ...request, identity: { ...request.identity, extra: true } })).toBe(false);
    } finally { client.dispose(); }
    return expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
  });
  it('supersede/abort/保存したlate callbackは新しいownerへ混入しない', async () => {
    const value = input(), result = await response(value), { client, workers } = rig();
    try {
      const first = client.analyzeFrameBoltContact(value), old = workers[0], late = old.port.onmessage;
      const controller = new AbortController(), next = client.analyzeFrameBoltContact(value, { signal: controller.signal });
      await expect(first).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      late?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: old.sent[0].identity, result } }));
      expect(workers[1].terminated).toBe(0);
      controller.abort(); await expect(next).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      expect(workers.map(w => w.terminated)).toEqual([1, 1]);
    } finally { client.dispose(); }
  });
  it('pre-abortはWorker0、disposeは1回解放してhandlerを外す', async () => {
    const { client, workers } = rig(), controller = new AbortController(); controller.abort();
    await expect(client.analyzeFrameBoltContact(input(), { signal: controller.signal })).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(workers).toHaveLength(0);
    const pending = client.analyzeFrameBoltContact(input()); client.dispose(); client.dispose();
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    expect(workers[0].terminated).toBe(1); expect(workers[0].port.onmessage).toBeNull();
    await expect(client.analyzeFrameBoltContact(input())).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    expect(workers).toHaveLength(1);
  });
  it.each(['total', 'solving'] as const)('元の%s期限とone-shot解放を保持する', async mode => {
    vi.useFakeTimers(); const { client, workers } = rig();
    try {
      const pending = client.analyzeFrameBoltContact(input()), w = workers[0], limit = mode === 'total' ? 180_000 : 60_000;
      if (mode === 'solving') w.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL,
        kind: 'phase', identity: w.sent[0].identity, phase: 'solving' } }));
      await vi.advanceTimersByTimeAsync(limit - 1); expect(w.terminated).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'deadline' } });
      expect(w.terminated).toBe(1);
    } finally { client.dispose(); vi.useRealTimers(); }
  });
  it('実Worker dispatchが専用offline入口へ1回だけ渡し、phase/result/closeを返す（fake）', async () => {
    const value = input(), result = await response(value);
    const dispatch = vi.fn((v: FrameBoltContactInput, notify: (phase: 'solving') => void) => {
      expect(v).toEqual(value); notify('solving'); return Promise.resolve(result);
    });
    vi.doMock('./offlineBrowser.js', async importOriginal => ({ ...await importOriginal<typeof import('./offlineBrowser.js')>(),
      analyzeFrameBoltContactInBrowser: dispatch }));
    const posted: unknown[] = [], close = vi.fn();
    const worker: { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (value: unknown) => void; close: () => void }
      = { onmessage: null, postMessage: v => { posted.push(v); }, close };
    vi.stubGlobal('self', worker);
    await import('./worker.js');
    const identity = { documentId: value.contact.geometry.source.documentId, revision: value.contact.geometry.revision, generation: 3, requestId: 'frame-3' };
    const request = { protocol: FEM_PROTOCOL, kind: 'analyze-frame-bolt-contact', identity, input: value };
    worker.onmessage?.(new MessageEvent('message', { data: request }));
    await vi.waitFor(() => { expect(close).toHaveBeenCalledTimes(1); });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([{ protocol: FEM_PROTOCOL, kind: 'phase', identity, phase: 'solving' },
      { protocol: FEM_PROTOCOL, kind: 'result', identity, result }]);
    worker.onmessage?.(new MessageEvent('message', { data: request }));
    expect(dispatch).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(2);
  });
});
