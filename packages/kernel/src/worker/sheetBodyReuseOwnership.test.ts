import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as allocationModule from '../occt/allocations.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { isValidShape, measureVolume } from '../occt/solidMesh.js';
import type { CurveSpec, SheetBaseStepSpec } from '../types.js';
import { createShapeCache } from './shapeCache.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createSheetBodyReuse } from './sheetBodyReuse.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });
afterEach(() => { vi.restoreAllMocks(); });

function base(x = 0): SheetBaseStepSpec {
  const points = [[x, 0, 0], [x + 10, 0, 0], [x + 10, 20, 0], [x, 20, 0]] as const;
  const outer: CurveSpec[] = points.map((from, index) => ({ kind: 'segment', from, to: points[(index + 1) % 4] }));
  return { kind: 'sheetBase', outer, holes: [], thickness: 2, reversed: false };
}

async function fixture() {
  const cache = createShapeCache<CachedSolid>();
  const reuse = createSheetBodyReuse(oc, cache);
  const input = base();
  const result = await recomputeSolids({ oc, cache }, {
    generation: 1, steps: [{ id: 'original', key: 'original', label: 'original', visible: true, step: input }],
  });
  expect(result.failures).toEqual([]);
  reuse.remember(input, 'original');
  const borrowed = cache.get('original');
  if (borrowed === undefined) { cache.clear(); throw new Error('Native sheet was not cached'); }
  return { cache, reuse, borrowed };
}

// Observes actual wrappers, without replacing the native transform or its geometry.
function observeNativeOwnership() {
  const create = allocationModule.createAllocations;
  const entries: { readonly item: allocationModule.OcctDeletable; deletes: number }[] = [];
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const group = create();
    return { release: group.release, keep<T extends allocationModule.OcctDeletable>(item: T): T {
      const observed = { item, deletes: 0 };
      const original = item.delete.bind(item);
      entries.push(observed);
      item.delete = () => { observed.deletes += 1; original(); };
      return group.keep(item);
    } };
  });
  return entries;
}

describe('sheet reuse native ownership transfer', () => {
  it('disposes an unpublished copy exactly once while its borrowed cache shape remains usable', async () => {
    const { cache, reuse, borrowed } = await fixture();
    try {
      const observed = observeNativeOwnership();
      const copy = reuse.copy(base(100));
      if (copy === null) throw new Error('Expected independent translated copy');
      const owned = observed.slice();
      expect(owned.length).toBeGreaterThan(0);
      expect(new Set(owned.map(value => value.item)).size).toBe(owned.length);
      expect(owned.some(value => value.item === borrowed || value.item === borrowed.shape)).toBe(false);
      try {
        expect(isValidShape(oc, copy.shape)).toBe(true);
        expect(measureVolume(oc, copy.shape)).toBeCloseTo(400, 9);
      } finally { copy.delete(); }
      copy.delete();
      expect(owned.every(value => value.deletes === 1)).toBe(true);
      expect(isValidShape(oc, borrowed.shape)).toBe(true);
      expect(measureVolume(oc, borrowed.shape)).toBeCloseTo(400, 9);
    } finally { cache.clear(); }
  });

  it('releases the real transformed copy when result metadata access fails and preserves the prototype', async () => {
    const { cache, reuse, borrowed } = await fixture();
    const originalMesh = borrowed.mesh;
    const cause = new Error('result metadata failed');
    try {
      const observed = observeNativeOwnership();
      Object.defineProperty(borrowed, 'mesh', { configurable: true, get() { throw cause; } });
      expect(() => reuse.copy(base(100))).toThrow(cause);
      const owned = observed.slice();
      expect(owned.length).toBeGreaterThan(0);
      expect(owned.every(value => value.deletes === 1)).toBe(true);
      expect(owned.some(value => value.item === borrowed || value.item === borrowed.shape)).toBe(false);
      Object.defineProperty(borrowed, 'mesh', { configurable: true, value: originalMesh });
      expect(isValidShape(oc, borrowed.shape)).toBe(true);
      const recovered = reuse.copy(base(200));
      if (recovered === null) throw new Error('Prototype was lost after failed copy publication');
      try { expect(measureVolume(oc, recovered.shape)).toBeCloseTo(400, 9); }
      finally { recovered.delete(); }
    } finally {
      Object.defineProperty(borrowed, 'mesh', { configurable: true, value: originalMesh });
      cache.clear();
    }
  });

  it('lets transformShape clean up its own failed native construction without taking the borrowed source', async () => {
    const { cache, reuse, borrowed } = await fixture();
    try {
      const observed = observeNativeOwnership();
      vi.spyOn(oc.BRepBuilderAPI_MakeShape.prototype, 'Shape').mockImplementationOnce(() => {
        throw new Error('native shape retrieval failed');
      });
      expect(() => reuse.copy(base(100))).toThrow('native shape retrieval failed');
      const owned = observed.slice();
      expect(owned.length).toBeGreaterThan(0);
      expect(owned.every(value => value.deletes === 1)).toBe(true);
      expect(owned.some(value => value.item === borrowed || value.item === borrowed.shape)).toBe(false);
      expect(isValidShape(oc, borrowed.shape)).toBe(true);
      expect(measureVolume(oc, borrowed.shape)).toBeCloseTo(400, 9);
    } finally { cache.clear(); }
  });
});
