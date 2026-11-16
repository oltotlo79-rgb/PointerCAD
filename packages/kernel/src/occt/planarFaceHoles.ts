/** 穴の平面・接触・包含を実形状で確かめてから、外周と逆向きの内周を加える。 */
import type { OpenCascadeInstance, TopoDS_Face, TopoDS_Wire, gp_Pnt } from 'opencascade.js/dist/opencascade.full.js';
import type { Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import type { OcctFaceHandle } from './makePlanarFace.js';
import { distanceBetween } from './measureShape.js';
import { isValidShape, measureArea } from './solidMesh.js';
import { exceedsMagnitude } from './tolerances.js';

const TOLERANCE_MM = 1e-7;
/** 穴と外周の平面の法線が平行とみなす、内積の大きさの 1 からのずれの上限。 */
const PLANE_ALIGNMENT_TOLERANCE = 1e-10;
/** 穴つきの面の面積が「外周 − 穴の和」と一致するとみなす相対の許容(1 mm² 未満の面は 1 mm² を尺度にする)。 */
const AREA_RELATIVE_TOLERANCE = 1e-9;
type Keep = Allocations['keep'];
interface PlaneFrame { readonly normal: Vec3Tuple; readonly point: Vec3Tuple }

function planeFrame(oc: OpenCascadeInstance, face: TopoDS_Face, keep: Keep): PlaneFrame {
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  const plane = keep(adaptor.Plane()), axis = keep(plane.Axis());
  const direction = keep(axis.Direction()), point = keep(plane.Location());
  const sign = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_FORWARD ? 1 : -1;
  return { normal: [sign * direction.X(), sign * direction.Y(), sign * direction.Z()], point: [point.X(), point.Y(), point.Z()] };
}

function wirePoint(oc: OpenCascadeInstance, wire: TopoDS_Wire, keep: Keep): gp_Pnt {
  const shapes = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(wire, shapes, true, true);
  for (let index = 1; index <= shapes.Size(); index += 1) {
    const shape = keep(shapes.FindKey(index));
    if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) {
      return keep(oc.BRep_Tool.Pnt(keep(oc.TopoDS.Vertex_1(shape))));
    }
  }
  throw new Error('穴の輪郭の点が見つかりません。');
}

function inside(oc: OpenCascadeInstance, face: TopoDS_Face, point: gp_Pnt, keep: Keep): boolean {
  const classifier = keep(new oc.BRepClass_FaceClassifier_4(face, point, TOLERANCE_MM, false, TOLERANCE_MM));
  return classifier.State() === oc.TopAbs_State.TopAbs_IN;
}

interface HoleCheck {
  readonly outer: TopoDS_Face; readonly boundaries: readonly TopoDS_Wire[];
  readonly previous: readonly TopoDS_Face[]; readonly label: string;
}

function checkHole(oc: OpenCascadeInstance, hole: TopoDS_Face, context: HoleCheck, keep: Keep): TopoDS_Wire {
  const { outer, boundaries, previous, label } = context;
  const frame = planeFrame(oc, outer, keep), inner = planeFrame(oc, hole, keep);
  const alignment = frame.normal.reduce((sum, value, axis) => sum + value * inner.normal[axis], 0);
  const offset = frame.normal.reduce((sum, value, axis) => sum + value * (inner.point[axis] - frame.point[axis]), 0);
  if (exceedsMagnitude(Math.abs(alignment) - 1, PLANE_ALIGNMENT_TOLERANCE) || exceedsMagnitude(offset, TOLERANCE_MM)) {
    throw new Error(`${label}が外周と同じ平面にありません。`);
  }
  const wire = keep(oc.BRepTools.OuterWire(hole)), point = wirePoint(oc, wire, keep);
  if (boundaries.some(boundary => distanceBetween(oc, boundary, wire).distance <= TOLERANCE_MM)) {
    throw new Error(`${label}が外周または別の穴に接するか交差しています。輪郭を離してください。`);
  }
  if (!inside(oc, outer, point, keep)) throw new Error(`${label}が外周の外にはみ出しています。`);
  if (previous.some((face, index) => inside(oc, face, point, keep) || inside(oc, hole, wirePoint(oc, boundaries[index + 1], keep), keep))) {
    throw new Error(`${label}が別の穴と重なっています。穴を入れ子にしないでください。`);
  }
  if (alignment > 0) wire.Reverse();
  return wire;
}

function boundaryPositions(handles: readonly OcctFaceHandle[]): Float32Array {
  const result = new Float32Array(handles.reduce((sum, handle) => sum + handle.boundaryPositions.length, 0));
  let offset = 0;
  for (const handle of handles) { result.set(handle.boundaryPositions, offset); offset += handle.boundaryPositions.length; }
  return result;
}

/** 渡された面は呼び出し元の今回の割当てだけ。キャッシュ済みの形を変更しない。 */
export function addPlanarFaceHoles(oc: OpenCascadeInstance, outer: OcctFaceHandle, holes: readonly OcctFaceHandle[], keep: Keep): OcctFaceHandle {
  const expected = measureArea(oc, outer.face) - holes.reduce((sum, hole) => sum + measureArea(oc, hole.face), 0);
  const boundaries = [keep(oc.BRepTools.OuterWire(outer.face))], previous: TopoDS_Face[] = [];
  const wires = holes.map((hole, index) => {
    const wire = checkHole(oc, hole.face, { outer: outer.face, boundaries, previous, label: `穴${String(index + 1)}` }, keep);
    boundaries.push(wire); previous.push(hole.face);
    return wire;
  });
  const maker = keep(new oc.BRepBuilderAPI_MakeFace_2(outer.face));
  for (const wire of wires) maker.Add(wire);
  if (!maker.IsDone()) throw new Error('外周と穴から面を張れませんでした。');
  const face = keep(maker.Face()), area = measureArea(oc, face);
  if (!isValidShape(oc, face) || expected <= 0 || !Number.isFinite(area)
    || exceedsMagnitude(area - expected, Math.max(1, Math.abs(expected)) * AREA_RELATIVE_TOLERANCE)) {
    throw new Error('穴つきの面の向きまたは面積を確かめられませんでした。輪郭を確認してください。');
  }
  return { ...outer, face, boundaryPositions: boundaryPositions([outer, ...holes]),
    boundaryEdgeCount: outer.boundaryEdgeCount + holes.reduce((sum, hole) => sum + hole.boundaryEdgeCount, 0) };
}
