/** P10-4: 外周と独立した内周から、一定厚の板金基板を作る。 */
import type { OpenCascadeInstance, TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makePlanarFace } from './makePlanarFace.js';
import { distanceBetween } from './measureShape.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';

export interface SheetMetalBaseInput {
  readonly outer: readonly CurveSpec[];
  readonly holes: readonly (readonly CurveSpec[])[];
  readonly thickness: number;
  readonly reversed: boolean;
  /** modelで解決した基準法線。省略時は輪郭面の向きを使う。 */
  readonly normal?: Vec3Tuple;
}
interface PlaneFrame { readonly normal: Vec3Tuple; readonly point: Vec3Tuple }
const GEOMETRY_TOLERANCE_MM = 1e-7;

function planeFrame(oc: OpenCascadeInstance, face: TopoDS_Face, keep: Allocations['keep']): PlaneFrame {
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  const plane = keep(adaptor.Plane()), axis = keep(plane.Axis());
  const direction = keep(axis.Direction()), point = keep(plane.Location());
  const sign = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_FORWARD ? 1 : -1;
  return { normal: [sign * direction.X(), sign * direction.Y(), sign * direction.Z()],
    point: [point.X(), point.Y(), point.Z()] };
}
function prism(oc: OpenCascadeInstance, face: TopoDS_Face, vector: Vec3Tuple, keep: Allocations['keep']): TopoDS_Shape {
  const delta = keep(new oc.gp_Vec_4(...vector));
  const maker = keep(new oc.BRepPrimAPI_MakePrism_1(face, delta, false, true));
  if (!maker.IsDone()) throw new Error('板金基板に厚みを付けられませんでした。');
  const shape = keep(maker.Shape());
  if (!hasSolid(oc, shape) || !isValidShape(oc, shape)) throw new Error('板金の輪郭から有効な基板を作れませんでした。');
  return shape;
}
function samePlane(first: PlaneFrame, second: PlaneFrame): boolean {
  const alignment = first.normal[0] * second.normal[0] + first.normal[1] * second.normal[1] + first.normal[2] * second.normal[2];
  const offset = first.normal.reduce((sum, value, index) => sum + value * (second.point[index] - first.point[index]), 0);
  return Number.isFinite(alignment) && Number.isFinite(offset)
    && Math.abs(Math.abs(alignment) - 1) <= 1e-10 && Math.abs(offset) <= GEOMETRY_TOLERANCE_MM;
}

/** 各穴は外周の内部へ完全に入り、外周・他の穴に触れないことを実形状で確認する。 */
export function makeSheetMetalBase(oc: OpenCascadeInstance, input: SheetMetalBaseInput): OcctShapeHandle {
  if (!Number.isFinite(input.thickness) || input.thickness <= GEOMETRY_TOLERANCE_MM) {
    throw new Error('板厚には0より大きい、幾何許容差を超える長さを指定してください。');
  }
  const { keep, release } = createAllocations();
  try {
    const outer = keep(makePlanarFace(oc, input.outer)), frame = planeFrame(oc, outer.face, keep);
    const normal = input.normal ?? frame.normal;
    if (!normal.every(Number.isFinite) || Math.abs(Math.hypot(...normal) - 1) > 1e-10
      || Math.abs(Math.abs(normal.reduce((sum, value, index) => sum + value * frame.normal[index], 0)) - 1) > 1e-10) {
      throw new Error('板金基板の法線が輪郭の平面と一致しません。');
    }
    const thickness = input.reversed ? -input.thickness : input.thickness;
    const vector: Vec3Tuple = [normal[0] * thickness, normal[1] * thickness, normal[2] * thickness];
    let shape = prism(oc, outer.face, vector, keep);
    const boundaries: TopoDS_Wire[] = [keep(oc.BRepTools.OuterWire(outer.face))];
    for (const [index, curves] of input.holes.entries()) {
      const label = `穴${String(index + 1)}`;
      const hole = keep(makePlanarFace(oc, curves));
      if (!samePlane(frame, planeFrame(oc, hole.face, keep))) throw new Error(`${label}は外周と同じ平面に置いてください。`);
      const wire = keep(oc.BRepTools.OuterWire(hole.face));
      for (const boundary of boundaries) {
        if (distanceBetween(oc, boundary, wire).distance <= GEOMETRY_TOLERANCE_MM) {
          throw new Error(`${label}が外周または別の穴に接しています。輪郭を離してください。`);
        }
      }
      const tool = prism(oc, hole.face, vector, keep), toolVolume = measureVolume(oc, tool);
      if (!Number.isFinite(toolVolume) || toolVolume <= 1e-9) throw new Error(`${label}の面積が小さすぎます。`);
      let intersectionVolume: number;
      try {
        const common = booleanOp(oc, 'intersect', shape, tool);
        try { intersectionVolume = common.volume; } finally { common.delete(); }
      } catch (error) {
        throw new Error(`${label}は基板の内側で、別の穴と重ならない位置に置いてください。`, { cause: error });
      }
      if (Math.abs(intersectionVolume - toolVolume) > Math.max(1e-9, toolVolume * 1e-8)) {
        throw new Error(`${label}が外周から出ているか、別の穴と重なっています。`);
      }
      shape = keep(booleanOp(oc, 'subtract', shape, tool)).shape;
      boundaries.push(wire);
    }
    return { shape, delete: release };
  } catch (error) { release(); throw error; }
}
