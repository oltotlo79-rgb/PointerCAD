/** FR-435: 案内線との長さ比の対応と、案内線上の点に追従する断面を作る。 */
import type { BRepAdaptor_CompCurve, BRepOffsetAPI_MakePipeShell, OpenCascadeInstance, TopoDS_Wire } from 'opencascade.js/dist/opencascade.full.js';
import type { Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';

const LENGTH_TOLERANCE = 1e-7;
const CONTACT_TOLERANCE = 1e-5;
const INTERVALS = 128;
const SECTION_STRIDE = 4;
const BAD_INTERVAL = '経路と案内線の対応区間が合いません。始点と終点を同じ断面の位置に合わせ、同じ向きに描いてください。';
const DEGENERATE = '案内線が経路に重なるか、途中で急に折り返しています。経路から離れた案内線に直してください。';

interface Station { readonly p: Vec3Tuple; readonly q: Vec3Tuple; readonly tangent: Vec3Tuple; readonly normal: Vec3Tuple; readonly binormal: Vec3Tuple; readonly radius: number }
export interface SweepGuidePlan {
  readonly stations: readonly Station[];
  /** A(s)=A0×scale(s)²の長さ積分。一定断面のarea×lengthをこの値で置き換える。 */
  readonly volumePerArea: number;
  readonly maxScale: number;
  readonly closed: boolean;
}
const sub = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(value: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(...value); if (!Number.isFinite(length) || length < LENGTH_TOLERANCE) throw new Error(DEGENERATE);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function parameterAt(oc: OpenCascadeInstance, curve: BRepAdaptor_CompCurve, length: number, ratio: number, keep: Allocations['keep']): number {
  if (ratio === 0) return curve.FirstParameter();
  if (ratio === 1) return curve.LastParameter();
  const parameter = keep(new oc.GCPnts_AbscissaPoint_3(LENGTH_TOLERANCE, curve, length * ratio, curve.FirstParameter()));
  if (!parameter.IsDone()) throw new Error(BAD_INTERVAL);
  return parameter.Parameter();
}

function readStation(oc: OpenCascadeInstance, spine: BRepAdaptor_CompCurve, guide: BRepAdaptor_CompCurve,
  spineLength: number, guideLength: number, ratio: number, keep: Allocations['keep']): Station {
  const p = keep(new oc.gp_Pnt_1()), q = keep(new oc.gp_Pnt_1());
  const dp = keep(new oc.gp_Vec_1()), dq = keep(new oc.gp_Vec_1());
  spine.D1(parameterAt(oc, spine, spineLength, ratio, keep), p, dp);
  guide.D1(parameterAt(oc, guide, guideLength, ratio, keep), q, dq);
  const point: Vec3Tuple = [p.X(), p.Y(), p.Z()], target: Vec3Tuple = [q.X(), q.Y(), q.Z()];
  const tangent = unit([dp.X(), dp.Y(), dp.Z()]), offset = sub(target, point), radius = Math.hypot(...offset);
  if (!Number.isFinite(radius) || radius < CONTACT_TOLERANCE) throw new Error(DEGENERATE);
  // CurvilinearEquivalence=trueに合わせる。単に同方向に延びるだけでは通さず、
  // 各対応点が経路の接線に直交する同じ断面上にあることも確認する。
  if (Math.abs(dot(offset, tangent)) > CONTACT_TOLERANCE || dot(tangent, unit([dq.X(), dq.Y(), dq.Z()])) <= 0) throw new Error(BAD_INTERVAL);
  const binormal = unit(cross(tangent, offset)), normal = unit(cross(binormal, tangent));
  return { p: point, q: target, tangent, normal, binormal, radius };
}

function integral(stations: readonly Station[], stride: number): number {
  const firstRadius = stations[0].radius;
  let sum = 0;
  for (let i = 0; i <= INTERVALS; i += stride) {
    const coefficient = i === 0 || i === INTERVALS ? 1 : (i / stride) % 2 === 0 ? 2 : 4;
    sum += coefficient * (stations[i].radius / firstRadius) ** 2;
  }
  return sum * stride / (3 * INTERVALS);
}

export function prepareSweepGuide(oc: OpenCascadeInstance, spineWire: TopoDS_Wire, guideWire: TopoDS_Wire,
  placedProfile: TopoDS_Wire, keep: Allocations['keep']): SweepGuidePlan {
  if (spineWire.Closed_1() !== guideWire.Closed_1()) throw new Error(BAD_INTERVAL);
  const spine = keep(new oc.BRepAdaptor_CompCurve_2(spineWire, false)), guide = keep(new oc.BRepAdaptor_CompCurve_2(guideWire, false));
  const spineLength = oc.GCPnts_AbscissaPoint.Length_3(spine, LENGTH_TOLERANCE);
  const guideLength = oc.GCPnts_AbscissaPoint.Length_3(guide, LENGTH_TOLERANCE);
  if (!Number.isFinite(spineLength) || !Number.isFinite(guideLength) || Math.min(spineLength, guideLength) < CONTACT_TOLERANCE) throw new Error(DEGENERATE);
  const stations: Station[] = [];
  for (let index = 0; index <= INTERVALS; index += 1) {
    const current = readStation(oc, spine, guide, spineLength, guideLength, index / INTERVALS, keep);
    const previous = stations[index - 1];
    if (previous !== undefined && (dot(current.normal, previous.normal) < 0.5 || dot(current.tangent, previous.tangent) < 0.5)) throw new Error(DEGENERATE);
    stations.push(current);
  }
  const q = stations[0].q, vertexMaker = keep(new oc.BRepBuilderAPI_MakeVertex(keep(new oc.gp_Pnt_3(...q))));
  const vertex = keep(vertexMaker.Vertex()), distance = keep(new oc.BRepExtrema_DistShapeShape_1());
  distance.LoadS1(vertex); distance.LoadS2(placedProfile); distance.Perform(keep(new oc.Message_ProgressRange_1()));
  if (!distance.IsDone() || distance.Value() > CONTACT_TOLERANCE) {
    throw new Error('案内線の始点を、経路の始点に置いた断面の縁に合わせてください。');
  }
  const fine = integral(stations, 1), coarse = integral(stations, 2);
  if (!Number.isFinite(fine) || fine <= 0 || Math.abs(fine - coarse) > fine * 1e-6) {
    throw new Error('案内線による断面の変化が急すぎます。案内線の曲がり方を緩やかにしてください。');
  }
  return { stations, volumePerArea: spineLength * fine,
    maxScale: Math.max(...stations.map((station) => station.radius / stations[0].radius)), closed: spineWire.Closed_1() };
}

function transformedSection(oc: OpenCascadeInstance, profile: TopoDS_Wire, start: Station, station: Station, keep: Allocations['keep']): TopoDS_Wire {
  const scale = station.radius / start.radius;
  const cell = (row: number, column: number): number => scale * (station.normal[row] * start.normal[column]
    + station.binormal[row] * start.binormal[column] + station.tangent[row] * start.tangent[column]);
  const translation = (row: number): number => station.p[row] - cell(row, 0) * start.p[0] - cell(row, 1) * start.p[1] - cell(row, 2) * start.p[2];
  const transform = keep(new oc.gp_Trsf_1());
  transform.SetValues(cell(0, 0), cell(0, 1), cell(0, 2), translation(0), cell(1, 0), cell(1, 1), cell(1, 2), translation(1),
    cell(2, 0), cell(2, 1), cell(2, 2), translation(2));
  const copier = keep(new oc.BRepBuilderAPI_Transform_2(profile, transform, true));
  if (!copier.IsDone()) throw new Error('案内線に合わせた断面を作れませんでした。');
  return keep(oc.TopoDS.Wire_1(keep(copier.Shape())));
}

/** NoContactの向きに、明示的な相似断面を沿わせる。SetLawは補助spineと非互換のため使わない。 */
export function addGuidedSections(oc: OpenCascadeInstance, pipe: BRepOffsetAPI_MakePipeShell, profile: TopoDS_Wire,
  plan: SweepGuidePlan, keep: Allocations['keep']): void {
  for (let index = 0; index <= INTERVALS; index += SECTION_STRIDE) {
    if (plan.closed && index === INTERVALS) break;
    pipe.Add_1(transformedSection(oc, profile, plan.stations[0], plan.stations[index], keep), false, false);
  }
}
