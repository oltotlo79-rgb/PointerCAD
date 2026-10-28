import { createHash } from 'node:crypto';
import { stdout } from 'node:process';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { expect, vi } from 'vitest';

import type { Vec3Tuple } from '../types.js';
import * as allocationModule from './allocations.js';
import type { Allocations, OcctDeletable } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { writeBrepBytes } from './brepBytes.js';

/** Raise an actual OCCT Standard_ConstructionError at the injected late stage. */
export function throwNativeDirectionError(oc: OpenCascadeInstance): never {
  const impossible = new oc.gp_Dir_4(0, 0, 0);
  impossible.delete();
  throw new Error('The native zero-direction constructor unexpectedly succeeded');
}

/** Counts registered wrappers only, not the WASM heap or unregistered native allocations. */
export function observeDirectEditOwnership() {
  const actualCreate = allocationModule.createAllocations;
  const entries = new Map<OcctDeletable, { calls: number }>();
  const spy = vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const actual = actualCreate();
    const keep: Allocations['keep'] = item => {
      expect(entries.has(item)).toBe(false);
      const entry = { calls: 0 }, original = item.delete.bind(item);
      entries.set(item, entry);
      item.delete = () => { entry.calls++; original(); };
      return actual.keep(item);
    };
    return { keep, release: actual.release };
  });
  return {
    stop: () => { spy.mockRestore(); },
    verify: () => {
      const counts = [...entries.values()].map(entry => entry.calls);
      expect(counts.every(count => count === 1)).toBe(true);
      return { ownedWrappers: counts.length, ownedDeletes: counts.reduce((sum, count) => sum + count, 0),
        remaining: counts.filter(count => count === 0).length };
    },
  };
}

/** Call after fixture selection/tessellation, which itself can change serialized triangulations. */
export function auditDirectEdit(
  oc: OpenCascadeInstance, label: string, borrowed: readonly TopoDS_Shape[], action: () => void,
) {
  const shapes = [...new Set(borrowed)];
  const digest = (shape: TopoDS_Shape) => createHash('sha256').update(writeBrepBytes(oc, shape)).digest('hex');
  const before = shapes.map(digest), deletes = shapes.map(shape => vi.spyOn(shape, 'delete'));
  const ownership = observeDirectEditOwnership();
  try {
    try { action(); } finally { ownership.stop(); }
    const counts = ownership.verify();
    const after = shapes.map(digest);
    expect(after).toEqual(before);
    for (const spy of deletes) expect(spy).not.toHaveBeenCalled();
    stdout.write(`EX18 boundary ${JSON.stringify({ label, ...counts, borrowedDeletes: 0, before, after })}\n`);
    return counts;
  } finally {
    ownership.stop();
    for (const spy of deletes) spy.mockRestore();
  }
}

export function boundaryBox(oc: OpenCascadeInstance, owned: Allocations, origin: Vec3Tuple = [0, 0, 0],
  size: Vec3Tuple = [40, 30, 8]): TopoDS_Shape {
  const { keep } = owned;
  return keep(keep(new oc.BRepPrimAPI_MakeBox_3(keep(new oc.gp_Pnt_3(...origin)), ...size)).Shape());
}

export function drillBoundaryHole(oc: OpenCascadeInstance, owned: Allocations, source: TopoDS_Shape,
  origin: Vec3Tuple = [10, 15, -1], radius = 3, depth = 10): TopoDS_Shape {
  const { keep } = owned;
  const axes = keep(new oc.gp_Ax2_3(keep(new oc.gp_Pnt_3(...origin)), keep(new oc.gp_Dir_4(0, 0, 1))));
  const tool = keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, radius, depth)).Shape());
  return keep(booleanOp(oc, 'subtract', source, tool)).shape;
}

/** An actual reversed parameterization: the polygon's first edge is constructed from +X to -X. */
export function reverseCurveBox(oc: OpenCascadeInstance, owned: Allocations): TopoDS_Shape {
  const { keep } = owned;
  const polygon = keep(new oc.BRepBuilderAPI_MakePolygon_1());
  for (const point of [[40, 0, 0], [0, 0, 0], [0, 30, 0], [40, 30, 0]] as const) {
    polygon.Add_1(keep(new oc.gp_Pnt_3(point[0], point[1], point[2])));
  }
  polygon.Close();
  const face = keep(keep(new oc.BRepBuilderAPI_MakeFace_15(keep(polygon.Wire()), true)).Face());
  return keep(keep(new oc.BRepPrimAPI_MakePrism_1(face, keep(new oc.gp_Vec_4(0, 0, 8)), true, true)).Shape());
}
