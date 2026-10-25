import { beforeAll, describe, expect, it } from 'vitest';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { createAllocations, type Allocations, type OcctDeletable } from './allocations.js';
import { admitNativeMaterialDomain, maximumOccurrencesForTriangleCap, NativeMaterialCapacityError } from './nativeMaterialDomain.js';

// AUTHOR-ONLY, UNEXECUTED (GO-17/18 successor of nativeMaterialDomain.test.ts 5c57162c; product path
// packages/kernel/src/occt/nativeMaterialDomain.test.ts). The eight cases and their accept/reject outcomes are those Root
// observed in run 20261012-225024 (receipt 5717298e) for the identical predicates. Added: cumulative capacity checked
// BEFORE a child handle is retained (wide compound, shells), cancellation during child and shell enumeration with the
// thrown value's identity preserved, exact capacity arithmetic. Synchronous native calls are not interruptible; these
// tests only observe the checkpoints between them.
let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });

function box(owner: Allocations, edge: number, offset = 0): TopoDS_Shape {
  const point = owner.keep(new oc.gp_Pnt_3(offset, offset, offset));
  return owner.keep(owner.keep(new oc.BRepPrimAPI_MakeBox_3(point, edge, edge, edge)).Shape());
}
function sphere(owner: Allocations, radius: number, x: number): TopoDS_Shape {
  const point = owner.keep(new oc.gp_Pnt_3(x, 0, 0));
  return owner.keep(owner.keep(new oc.BRepPrimAPI_MakeSphere_5(point, radius)).Shape());
}
function compound(owner: Allocations, children: readonly TopoDS_Shape[]): TopoDS_Shape {
  const builder = owner.keep(new oc.BRep_Builder());
  const result = owner.keep(new oc.TopoDS_Compound());
  builder.MakeCompound(result);
  for (const child of children) builder.Add(result, child);
  return result;
}
function hollow(owner: Allocations): TopoDS_Shape {
  const maker = owner.keep(new oc.BRepAlgoAPI_Cut_3(box(owner, 20), box(owner, 6, 7), owner.keep(new oc.Message_ProgressRange_1())));
  if (!maker.IsDone() || maker.HasErrors()) throw new Error('Hollow fixture cut failed');
  return owner.keep(maker.Shape());
}
/** Same copy/mesh choices as buildAnalysisSurfaceMesh; admission runs on that exact meshed copy and owner. */
function admitMeshedCopy(owner: Allocations, source: TopoDS_Shape, checkpoint: () => void = () => undefined) {
  const copier = owner.keep(new oc.BRepBuilderAPI_Copy_2(source, false, false));
  if (!copier.IsDone()) throw new Error('Copy failed');
  const copy = owner.keep(copier.Shape());
  const mesher = owner.keep(new oc.BRepMesh_IncrementalMesh_2(copy, 0.05, false, 0.25, false));
  if (!mesher.IsDone() || Number(mesher.GetStatusFlags()) !== 0) throw new Error('Mesher failed');
  return admitNativeMaterialDomain(oc, copy, owner, maximumOccurrencesForTriangleCap(2048), checkpoint);
}
/** Delegating owner that records every handle the admission retains (all still released by the real owner). */
function counting(owner: Allocations): { readonly owner: Allocations; readonly kept: OcctDeletable[] } {
  const kept: OcctDeletable[] = [];
  return { kept, owner: { keep: <T extends OcctDeletable>(item: T): T => { kept.push(item); return owner.keep(item); }, release: owner.release } };
}
/** External checkpoint boundary accepts unknown thrown values; forwards the exact sentinel on the selected call. */
function cancelAt(at: number, sentinel: unknown): { readonly calls: () => number; readonly checkpoint: () => void } {
  let calls = 0;
  return { calls: () => calls, checkpoint: () => { calls += 1; if (calls === at) throw sentinel; } };
}
function thrown(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error('expected a throw');
}

const cases: readonly { name: string; make: (owner: Allocations) => TopoDS_Shape; accepted: boolean; problem?: string }[] = [
  { name: 'single-box', make: owner => box(owner, 20), accepted: true },
  { name: 'reversed-box (native-valid; only infinity OUT rejects)', make: owner => owner.keep(box(owner, 20).Reversed()), accepted: false },
  { name: 'hollow-box (cavity accepted)', make: hollow, accepted: true },
  { name: 'reversed-hollow', make: owner => owner.keep(hollow(owner).Reversed()), accepted: false },
  { name: 'separated-spheres (compound accepted)', make: owner => compound(owner, [sphere(owner, 1, 0), sphere(owner, 1, 3)]), accepted: true },
  { name: 'overlapping-spheres (only whole-compound check rejects)', make: owner => compound(owner, [sphere(owner, 1, 0), sphere(owner, 1, 1.5)]), accepted: false },
  { name: 'contained-solids-not-a-cavity', make: owner => compound(owner, [sphere(owner, 1, 0), sphere(owner, 0.25, 0)]), accepted: false },
  { name: 'repeated-solid-identity (native-valid; only IsSame rejects)', make: owner => { const shape = box(owner, 20); return compound(owner, [shape, shape]); },
    accepted: false, problem: 'duplicate-solid-occurrence' },
];

describe('native numerical material admission (successor; numerical validation only)', () => {
  it.each(cases)('$name', ({ make, accepted, problem }) => {
    const owner = createAllocations();
    try {
      const result = admitMeshedCopy(owner, make(owner));
      expect(result.nativeChecksPass).toBe(accepted);
      if (problem !== undefined) expect(result.structuralProblems).toContain(problem);
      expect(result.fuzzyValue).toBe(1e-7);
      expect(result.classificationTolerance).toBe(1e-7);
      expect(result.occurrencesReserved).toBeGreaterThan(0);
      expect(result).toMatchObject({ globalCertified: false, materialVolumeCertified: false, topologyCertified: false });
    } finally { owner.release(); }
  });

  it('a wide compound is refused before the first excess child handle is retained', () => {
    const owner = createAllocations();
    try {
      const wide = compound(owner, [0, 1, 2, 3, 4].map(index => box(owner, 1, 3 * index)));
      const probe = counting(owner);
      // Budget 3 = root + two children. The third child must fail at reservation, before iterator.Value() is kept:
      // retained = the compound iterator + exactly two children (the r1 module kept all five children first).
      const error = thrown(() => admitNativeMaterialDomain(oc, wide, probe.owner, 3, () => undefined));
      expect(error).toBeInstanceOf(NativeMaterialCapacityError);
      expect(probe.kept).toHaveLength(3);
    } finally { owner.release(); }
  });

  it('shells share the same cumulative budget: exact boundary between accepted and refused', () => {
    const owner = createAllocations();
    try {
      // Two separated boxes: root + 2 compound children + 2 shells = 5 units.
      const pair = compound(owner, [box(owner, 1, 0), box(owner, 1, 5)]);
      const exact = admitNativeMaterialDomain(oc, pair, owner, 5, () => undefined);
      expect(exact.nativeChecksPass).toBe(true);
      expect(exact.occurrencesReserved).toBe(5);
      expect(exact.shells).toEqual([1, 1]);
      expect(thrown(() => admitNativeMaterialDomain(oc, pair, owner, 4, () => undefined))).toBeInstanceOf(NativeMaterialCapacityError);
    } finally { owner.release(); }
  });

  it('cancellation during compound child enumeration propagates the identical thrown value', () => {
    const owner = createAllocations();
    try {
      const three = compound(owner, [box(owner, 1, 0), box(owner, 1, 3), box(owner, 1, 6)]);
      const sentinel = { reason: 'cancelled-during-children' };
      // Call order: 1 root reservation, 2 pop of the compound, 3/4/5 child reservations. Call 4 is the second child.
      const cancel = cancelAt(4, sentinel);
      const probe = counting(owner);
      expect(thrown(() => admitNativeMaterialDomain(oc, three, probe.owner, 100, cancel.checkpoint))).toBe(sentinel);
      expect(cancel.calls()).toBe(4);
      expect(probe.kept).toHaveLength(2); // the iterator + the first child only
    } finally { owner.release(); }
  });

  it('cancellation during shell enumeration propagates the identical thrown value and stops before classification', () => {
    const owner = createAllocations();
    try {
      const solid = box(owner, 2);
      // A full counting run fixes the observation points of a single solid with one shell:
      // 1 root reservation, 2 pop, 3 after traversal, 4 after analyzer construction, 5 after IsValid, 6 after Perform,
      // 7 solid loop, 8 shell reservation, 9 before classifier, 10 after construction, 11 after PerformInfinitePoint, 12 end.
      const full = cancelAt(Number.POSITIVE_INFINITY, {});
      expect(admitNativeMaterialDomain(oc, solid, owner, 100, full.checkpoint).nativeChecksPass).toBe(true);
      expect(full.calls()).toBe(12);
      const sentinel = new Error('cancelled-during-shells');
      const cancel = cancelAt(8, sentinel);
      expect(thrown(() => admitNativeMaterialDomain(oc, solid, owner, 100, cancel.checkpoint))).toBe(sentinel);
      expect(cancel.calls()).toBe(8);
    } finally { owner.release(); }
  });

  it('capacity arithmetic: 4 units per allowed triangle, safe integers only, never silently raised', () => {
    expect(maximumOccurrencesForTriangleCap(2048)).toBe(8192);
    expect(maximumOccurrencesForTriangleCap(1_000_000)).toBe(4_000_000);
    const largest = Math.floor(Number.MAX_SAFE_INTEGER / 4);
    expect(maximumOccurrencesForTriangleCap(largest)).toBe(4 * largest);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, largest + 1, Number.MAX_SAFE_INTEGER]) {
      expect(thrown(() => maximumOccurrencesForTriangleCap(invalid))).toBeInstanceOf(NativeMaterialCapacityError);
    }
    const owner = createAllocations();
    try {
      for (const invalid of [0, 1.5, Number.NaN]) {
        expect(thrown(() => admitNativeMaterialDomain(oc, box(owner, 1), owner, invalid, () => undefined))).toBeInstanceOf(NativeMaterialCapacityError);
      }
    } finally { owner.release(); }
  });
});
