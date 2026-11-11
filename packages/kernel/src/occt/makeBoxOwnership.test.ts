import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as allocationModule from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { tessellate } from './tessellate.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { vi.restoreAllMocks(); });

// Same real-wrapper accounting as booleanOp.test.ts: keep observes native delete calls.
function observe() {
  const create = allocationModule.createAllocations;
  const entries: { deletes: number }[] = [];
  const order: number[] = [];
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const group = create();
    return { release: group.release, keep<T extends allocationModule.OcctDeletable>(item: T): T {
      const index = entries.length, entry = { deletes: 0 }, original = item.delete.bind(item);
      entries.push(entry);
      item.delete = () => { entry.deletes += 1; order.push(index); original(); };
      return group.keep(item);
    } };
  });
  return { entries, order };
}

describe('makeBox native wrapper ownership', () => {
  it('keeps the actual shape until release and frees both wrappers in reverse order', () => {
    const tracked = observe();
    const handle = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    const entries = tracked.entries.slice();
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.deletes)).toEqual([0, 0]);
    try {
      const mesh = tessellate(oc, handle.shape);
      expect(mesh.faceCount).toBe(6); expect(mesh.triangleCount).toBe(12);
    } finally { handle.delete(); }
    expect(entries.map(entry => entry.deletes)).toEqual([1, 1]);
    expect(tracked.order.filter(index => index < 2)).toEqual([1, 0]);
    handle.delete();
    expect(entries.map(entry => entry.deletes)).toEqual([1, 1]);
  });

  it('releases the real maker if shape retrieval throws', () => {
    const tracked = observe();
    vi.spyOn(oc.BRepBuilderAPI_MakeShape.prototype, 'Shape').mockImplementation(() => { throw new Error('injected Shape failure'); });
    expect(() => makeBox(oc, { dx: 10, dy: 20, dz: 30 })).toThrow('injected Shape failure');
    expect(tracked.entries.map(entry => entry.deletes)).toEqual([1]);
  });
});
