/** 部分形状の借用ラッパーを走査ごとに解放し、ソリッドだけを数える。 */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

export function countSolidShapes(oc: OpenCascadeInstance, shape: TopoDS_Shape, stopAfter = Infinity): number {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, map, true, true);
    let count = 0;
    for (let i = 1; i <= map.Size(); i++) {
      const current = map.FindKey(i);
      try { if (current.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) count++; }
      finally { current.delete(); }
      if (count >= stopAfter) break;
    }
    return count;
  } finally { map.delete(); }
}
