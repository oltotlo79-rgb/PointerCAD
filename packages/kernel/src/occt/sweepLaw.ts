/**
 * スイープのねじれと先細り(M-07)。断面を経路に沿って、全体で決めた角度だけ回し、終わりへ向けて長さに比例して大きさを変える。
 *
 * 向きは OCCT の Frenet や副法線の固定に任せず、自分で作る「回転を抑えた枠」(二重反射の方法)で決める。
 * 経路を長さで 128 区間に分け、各点の枠を、始点の断面の面内の向きから運ぶ。各点 i で、
 * - 回す角度 φ_i = ねじれ × s_i / L、倍率 k_i = 1 + (終わりの倍率 − 1) × s_i / L(s_i は始点からの長さ、L は全長)。
 * - 向きは、点 p_i から回した法線の向きへ一定の距離だけ離した点を通る補助の線(B スプライン)を
 *   `SetMode_5(補助の線, false, NoContact)` で渡して固める。第 2 引数 false は、経路に直交する面と補助の線の交点で向きを決める指定。
 *   上下方向の経路でも決まる(副法線を固める `SetMode_3` の制限を受けない)。
 * - 断面は、始点の断面を枠 i へ移して回し k_i 倍にした写し(sweepGuide.ts の transformedSection と同じ相似の変換)を足す。
 *
 * 足す断面の数(試作 M07-0 の実測。scratchpad の results-summary.md):
 * - ねじれは補助の線が受け持つので、断面は始めと終わりの 2 枚でよい(3600° まで途中の角のずれ 0.0007mm 以下)。
 * - 先細りは、経路の稜線がどれも直線・円弧なら 2 枚。自由曲線・楕円などを含む時は 4 つおき(33 枚)に足し、
 *   倍率を稜線ごとに補正する。OCCT は、稜線の中の長さの比 f の位置に足した断面を、その稜線の媒介変数の比 f の位置に見せるため。
 *
 * 断るもの(作る前に。断りの文はそのまま利用者へ見せる):
 * - 閉じた経路(終わりの断面が始めと合わず、回転を抑えた枠も一周して元の向きに戻らない)。
 * - 継ぎ目で接線がそろっていない経路(試作で、わずかな食い違いでも形が正しくならず、失敗まで 4〜14 秒かかった)。
 *   角を丸めた経路(直線と円弧が接する経路)は作れる。
 * - ねじれが ±3600°(10 回転)を超える、終わりの倍率が 0 以下か 10 を超える。
 */
import type { BRepAdaptor_Curve, BRepOffsetAPI_MakePipeShell, OpenCascadeInstance, TopoDS_Edge, TopoDS_Wire }
  from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { makeCurveEdge } from './makeSketchEdges.js';
import { exceedsMagnitude } from './tolerances.js';

const INTERVALS = 128;
const LENGTH_TOLERANCE = 1e-7;
/** 先細りで自由曲線を含む経路に足す断面の間隔(128 区間のうち何個おきか)。案内線(sweepGuide.ts)と同じ。 */
const CURVED_SECTION_STRIDE = 4;
/** ねじれの上限(ラジアン)。±3600°(10 回転)。 */
const TWIST_LIMIT_RADIANS = 20 * Math.PI;
/** 終わりの倍率の上限。 */
const END_SCALE_LIMIT = 10;
/**
 * 継ぎ目の接線の食い違いの許容(ラジアン)。スケッチの拘束で接するように描いた線と円弧は、解の許容 1e-6mm から
 * 1e-6 / 半径 程度しか食い違わないので通し、目で見て分かる折れは断る。
 */
const JOINT_TANGENT_TOLERANCE_RADIANS = 1e-5;

const CLOSED_PATH_MESSAGE = '閉じた道筋では、ねじれと先細りは使えません。';
const JOINT_MESSAGE = 'ねじれ・先細りには、継ぎ目で向きのそろった道筋(角を丸めた道筋)を選んでください。';
const TWIST_LIMIT_MESSAGE = 'ねじれは±3600度(10回転)までにしてください。';
const END_SCALE_MESSAGE = '終わりの大きさは、0より大きく10以下の倍率にしてください。';
const FRAME_MESSAGE = '道筋の向きが決まらないため、ねじれ・先細りの掃引を作れませんでした。道筋を選び直してください。';

const add = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3Tuple, k: number): Vec3Tuple => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(a: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(a[0], a[1], a[2]);
  if (!(length > 1e-12)) throw new Error(FRAME_MESSAGE);
  return mul(a, 1 / length);
}

/** ねじれ・先細りの指定と、断面の大きさ(補助の線を経路から離す距離に使う)。 */
interface SweepLawSpec {
  /** 全体で回す角度(ラジアン)。 */
  readonly twist: number;
  /** 終わりの断面の倍率。 */
  readonly endScale: number;
  /** 断面の重心から最も遠い縁までの距離(mm)。 */
  readonly profileRadius: number;
}

/** 掃引の準備の結果。外と内側の線(中空)に同じ物を当てる。 */
interface SweepLawPlan {
  /** 向きを固める補助の線。 */
  readonly auxiliary: TopoDS_Wire;
  /** 体積 = 断面の面積 × これ(L × (1 + k + k²) / 3。ねじれは面積を変えない)。 */
  readonly volumePerArea: number;
  /** 断面の倍率の最大(曲がりの半径の確かめに使う)。 */
  readonly maxScale: number;
  /** 始点に置いた断面の写しを、枠の列に合わせて足す。 */
  readonly addSections: (pipe: BRepOffsetAPI_MakePipeShell, placed: TopoDS_Wire) => void;
}

interface Station { readonly p: Vec3Tuple; readonly t: Vec3Tuple; readonly r: Vec3Tuple; readonly ratio: number }
interface LawFrame { readonly p: Vec3Tuple; readonly n: Vec3Tuple; readonly b: Vec3Tuple; readonly t: Vec3Tuple; readonly k: number }

/** 稜線の、ワイヤをたどる向きでの始めと終わりの接線(単位)。 */
function edgeEndTangents(oc: OpenCascadeInstance, edge: TopoDS_Edge, reversed: boolean, keep: Allocations['keep']): readonly [Vec3Tuple, Vec3Tuple] {
  const curve = keep(new oc.BRepAdaptor_Curve_2(edge));
  const tangentAt = (parameter: number): Vec3Tuple => {
    const point = keep(new oc.gp_Pnt_1()), derivative = keep(new oc.gp_Vec_1());
    curve.D1(parameter, point, derivative);
    const tangent = unit([derivative.X(), derivative.Y(), derivative.Z()]);
    return reversed ? mul(tangent, -1) : tangent;
  };
  const first = tangentAt(curve.FirstParameter()), last = tangentAt(curve.LastParameter());
  return reversed ? [last, first] : [first, last];
}

/** 稜線ごとの長さ・媒介変数の範囲・種類。継ぎ目の確かめと、先細りの補正に使う。 */
interface SpineEdge {
  readonly curve: BRepAdaptor_Curve;
  readonly first: number;
  readonly last: number;
  readonly length: number;
  readonly reversed: boolean;
  readonly start: number;
  /** 直線か円弧(断面 2 枚で先細りが長さに比例する稜線)。 */
  readonly simple: boolean;
}

function readSpineEdges(oc: OpenCascadeInstance, spine: TopoDS_Wire, keep: Allocations['keep']): readonly SpineEdge[] {
  const explorer = keep(new oc.BRepTools_WireExplorer_2(spine));
  const reversedOrientation = oc.TopAbs_Orientation.TopAbs_REVERSED;
  const kinds = oc.GeomAbs_CurveType;
  const edges: SpineEdge[] = [];
  let total = 0;
  let previousEnd: Vec3Tuple | null = null;
  for (; explorer.More(); explorer.Next()) {
    const edge = keep(explorer.Current());
    const reversed = explorer.Orientation() === reversedOrientation;
    const [startTangent, endTangent] = edgeEndTangents(oc, edge, reversed, keep);
    if (previousEnd !== null && Math.acos(Math.min(1, Math.max(-1, dot(previousEnd, startTangent)))) > JOINT_TANGENT_TOLERANCE_RADIANS) {
      throw new Error(JOINT_MESSAGE);
    }
    previousEnd = endTangent;
    const curve = keep(new oc.BRepAdaptor_Curve_2(edge));
    const first = curve.FirstParameter(), last = curve.LastParameter();
    const length = oc.GCPnts_AbscissaPoint.Length_7(curve, first, last, LENGTH_TOLERANCE);
    const type = curve.GetType();
    edges.push({ curve, first, last, length, reversed, start: total, simple: type === kinds.GeomAbs_Line || type === kinds.GeomAbs_Circle });
    total += length;
  }
  return edges;
}

/** 経路を長さで 128 区間に割り、点・接線と、二重反射で運ぶ回転を抑えた枠の基準の向き r を返す。 */
function lawStations(oc: OpenCascadeInstance, spine: TopoDS_Wire, r0: Vec3Tuple, keep: Allocations['keep']):
  { readonly stations: readonly Station[]; readonly length: number } {
  const curve = keep(new oc.BRepAdaptor_CompCurve_2(spine, false));
  const length = oc.GCPnts_AbscissaPoint.Length_3(curve, LENGTH_TOLERANCE);
  const stations: Station[] = [];
  for (let i = 0; i <= INTERVALS; i += 1) {
    const ratio = i / INTERVALS;
    let parameter = i === INTERVALS ? curve.LastParameter() : curve.FirstParameter();
    if (i > 0 && i < INTERVALS) {
      const abscissa = keep(new oc.GCPnts_AbscissaPoint_3(LENGTH_TOLERANCE, curve, length * ratio, curve.FirstParameter()));
      if (!abscissa.IsDone()) throw new Error(FRAME_MESSAGE);
      parameter = abscissa.Parameter();
    }
    const point = keep(new oc.gp_Pnt_1()), derivative = keep(new oc.gp_Vec_1());
    curve.D1(parameter, point, derivative);
    const p: Vec3Tuple = [point.X(), point.Y(), point.Z()];
    const t = unit([derivative.X(), derivative.Y(), derivative.Z()]);
    const previous = stations.at(-1);
    if (previous === undefined) {
      stations.push({ p, t, r: unit(sub(r0, mul(t, dot(r0, t)))), ratio });
      continue;
    }
    // 二重反射(double reflection)で、前の点の枠を次の点へ運ぶ。
    const v1 = sub(p, previous.p), c1 = dot(v1, v1);
    const rL = c1 > 1e-18 ? sub(previous.r, mul(v1, 2 * dot(v1, previous.r) / c1)) : previous.r;
    const tL = c1 > 1e-18 ? sub(previous.t, mul(v1, 2 * dot(v1, previous.t) / c1)) : previous.t;
    const v2 = sub(t, tL), c2 = dot(v2, v2);
    const r = c2 > 1e-18 ? sub(rL, mul(v2, 2 * dot(v2, rL) / c2)) : rL;
    stations.push({ p, t, r: unit(sub(r, mul(t, dot(r, t)))), ratio });
  }
  return { stations, length };
}

function lawFrame(station: Station, twist: number, scale: number): LawFrame {
  const phi = twist * station.ratio, side = cross(station.t, station.r);
  const n = add(mul(station.r, Math.cos(phi)), mul(side, Math.sin(phi)));
  return { p: station.p, n, b: cross(station.t, n), t: station.t, k: scale };
}

/** 始めの枠から点 i の枠へ移す相似の変換で、置いた断面の写しを作る(sweepGuide.ts の transformedSection と同じ形)。 */
function sectionAt(oc: OpenCascadeInstance, wire: TopoDS_Wire, start: LawFrame, frame: LawFrame, keep: Allocations['keep']): TopoDS_Wire {
  const cell = (row: number, column: number): number =>
    frame.k * (frame.n[row] * start.n[column] + frame.b[row] * start.b[column] + frame.t[row] * start.t[column]);
  const translation = (row: number): number => frame.p[row] - cell(row, 0) * start.p[0] - cell(row, 1) * start.p[1] - cell(row, 2) * start.p[2];
  const transform = keep(new oc.gp_Trsf_1());
  transform.SetValues(cell(0, 0), cell(0, 1), cell(0, 2), translation(0), cell(1, 0), cell(1, 1), cell(1, 2), translation(1),
    cell(2, 0), cell(2, 1), cell(2, 2), translation(2));
  const copier = keep(new oc.BRepBuilderAPI_Transform_2(wire, transform, true));
  if (!copier.IsDone()) throw new Error(FRAME_MESSAGE);
  return keep(oc.TopoDS.Wire_1(keep(copier.Shape())));
}

/**
 * 断面 i の倍率。直線・円弧だけの経路は長さの比のまま。自由曲線などを含む経路は、OCCT が断面を見せる位置
 * (稜線の中の長さの比 f を、その稜線の媒介変数の比 f と読んだ位置)の長さの比で決める。
 */
function scaleAt(oc: OpenCascadeInstance, edges: readonly SpineEdge[], total: number, ratio: number, endScale: number): number {
  const s = ratio * total;
  const edge = edges.find((candidate) => s <= candidate.start + candidate.length + 1e-9) ?? edges.at(-1);
  if (edge === undefined || edge.simple || !(edge.length > 0)) return 1 + (endScale - 1) * ratio;
  const f = Math.min(1, Math.max(0, (s - edge.start) / edge.length));
  const parameter = edge.reversed ? edge.last - f * (edge.last - edge.first) : edge.first + f * (edge.last - edge.first);
  const inside = edge.reversed ? oc.GCPnts_AbscissaPoint.Length_7(edge.curve, parameter, edge.last, LENGTH_TOLERANCE)
    : oc.GCPnts_AbscissaPoint.Length_7(edge.curve, edge.first, parameter, LENGTH_TOLERANCE);
  return 1 + (endScale - 1) * Math.min(1, (edge.start + inside) / total);
}

/**
 * ねじれ・先細りの掃引の準備。`reference` は、始点に置いた断面の面内の基準の向き(断面の元の X 軸を置き方で移した向き)。
 * 断る時は利用者へ見せる日本語の Error を投げる。
 */
export function prepareSweepLaw(oc: OpenCascadeInstance, spine: TopoDS_Wire, reference: Vec3Tuple, law: SweepLawSpec,
  keep: Allocations['keep']): SweepLawPlan {
  if (!Number.isFinite(law.twist) || exceedsMagnitude(law.twist, TWIST_LIMIT_RADIANS)) throw new Error(TWIST_LIMIT_MESSAGE);
  if (!Number.isFinite(law.endScale) || !(law.endScale > 0) || law.endScale > END_SCALE_LIMIT) throw new Error(END_SCALE_MESSAGE);
  if (spine.Closed_1()) throw new Error(CLOSED_PATH_MESSAGE);
  const edges = readSpineEdges(oc, spine, keep);
  const { stations, length } = lawStations(oc, spine, reference, keep);
  const simple = law.endScale === 1 || edges.every((edge) => edge.simple);
  const total = edges.reduce((sum, edge) => sum + edge.length, 0);
  const frames = stations.map((station) => lawFrame(station, law.twist,
    simple ? 1 + (law.endScale - 1) * station.ratio : scaleAt(oc, edges, total, station.ratio, law.endScale)));
  const distance = Math.max(1, law.profileRadius) * 2;
  const auxiliaryPoints = frames.map((frame) => add(frame.p, mul(frame.n, distance)));
  const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_1());
  wireMaker.Add_1(keep(makeCurveEdge(oc, { kind: 'spline', mode: 'interpolate', points: auxiliaryPoints, closed: false })).edge);
  if (!wireMaker.IsDone()) throw new Error(FRAME_MESSAGE);
  const auxiliary = keep(wireMaker.Wire());
  const stride = simple ? INTERVALS : CURVED_SECTION_STRIDE;
  const start = frames[0];
  return {
    auxiliary,
    volumePerArea: length * (1 + law.endScale + law.endScale * law.endScale) / 3,
    maxScale: Math.max(1, law.endScale),
    addSections: (pipe, placed) => {
      for (let i = 0; i <= INTERVALS; i += stride) pipe.Add_1(sectionAt(oc, placed, start, frames[i], keep), false, false);
    },
  };
}
