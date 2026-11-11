import { describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, createSubShapeReference, requestAnalysisBoundary, resolvePart,
  type AnalysisBoundaryReply, type AnalysisBoundarySource, type ResolvedAssembly, type RigidPlacement } from '@pointercad/model';
import type { FemClient } from './client.js';
import { meshAssemblyTetrahedra, selectAssemblyTetraBoundary, type AssemblyTetraBudget, type AssemblyTetraContext,
  type AssemblyTetraPart } from './assemblyTetraMesh.js';
import { meshCadAssemblyTetrahedra, type CadAssemblyTetraContext, type CadAssemblyTetraPart } from './cadAssemblyTetraMesh.js';
import { prepareCadTetraMesh } from './cadTetraMesh.js';
import { boundaryMesh, context, kernel, ownedClient } from './cadSolidFinite.testSupport.js';
import { cantilever } from './analysisCases.testSupport.js';

// Existing analytic 2x3x4 box transport fixtures with the real FemClient owner. No native qualification claim.
const budget: AssemblyTetraBudget = { occurrences: 1000, uniqueParts: 1000,
  nodes: 10000000, tetrahedra: 50000000, numericBytes: 8000000000, concurrentGenerations: 1 };
const boundary = { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 };
async function fixture() {
  const number = (value: number) => ({ source: String(value), value, display: String(value) });
  const resolved = resolvePart(appendSolid(createEmptyPartDocument(), { id: 'box', name: 'box', kind: 'primitive',
    suppressed: false, origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: number(2), sizeY: number(3), sizeZ: number(4) } }));
  const step = resolved.steps.find(item => item.featureId === 'box');
  if (step === undefined) throw new Error('Box fixture did not resolve');
  const parts = new Map<string, AssemblyTetraPart>(), cadParts = new Map<string, CadAssemblyTetraPart>();
  const resolvedParts = new Map<string, typeof resolved>(), placements = new Map<string, RigidPlacement>();
  const partKeys = new Map<string, string>();
  for (let i = 0; i < 2; i++) {
    const key = `part-${i}`, current = { ...context(), documentId: key, steps: [{ featureId: 'box', key: step.key }] };
    const extracted = await requestAnalysisBoundary(kernel(), current.steps, current.body, { ...boundary, materialValidation: 'native-solid' });
    if (extracted.kind !== 'ready') throw new Error(extracted.message);
    const prepared = prepareCadTetraMesh(extracted.boundary, current);
    parts.set(key, { input: prepared.input, regions: { regions: prepared.regions, labelFaces: [0, 1, 2, 3, 4, 5] } });
    cadParts.set(key, { kind: 'planar', context: current, boundary }); resolvedParts.set(key, resolved);
    placements.set(`component-${i}`, { position: [i * 10, 0, 0], rotation: [0, 0, 0, 1] }); partKeys.set(`component-${i}`, key);
  }
  const assembly: ResolvedAssembly = { parts: resolvedParts, placements, partKeys, errors: [] };
  const value: AssemblyTetraContext = { documentId: 'assembly', revision: 9, assembly, parts };
  const cad: CadAssemblyTetraContext = { documentId: 'assembly', revision: 9, assembly, parts: cadParts };
  const first = parts.get('part-0'), cadFirst = cadParts.get('part-0');
  if (first === undefined || cadFirst === undefined) throw new Error('Missing first part');
  const reference = createSubShapeReference(cadFirst.context.body, 'face', 1);
  if (reference === null) throw new Error('Missing face origin');
  return { value, cad, first, reference };
}
function heldBoundary() {
  let finish: ((reply: AnalysisBoundaryReply) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let key: string | undefined, calls = 0;
  const source: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => {
    calls++;
    if (calls > 1) return Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: boundaryMesh() });
    key = request.bodyKey;
    return new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  } };
  return { source, calls: () => calls,
    finish: (): void => {
      if (finish === undefined || key === undefined) throw new Error('Boundary was not requested');
      finish({ kind: 'mesh', bodyKey: key, mesh: boundaryMesh() });
    },
    fail: (): void => {
      if (reject === undefined) throw new Error('Boundary was not requested');
      reject(new Error('Delayed CAD extraction failure'));
    },
  };
}

describe.each(['prepared', 'cad'] as const)('%s assembly shares one parent reservation', route => {
  it.each(['new-solver', 'invalid-solver', 'disposed', 'abort'] as const)(
    'rejects old preparation after %s without stopping a later solver', async mode => {
      const f = await fixture(), h = ownedClient(), held = heldBoundary(), controller = new AbortController();
      const narrowed: Pick<FemClient, 'meshTetrahedra'> = h.client;
      const pending = route === 'prepared'
        ? meshAssemblyTetrahedra(narrowed, () => f.value, budget, { signal: controller.signal })
        : meshCadAssemblyTetrahedra(narrowed, held.source, () => f.cad, budget, { signal: controller.signal });
      let newer: ReturnType<FemClient['analyze']> | undefined;
      try {
        expect(h.requests).toHaveLength(0);
        if (mode === 'new-solver') newer = h.client.analyze(cantilever());
        else if (mode === 'invalid-solver') await expect(h.client.analyze({})).rejects.toThrow();
        else if (mode === 'disposed') h.client.dispose();
        else controller.abort();
        if (route === 'cad') held.finish();
        await expect(pending).resolves.toEqual({ kind: 'cancelled',
          reason: mode === 'new-solver' || mode === 'invalid-solver' ? 'superseded' : mode });
        expect(h.requests.filter(request => request.kind === 'mesh-cad-convex-tetra')).toHaveLength(0);
        if (newer !== undefined) {
          expect(h.workers[0].terminations).toBe(0);
          h.client.dispose();
          await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
          expect(h.workers[0].terminations).toBe(1);
        } else expect(h.workers).toHaveLength(0);
      } finally { if (route === 'cad') held.finish(); h.client.dispose(); await pending; if (newer !== undefined) await newer; }
    });

  it('meshes both unique parts in one generation with two individually terminated Workers', async () => {
    const f = await fixture(), h = ownedClient();
    try {
      const outcome = route === 'prepared' ? await meshAssemblyTetrahedra(h.client, () => f.value, budget)
        : await meshCadAssemblyTetrahedra(h.client, kernel(), () => f.cad, budget);
      if (outcome.kind !== 'result') throw new Error(JSON.stringify(outcome));
      expect(outcome.result.parts.size).toBe(2);
      expect(h.requests.map(request => request.kind)).toEqual(['mesh-cad-convex-tetra', 'mesh-cad-convex-tetra']);
      expect(new Set(h.requests.map(request => request.identity.generation)).size).toBe(1);
      expect(new Set(h.requests.map(request => request.identity.requestId)).size).toBe(2);
      expect(h.workers.map(worker => worker.terminations)).toEqual([1, 1]);
      expect(selectAssemblyTetraBoundary(outcome.result, 'component-1', f.reference))
        .toMatchObject({ kind: 'selected', partKey: 'part-1', triangleIndices: [2, 3], nodeIndices: [4, 5, 6, 7] });
      const newer = h.client.analyze(cantilever());
      expect(h.workers[2].terminations).toBe(0);
      h.client.dispose(); await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    } finally { h.client.dispose(); }
  });

  it.each(['new-solver', 'disposed', 'abort'] as const)('stops before part two after %s between meshes', async mode => {
    const f = await fixture(), h = ownedClient(), controller = new AbortController();
    let acted = false, newer: ReturnType<FemClient['analyze']> | undefined;
    const intervene = (): void => {
      if (acted || h.workers[0]?.terminations !== 1) return;
      acted = true;
      if (mode === 'new-solver') newer = h.client.analyze(cantilever());
      else if (mode === 'disposed') h.client.dispose();
      else controller.abort();
    };
    try {
      const pending = route === 'prepared'
        ? meshAssemblyTetrahedra(h.client, () => { intervene(); return f.value; }, budget, { signal: controller.signal })
        : meshCadAssemblyTetrahedra(h.client, kernel(), () => { intervene(); return f.cad; }, budget, { signal: controller.signal });
      await expect(pending).resolves.toEqual({ kind: 'cancelled', reason: mode === 'new-solver' ? 'superseded' : mode });
      expect(acted).toBe(true);
      expect(h.requests.filter(request => request.kind === 'mesh-cad-convex-tetra')).toHaveLength(1);
      expect(h.workers[0].terminations).toBe(1);
      if (newer !== undefined) {
        expect(h.workers[1].terminations).toBe(0); h.client.dispose();
        await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
      }
    } finally { h.client.dispose(); if (newer !== undefined) await newer; }
  });

  it.each(['new-solver', 'disposed', 'abort'] as const)('discards the second Worker reply after %s', async mode => {
    const f = await fixture(), controller = new AbortController();
    let meshReplies = 0, newer: ReturnType<FemClient['analyze']> | undefined;
    const h = ownedClient(request => {
      if (request.kind !== 'mesh-cad-convex-tetra' || ++meshReplies !== 2) return;
      if (mode === 'new-solver') newer = h.client.analyze(cantilever());
      else if (mode === 'disposed') h.client.dispose();
      else controller.abort();
    });
    try {
      const outcome = route === 'prepared'
        ? await meshAssemblyTetrahedra(h.client, () => f.value, budget, { signal: controller.signal })
        : await meshCadAssemblyTetrahedra(h.client, kernel(), () => f.cad, budget, { signal: controller.signal });
      expect(outcome).toEqual({ kind: 'cancelled', reason: mode === 'new-solver' ? 'superseded' : mode });
      expect(meshReplies).toBe(2);
      expect(h.workers.slice(0, 2).map(worker => worker.terminations)).toEqual([1, 1]);
      if (newer !== undefined) {
        expect(h.workers[2].terminations).toBe(0); h.client.dispose();
        await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
      }
    } finally { h.client.dispose(); if (newer !== undefined) await newer; }
  });

  it('does not overwrite ownership created by an old reservation abort listener', async () => {
    const f = await fixture(), h = ownedClient(), previous = h.client.beginAssemblyTetraMeshPreparation();
    let newer: ReturnType<FemClient['analyze']> | undefined, reads = 0;
    previous.signal.addEventListener('abort', () => { newer = h.client.analyze(cantilever()); }, { once: true });
    try {
      const outcome = route === 'prepared'
        ? await meshAssemblyTetrahedra(h.client, () => { reads++; return f.value; }, budget)
        : await meshCadAssemblyTetrahedra(h.client, kernel(), () => { reads++; return f.cad; }, budget);
      expect(outcome).toEqual({ kind: 'cancelled', reason: 'superseded' }); expect(reads).toBe(0);
      expect(h.workers).toHaveLength(1); expect(h.workers[0].terminations).toBe(0);
      h.client.dispose(); await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    } finally { previous.release(); h.client.dispose(); if (newer !== undefined) await newer; }
  });
});

describe('assembly parent capability boundaries', () => {
  it('rejects simultaneous dispatch, permits subsequent dispatch and leaves borrowed release to its creator', async () => {
    const f = await fixture(), h = ownedClient(), lease = h.client.beginAssemblyTetraMeshPreparation();
    try {
      const first = lease.meshTetrahedra(f.first.input);
      await expect(lease.meshTetrahedra(f.first.input)).rejects.toThrow('sequentially');
      expect((await first).kind).toBe('result');
      const outcome = await meshAssemblyTetrahedra(h.client, () => f.value, budget, {}, lease);
      expect(outcome.kind).toBe('result'); expect(lease.cancellation()).toBeNull(); expect(lease.signal.aborted).toBe(false);
      expect(h.requests).toHaveLength(3); expect(h.workers.map(worker => worker.terminations)).toEqual([1, 1, 1]);
    } finally { lease.release(); h.client.dispose(); }
  });

  it('refuses a structural copy or a different client parent before reading CAD or dispatching', async () => {
    const f = await fixture(), h = ownedClient(), other = ownedClient(), lease = h.client.beginAssemblyTetraMeshPreparation();
    let reads = 0;
    try {
      for (const [client, parent] of [[h.client, { ...lease }], [other.client, lease]] as const) {
        await expect(meshAssemblyTetrahedra(client, () => { reads++; return f.value; }, budget, {}, parent))
          .resolves.toMatchObject({ kind: 'failed', code: 'input' });
      }
      expect(reads).toBe(0); expect(h.requests).toHaveLength(0); expect(other.requests).toHaveLength(0);
      expect(lease.cancellation()).toBeNull();
    } finally { lease.release(); h.client.dispose(); other.client.dispose(); }
  });

  it('keeps supersession when CAD extraction rejects late and its finally releases the old parent', async () => {
    const f = await fixture(), h = ownedClient(), held = heldBoundary();
    const pending = meshCadAssemblyTetrahedra(h.client, held.source, () => f.cad, budget);
    const newer = h.client.analyze(cantilever());
    try {
      held.fail(); await expect(pending).resolves.toEqual({ kind: 'cancelled', reason: 'superseded' });
      expect(h.requests).toHaveLength(1); expect(h.workers[0].terminations).toBe(0);
      h.client.dispose(); await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    } finally { held.finish(); h.client.dispose(); await pending; await newer; }
  });
});
