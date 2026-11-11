import { describe, expect, it } from 'vitest';
import type { AnalysisBoundaryReply, AnalysisBoundarySource } from '@pointercad/model';
import { analyzeCadSolidFinite, cadSolidFiniteInput } from './cadSolidFinite.js';
import { meshCadBoundary } from './cadTetraMesh.js';
import { prepareCadSolidAnalysis } from './cadSolidAnalysis.js';
import { translateSolidFinite } from './solidFiniteTranslation.js';
import { context, kernel, boundaryMesh, finiteSettings, ownedClient } from './cadSolidFinite.testSupport.js';

function delayedKernel() {
  let resolve: ((reply: AnalysisBoundaryReply) => void) | undefined;
  const source: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => new Promise(done => { resolve = done; }) };
  return { source, finish: () => { resolve?.({ kind: 'mesh', bodyKey: 'box:7', mesh: boundaryMesh() }); } };
}
describe('CAD finite ownership: actual client, synthetic zero-state Workers, no native physics claim', () => {
  it('sends mesh and finite solve through separate Workers in one owned generation, preserving material provenance', async () => {
    const current = context(), h = ownedClient();
    const result = await analyzeCadSolidFinite(h.client, kernel(), () => current, finiteSettings(current));
    expect(result.kind).toBe('result');
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(result.materialReference).toBe(finiteSettings(current).materialReference);
    expect(result.input.source).toEqual({ documentId: 'part', revision: 7 });
    expect(result.prepared.input.source.meshKey).toBe(result.mesh.inputSha256);
    expect(h.requests.map(row => row.kind)).toEqual(['mesh-cad-convex-tetra', 'analyze-solid-finite-j2']);
    expect(h.requests[0].identity.generation).toBe(h.requests[1].identity.generation);
    expect(h.requests[0].identity.requestId).not.toBe(h.requests[1].identity.requestId);
    expect(h.workers.map(worker => worker.terminations)).toEqual([1, 1]);
  });
  it.each(['another-solver', 'invalid-request', 'contact-preparation', 'abort', 'dispose'] as const)(
    'refuses an old boundary after %s without superseding newer work', async action => {
      const h = ownedClient(), delayed = delayedKernel(), current = context(), abort = new AbortController();
      const old = analyzeCadSolidFinite(h.client, delayed.source, () => current, finiteSettings(current), { signal: abort.signal });
      let newer: ReturnType<typeof h.client.qualify> | undefined;
      let contact: ReturnType<typeof h.client.beginSolidContactPreparation> | undefined;
      if (action === 'another-solver') newer = h.client.qualify('newer', 9);
      else if (action === 'invalid-request') await expect(h.client.analyzeSolidFinite({})).rejects.toThrow();
      else if (action === 'contact-preparation') contact = h.client.beginSolidContactPreparation();
      else if (action === 'abort') abort.abort();
      else h.client.dispose();
      delayed.finish();
      expect(await old).toEqual({ kind: 'cancelled', reason: action === 'abort' ? 'abort' : action === 'dispose' ? 'disposed' : 'superseded' });
      expect(h.requests.filter(row => row.kind !== 'qualify-oofem-beam')).toEqual([]);
      expect(contact?.cancellation() ?? null).toBeNull();
      if (newer !== undefined) {
        expect(h.workers[0].terminations).toBe(0);
        h.client.dispose(); expect(await newer).toMatchObject({ kind: 'cancelled', reason: 'disposed' });
      }
      contact?.release();
    });
  it('a newer finite CAD preparation wins when the older boundary finishes last', async () => {
    const h = ownedClient(), delayed = delayedKernel(), current = context();
    const old = analyzeCadSolidFinite(h.client, delayed.source, () => current, finiteSettings(current));
    const newer = await analyzeCadSolidFinite(h.client, kernel(), () => current, finiteSettings(current));
    expect(newer.kind).toBe('result'); delayed.finish();
    expect(await old).toEqual({ kind: 'cancelled', reason: 'superseded' }); expect(h.requests).toHaveLength(2);
  });
  it.each(['revision', 'body-key', 'same-revision-face'] as const)('rejects stale %s during kernel wait before a mesh Worker', async change => {
    const h = ownedClient(), delayed = delayedKernel(); let current = context();
    const old = analyzeCadSolidFinite(h.client, delayed.source, () => current, finiteSettings(current));
    current = change === 'revision' ? { ...current, revision: 8 }
      : change === 'body-key' ? { ...current, steps: [{ featureId: 'box', key: 'box:8' }] }
      : { ...current, body: { ...current.body, faces: current.body.faces.map((face, index) => index === 0 ? { ...face, area: face.area + 1 } : face) } };
    delayed.finish(); expect(await old).toMatchObject({ kind: 'failed' }); expect(h.requests).toEqual([]);
  });
  it('cannot publish a same-revision CAD change made while the finite result is pending', async () => {
    let current = context();
    const h = ownedClient(request => { if (request.kind === 'analyze-solid-finite-j2') current = { ...current, body: { ...current.body, volume: 25 } }; });
    const result = await analyzeCadSolidFinite(h.client, kernel(), () => current, finiteSettings(current));
    expect(result).toMatchObject({ kind: 'failed', code: 'cad-solid-finite' });
  });
  it('a newer solver started during post-result re-preparation survives the old lease release', async () => {
    const current = context(); let afterResult = false, reads = 0;
    const h = ownedClient(request => { if (request.kind === 'analyze-solid-finite-j2') afterResult = true; });
    let newer: ReturnType<typeof h.client.qualify> | undefined;
    const result = await analyzeCadSolidFinite(h.client, kernel(), () => {
      if (afterResult && ++reads === 2) newer = h.client.qualify('newer', 10);
      return current;
    }, finiteSettings(current));
    expect(result).toEqual({ kind: 'cancelled', reason: 'superseded' });
    expect(h.workers.at(-1)?.terminations).toBe(0);
    h.client.dispose(); expect(await newer).toMatchObject({ kind: 'cancelled', reason: 'disposed' });
  });
  it('publishes a reservation before old abort listeners can start newer work', async () => {
    const h = ownedClient(), old = h.client.beginSolidContactPreparation();
    let newer: ReturnType<typeof h.client.qualify> | undefined;
    old.signal.addEventListener('abort', () => { newer = h.client.qualify('newer', 11); }, { once: true });
    const reserved = h.client.beginSolidFinitePreparation();
    expect(reserved.cancellation()).toBe('superseded'); reserved.release();
    expect(h.workers[0].terminations).toBe(0);
    h.client.dispose(); expect(await newer).toMatchObject({ kind: 'cancelled', reason: 'disposed' });
  });
  it('rejects bad history before calling the boundary source', async () => {
    const h = ownedClient(), current = context(); let calls = 0;
    const result = await analyzeCadSolidFinite(h.client, kernel(() => { calls++; }), () => current,
      { ...finiteSettings(current), forceFactors: [NaN] });
    expect(result).toMatchObject({ kind: 'failed' }); expect(calls).toBe(0); expect(h.requests).toEqual([]);
  });
  it('binds the solve to the successful mesh source and refuses replay of either Worker stage', async () => {
    const h = ownedClient(), current = context(), settings = finiteSettings(current), lease = h.client.beginSolidFinitePreparation();
    const mesh = await meshCadBoundary(lease, kernel(), () => current,
      { boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2 }, { signal: lease.signal });
    if (mesh.kind !== 'result') throw new Error(JSON.stringify(mesh));
    await expect(lease.meshTetrahedra(mesh.mesh.input)).rejects.toThrow('already dispatched');
    const input = cadSolidFiniteInput(prepareCadSolidAnalysis(current, mesh.mesh, mesh.regions, [0, 1, 2, 3, 4, 5], settings), settings);
    await expect(lease.analyzeSolidFinite({ ...input, source: { ...input.source, revision: 8 } })).rejects.toThrow('another mesh source');
    expect((await lease.analyzeSolidFinite(input)).kind).toBe('result');
    await expect(lease.analyzeSolidFinite(input)).rejects.toThrow('unused mesh');
    lease.release(); expect(await lease.analyzeSolidFinite(input)).toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(h.requests).toHaveLength(2); expect(h.workers.map(worker => worker.terminations)).toEqual([1, 1]);
  });
  it.each(['coordinates', 'element-order', 'local-connectivity', 'node-order', 'mutated-returned-mesh'] as const)(
    'rejects same-source %s changes against the privately captured successful mesh', async changed => {
      const h = ownedClient(), current = context(), settings = finiteSettings(current), lease = h.client.beginSolidFinitePreparation();
      const mesh = await meshCadBoundary(lease, kernel(), () => current,
        { boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2 }, { signal: lease.signal });
      if (mesh.kind !== 'result') throw new Error(JSON.stringify(mesh));
      const input = cadSolidFiniteInput(prepareCadSolidAnalysis(current, mesh.mesh, mesh.regions, [0, 1, 2, 3, 4, 5], settings), settings);
      const nodeCount = input.plan.nodes.length;
      const plan = changed === 'element-order' ? { ...input.plan, elements: [...input.plan.elements].reverse() }
        : changed === 'local-connectivity' ? { ...input.plan, elements: input.plan.elements.map(([a, b, c, d]) => [b, c, a, d]) }
        : changed === 'node-order' ? { ...input.plan, nodes: [...input.plan.nodes].reverse(),
          elements: input.plan.elements.map(element => element.map(node => nodeCount - 1 - node)) }
        : { ...input.plan, nodes: input.plan.nodes.map(([x, y, z]) => [x + 1, y, z]) };
      const other = { ...input, plan };
      expect(other.source).toEqual(input.source);
      expect(() => translateSolidFinite(other)).not.toThrow(); // Each is a valid W34 plan; mesh ownership must reject it.
      if (changed === 'mutated-returned-mesh') {
        Object.defineProperty(mesh.mesh, 'coordinates', { value: plan.nodes.flat(), configurable: true });
      }
      await expect(lease.analyzeSolidFinite(other)).rejects.toThrow('nodes or tetrahedra differ from the accepted mesh');
      expect(h.requests.map(row => row.kind)).toEqual(['mesh-cad-convex-tetra']);
      lease.release(); expect(h.workers.map(worker => worker.terminations)).toEqual([1]);
    });
});
