import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations } from './allocations.js';
import { AnalysisBoundaryError, buildAnalysisSurfaceMesh, buildAnalysisSurfaceMeshBinding,
  type AnalysisBoundaryErrorCode } from './analysisSurfaceMesh.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { buildSolidBodyMesh } from './solidMesh.js';
import { makeCompound } from './transformShape.js';
import { createKernelApi } from '../worker/kernelApi.js';
import { ExportWorkLimitError } from '../worker/exportWorkLimits.js';
import { createShapeCache, type AcquiringShapeCache } from '../worker/shapeCache.js';
import type { CachedSolid } from '../worker/recomputeSolids.js';

/*
 * AUTHOR-ONLY, UNEXECUTED (GO-18). NEW standalone file packages/kernel/src/occt/analysisMaterialValidation.test.ts so it
 * does not compete with the active analysisSurfaceMesh.test.ts. It covers the explicit FEM opt-in only:
 * - the generic default is unchanged (coincident boxes and a reversed box keep their pre-existing outcomes);
 * - 'native-solid' rejects the actual overlap and reversed cases as 'material-invalid';
 * - 'native-solid' requires a closed boundary and a real in-worker checkpoint;
 * - Error checkpoint throws keep identity; non-Error throws retain their identity in Error.cause, never material-invalid.
 * Synchronous native calls are not interruptible: these tests only observe checkpoints between native calls.
 */
const FINE = { linearDeflection: 0.05, angularDeflection: 0.2, maximumTriangles: 1_000_000 } as const;
let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });

/** External callback boundary: JavaScript dependencies may throw an unknown value. */
function throwExternalFailure(value: unknown): never { throw value; }

function refusalCode(run: () => unknown): AnalysisBoundaryErrorCode {
  let caught: unknown = null;
  try { run(); } catch (error) { caught = error; }
  if (!(caught instanceof AnalysisBoundaryError)) throw new Error(`expected a refusal, got ${String(caught)}`);
  expect(caught.message.length).toBeGreaterThan(10);
  return caught.code;
}

/** Runs `build` with a checkpoint that throws `thrown` on its `pick`-th call (never for Infinity); returns what escaped. */
function escapeAtCall(build: (checkpoint: () => void) => unknown, pick: number,
  thrown: unknown): { readonly caught: unknown; readonly calls: number } {
  let calls = 0;
  let caught: unknown = null;
  try {
    build(() => { calls += 1; if (calls === pick) throwExternalFailure(thrown); });
  } catch (error) { caught = error; }
  return { caught, calls };
}

/** The first calls (they used to sit outside the conversion), the last call, and an even spread in between. */
function checkpointPicks(total: number): number[] {
  const picks = new Set<number>([1, 2, 3, total]);
  for (let part = 1; part < 8; part += 1) picks.add(Math.max(1, Math.round(total * part / 8)));
  return [...picks].sort((left, right) => left - right);
}

/** At every picked checkpoint call an Error keeps its identity and any other value survives as the Error's cause. */
function expectEveryCheckpointConverted(build: (checkpoint: () => void) => unknown): void {
  const { calls: total } = escapeAtCall(build, Number.POSITIVE_INFINITY, undefined);
  expect(total).toBeGreaterThan(3);
  for (const pick of checkpointPicks(total)) {
    const error = new Error(`checkpoint ${String(pick)} failed`);
    const failed = escapeAtCall(build, pick, error);
    expect(failed.calls, `calls made when call ${String(pick)} throws an Error`).toBe(pick);
    expect(failed.caught, `Error thrown by call ${String(pick)}`).toBe(error);
    const value = { reason: `checkpoint ${String(pick)} cancelled` };
    const cancelled = escapeAtCall(build, pick, value);
    expect(cancelled.calls, `calls made when call ${String(pick)} throws a non-Error`).toBe(pick);
    expect(cancelled.caught, `non-Error thrown by call ${String(pick)}`).toBeInstanceOf(Error);
    if (!(cancelled.caught instanceof Error)) throw new Error('expected normalized checkpoint error');
    expect(cancelled.caught.cause, `cause of the Error for call ${String(pick)}`).toBe(value);
    expect(cancelled.caught instanceof AnalysisBoundaryError).toBe(false);
  }
}

describe('explicit FEM material validation on the analysis boundary (kernel)', () => {
  it('generic default is unchanged: overlapping coincident boxes still mesh; only the opt-in rejects them', () => {
    const first = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const second = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const coincident = makeCompound(oc, [first.shape, second.shape]);
    try {
      const generic = buildAnalysisSurfaceMesh(oc, coincident.shape, { ...FINE, boundary: 'closed' });
      expect(generic.faces).toHaveLength(12);
      expect(generic.metrics.components).toBe(2);
      let calls = 0;
      expect(refusalCode(() => buildAnalysisSurfaceMesh(oc, coincident.shape,
        { ...FINE, boundary: 'closed', materialValidation: 'native-solid' }, () => { calls += 1; }))).toBe('material-invalid');
      expect(calls).toBeGreaterThan(0);
      // The single valid box passes the same opt-in and returns the same mesh shape as the generic path.
      const plain = buildAnalysisSurfaceMesh(oc, first.shape, { ...FINE, boundary: 'closed' });
      const checked = buildAnalysisSurfaceMesh(oc, first.shape, { ...FINE, boundary: 'closed', materialValidation: 'native-solid' }, () => undefined);
      expect(checked.nodeCount).toBe(plain.nodeCount);
      expect(Array.from(checked.triangles)).toEqual(Array.from(plain.triangles));
      expect(Array.from(checked.coordinates)).toEqual(Array.from(plain.coordinates));
    } finally { coincident.delete(); second.delete(); first.delete(); }
  });

  it('a reversed box keeps its generic refusal and is material-invalid under the opt-in (no orientation normalization)', () => {
    const box = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const owner = createAllocations();
    try {
      const reversed = owner.keep(box.shape.Reversed());
      expect(refusalCode(() => buildAnalysisSurfaceMesh(oc, reversed, { ...FINE, boundary: 'closed' }))).toBe('inward-orientation');
      expect(refusalCode(() => buildAnalysisSurfaceMesh(oc, reversed,
        { ...FINE, boundary: 'closed', materialValidation: 'native-solid' }, () => undefined))).toBe('material-invalid');
    } finally { owner.release(); box.delete(); }
  });

  it('the opt-in requires a closed boundary and a real checkpoint', () => {
    const box = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      expect(refusalCode(() => buildAnalysisSurfaceMesh(oc, box.shape,
        { ...FINE, boundary: 'open', materialValidation: 'native-solid' }, () => undefined))).toBe('invalid-options');
      expect(refusalCode(() => buildAnalysisSurfaceMesh(oc, box.shape,
        { ...FINE, boundary: 'closed', materialValidation: 'native-solid' }))).toBe('invalid-options');
      // Generic open boundary without the opt-in is unchanged.
      expect(buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, boundary: 'open' }).faces).toHaveLength(6);
    } finally { box.delete(); }
  });

  it('an Error checkpoint throw propagates with its identity and is never converted to material-invalid', () => {
    const box = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      const sentinel = new Error('request-cancelled');
      let caught: unknown = null;
      try {
        buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, boundary: 'closed', materialValidation: 'native-solid' }, () => { throw sentinel; });
      } catch (error) { caught = error; }
      expect(caught).toBe(sentinel);
      expect(caught instanceof AnalysisBoundaryError).toBe(false);
    } finally { box.delete(); }
  });

  it('a non-Error checkpoint throw is normalized to Error with the original object as cause', () => {
    const box = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      const sentinel = { reason: 'request-cancelled' };
      let caught: unknown = null;
      try {
        buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, boundary: 'closed', materialValidation: 'native-solid' }, () => { throwExternalFailure(sentinel); });
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      if (!(caught instanceof Error)) throw new Error('expected normalized checkpoint error');
      expect(caught.cause).toBe(sentinel);
      expect(caught instanceof AnalysisBoundaryError).toBe(false);
    } finally { box.delete(); }
  });

  it('every checkpoint call is converted the same way: an Error keeps its identity, any other value stays the cause', () => {
    const box = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      expectEveryCheckpointConverted(checkpoint => buildAnalysisSurfaceMesh(oc, box.shape,
        { ...FINE, boundary: 'closed', materialValidation: 'native-solid' }, checkpoint));
    } finally { box.delete(); }
  });

  it('the proof-binding entry converts its checkpoint throws the same way', () => {
    const box = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      expectEveryCheckpointConverted(checkpoint => buildAnalysisSurfaceMeshBinding(oc, box.shape,
        { ...FINE, boundary: 'closed' }, checkpoint));
    } finally { box.delete(); }
  });

  it('the refinement loop converts its own checkpoint throws the same way', () => {
    const box = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      const freeformRefinement = { maximumChordDeviationMm: 0.01, maximumVolumeDeviationMm3: 0.02,
        maximumNodes: 1024, maximumTriangles: 2048 };
      expectEveryCheckpointConverted(checkpoint => buildAnalysisSurfaceMesh(oc, box.shape,
        { ...FINE, boundary: 'closed', materialValidation: 'native-solid', freeformRefinement }, checkpoint));
    } finally { box.delete(); }
  });

});

describe('explicit FEM material validation through the worker API', () => {
  const caches: AcquiringShapeCache<CachedSolid>[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const cache of caches.splice(0)) cache.clear(); });
  function cachedBox(key: string): AcquiringShapeCache<CachedSolid> {
    const shapes = createShapeCache<CachedSolid>(4); caches.push(shapes);
    const handle = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    shapes.set(key, { shape: handle.shape, mesh: buildSolidBodyMesh(oc, key, handle.shape), delete: () => { handle.delete(); } });
    return shapes;
  }
  const request = { bodyKey: 'box', boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 };

  it('default and explicit requests both mesh a valid box; the opt-in is carried as clonable data only', async () => {
    const api = createKernelApi(() => Promise.resolve(oc), cachedBox('box'));
    const generic = await api.buildAnalysisSurfaceMesh(request);
    const explicit = await api.buildAnalysisSurfaceMesh({ ...request, materialValidation: 'native-solid' });
    expect(generic.kind).toBe('mesh');
    expect(explicit.kind).toBe('mesh');
    expect(structuredClone({ ...request, materialValidation: 'native-solid' })).toEqual({ ...request, materialValidation: 'native-solid' });
  });

  it('an open opt-in is a failed reply, not a thrown error', async () => {
    const api = createKernelApi(() => Promise.resolve(oc), cachedBox('box'));
    expect(await api.buildAnalysisSurfaceMesh({ ...request, boundary: 'open', materialValidation: 'native-solid' }))
      .toMatchObject({ kind: 'failed', code: 'invalid-options' });
  });

  it('the existing finite request deadline stops the opt-in with ExportWorkLimitError identity (between native calls)', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    // The budget starts on arrival (now = 0); the deadline has passed by the time OCCT is loaded.
    const api = createKernelApi(() => { now = 30_000; return Promise.resolve(oc); }, cachedBox('box'));
    let caught: unknown = null;
    try { await api.buildAnalysisSurfaceMesh({ ...request, materialValidation: 'native-solid' }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ExportWorkLimitError);
    // The generic request has no material deadline and is unchanged by the same clock.
    now = 0;
    const generic = createKernelApi(() => { now = 30_000; return Promise.resolve(oc); }, cachedBox('box2'));
    expect((await generic.buildAnalysisSurfaceMesh({ ...request, bodyKey: 'box2' })).kind).toBe('mesh');
  });
});
