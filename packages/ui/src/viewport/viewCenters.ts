import { rotateVector, type RigidPlacement, type SolidBody } from '@pointercad/model';
import type { PointerRay } from '../sketch/trackMath.js';
import type { SolidGeometryBundle } from './buildSolidGeometry.js';
import type { AssemblyGeometryBundle } from './createAssemblyLayer.js';
import type { ViewBounds } from './viewFit.js';

/*
 * 回転の中心・拡大の中心の点(設計 2-3・B-08d)。押した所の形の上の点は、scene の当たり(pickFaceAt・pickAssemblyFace)で
 * 決まった面の三角形と、押した画素の光線(pointerRay)の交点にする。three.js にも DOM にも触れない純関数だけを置く。
 */

type Point = readonly [number, number, number];

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 光線と三角形の交点までの距離(メラー・トランボアの方法)。当たらない・後ろ・平行なら null。 */
export function rayTriangleDistance(origin: Point, direction: Point, a: Point, b: Point, c: Point): number | null {
  const edge1 = sub(b, a), edge2 = sub(c, a), p = cross(direction, edge2), determinant = dot(edge1, p);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const s = sub(origin, a), u = dot(s, p) / determinant;
  if (u < 0 || u > 1) return null;
  const q = cross(s, edge1), v = dot(direction, q) / determinant;
  if (v < 0 || u + v > 1) return null;
  const distance = dot(edge2, q) / determinant;
  return distance > 0 && Number.isFinite(distance) ? distance : null;
}

/** 1 つの面の三角形(索引の [offset, offset+count) 枚)と光線の、いちばん近い交点。座標は positions と同じ系。 */
function faceHit(positions: ArrayLike<number>, indices: ArrayLike<number>, face: { readonly triangleOffset: number; readonly triangleCount: number },
  origin: Point, direction: Point): Point | null {
  let nearest: number | null = null;
  const corner = (triangle: number, k: number): Point => {
    const vertex = (indices[triangle * 3 + k] ?? -1) * 3;
    return [positions[vertex] ?? Number.NaN, positions[vertex + 1] ?? Number.NaN, positions[vertex + 2] ?? Number.NaN];
  };
  for (let triangle = face.triangleOffset; triangle < face.triangleOffset + face.triangleCount; triangle += 1) {
    const distance = rayTriangleDistance(origin, direction, corner(triangle, 0), corner(triangle, 1), corner(triangle, 2));
    if (distance !== null && (nearest === null || distance < nearest)) nearest = distance;
  }
  return nearest === null ? null : [origin[0] + direction[0] * nearest, origin[1] + direction[1] * nearest, origin[2] + direction[2] * nearest];
}

function frameOrigin(frame: SolidBody['coordinateFrame']): Point {
  return frame === undefined ? [0, 0, 0] : frame.origin;
}

/** 部品の画面: pickFaceAt が返した立体の面と光線の交点(ワールド座標)。 */
export function partSurfacePoint(solid: SolidGeometryBundle, hit: { readonly featureId: string; readonly faceIndex: number },
  ray: PointerRay): Point | null {
  const entry = solid.index.get(hit.featureId), face = entry?.faces.find(item => item.index === hit.faceIndex);
  if (entry === undefined || face === undefined) return null;
  const origin = frameOrigin(entry.coordinateFrame), local = faceHit(entry.positions, entry.indices, face, sub(ray.origin, origin), ray.direction);
  return local === null ? null : [local[0] + origin[0], local[1] + origin[1], local[2] + origin[2]];
}

/** 配置の逆(ワールド → 部品の座標)で点と向きを写す。 */
function toLocal(placement: RigidPlacement, point: Point, direction: Point): { readonly origin: Point; readonly direction: Point } {
  const [x, y, z, w] = placement.rotation, inverse = [-x, -y, -z, w] as const;
  return { origin: rotateVector(inverse, sub(point, placement.position)), direction: rotateVector(inverse, direction) };
}

/** 組立の画面: pickAssemblyFace が返した配置・部品の立体の面と光線の交点(ワールド座標)。 */
export function assemblySurfacePoint(assembly: AssemblyGeometryBundle,
  hit: { readonly componentId: string; readonly partKey: string; readonly bodyFeatureId: string; readonly faceIndex: number },
  ray: PointerRay): Point | null {
  const instance = assembly.instances.find(item => item.componentId === hit.componentId && item.partKey === hit.partKey);
  const body = assembly.parts.find(part => part.partKey === hit.partKey)?.bodies.find(item => item.featureId === hit.bodyFeatureId);
  const face = body?.faces.find(item => item.index === hit.faceIndex);
  if (instance === undefined || body === undefined || face === undefined) return null;
  const frame = frameOrigin(body.coordinateFrame), local = toLocal(instance.placement, ray.origin, ray.direction);
  const point = faceHit(body.mesh.positions, body.mesh.indices, face, sub(local.origin, frame), local.direction);
  if (point === null) return null;
  const world = rotateVector(instance.placement.rotation, [point[0] + frame[0], point[1] + frame[1], point[2] + frame[2]]);
  return [world[0] + instance.placement.position[0], world[1] + instance.placement.position[1], world[2] + instance.placement.position[2]];
}

/** 形に当たらない所の拡大の中心: 光線と、注視点を通り視線に垂直な面の交点。平行なら null。 */
export function rayPointAtTargetDepth(ray: PointerRay, target: Point, viewDirection: Point): Point | null {
  const denominator = dot(ray.direction, viewDirection);
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return null;
  const distance = dot(sub(target, ray.origin), viewDirection) / denominator;
  return Number.isFinite(distance) ? [ray.origin[0] + ray.direction[0] * distance, ray.origin[1] + ray.direction[1] * distance,
    ray.origin[2] + ray.direction[2] * distance] : null;
}

/** 外接箱の中心(選んだ物の中心)。 */
export function boundsCenter(bounds: ViewBounds): Point {
  return [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
}
