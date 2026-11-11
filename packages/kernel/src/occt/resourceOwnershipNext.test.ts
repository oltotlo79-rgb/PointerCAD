import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurveSpec } from '../types.js';
import * as allocations from './allocations.js';
import type { OcctDeletable } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeEllipseEdge } from './makeEllipseEdge.js';
import { makePlanarFace } from './makePlanarFace.js';
import { tessellate } from './tessellate.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Same observation pattern as booleanOp.test.ts: every tracked object is real OCCT or its actual owner. */
function observe() {
  const entries: { item: OcctDeletable; deleted: number; failAfterDelete: Error | null }[] = [];
  const create = allocations.createAllocations;
  vi.spyOn(allocations, 'createAllocations').mockImplementation(() => {
    const owner = create();
    return {
      keep<T extends OcctDeletable>(item: T): T {
        const entry: (typeof entries)[number] = { item, deleted: 0, failAfterDelete: null };
        const remove = item.delete.bind(item);
        item.delete = (): void => {
          entry.deleted++;
          remove();
          if (entry.failAfterDelete !== null) throw entry.failAfterDelete;
        };
        entries.push(entry);
        return owner.keep(item);
      },
      release: owner.release,
    };
  });
  return entries;
}
const ellipse = { center: [0, 0, 0] as const, normal: [0, 0, 1] as const,
  majorAxis: [1, 0, 0] as const, majorRadius: 20, minorRadius: 10 };
const square: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [2, 0, 0] },
  { kind: 'segment', from: [2, 0, 0], to: [2, 3, 0] },
  { kind: 'segment', from: [2, 3, 0], to: [0, 3, 0] },
  { kind: 'segment', from: [0, 3, 0], to: [0, 0, 0] },
];
const lineOrigin = { sketchId: 'sketch', faceFeatureId: 'profile', lineFeatureIds: ['a', 'b', 'c', 'd'] as const };
const curveOrigin = { sketchId: 'sketch', faceFeatureId: 'profile', curveFeatureIds: ['a', 'b', 'c', 'd'] as const };

describe('P18 actual ellipse/planar native ownership', () => {
  it('keeps the ellipse and construction objects alive until handle deletion, then releases exactly once', () => {
    const entries = observe(), handle = makeEllipseEdge(oc, ellipse);
    const retained = [...entries];
    try {
      expect(retained.length).toBeGreaterThan(0);
      expect(retained.every(entry => entry.deleted === 0)).toBe(true);
      const adaptor = new oc.BRepAdaptor_Curve_2(handle.edge);
      try {
        expect(handle.edge.IsNull()).toBe(false);
        expect(adaptor.LastParameter()).toBeGreaterThan(adaptor.FirstParameter());
      } finally { adaptor.delete(); }
    } finally { handle.delete(); }
    expect(retained.every(entry => entry.deleted === 1)).toBe(true);
    expect(() => handle.delete()).not.toThrow();
    expect(retained.every(entry => entry.deleted === 1)).toBe(true);
  });

  it('releases real ellipse predecessors when a later native construction throws, retaining the original error', () => {
    const entries = observe(), failure = new Error('injected ellipse constructor failure');
    vi.spyOn(oc, 'gp_Elips_2').mockImplementationOnce(function () { throw failure; });
    expect(() => makeEllipseEdge(oc, ellipse)).toThrow(failure);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
  });

  it('continues ellipse release after a native wrapper delete reports failure and does not retry freed objects', () => {
    const entries = observe(), handle = makeEllipseEdge(oc, ellipse);
    const edge = entries.find(entry => entry.item === handle.edge);
    if (!edge) throw new Error('Returned native edge was not registered');
    const failure = new Error('reported after real native edge deletion');
    edge.failAfterDelete = failure;
    expect(() => handle.delete()).toThrow(failure);
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
    expect(() => handle.delete()).not.toThrow();
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
  });

  it.each([undefined, lineOrigin, curveOrigin])('retains the planar face and borrowed profile edges for origin %j', origin => {
    const entries = observe(), handle = makePlanarFace(oc, square, {}, origin);
    // Discretization releases its own short-lived native objects before the face is returned.
    const retained = entries.filter(entry => entry.deleted === 0);
    const temporary = entries.filter(entry => entry.deleted === 1);
    try {
      expect(retained.length).toBeGreaterThan(0);
      expect(temporary.length).toBeGreaterThan(0);
      expect(entries.every(entry => entry.deleted === 0 || entry.deleted === 1)).toBe(true);
      expect(retained.some(entry => entry.item === handle.face)).toBe(true);
      expect(handle.boundaryEdgeCount).toBe(4);
      expect(oc.BRepAlgo.IsValid_1(handle.face)).toBe(true);
      if (origin === lineOrigin) expect(handle.nativeProfileLines).toHaveLength(4);
      if (origin === curveOrigin) expect(handle.nativeProfileCurves).toHaveLength(4);
      for (const row of [...(handle.nativeProfileLines ?? []), ...(handle.nativeProfileCurves ?? [])]) {
        expect(row.edge.IsNull()).toBe(false);
        expect(retained.some(entry => entry.item === row.edge)).toBe(true);
      }
      const mesh = tessellate(oc, handle.face);
      expect(mesh.faceCount).toBe(1);
      expect(mesh.triangleCount).toBeGreaterThan(0);
      expect(retained.every(entry => entry.deleted === 0)).toBe(true);
    } finally { handle.delete(); }
    expect(retained.every(entry => entry.deleted === 1)).toBe(true);
    expect(temporary.every(entry => entry.deleted === 1)).toBe(true);
    expect(() => handle.delete()).not.toThrow();
    expect(retained.every(entry => entry.deleted === 1)).toBe(true);
    expect(temporary.every(entry => entry.deleted === 1)).toBe(true);
  });

  it('releases real wire, edge and shared-vertex predecessors when face construction throws', () => {
    const entries = observe(), failure = new Error('injected face constructor failure');
    vi.spyOn(oc, 'BRepBuilderAPI_MakeFace_15').mockImplementationOnce(function () { throw failure; });
    expect(() => makePlanarFace(oc, square, {}, lineOrigin)).toThrow(failure);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
  });

  it('keeps the existing open-wire refusal while releasing its real resources', () => {
    const entries = observe();
    expect(() => makePlanarFace(oc, square.slice(0, 2))).toThrow('輪郭が閉じていない');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
  });

  it('continues all planar owner groups after a real face deletion reports failure', () => {
    const entries = observe(), handle = makePlanarFace(oc, square, {}, lineOrigin);
    const face = entries.find(entry => entry.item === handle.face);
    if (!face) throw new Error('Returned native face was not registered');
    const failure = new Error('reported after real native face deletion');
    face.failAfterDelete = failure;
    expect(() => handle.delete()).toThrow(failure);
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
    expect(() => handle.delete()).not.toThrow();
    expect(entries.every(entry => entry.deleted === 1)).toBe(true);
  });
});
