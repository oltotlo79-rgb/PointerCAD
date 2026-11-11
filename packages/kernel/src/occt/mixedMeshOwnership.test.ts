import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Poly_Triangulation, TColgp_Array1OfDir, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { OcctDeletable } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { tessellate } from './tessellate.js';
import { readCafMesh } from './readCafMesh.js';
import { edgeAt, faceAt, vertexAt } from './subShapes.js';
import { measureVolume } from './solidMesh.js';
import { placeShape } from './placeBodies.js';
import { buildAnalysisSurfaceMesh } from './analysisSurfaceMesh.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
interface Observed { deletes: number; dispose: () => void }
function watch<T extends OcctDeletable>(item: T, observed: Observed[]): T {
  const entry = { deletes: 0, dispose: item.delete.bind(item) };
  observed.push(entry);
  item.delete = () => { entry.deletes++; entry.dispose(); };
  return item;
}
function clean(observed: Observed[]): void {
  vi.restoreAllMocks();
  for (const entry of observed) if (entry.deletes === 0) entry.dispose();
}

// A real native OBJ triangle, with an explicit normal. No geometry or output mock.
const OBJ = new TextEncoder().encode('v 0 0 0\nv 10 0 0\nv 0 10 0\nvn 0 0 1\nf 1//1 2//1 3//1\n');
describe('mixed mesh paths release native values on read failure', () => {
  for (const operation of ['surface', 'caf'] as const) {
    it.each(['node', 'normal', 'triangle'] as const)(`${operation}: %s read failure releases its acquired copy`, kind => {
      const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
      const observed: Observed[] = [];
      const failure = new Error('injected native component read');
      const fail = (): never => { throw failure; };
      const run = () => operation === 'surface' ? tessellate(oc, box.shape) : readCafMesh(oc, OBJ, { format: 'obj' });
      try {
        if (kind === 'node') {
          const read = Reflect.get(oc.Poly_Triangulation.prototype, 'Node');
          vi.spyOn(oc.Poly_Triangulation.prototype, 'Node').mockImplementation(function (this: Poly_Triangulation, index) {
            const point = watch(read.call(this, index), observed);
            point.X = fail;
            return point;
          });
        } else if (kind === 'normal' && operation === 'surface') {
          const read = Reflect.get(oc.TColgp_Array1OfDir.prototype, 'Value');
          vi.spyOn(oc.TColgp_Array1OfDir.prototype, 'Value').mockImplementation(function (this: TColgp_Array1OfDir, index) {
            const direction = watch(read.call(this, index), observed);
            direction.X = fail;
            return direction;
          });
        } else if (kind === 'normal') {
          const read = Reflect.get(oc.Poly_Triangulation.prototype, 'Normal_1');
          vi.spyOn(oc.Poly_Triangulation.prototype, 'Normal_1').mockImplementation(function (this: Poly_Triangulation, index) {
            const direction = watch(read.call(this, index), observed);
            direction.X = fail;
            return direction;
          });
        } else {
          const read = Reflect.get(oc.Poly_Triangulation.prototype, 'Triangles');
          vi.spyOn(oc.Poly_Triangulation.prototype, 'Triangles').mockImplementation(function (this: Poly_Triangulation) {
            const array = read.call(this), value = array.Value.bind(array);
            array.Value = index => {
              const triangle = watch(value(index), observed);
              triangle.Value = fail;
              return triangle;
            };
            return array;
          });
        }
        expect(run).toThrow(failure);
        expect(observed.length).toBeGreaterThan(0);
        expect(observed.map(entry => entry.deletes)).toEqual(observed.map(() => 1));
        vi.restoreAllMocks();
        expect(measureVolume(oc, box.shape)).toBeCloseTo(6000, 6);
        expect(run().positions.length).toBeGreaterThan(0);
      } finally { clean(observed); box.delete(); }
    });
  }
});

describe('indexed lookup separates temporary copies from returned ownership', () => {
  it.each([faceAt, edgeAt, vertexAt])('%s reclaims its selected copy if map cleanup rejects transfer', lookup => {
    const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    const observed: Observed[] = [];
    const MapType = oc.TopTools_IndexedMapOfShape_1;
    try {
      vi.spyOn(oc, 'TopTools_IndexedMapOfShape_1').mockImplementation(function () {
        const map = new MapType(), find = map.FindKey.bind(map), dispose = map.delete.bind(map);
        map.FindKey = index => watch(find(index), observed);
        map.delete = () => { dispose(); throw new Error('injected map cleanup'); };
        return map;
      });
      expect(() => lookup(oc, box.shape, 0)).toThrow('injected map cleanup');
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.map(entry => entry.deletes)).toEqual(observed.map(() => 1));
    } finally { clean(observed); box.delete(); }
  });

  it('reclaims a typed face if cleanup of the selected untyped wrapper rejects transfer', () => {
    const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    const observed: Observed[] = [];
    const read = oc.TopoDS.Face_1.bind(oc.TopoDS);
    try {
      vi.spyOn(oc.TopoDS, 'Face_1').mockImplementation(shape => {
        const face = watch(read(shape), observed), dispose = shape.delete.bind(shape);
        shape.delete = () => { dispose(); throw new Error('injected selected wrapper cleanup'); };
        return face;
      });
      expect(() => faceAt(oc, box.shape, 0)).toThrow('injected selected wrapper cleanup');
      expect(observed.map(entry => entry.deletes)).toEqual([1]);
    } finally { clean(observed); box.delete(); }
  });

  it.each([faceAt, edgeAt, vertexAt])('%s cleans the native candidate when its type predicate throws', lookup => {
    const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    const observed: Observed[] = [];
    const MapType = oc.TopTools_IndexedMapOfShape_1;
    try {
      vi.spyOn(oc, 'TopTools_IndexedMapOfShape_1').mockImplementation(function () {
        const map = new MapType(), find = map.FindKey.bind(map);
        map.FindKey = index => {
          const shape = watch(find(index), observed);
          shape.ShapeType = () => { throw new Error('injected predicate failure'); };
          return shape;
        };
        return map;
      });
      expect(() => lookup(oc, box.shape, 0)).toThrow('injected predicate failure');
      expect(observed.map(entry => entry.deletes)).toEqual([1]);
      vi.restoreAllMocks();
      const returned: TopoDS_Shape | null = lookup(oc, box.shape, 0);
      expect(returned).not.toBeNull();
      try { expect(returned?.IsNull()).toBe(false); }
      finally { returned?.delete(); }
      expect(measureVolume(oc, box.shape)).toBeCloseTo(6000, 6);
    } finally { clean(observed); box.delete(); }
  });
});

it('analysis mesh releases both the transformed point and source point when transformed reading throws', () => {
  const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
  const moved = placeShape(oc, box.shape, { position: [100, 200, 300], rotation: [0, 0, 0, 1] });
  const observed: Observed[] = [];
  try {
    const read = Reflect.get(oc.Poly_Triangulation.prototype, 'Node');
    vi.spyOn(oc.Poly_Triangulation.prototype, 'Node').mockImplementation(function (this: Poly_Triangulation, index) {
      const node = watch(read.call(this, index), observed), transform = node.Transformed.bind(node);
      node.Transformed = transformation => {
        const point = watch(transform(transformation), observed);
        point.X = () => { throw new Error('injected transformed read'); };
        return point;
      };
      return node;
    });
    expect(() => buildAnalysisSurfaceMesh(oc, moved.shape,
      { linearDeflection: 0.05, angularDeflection: 0.2, maximumTriangles: 10000, boundary: 'closed' }))
      .toThrow('injected transformed read');
    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(observed.map(entry => entry.deletes)).toEqual(observed.map(() => 1));
    vi.restoreAllMocks();
    expect(measureVolume(oc, moved.shape)).toBeCloseTo(6000, 6);
  } finally { clean(observed); moved.delete(); box.delete(); }
});
