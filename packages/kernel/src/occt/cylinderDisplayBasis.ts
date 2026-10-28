import type { OpenCascadeInstance, TopoDS_Face } from 'opencascade.js/dist/opencascade.full.js';
import type { SolidFaceInfo, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';

const normalizedZero = (value: number): number => value === 0 ? 0 : value;

/** Display-only native basis. Never infer it from a fingerprint, material normal or world axes. */
export function readCylinderDisplayBasis(oc: OpenCascadeInstance, face: TopoDS_Face,
  allocations: Allocations): SolidFaceInfo['cylinderBasis'] {
  const { keep } = allocations;
  const orientation = face.Orientation_1();
  if (orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) return undefined;
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, true));
  if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return undefined;
  const scale = keep(adaptor.Trsf()).ScaleFactor();
  if (!Number.isFinite(scale) || Math.abs(Math.abs(scale) - 1) > 1e-12) return undefined;
  const cylinder = keep(adaptor.Cylinder()), position = keep(cylinder.Position());
  const point = keep(position.Location()), z = keep(position.Direction()), x = keep(position.XDirection());
  const origin: Vec3Tuple = [normalizedZero(point.X()), normalizedZero(point.Y()), normalizedZero(point.Z())];
  const axis: Vec3Tuple = [z.X(), z.Y(), z.Z()], zeroDirection: Vec3Tuple = [x.X(), x.Y(), x.Z()];
  const zLength = Math.hypot(...axis), xLength = Math.hypot(...zeroDirection);
  const firstV = adaptor.FirstVParameter(), lastV = adaptor.LastVParameter();
  const firstU = adaptor.FirstUParameter(), lastU = adaptor.LastUParameter(), radius = cylinder.Radius();
  if (![...origin, ...axis, ...zeroDirection, firstV, lastV, firstU, lastU, radius].every(Number.isFinite)
    || !(lastU > firstU) || radius <= 0
    || Math.abs(zLength - 1) > 1e-9 || Math.abs(xLength - 1) > 1e-9 || !(lastV > firstV)
    || Math.abs(axis[0] * zeroDirection[0] + axis[1] * zeroDirection[1] + axis[2] * zeroDirection[2]) > 1e-9) return undefined;
  // Same normalization as makeHole.readCylinderFrame; Orientation deliberately does not flip these axes.
  return { origin, axis: [normalizedZero(axis[0] / zLength), normalizedZero(axis[1] / zLength), normalizedZero(axis[2] / zLength)],
    zeroDirection: [normalizedZero(zeroDirection[0] / xLength), normalizedZero(zeroDirection[1] / xLength), normalizedZero(zeroDirection[2] / xLength)],
    axialRange: [normalizedZero(firstV), normalizedZero(lastV)] };
}
