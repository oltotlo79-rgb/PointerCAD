import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { cantilever } from './analysisCases.testSupport.js';
import { modalFixture } from './modal.testSupport.js';
import { FEM_PROTOCOL, type FemRequest } from './protocol.js';
import { decodeTetraMesh, tetraMeshInputSha256, TETRA_MESH_SCHEMA, type TetraMeshInput } from './tetraMesh.js';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import { decodeSolidAnalysis } from './solidAnalysisResults.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';

function port(): FemWorkerPort & { terminations: number } {
  return { terminations: 0, postMessage: () => undefined,
    terminate() { this.terminations += 1; }, onmessage: null, onerror: null, onmessageerror: null };
}

function solidFixture(): SolidAnalysisInput {
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'solid', revision: 2, meshKey: 'mesh:2' },
    units: 'N-mm-MPa', numericBudgetBytes: 1000000,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }], materials: [{ id: 'm', youngMPa: 6, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [1, 0, 0] }], surfaceLoads: [] };
}
describe('public solid solver ownership and strict reply contract', () => {
  it('accepts only the captured physical input and current native reply', async () => {
    const worker = port(), requests: FemRequest[] = [];
    worker.postMessage = request => { requests.push(request); };
    const client = new FemClient(() => worker);
    const input = solidFixture();
    try {
      const pending = client.analyzeSolid(input), request = requests[0];
      if (request?.kind !== 'analyze-solid-tet4') throw new Error('Missing public solid request');
      expect(request.input).not.toBe(input);
      expect(request.input.materials[0]).not.toBe(input.materials[0]);
      const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
        displacementMm: [[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0]],
        elementForcesN: [[-1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]],
        reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, await solidInputSha256(input));
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
      await expect(pending).resolves.toMatchObject({ kind: 'result', result: { reactionN: [[-1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] } });
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });
  it('supersedes across beam/solid, ignores late replies and preserves the new owner on abort', async () => {
    const workers: ReturnType<typeof port>[] = [];
    const client = new FemClient(() => { const worker = port(); workers.push(worker); return worker; });
    try {
      const old = client.analyze(cantilever());
      const control = new AbortController(), pending = client.analyzeSolid(solidFixture(), { signal: control.signal });
      await expect(old).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      expect(workers[0].onmessage).toBeNull();
      control.abort();
      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      const next = client.analyzeSolid(solidFixture());
      const beam = client.analyze(cantilever());
      await expect(next).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      client.dispose();
      await expect(beam).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
      expect(workers.map(worker => worker.terminations)).toEqual([1, 1, 1, 1]);
    } finally { client.dispose(); }
  });
  it('rejects malformed or stale solid input/replies and respects a pre-aborted request', async () => {
    const worker = port(), requests: FemRequest[] = [];
    worker.postMessage = request => { requests.push(request); };
    let created = 0;
    const client = new FemClient(() => { created += 1; return worker; });
    try {
      const control = new AbortController(); control.abort();
      await expect(client.analyzeSolid(solidFixture(), { signal: control.signal })).resolves.toMatchObject({ kind: 'cancelled' });
      expect(created).toBe(0);
      const pending = client.analyzeSolid(solidFixture());
      await expect(client.analyzeSolid({})).rejects.toThrow();
      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      const current = client.analyzeSolid(solidFixture()), request = requests[1];
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'phase',
        identity: { ...request.identity, revision: 1 }, phase: 'solving' } }));
      await expect(current).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    } finally { client.dispose(); }
  });
});

describe.each(['static', 'modal'] as const)('%s client asynchronous contract', kind => {
  const document = () => kind === 'static' ? cantilever() : modalFixture();
  const analyze = (client: FemClient, value: unknown, signal?: AbortSignal) => kind === 'static'
    ? client.analyze(value, { signal }) : client.analyzeModal(value, { signal });

  it('rejects invalid input asynchronously with Error and supersedes the previous request', async () => {
    const worker = port();
    let created = 0;
    const client = new FemClient(() => { created += 1; return worker; });
    try {
      const previous = analyze(client, document());
      let rejected: ReturnType<typeof analyze> | undefined;
      expect(() => { rejected = analyze(client, {}); }).not.toThrow();
      if (rejected === undefined) throw new Error('Promise was not returned');
      await expect(rejected).rejects.toBeInstanceOf(Error);
      await expect(previous).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      expect(created).toBe(1);
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });

  it('accepts pre-aborted valid input without creating a Worker', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new FemClient(() => { throw new Error('Worker must not be created'); });
    try {
      await expect(analyze(client, document(), controller.signal))
        .resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    } finally { client.dispose(); }
  });

  it('settles disposal once and detaches handlers from the old Worker', async () => {
    const worker = port();
    const client = new FemClient(() => worker);
    const pending = analyze(client, document());
    client.dispose(); client.dispose();
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    expect(worker.terminations).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
  });
});

function qualityInput(): TetraMeshInput {
  return { schema: TETRA_MESH_SCHEMA, source: { documentId: 'quality', revision: 1, featureId: 'body', bodyKey: 'body:1' },
    units: 'mm', coordinates: [0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4],
    triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3], tags: [0, 1, 2, 3], tagCount: 4 };
}
describe('explicit tetrahedral quality client connection', () => {
  it('keeps controlled requests owned across supersession, late replies and abort', async () => {
    const workers: ReturnType<typeof port>[] = [], requests: FemRequest[] = [];
    const client = new FemClient(() => {
      const worker = port(); worker.postMessage = request => { requests.push(request); }; workers.push(worker); return worker;
    });
    const input = { ...qualityInput(), meshing: { targetSizeMm: 0.75, grading: 0.2, maximumOptimizationPasses: 3,
      quality: { minimumMeanRatio: 0, maximumEdgeRatio: 10 } } };
    try {
      const preAborted = new AbortController(); preAborted.abort();
      await expect(client.meshTetrahedra(input, { signal: preAborted.signal }))
        .resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      expect(workers).toHaveLength(0);
      const first = client.meshTetrahedra(input), staleHandler = workers[0].onmessage;
      const firstRequest = requests[0];
      const controller = new AbortController();
      const second = client.meshTetrahedra(input, { signal: controller.signal });
      await expect(first).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      const result = decodeTetraMesh({ coordinates: input.coordinates, tetrahedra: [0, 1, 2, 3],
        boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, await tetraMeshInputSha256(input));
      staleHandler?.(new MessageEvent<unknown>('message', { data: {
        protocol: FEM_PROTOCOL, kind: 'result', identity: firstRequest.identity, result } }));
      expect(workers[0].terminations).toBe(1);
      expect(workers[1].terminations).toBe(0);
      controller.abort();
      await expect(second).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      expect(workers[1].terminations).toBe(1);
      await expect(client.meshTetrahedra({ ...input, meshing: { ...input.meshing, maximumOptimizationPasses: 4 } }))
        .rejects.toThrow('bounded meshing controls');
      expect(workers).toHaveLength(2);
    } finally { client.dispose(); }
  });
  it.each([[2.5, 'result'], [2, 'failed']] as const)(
    'uses the captured explicit edge-ratio target %s for native acceptance (%s)', async (maximumEdgeRatio, kind) => {
    const worker = port(), requests: FemRequest[] = [];
    worker.postMessage = request => { requests.push(request); };
    const client = new FemClient(() => worker);
    const quality: { minimumMeanRatio: number; maximumEdgeRatio: number } = { minimumMeanRatio: 0, maximumEdgeRatio };
    const meshing = { targetSizeMm: 0.75, grading: 0.2, maximumOptimizationPasses: 2,
      quality };
    try {
      const pending = client.meshTetrahedra({ ...qualityInput(), meshing });
      meshing.quality.maximumEdgeRatio = 100;
      const request = requests[0];
      if (request?.kind !== 'mesh-cad-convex-tetra') throw new Error('Missing actual mesh request');
      // The independent 2/3/4 right tetrahedron has shortest edge 2, longest edge 5: ratio 2.5.
      const input = request.input;
      expect(input.meshing?.quality.maximumEdgeRatio).toBe(maximumEdgeRatio);
      const result = decodeTetraMesh({ coordinates: input.coordinates, tetrahedra: [0, 1, 2, 3],
        boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, await tetraMeshInputSha256(input));
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: {
        protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
      const completion = await pending;
      expect(completion.kind).toBe(kind);
      if (kind === 'failed') expect(completion).toMatchObject({ failure: { code: 'invalid-protocol' } });
      else expect(completion).toMatchObject({ result: { volumeMm3: 4 } });
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });
  it('keeps boundary validation ahead of quality and rejects a forged numerical result', async () => {
    const worker = port(), requests: FemRequest[] = [];
    worker.postMessage = request => { requests.push(request); };
    const client = new FemClient(() => worker), input = qualityInput();
    try {
      const pending = client.meshTetrahedraWithQuality(input, { minimumMeanRatio: 0, maximumEdgeRatio: 10 });
      const request = requests[0];
      if (request === undefined) throw new Error('Missing request');
      const result = decodeTetraMesh({ coordinates: input.coordinates, tetrahedra: [0, 1, 2, 3],
        boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, await tetraMeshInputSha256(input));
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL,
        kind: 'result', identity: request.identity, result: { ...result, volumeMm3: 40 } } }));
      await expect(pending).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    } finally { client.dispose(); }
  });
  it('diagnoses an independently valid reply without rejecting its poor requested quality', async () => {
    const worker = port(), requests: FemRequest[] = [];
    worker.postMessage = request => { requests.push(request); };
    const client = new FemClient(() => worker), input = qualityInput();
    const limits = { minimumMeanRatio: 1, maximumEdgeRatio: 1 };
    try {
      const pending = client.meshTetrahedraWithQuality(input, limits);
      limits.minimumMeanRatio = 0; limits.maximumEdgeRatio = 100;
      const request = requests[0];
      if (request?.kind !== 'mesh-cad-convex-tetra') throw new Error('Missing actual mesh request');
      const result = decodeTetraMesh({ coordinates: input.coordinates, tetrahedra: [0, 1, 2, 3],
        boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, await tetraMeshInputSha256(input));
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: {
        protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
      const completed = await pending;
      if (completed.kind !== 'result') throw new Error('Expected valid geometry result');
      expect(completed.result.volumeMm3).toBe(4);
      expect(completed.quality.meetsRequestedLimits).toBe(false);
      expect(completed.quality.failingElements).toEqual([0]);
      expect(completed.quality.elements[0].meanRatio).toBeCloseTo(12 * 12 ** (2 / 3) / 87, 13);
      expect(completed.quality.limits).toEqual({ minimumMeanRatio: 1, maximumEdgeRatio: 1 });
      expect(completed.quality.physicsValidated).toBe(false);
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });
  it('preserves worker failure without inventing a quality result', async () => {
    const worker = port(), requests: FemRequest[] = [];
    worker.postMessage = request => { requests.push(request); };
    const client = new FemClient(() => worker);
    try {
      const pending = client.meshTetrahedraWithQuality(qualityInput(), { minimumMeanRatio: 0, maximumEdgeRatio: 10 });
      const request = requests[0];
      if (request === undefined) throw new Error('Missing request');
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL,
        kind: 'failure', identity: request.identity, failure: { code: 'solver-failed', message: 'native refused' } } }));
      expect(await pending).toEqual({ kind: 'failed', identity: request.identity,
        failure: { code: 'solver-failed', message: 'native refused' } });
    } finally { client.dispose(); }
  });
  it('preserves pre-abort and supersedes an active request on invalid explicit limits', async () => {
    const worker = port(); let created = 0;
    const client = new FemClient(() => { created += 1; return worker; });
    const limits = { minimumMeanRatio: 0, maximumEdgeRatio: 10 };
    try {
      const controller = new AbortController(); controller.abort();
      await expect(client.meshTetrahedraWithQuality(qualityInput(), limits, { signal: controller.signal }))
        .resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      expect(created).toBe(0);
      const pending = client.meshTetrahedraWithQuality(qualityInput(), limits);
      await expect(client.meshTetrahedraWithQuality(qualityInput(), { minimumMeanRatio: NaN, maximumEdgeRatio: 10 }))
        .rejects.toThrow('invalid limits');
      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
      expect(worker.terminations).toBe(1);
    } finally { client.dispose(); }
  });
  it('keeps disposal and in-flight abort effective for opt-in requests', async () => {
    for (const reason of ['abort', 'disposed'] as const) {
      const worker = port(), client = new FemClient(() => worker), controller = new AbortController();
      try {
        const pending = client.meshTetrahedraWithQuality(qualityInput(),
          { minimumMeanRatio: 0, maximumEdgeRatio: 10 }, { signal: controller.signal });
        if (reason === 'abort') controller.abort(); else client.dispose();
        await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason });
        expect(worker.terminations).toBe(1);
        expect(worker.onmessage).toBeNull();
      } finally { client.dispose(); }
    }
  });
});

describe('frame client input admission', () => {
  it('新frameも不正入力をPromise拒否し、Workerを作らず旧入力を採用しない', async () => {
    let created = 0;
    const client = new FemClient(() => { created += 1; return port(); });
    try {
      let rejected: ReturnType<FemClient['analyzeFrameBoltContact']> | undefined;
      expect(() => { rejected = client.analyzeFrameBoltContact({ schema: 'pointercad-bolt-contact/1' }); }).not.toThrow();
      if (rejected === undefined) throw new Error('Frame client did not return Promise');
      await expect(rejected).rejects.toBeInstanceOf(Error); expect(created).toBe(0);
    } finally { client.dispose(); }
  });
});
