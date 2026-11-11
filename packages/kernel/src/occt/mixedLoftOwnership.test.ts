import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BRepBuilderAPI_Sewing } from 'opencascade.js/dist/opencascade.full.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeThruSections } from './makeThruSections.js';
import type { OcctShapeHandle } from './makeBox.js';
import { measureVolume } from './solidMesh.js';
import { createAllocations } from './allocations.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

describe('loft shell search owns the copies returned by its native shape map', () => {
  it.each([false, true])('all shell-search keys are released, predicate failure=%s', failPredicate => {
    const acquired: { dispose: () => void; deletes: number }[] = [];
    const result: { value?: OcctShapeHandle } = {};
    const inputs = createAllocations();
    let searching = false;
    const read = Reflect.get(oc.BRepBuilderAPI_Sewing.prototype, 'SewedShape');
    const MapType = oc.TopTools_IndexedMapOfShape_1;
    try {
      const compound = inputs.keep(new oc.TopoDS_Compound());
      const builder = inputs.keep(new oc.BRep_Builder());
      builder.MakeCompound(compound);
      const compoundType = compound.ShapeType();
      vi.spyOn(oc.BRepBuilderAPI_Sewing.prototype, 'SewedShape').mockImplementation(function (this: BRepBuilderAPI_Sewing) {
        const shape = read.call(this);
        // Select the existing map-search branch; all traversed shapes and geometry remain native.
        shape.ShapeType = () => compoundType;
        searching = true;
        return shape;
      });
      vi.spyOn(oc, 'TopTools_IndexedMapOfShape_1').mockImplementation(function () {
        const map = new MapType(), find = map.FindKey.bind(map);
        map.FindKey = index => {
          const shape = find(index);
          if (searching) {
            const entry = { dispose: shape.delete.bind(shape), deletes: 0 };
            acquired.push(entry);
            shape.delete = () => { entry.deletes++; entry.dispose(); };
            if (failPredicate) shape.ShapeType = () => { throw new Error('injected shell predicate'); };
          }
          return shape;
        };
        return map;
      });
      const run = (): void => {
        result.value = makeThruSections(oc, { kind: 'thruSections', smooth: false, ruled: true,
          closed: true, twist: 0, sphereSegments: 24, sections: [
            { kind: 'sphere', center: [0, 0, 0], radius: 10 },
            { kind: 'curves', curves: [{ kind: 'arc', center: [0, 0, -30], normal: [0, 0, 1],
              xAxis: [1, 0, 0], radius: 20, startAngle: 0, endAngle: 2 * Math.PI }] },
          ] });
      };
      if (failPredicate) expect(run).toThrow('injected shell predicate');
      else {
        run();
        if (result.value === undefined) throw new Error('missing loft result');
        // Independent cap + cone-frustum volume; same precision as the existing native regression.
        expect(Math.abs(measureVolume(oc, result.value.shape) - 24741.124688560023) / 24741.124688560023).toBeLessThan(0.001);
        result.value.delete(); result.value = undefined;
      }
      expect(acquired.length).toBeGreaterThan(0);
      expect(acquired.map(entry => entry.deletes)).toEqual(acquired.map(() => 1));
    } finally {
      vi.restoreAllMocks(); result.value?.delete(); inputs.release();
      for (const entry of acquired) if (entry.deletes === 0) entry.dispose();
    }
  });
});
