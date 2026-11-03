import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as allocations from './allocations.js';
import { readNativeFreeformBound } from './analysisFreeformBound.js';
import { readLegacyOcctFixture } from './legacyOcctFixtureLoader.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { discretizeEdge, makeArcEdge, makeSegmentEdge } from './makeSketchEdges.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { vi.restoreAllMocks(); });

// Existing booleanOp.test.ts approach: count real wrappers registered in the real helper.
function observe() {
  const create = allocations.createAllocations;
  const entries: { deleted: number }[] = [], order: number[] = [];
  vi.spyOn(allocations, 'createAllocations').mockImplementation(() => {
    const owner = create();
    return { release: owner.release, keep<T extends allocations.OcctDeletable>(value: T): T {
      const index = entries.length, entry = { deleted: 0 }, original = value.delete.bind(value);
      entries.push(entry);
      value.delete = () => { entry.deleted += 1; order.push(index); original(); };
      return owner.keep(value);
    } };
  });
  return { entries, order };
}

describe('sketch edge ownership', () => {
  it('retains native segment and clockwise arc until handle release', () => {
    const tracked = observe();
    const segment = makeSegmentEdge(oc, [0, 0, 0], [10, 0, 0]);
    const segmentEntries = tracked.entries.slice();
    try {
      const points = discretizeEdge(oc, segment.edge);
      expect(points[0]).toBeCloseTo(0, 6);
      expect(points[points.length - 3]).toBeCloseTo(10, 6);
    } finally { segment.delete(); }
    expect(segmentEntries.every(entry => entry.deleted === 1)).toBe(true);
    expect(tracked.order.filter(index => index < segmentEntries.length)).toEqual([3, 2, 1, 0]);
    segment.delete();
    expect(segmentEntries.every(entry => entry.deleted === 1)).toBe(true);
    const arc = makeArcEdge(oc, { kind: 'arc', center: [0, 0, 0], normal: [0, 0, 1],
      xAxis: [1, 0, 0], radius: 10, startAngle: Math.PI / 2, endAngle: 0 });
    try { expect(discretizeEdge(oc, arc.edge).length).toBeGreaterThan(3); } finally { arc.delete(); }
    expect(tracked.entries.every(entry => entry.deleted === 1)).toBe(true);
  });

  it('frees the already-created centre if a direction constructor fails', () => {
    const tracked = observe();
    vi.spyOn(oc, 'gp_Dir_4').mockImplementation(function () { throw new Error('injected direction failure'); });
    expect(() => makeArcEdge(oc, { kind: 'arc', center: [0, 0, 0], normal: [0, 0, 1],
      xAxis: [1, 0, 0], radius: 10, startAngle: 0, endAngle: 1 })).toThrow('injected direction failure');
    expect(tracked.entries.map(entry => entry.deleted)).toEqual([1]);
  });
});

describe('native freeform temporary ownership', () => {
  it('retains the borrowed face and caller-owned bound while releasing temporary wrappers', () => {
    const owned = allocations.createAllocations();
    try {
      const face = owned.keep(oc.TopoDS.Face_1(owned.keep(readLegacyOcctFixture(oc, 'periodicExtrusion'))));
      const tracked = observe();
      const bound = readNativeFreeformBound(oc, face, owned, () => {});
      if (bound === null) throw new Error('expected native extrusion');
      const actual = bound.point([3.5, 2]);
      [13, 13.5, 16.5].forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 12));
      expect(tracked.entries.length).toBeGreaterThan(0);
      expect(tracked.entries.every(entry => entry.deleted === 1)).toBe(true);
      expect(face.IsNull()).toBe(false);
      expect(bound.point([3.5, 2])).toEqual(actual);
    } finally { vi.restoreAllMocks(); owned.release(); }
  });

  it('releases temporary native objects when a checkpoint cancels mid-read', () => {
    const owned = allocations.createAllocations();
    try {
      const face = owned.keep(oc.TopoDS.Face_1(owned.keep(readLegacyOcctFixture(oc, 'periodicExtrusion'))));
      const tracked = observe();
      const checkpoint = () => { if (tracked.entries.length > 0) throw new Error('cancelled'); };
      expect(() => readNativeFreeformBound(oc, face, owned, checkpoint)).toThrow('cancelled');
      expect(tracked.entries.length).toBeGreaterThan(0);
      expect(tracked.entries.every(entry => entry.deleted === 1)).toBe(true);
      expect(face.IsNull()).toBe(false);
    } finally { vi.restoreAllMocks(); owned.release(); }
  });
});
