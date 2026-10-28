import type { OpenCascadeInstance, TopoDS_Face } from 'opencascade.js/dist/opencascade.full.js';
import type { PlanarFaceBasis, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';

function unit(value: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length <= 0) throw new Error('平面の座標軸を読み取れません。');
  const clean = (n: number) => n === 0 ? 0 : n;
  return [clean(value[0] / length), clean(value[1] / length), clean(value[2] / length)];
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
