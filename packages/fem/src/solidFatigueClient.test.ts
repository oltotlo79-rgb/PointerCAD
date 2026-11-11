import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, type FemRequest } from './protocol.js';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import { decodeSolidAnalysis } from './solidAnalysisResults.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';

/** Transport harness only. Constitutive/equilibrium payload is the independent single-free-DOF analytical case,
 * not an actual native solve and not a mocked fatigue criterion. Root native acceptance remains separate. */
async function fixture() {
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1', source: { documentId: 'part', revision: 3, meshKey: 'mesh3' },
    units: 'N-mm-MPa', numericBudgetBytes: 1000000, nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }], materials: [{ id: 'm', youngMPa: 200, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [1, 0, 0] }], surfaceLoads: [] };
  const hash = await solidInputSha256(input);
  const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: [[0, 0, 0], [0.03, 0, 0], [0, 0, 0], [0, 0, 0]],
    elementForcesN: [[-1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]], reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, hash);
  const selection = { source: { ...input.source }, inputSha256: hash, elementIndex: 0, historyId: 'tet0',
    loadFactors: [0, 1, 0, -1], sequence: 'once', repeats: 1, reference: 'Explicit chronology' };
  const curve = { id: 'test', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
    referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null,
    source: { kind: 'user-supplied', reference: 'Test-only', condition: 'Not material data' } };
  return { input, result, selection, curve };
}
function port() {
  const requests: FemRequest[] = [];
  const worker: FemWorkerPort & { terminations: number } = { terminations: 0, postMessage: request => { requests.push(request); },
    terminate() { this.terminations += 1; }, onmessage: null, onerror: null, onmessageerror: null };
  return { worker, requests };
}

describe('public native solid to proportional fatigue client path', () => {
  it('uses the existing solid request and owns factors/curve before the caller changes them', async () => {
    const { input, result, selection, curve } = await fixture(), { worker, requests } = port();
    const client = new FemClient(() => worker);
    try {
      const pending = client.analyzeSolidFatigue(input, selection, curve), request = requests[0];
      if (request?.kind !== 'analyze-solid-tet4') throw new Error('Missing existing solid protocol request');
      selection.loadFactors[1] = 999;
      curve.referenceStressMpa = 999;
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
      const completion = await pending;
      expect(completion.kind).toBe('result');
      if (completion.kind !== 'result' || !completion.fatigue.ok) throw new Error('Fatigue was not accepted');
      expect(completion.fatigue.input.histories[0].stressMpa).toEqual([0, 6, 0, -6]);
      expect(completion.fatigue.input.curve.referenceStressMpa).toBe(100);
      expect(completion.fatigue.provenance.inputSha256).toBe(result.inputSha256);
      expect(completion.fatigue.result.damage).toBeGreaterThan(0);
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });
  it('keeps fatigue binding refusal separate from a valid native solve', async () => {
    const { input, result, selection, curve } = await fixture(), { worker, requests } = port();
    const client = new FemClient(() => worker);
    try {
      const pending = client.analyzeSolidFatigue(input, { ...selection, source: { ...selection.source, meshKey: 'old' } }, curve);
      const request = requests[0];
      if (request === undefined) throw new Error('No request');
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
      await expect(pending).resolves.toMatchObject({ kind: 'result', fatigue: { ok: false, code: 'fatigue-solid-binding' } });
    } finally { client.dispose(); }
  });
  it('retains abort during asynchronous result acceptance and refuses malformed configuration before Worker creation', async () => {
    const { input, result, selection, curve } = await fixture(), { worker, requests } = port();
    let created = 0;
    const client = new FemClient(() => { created += 1; return worker; });
    try {
      await expect(client.analyzeSolidFatigue(input, { ...selection, loadFactors: new Array<number>(2) }, curve)).rejects.toBeInstanceOf(Error);
      await expect(client.analyzeSolidFatigue(input, selection, { ...curve, slope: 0 })).rejects.toBeInstanceOf(Error);
      expect(created).toBe(0);
      const control = new AbortController(), pending = client.analyzeSolidFatigue(input, selection, curve, { signal: control.signal });
      const request = requests[0];
      if (request === undefined) throw new Error('No request');
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
      control.abort();
      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });
});
