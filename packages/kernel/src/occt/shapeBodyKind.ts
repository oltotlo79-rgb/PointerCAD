/** Classify actual topology, including compounds containing both solids and open faces. */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';

export type CadBodyKind = 'solid' | 'shell' | 'mixed';
export const OPEN_FACES_NOT_SUPPORTED = '閉じていない面を含む形には使えません。立体を選び直してください。';
export function shapeBodyKind(oc: OpenCascadeInstance, shape: TopoDS_Shape): CadBodyKind {
  // ShapeType dereferences a null native TShape; guard before entering that OCCT call.
  if (shape.IsNull()) throw new Error('形状が空のため、立体か面かを判定できません。');
  const kind = shape.ShapeType(), types = oc.TopAbs_ShapeEnum;
  if (kind === types.TopAbs_SOLID || kind === types.TopAbs_COMPSOLID) return 'solid';
  if (kind !== types.TopAbs_COMPOUND) return 'shell';
  const { keep, release } = createAllocations();
  try {
    const all = keep(new oc.TopTools_IndexedMapOfShape_1()), covered = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, all, true, true);
    let solids = 0;
    for (let index = 1; index <= all.Size(); index++) {
      const part = all.FindKey(index);
      try { if (part.ShapeType() === types.TopAbs_SOLID) { solids++; oc.TopExp.MapShapes_2(part, covered, true, true); } }
      finally { part.delete(); }
    }
    if (solids === 0) return 'shell';
    for (let index = 1; index <= all.Size(); index++) {
      const part = all.FindKey(index);
      try { if (part.ShapeType() === types.TopAbs_FACE && !covered.Contains(part)) return 'mixed'; }
      finally { part.delete(); }
    }
    return 'solid';
  } finally { release(); }
}

/** Open faces do not contribute to the volume of a mixed body. */
export function measureClosedBodyVolume(oc: OpenCascadeInstance, shape: TopoDS_Shape,
  measure: (solid: TopoDS_Shape) => number): number {
  const { keep, release } = createAllocations();
  try {
    const all = keep(new oc.TopTools_IndexedMapOfShape_1()); oc.TopExp.MapShapes_2(shape, all, true, true);
    let volume = 0;
    for (let index = 1; index <= all.Size(); index++) {
      const part = all.FindKey(index);
      try { if (part.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) volume += measure(part); }
      finally { part.delete(); }
    }
    return volume;
  } finally { release(); }
}
