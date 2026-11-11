import { createHash } from 'node:crypto';
import type { OpenCascadeInstance, TopoDS_Face, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { vi } from 'vitest';

import type { Vec3Tuple } from '../types.js';
import * as allocations from './allocations.js';
import { writeBrepBytes } from './brepBytes.js';

/** 実円筒の各面を幾何ごと独立に複製する。縫う前は面間で辺を共有しない。 */
export function cylinderFaces(oc: OpenCascadeInstance, radius = 3, height = 8, origin: Vec3Tuple = [0, 0, 0]) {
  const { keep, release } = allocations.createAllocations();
  try {
    const point = keep(new oc.gp_Pnt_3(...origin));
    const axis = keep(new oc.gp_Ax2_3(point, keep(new oc.gp_Dir_4(0, 0, 1))));
    const maker = keep(new oc.BRepPrimAPI_MakeCylinder_3(axis, radius, height));
    const source = keep(maker.Shape());
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_1(source, oc.TopAbs.ShapeTypeFromString_1('FACE'), map);
    let side: TopoDS_Face | undefined;
    const ends: TopoDS_Face[] = [];
    for (let index = 1; index <= map.Size(); index += 1) {
      const original = keep(oc.TopoDS.Face_1(keep(map.FindKey(index))));
      const copy = keep(new oc.BRepBuilderAPI_Copy_2(original, true, false));
      const face = keep(oc.TopoDS.Face_1(keep(copy.Shape())));
      const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
      if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) side = face;
      else if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) ends.push(face);
      else throw new Error('Unexpected cylinder surface');
    }
    if (side === undefined || ends.length !== 2) throw new Error('Expected one side and two ends');
    const faces: readonly [TopoDS_Face, TopoDS_Face, TopoDS_Face] = [side, ends[0], ends[1]];
    return { faces, source, radius, height, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

export function brepSnapshots(oc: OpenCascadeInstance, shapes: readonly TopoDS_Shape[]) {
  return shapes.map(shape => {
    const bytes = writeBrepBytes(oc, shape);
    return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

/** createAllocations の実確保を観測する。コンストラクターや演算の結果は置き換えない。 */
export function observeSewAllocations(oc: OpenCascadeInstance) {
  const original = allocations.createAllocations;
  const records: { item: allocations.OcctDeletable; deletes: number }[] = [];
  const observed = new Set<allocations.OcctDeletable>();
  function observe<T extends allocations.OcctDeletable>(item: T): T {
    if (observed.has(item)) return item;
    observed.add(item);
    const entry = { item, deletes: 0 };
    const dispose = item.delete.bind(item);
    item.delete = () => { entry.deletes += 1; dispose(); };
    records.push(entry);
    // 所有登録とは独立に戻り wrapper も数える。Shape() 等の keep 忘れを検出する。
    if (item instanceof oc.BRepBuilderAPI_Copy) {
      const shape = item.Shape.bind(item);
      item.Shape = () => observe(shape());
    }
    if (item instanceof oc.BRepBuilderAPI_Sewing) {
      const sewed = item.SewedShape.bind(item);
      item.SewedShape = () => observe(sewed());
    }
    if (item instanceof oc.BRepBuilderAPI_MakeSolid) {
      const solid = item.Solid.bind(item);
      item.Solid = () => observe(solid());
    }
    if (item instanceof oc.TopoDS_Shape) {
      const reversed = item.Reversed.bind(item);
      item.Reversed = () => observe(reversed());
    }
    return item;
  }
  const shell = oc.TopoDS.Shell_1.bind(oc.TopoDS);
  const shellObserver = vi.spyOn(oc.TopoDS, 'Shell_1').mockImplementation(shape => observe(shell(shape)));
  const observer = vi.spyOn(allocations, 'createAllocations').mockImplementation(() => {
    const owned = original();
    return {
      keep<T extends allocations.OcctDeletable>(item: T): T {
        return owned.keep(observe(item));
      },
      release: owned.release,
    };
  });
  return { records, stop: () => { observer.mockRestore(); shellObserver.mockRestore(); } };
}

/** 縫合の返す数値とは独立に、各辺を持つ面と円筒の継ぎ目から自由辺を数える。 */
export function freeEdges(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const { keep, release } = allocations.createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(shape, oc.TopAbs.ShapeTypeFromString_1('EDGE'),
      oc.TopAbs.ShapeTypeFromString_1('FACE'), map);
    let count = 0;
    for (let index = 1; index <= map.Size(); index += 1) {
      const edge = keep(oc.TopoDS.Edge_1(keep(map.FindKey(index))));
      const owners = keep(new oc.TopTools_ListOfShape_3(keep(map.FindFromIndex(index))));
      const unique = keep(new oc.TopTools_IndexedMapOfShape_1());
      let seam = false;
      while (owners.Size() > 0) {
        const owner = keep(oc.TopoDS.Face_1(keep(owners.First_1())));
        owners.RemoveFirst();
        unique.Add(owner);
        seam ||= oc.BRep_Tool.IsClosed_2(edge, owner);
      }
      if (unique.Size() === 1 && !seam && !oc.BRep_Tool.Degenerated(edge)) count += 1;
    }
    return count;
  } finally {
    release();
  }
}
