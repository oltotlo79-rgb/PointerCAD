import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { tessellate } from './tessellate.js';
import { extractEdges } from './extractEdges.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

interface AcquiredShape { readonly shape: TopoDS_Shape; readonly dispose: () => void; deleted: number }
function observeReadShapes(control: { failType: boolean }): AcquiredShape[] {
  const acquired: AcquiredShape[] = [];
  const ShapeMap = oc.TopTools_IndexedMapOfShape_1;
  vi.spyOn(oc, 'TopTools_IndexedMapOfShape_1').mockImplementation(function () {
    const map = new ShapeMap(), find = map.FindKey.bind(map);
    map.FindKey = index => {
      const shape = find(index), dispose = shape.delete.bind(shape);
      const record = { shape, dispose, deleted: 0 }; acquired.push(record);
      shape.delete = () => { record.deleted++; dispose(); };
      if (control.failType) shape.ShapeType = () => { throw new Error('injected shape type failure'); };
      return shape;
    };
    return map;
  });
  return acquired;
}

describe('描画の実OCCT走査は読み取った全ての形を所有し、終了時に返す', () => {
  for (const operation of ['surface', 'edges'] as const) {
    it.each(['success', 'shape-type', 'downstream'] as const)(`${operation}: %sでも対象外の形と処理中の形を残さない`, mode => {
      const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
      const run = () => operation === 'surface' ? tessellate(oc, box.shape) : extractEdges(oc, box.shape);
      let acquired: AcquiredShape[] = [];
      try {
        const control = { failType: false };
        acquired = observeReadShapes(control);
        // OCCT reports a different status when triangulation already exists. Compare
        // repeated extraction after the first mesh, while observing every acquired shape.
        run();
        const expected = run();
        control.failType = mode === 'shape-type';
        if (mode === 'downstream') {
          function fail(): never { throw new Error('injected extraction failure'); }
          if (operation === 'surface') vi.spyOn(oc.BRep_Tool, 'Triangulation').mockImplementation(fail);
          else vi.spyOn(oc, 'GCPnts_TangentialDeflection_2').mockImplementation(fail);
        }
        if (mode === 'success') {
          for (let count = 0; count < 5; count++) {
            expect(run()).toEqual(expected);
            expect(acquired.map(record => record.deleted)).toEqual(acquired.map(() => 1));
          }
          // A box has 6 faces and 12 edges; the traversal also acquires its other shape types.
          expect(acquired.length).toBeGreaterThan(5 * (operation === 'surface' ? 6 : 12));
        } else {
          expect(run).toThrow(mode === 'shape-type' ? 'injected shape type failure' : 'injected extraction failure');
          expect(acquired.length).toBeGreaterThan(0);
          expect(acquired.map(record => record.deleted)).toEqual(acquired.map(() => 1));
        }
      } finally {
        vi.restoreAllMocks();
        // A failing regression must not itself leak the native shapes it observed.
        for (const record of acquired) if (record.deleted === 0) record.dispose();
        box.delete();
      }
    });
  }
});
