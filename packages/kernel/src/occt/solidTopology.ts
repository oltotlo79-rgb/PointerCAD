/** 部分形状の借用ラッパーを走査ごとに解放し、ソリッドだけを数える。 */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';

export function countSolidShapes(oc: OpenCascadeInstance, shape: TopoDS_Shape, stopAfter = Infinity): number {
  const { keep, release } = createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    let count = 0;
    for (let i = 1; i <= map.Size(); i++) {
      const currentOwner = createAllocations();
      try {
        const current = currentOwner.keep(map.FindKey(i));
        if (current.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) count++;
      } finally { currentOwner.release(); }
      if (count >= stopAfter) break;
    }
    return count;
  } finally { release(); }
}
