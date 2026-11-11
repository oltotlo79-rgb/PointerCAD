import type { BRepAdaptor_Surface } from 'opencascade.js/dist/opencascade.full.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurveSpec, ThruSectionSpec, Vec3Tuple } from '../types.js';
import * as allocations from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { sectionNormalAngles, splineLoft, splineSection } from './loftSurface.testSupport.js';
import { makeThruSections } from './makeThruSections.js';
import { sewSolid } from './sewSolid.js';
import { measureVolume } from './solidMesh.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { vi.restoreAllMocks(); });

function observe() {
  const create = allocations.createAllocations;
  const entries: { deleted: number }[] = [];
  vi.spyOn(allocations, 'createAllocations').mockImplementation(() => {
    const group = create();
    return { release: group.release, keep<T extends allocations.OcctDeletable>(value: T): T {
      const entry = { deleted: 0 }, original = value.delete.bind(value);
      entries.push(entry);
      value.delete = () => { entry.deleted += 1; original(); };
      return group.keep(value);
    } };
  });
  return entries;
}

function loop(points: readonly Vec3Tuple[]): readonly CurveSpec[] {
  return points.map((from, index) => ({ kind: 'segment', from, to: points[(index + 1) % points.length] }));
}
const profiles = [
  loop([[0, 0, 0], [10, 0, 0], [10, 20, 0], [0, 20, 0]]),
  loop([[0, 0, 30], [10, 0, 30], [10, 20, 30], [0, 20, 30]]),
  loop([[0, 0, 0], [10, 0, 0], [10, 0, 30], [0, 0, 30]]),
  loop([[0, 20, 0], [10, 20, 0], [10, 20, 30], [0, 20, 30]]),
  loop([[0, 0, 0], [0, 20, 0], [0, 20, 30], [0, 0, 30]]),
  loop([[10, 0, 0], [10, 20, 0], [10, 20, 30], [10, 0, 30]]),
];
const spec = { kind: 'sew' as const, profiles, tolerance: 0.01 };

describe('sewing resource ownership', () => {
  it('retains the completed solid and releases all tracked resources once', () => {
    const entries = observe();
    const result = sewSolid(oc, spec);
    try { expect(measureVolume(oc, result.shape)).toBeCloseTo(6000, 6); }
    finally { result.delete(); }
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
    result.delete();
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
  });

  it('releases registered faces and sewing when Add fails', () => {
    const entries = observe();
    vi.spyOn(oc.BRepBuilderAPI_Sewing.prototype, 'Add').mockImplementation(() => { throw new Error('injected Add failure'); });
    expect(() => sewSolid(oc, spec)).toThrow('injected Add failure');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
  });
});

describe('loft normal-sampling ownership', () => {
  it('keeps the borrowed loft alive and releases each bisection point', () => {
    const owner = allocations.createAllocations();
    const sections: readonly ThruSectionSpec[] = [[0, 1], [20, 2], [60, 1.5], [100, 1]]
      .map(([z, scale]) => ({ kind: 'curves', curves: splineSection(z, scale) }));
    const shape = owner.keep(makeThruSections(oc, splineLoft({ sections, smooth: true })));
    try {
      const entries = observe();
      const angles = sectionNormalAngles(oc, shape.shape, owner.keep);
      expect(angles.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...angles)).toBeLessThan(0.01);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every(entry => entry.deleted === 1)).toBe(true);
      expect(measureVolume(oc, shape.shape)).toBeGreaterThan(0);
    } finally { vi.restoreAllMocks(); owner.release(); }
  });

  it('retains the borrowed loft after a sampling interruption', () => {
    const owner = allocations.createAllocations();
    const sections: readonly ThruSectionSpec[] = [[0, 1], [20, 2], [60, 1.5], [100, 1]]
      .map(([z, scale]) => ({ kind: 'curves', curves: splineSection(z, scale) }));
    const shape = owner.keep(makeThruSections(oc, splineLoft({ sections, smooth: true })));
    try {
      const entries = observe(), original = Reflect.get(oc.BRepAdaptor_Surface.prototype, 'Value');
      vi.spyOn(oc.BRepAdaptor_Surface.prototype, 'Value').mockImplementation(function (this: BRepAdaptor_Surface, u, v) {
        if (entries.length > 0) throw new Error('sampling interruption');
        return original.call(this, u, v);
      });
      expect(() => sectionNormalAngles(oc, shape.shape, owner.keep)).toThrow('sampling interruption');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every(entry => entry.deleted === 1)).toBe(true);
      vi.restoreAllMocks();
      expect(measureVolume(oc, shape.shape)).toBeGreaterThan(0);
    } finally { vi.restoreAllMocks(); owner.release(); }
  });
});
