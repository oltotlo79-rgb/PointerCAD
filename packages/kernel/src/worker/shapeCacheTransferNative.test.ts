import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { isValidShape, measureVolume } from '../occt/solidMesh.js';
import type { SolidRecomputeRequest } from '../types.js';
import { recomputeSolids, solidMeshBuffers, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache } from './shapeCache.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });
afterEach(() => { vi.restoreAllMocks(); });

function request(id: string): SolidRecomputeRequest {
  return { generation: 1, steps: [{ id, key: 'shared-shape', label: id, visible: true,
    step: { kind: 'primitive', shape: { kind: 'box', sizeX: 10, sizeY: 20, sizeZ: 2 },
      targetKey: null, originQuery: null, origin: [0, 0, 0], axis: [0, 0, 1] } }] };
}

describe('actual recompute caller after a failed cache replacement', () => {
  it('keeps the newly built native shape owned despite the outer failure catch and cleans it once', async () => {
    const cache = createShapeCache<CachedSolid>(2, undefined, value => solidMeshBuffers(value.mesh));
    const first = await recomputeSolids({ oc, cache }, request('old-feature'));
    expect(first.failures).toEqual([]);
    const old = cache.get('shared-shape');
    if (old === undefined) { cache.clear(); throw new Error('Actual native first body missing'); }
    const failure = new Error('old native owner failed after actual cleanup');
    const originalDelete = old.delete.bind(old);
    const oldDeletes = vi.spyOn(old, 'delete').mockImplementation(() => { originalDelete(); throw failure; });
    const admitted: CachedSolid[] = [], disposed: CachedSolid[] = [];
    const originalSet = cache.set.bind(cache);
    vi.spyOn(cache, 'set').mockImplementation((key, value) => {
      admitted.push(value);
      const dispose = value.delete.bind(value);
      value.delete = () => { disposed.push(value); dispose(); };
      originalSet(key, value);
    });
    try {
      // The real origin identity rule rebuilds the same shape key for another feature.
      expect(old.mesh.origins?.state).toBe('tracked');
      const result = await recomputeSolids({ oc, cache }, request('new-feature'));
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.message).toContain(failure.message);
      expect(result.bodies).toHaveLength(0);
      expect(admitted).toHaveLength(1);
      const fresh = admitted[0];
      if (fresh === undefined) throw new Error('Actual replacement was not built');
      expect(fresh).not.toBe(old);
      expect(cache.get('shared-shape')).toBe(fresh);
      expect(isValidShape(oc, fresh.shape)).toBe(true);
      expect(measureVolume(oc, fresh.shape)).toBeCloseTo(400, 9);
      expect(disposed).toEqual([]);
      expect(oldDeletes).toHaveBeenCalledTimes(1);
      expect(cache.cleanupFailureCount?.()).toBe(1);
      expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
      expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
      expect(disposed).toEqual([fresh]);
      expect(oldDeletes).toHaveBeenCalledTimes(1);
    } finally {
      // Preserve the real cleanup failure. Repeated clear must not repeat native delete.
      expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    }
  });
});
