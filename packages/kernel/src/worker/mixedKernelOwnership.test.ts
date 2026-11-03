import { describe, expect, it, vi } from 'vitest';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import * as placements from '../occt/placeBodies.js';
import { createKernelApi } from './kernelApi.js';
import { createShapeCache } from './shapeCache.js';
import type { CachedSolid } from './recomputeSolids.js';

describe('measurement ownership with actual cached and placed bodies', () => {
  it.each([false, true])('all placement handles are released even when cleanup throws=%s', async failCleanup => {
    const cache = createShapeCache<CachedSolid>();
    const api = createKernelApi(loadOcctForNode, cache);
    const nativePlace = placements.placeShape;
    const observed: { deletes: number; dispose: () => void }[] = [];
    const failure = new Error('injected placement destructor failure');
    try {
      const built = await api.recomputeSolids({ generation: 1, steps: [{
        id: 'box', key: 'box-key', label: 'box', visible: true,
        step: { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1], shape: { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 },
          originQuery: null, targetKey: null },
      }] });
      expect(built.failures).toEqual([]);
      vi.spyOn(placements, 'placeShape').mockImplementation((...args) => {
        const handle = nativePlace(...args);
        const entry = { deletes: 0, dispose: handle.delete.bind(handle) };
        observed.push(entry);
        const shouldFail = failCleanup && observed.length === 2;
        handle.delete = () => {
          entry.deletes++; entry.dispose();
          if (shouldFail) throw failure;
        };
        return handle;
      });
      const measured = api.measure({ kind: 'distance', targets: [0, 50].map(x => ({
        bodyKey: 'box-key', subShape: null,
        placement: { position: [x, 0, 0] as const, rotation: [0, 0, 0, 1] as const },
      })) });
      if (failCleanup) await expect(measured).rejects.toBe(failure);
      else {
        const distance = await measured;
        expect(distance.kind).toBe('distance');
        if (distance.kind !== 'distance') throw new Error('Expected native distance result');
        // kernelApi.test.ts uses six decimal places for native box distances (50 - 20 = 30 mm).
        expect(distance.distance).toBeCloseTo(30, 6);
      }
      expect(observed.map(entry => entry.deletes)).toEqual([1, 1]);
      expect(cache.get('box-key')?.shape.IsNull()).toBe(false);
      const properties = await api.measure({ kind: 'massProperties', targets: [{ bodyKey: 'box-key', subShape: null }] });
      expect(properties.kind).toBe('massProperties');
      if (properties.kind !== 'massProperties') throw new Error('Expected native mass properties');
      // Same precision as kernelApi.test.ts's native 20 mm cube; independent volume is 20 * 20 * 20.
      expect(properties.volume).toBeCloseTo(8000, 6);
    } finally {
      vi.restoreAllMocks();
      for (const entry of observed) if (entry.deletes === 0) entry.dispose();
      cache.clear();
    }
  });
});
