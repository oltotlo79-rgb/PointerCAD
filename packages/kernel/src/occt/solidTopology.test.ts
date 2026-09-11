import type { OpenCascadeInstance, TopoDS_Shape, TopTools_IndexedMapOfShape } from 'opencascade.js/dist/opencascade.full.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { hasSolid, measureVolume } from './solidMesh.js';
import { countSheetMetalSolids } from './sheetMetalJoin.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
afterEach(() => vi.restoreAllMocks());
function captureMethod<Key extends string, Args extends unknown[], Result>(prototype: Record<Key, (...args: Args) => Result>, key: Key) {
  const method = prototype[key];
  return function (this: Record<Key, (...args: Args) => Result>, ...args: Args): Result { return method.apply(this, args); };
}

describe('ソリッド走査のラッパー解放', () => {
  it.each([false, true])('ShapeType例外=%sでもFindKeyの借用ラッパーを1回だけ解放し、元の立体を保持する', (fail) => {
    const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    const returned: { readonly calls: () => number }[] = [];
    const find = captureMethod<'FindKey', [number], TopoDS_Shape>(oc.TopTools_IndexedMapOfShape.prototype, 'FindKey');
    vi.spyOn(oc.TopTools_IndexedMapOfShape.prototype, 'FindKey').mockImplementation(function (this: TopTools_IndexedMapOfShape, index: number) {
      const item = find.call(this, index), disposal = vi.spyOn(item, 'delete');
      returned.push({ calls: () => disposal.mock.calls.length });
      if (fail) vi.spyOn(item, 'ShapeType').mockImplementationOnce(() => { throw new Error('走査の中断'); });
      return item;
    });
    try {
      if (fail) {
        expect(() => hasSolid(oc, box.shape)).toThrow('走査の中断');
        expect(() => countSheetMetalSolids(oc, box.shape)).toThrow('走査の中断');
      } else {
        expect(hasSolid(oc, box.shape)).toBe(true);
        expect(countSheetMetalSolids(oc, box.shape)).toBe(1);
      }
      expect(returned.length).toBeGreaterThan(0);
      expect(returned.every((entry) => entry.calls() === 1)).toBe(true);
      vi.restoreAllMocks();
      expect(measureVolume(oc, box.shape)).toBeCloseTo(6000, 7);
    } finally { vi.restoreAllMocks(); box.delete(); }
  });
});
