import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as allocations from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { isValidShape, measureArea, measureVolume } from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';
import * as volumeProperties from './volumeProperties.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { vi.restoreAllMocks(); });

// Follows booleanOp.test.ts: track the actual native wrappers passed to the real helper.
function observe() {
  const create = allocations.createAllocations;
  const entries: { deletes: number }[] = [], order: number[] = [];
  vi.spyOn(allocations, 'createAllocations').mockImplementation(() => {
    const group = create();
    return { release: group.release, keep<T extends allocations.OcctDeletable>(item: T): T {
      const index = entries.length, entry = { deletes: 0 }, original = item.delete.bind(item);
      entries.push(entry);
      item.delete = () => { entry.deletes += 1; order.push(index); original(); };
      return group.keep(item);
    } };
  });
  return { entries, order };
}

describe('solid mesh and topology native ownership', () => {
  it('releases temporary wrappers but keeps the borrowed shape and numerical results', () => {
    const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    const shapeDelete = vi.spyOn(box.shape, 'delete');
    try {
      const observed = observe();
      expect(measureVolume(oc, box.shape)).toBeCloseTo(6000, 6);
      expect(measureArea(oc, box.shape)).toBeCloseTo(2200, 6);
      expect(isValidShape(oc, box.shape)).toBe(true);
      expect(countSolidShapes(oc, box.shape, 1)).toBe(1);
      expect(observed.entries.length).toBeGreaterThanOrEqual(5);
      expect(observed.entries.every(entry => entry.deletes === 1)).toBe(true);
      expect(shapeDelete).not.toHaveBeenCalled();
      expect(measureVolume(oc, box.shape)).toBeCloseTo(6000, 6);
    } finally { vi.restoreAllMocks(); box.delete(); }
  });

  it('releases properties after a measurement failure and leaves the input usable', () => {
    const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    try {
      const observed = observe();
      vi.spyOn(volumeProperties, 'computeVolumeProperties').mockImplementation(() => { throw new Error('measurement failure'); });
      expect(() => measureVolume(oc, box.shape)).toThrow('measurement failure');
      expect(observed.entries.map(entry => entry.deletes)).toEqual([1]);
      vi.restoreAllMocks();
      expect(measureVolume(oc, box.shape)).toBeCloseTo(6000, 6);
    } finally { vi.restoreAllMocks(); box.delete(); }
  });

  it('releases the current key before the map on a shape-type failure', () => {
    const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    try {
      const observed = observe();
      vi.spyOn(oc.TopoDS_Shape.prototype, 'ShapeType').mockImplementation(() => { throw new Error('shape type failure'); });
      expect(() => countSolidShapes(oc, box.shape)).toThrow('shape type failure');
      expect(observed.entries.map(entry => entry.deletes)).toEqual([1, 1]);
      expect(observed.order).toEqual([1, 0]);
      vi.restoreAllMocks();
      expect(countSolidShapes(oc, box.shape)).toBe(1);
    } finally { vi.restoreAllMocks(); box.delete(); }
  });
});
