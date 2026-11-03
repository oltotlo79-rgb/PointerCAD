import type { OpenCascadeInstance, TopoDS_Face } from 'opencascade.js/dist/opencascade.full.js';
import type { PlanarFaceBasis, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { unitDirectionCleanZero } from './normalizeDirection.js';

function unit(value: Vec3Tuple): Vec3Tuple {
  const direction = unitDirectionCleanZero(value);
  if (direction === null) throw new Error('平面の座標軸を読み取れません。');
  return direction;
}

/** adaptorは面のLocationを適用済み。INTERNAL/EXTERNALには外向きを定義せず、省略する。 */
export function readNativePlanarBasis(
  oc: OpenCascadeInstance, face: TopoDS_Face, keep: Allocations['keep'],
): PlanarFaceBasis | null {
  const orientation = face.Orientation_1();
  if (orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) {
    return null;
  }
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  const plane = keep(adaptor.Plane());
  const axis = keep(plane.Axis());
  const direction = keep(axis.Direction());
  const sign = orientation === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
  const normal = unit([direction.X() * sign, direction.Y() * sign, direction.Z() * sign]);
  const xAxisLine = keep(plane.XAxis());
  const x = keep(xAxisLine.Direction());
  const xAxis = unit([x.X(), x.Y(), x.Z()]);
  const location = keep(plane.Location());
  return {
    origin: [location.X(), location.Y(), location.Z()], normal, xAxis,
    yAxis: [normal[1] * xAxis[2] - normal[2] * xAxis[1],
      normal[2] * xAxis[0] - normal[0] * xAxis[2], normal[0] * xAxis[1] - normal[1] * xAxis[0]],
  };
}
