import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as allocationModule from './allocations.js';
import { makeFunctionCurveSplineEdge, readFunctionCurveSplineEdge, type FunctionCurveSplineSpec } from './functionCurveSpline.js';
import { loadOcctForNode } from './loadOcct.node.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { vi.restoreAllMocks(); });

const spline: FunctionCurveSplineSpec = {
  knots: [0, 1], poles: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]],
};

// Observe the actual allocation helper and real wrappers, as in booleanOp.test.ts.
function observe() {
  const create = allocationModule.createAllocations;
  const entries: { deletes: number }[] = [];
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const group = create();
    return { release: group.release, keep<T extends allocationModule.OcctDeletable>(item: T): T {
      const entry = { deletes: 0 }, original = item.delete.bind(item);
      entries.push(entry);
      item.delete = () => { entry.deletes += 1; original(); };
      return group.keep(item);
    } };
  });
  return entries;
}

describe('function spline temporary point ownership', () => {
  it('keeps the caller-owned edge alive while releasing points on construction and readback', () => {
    const owner = allocationModule.createAllocations();
    const entries = observe();
    try {
      const edge = makeFunctionCurveSplineEdge(oc, spline, owner.keep, () => false);
      expect(edge).not.toBeNull();
      if (edge === null) throw new Error('expected native edge');
      const adaptor = owner.keep(new oc.BRepAdaptor_Curve_2(edge));
      const result = readFunctionCurveSplineEdge(oc, adaptor, 0, 1, false, owner.keep);
      expect(result.knots).toEqual([0, 1]);
      for (const [index, point] of result.points.entries()) {
        expect(point[0]).toBeCloseTo(index, 12);
        expect(point[1]).toBeCloseTo(0, 12);
        expect(point[2]).toBeCloseTo(0, 12);
      }
      expect(entries).toHaveLength(8);
      expect(entries.map(entry => entry.deletes)).toEqual(Array(8).fill(1));
      expect(Number(adaptor.Degree())).toBe(3);
    } finally { owner.release(); }
  });

  it('releases a real temporary point when writing a pole fails and leaves caller cleanup to the caller', () => {
    const owner = allocationModule.createAllocations();
    const entries = observe();
    const Original = oc.TColgp_Array1OfPnt_2;
    vi.spyOn(oc, 'TColgp_Array1OfPnt_2').mockImplementation(function (...args: ConstructorParameters<typeof Original>) {
      const array = new Original(...args);
      vi.spyOn(array, 'SetValue').mockImplementation(() => { throw new Error('injected pole failure'); });
      return array;
    });
    try {
      expect(() => makeFunctionCurveSplineEdge(oc, spline, owner.keep, () => false)).toThrow('injected pole failure');
      expect(entries.map(entry => entry.deletes)).toEqual([1]);
    } finally { owner.release(); }
  });
});
