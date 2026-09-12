/**
 * 立体の面・辺を作図面へ投影する(FR-325、計画書 P4 §2.7・タスク26)。
 *
 * このファイルは投影そのものに加えて、**作図面の姿勢(原点・第 1 軸・法線)と、
 * 作図面の上の 2 次元の曲線の型**を持つ。交差(makeSection.ts)も同じ型で結果を返すので、
 * 面・辺を読み取って 2 次元へ落とす部分をここへ寄せてある。
 *
 * ## 採った方式と、採らなかった API(2026-09-04 に Node 上で実測)
 *
 * **直交投影は OCCT を使わず自前で計算する。** 読み取り(辺の種類・中心・半径・端点)は
 * OCCT に聞き、平面へ落とす計算だけを自分で行う。理由は 3 つで、いずれも実測に基づく。
 *
 * 1. `BRepProj_Projection_1(wire, targetFace, dir)` は動くが、**投影先の面からはみ出した
 *    ぶんを黙って切り落とす。** 40×30 の矩形を半幅 10 の面へ投影すると、`IsDone()` は
 *    true のまま辺 2 本の開いた輪郭が返った(本来は 4 本の閉じた輪郭)。作図面は
 *    無限に広いのに、OCCT へ渡す面には必ず大きさが要るため、どんな大きさを選んでも
 *    「静かに間違った答えが返る」経路が残る。
 * 2. 同じ API は入力に**ワイヤ**を要る。利用者が選ぶのは 1 本の辺のこともあり、
 *    つながらない複数の辺のこともある。
 * 3. `GeomProjLib.ProjectOnPlane` は使えない。辺から曲線を取り出す
 *    `BRep_Tool.Curve_2(edge, First, Last)` の First / Last は C++ の参照渡しの
 *    戻り口で、embind 越しには受け取れない。そのため**切り取り範囲を失った
 *    無限の曲線**(パラメータ ±2e100)が返り、投影結果は両端が原点に潰れた
 *    1 次の B スプラインになった。
 *
 * 自前で計算すると、線分と「軸が作図面の法線と平行な円」は**誤差なく**線分・円弧のまま
 * 残る(板の外周と穴の縁という、投影のほとんどの用途がここに入る)。それ以外の曲線
 * (傾いた円・楕円・自由曲線)は点列へ落とす。`BRepProj_Projection` でも傾いた円は
 * 極 100 個・次数 8 の B スプラインになったので(実測)、どちらにせよ厳密には残らない。
 *
 * ## OCCT の扱いの注意
 *
 * - `Handle_Geom_Plane_2(plane)` のような**ハンドルへ包んだ生の実体を、ハンドルとは別に
 *   `delete()` してはいけない**(2026-09-04 実測。`RuntimeError: table index is out of bounds`
 *   で落ちる)。このファイルはハンドルを 1 つも使わないので、その落とし穴を踏まない。
 * - 列挙を引数に取る API を 1 つも使わないため、述語ガード(計画書 §0.a-0.23 で
 *   2 か所だけ承認)を増やさない。
 */

import type {
  BRepAdaptor_Curve,
  OpenCascadeInstance,
  TopoDS_Edge,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import type { TessellationOptions, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { discretizeEdge } from './makeSketchEdges.js';
import { curveSampleCoordinates } from './curveSampleCoordinates.js';

/** 作図面の上の座標(mm)。第 1 軸の向きが u、第 2 軸(法線 × 第 1 軸)の向きが v。 */
export type Vec2Tuple = readonly [number, number];

/**
 * 作図面の姿勢。第 2 軸は「法線 × 第 1 軸」で決まるので持たない。
 * 第 1 軸が法線と直交していなくてもよい(直交する成分だけを使う)。
 */
export interface SketchPlaneFrame {
  readonly origin: Vec3Tuple;
  readonly axisU: Vec3Tuple;
  readonly normal: Vec3Tuple;
}

/** 作図面の上の線分。 */
export interface PlaneSegment {
  readonly kind: 'segment';
  readonly from: Vec2Tuple;
  readonly to: Vec2Tuple;
}

/**
 * 作図面の上の円弧。角度は第 1 軸の向きを 0 とし、第 2 軸へ回る向きを正とする(ラジアン)。
 * `endAngle` が `startAngle` より小さいこともある(逆回りの弧)。
 * 差の絶対値が 2π 以上なら全周の円。
 */
export interface PlaneArc {
  readonly kind: 'arc';
  readonly center: Vec2Tuple;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

/**
 * 線分にも円弧にも収まらない曲線(傾いた円・楕円・自由曲線)を、通過点の列で表したもの。
 * 呼び出し側はそのまま折れ線として使ってもよいし、通過点方式のスプラインの材料にしてもよい。
 * `closed` が true のとき、最後の点と最初の点はつながっている(重複した点は入れない)。
 */
export interface PlanePolyline {
  readonly kind: 'polyline';
  readonly points: readonly Vec2Tuple[];
  readonly closed: boolean;
}

/** 作図面の上の曲線 1 本。 */
export type PlaneCurve = PlaneSegment | PlaneArc | PlanePolyline;

/** 投影・交差の結果。曲線はつながる順に並ぶ(orderPlaneCurves)。 */
export interface PlaneCurves {
  readonly curves: readonly PlaneCurve[];
}

/** 投影の依頼。 */
export interface ProjectionSpec {
  /**
   * 投影するもと。**面なら外周の辺**(内側の穴の輪は含めない)、辺ならその辺 1 本、
   * それ以外(ワイヤ・殻・立体)なら含まれるすべての辺を投影する。
   */
  readonly source: TopoDS_Shape;
  /** 投影先の作図面。 */
  readonly plane: SketchPlaneFrame;
  /** 点列へ落とすときの粗さ。省略時は表示と同じ既定値。 */
  readonly tessellation?: TessellationOptions;
}

const TAU = 2 * Math.PI;

/** 作図面の法線と円の軸がこれだけ平行に近ければ「平行」とみなす(内積の 1 からのずれ)。 */
const PARALLEL_EPSILON = 1e-9;

/** これより短い線分・これより近い 2 点は「同じ位置」とみなす(mm)。 */
const POINT_EPSILON = 1e-9;

/** 掃き角がこの値だけ 2π に足りなくても全周とみなす(makeSketchEdges.ts と同じ決め)。 */
const FULL_TURN_EPSILON = 1e-9;

/** 曲線どうしがつながっているとみなす距離(mm)。輪郭の並べ替えに使う。 */
const JOIN_TOLERANCE_MM = 1e-6;

/**
 * 点列で返す曲線 1 本あたりの点の数の上限。
 * model 側のスプラインが受け取れる点の数の上限(計画書 §0.a-0.17)に合わせてある。
 */
const MAX_POLYLINE_POINTS = 100;

const BAD_PLANE_NUMBER_MESSAGE = '作図面の指定に使えない数値が含まれています。';
const ZERO_NORMAL_MESSAGE = '作図面の法線の長さが 0 です。向きを指定し直してください。';
const PARALLEL_AXIS_MESSAGE =
  '作図面の第 1 軸が法線と同じ向きのため、作図面の向きを決められません。';
const NO_EDGE_MESSAGE = '投影できる辺がありません。面か辺を選び直してください。';
const ALL_DEGENERATE_MESSAGE =
  '選んだ辺は作図面に対して真横を向いているため、投影しても線になりません。';

/** -0 を +0 へ揃える(subShapes.ts と同じ理由。同じ形から常に同じ値を返すため)。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function isFiniteVec3(value: Vec3Tuple): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

function dot3(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** 作図面の 3 本の軸(単位ベクトル)と原点。planeBasisOf が作る。 */
export interface PlaneBasis {
  readonly origin: Vec3Tuple;
  readonly axisU: Vec3Tuple;
  readonly axisV: Vec3Tuple;
  readonly normal: Vec3Tuple;
}

/**
 * 作図面の指定から、直交する 3 本の単位ベクトルを作る。
 * 第 1 軸は法線に直交する成分だけを取り出して正規化する(グラム・シュミット)ので、
 * 呼び出し側が厳密に直交した軸を用意しなくてよい。
 */
export function planeBasisOf(plane: SketchPlaneFrame): PlaneBasis {
  if (!isFiniteVec3(plane.origin) || !isFiniteVec3(plane.axisU) || !isFiniteVec3(plane.normal)) {
    throw new Error(BAD_PLANE_NUMBER_MESSAGE);
  }
  const normalLength = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]);
  if (!(normalLength > 0)) {
    throw new Error(ZERO_NORMAL_MESSAGE);
  }
  const normal: Vec3Tuple = [
    plane.normal[0] / normalLength,
    plane.normal[1] / normalLength,
    plane.normal[2] / normalLength,
  ];

  const along = dot3(plane.axisU, normal);
  const planar: Vec3Tuple = [
    plane.axisU[0] - along * normal[0],
    plane.axisU[1] - along * normal[1],
    plane.axisU[2] - along * normal[2],
  ];
  const planarLength = Math.hypot(planar[0], planar[1], planar[2]);
  if (!(planarLength > 0)) {
    throw new Error(PARALLEL_AXIS_MESSAGE);
  }
  const axisU: Vec3Tuple = [
    planar[0] / planarLength,
    planar[1] / planarLength,
    planar[2] / planarLength,
  ];

  return { origin: plane.origin, axisU, axisV: cross3(normal, axisU), normal };
}

/** 3 次元の点を作図面へ直交投影して、作図面の上の 2 次元座標にする。 */
export function projectPointToPlane(point: Vec3Tuple, basis: PlaneBasis): Vec2Tuple {
  const offset: Vec3Tuple = [
    point[0] - basis.origin[0],
    point[1] - basis.origin[1],
    point[2] - basis.origin[2],
  ];
  return [normalizeZero(dot3(offset, basis.axisU)), normalizeZero(dot3(offset, basis.axisV))];
}

function distance2(a: Vec2Tuple, b: Vec2Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * 開始角を [0, 2π) へ寄せ、掃き角(符号つき)はそのまま保つ
 * (makeOffsetWire.ts と同じ考え方。同じ弧を指す角の組の揺れを無くす)。
 */
function normalizeArcAngles(start: number, end: number): { start: number; end: number } {
  const sweep = end - start;
  const shifted = start % TAU;
  const normalized = shifted < 0 ? shifted + TAU : shifted;
  return { start: normalizeZero(normalized), end: normalizeZero(normalized + sweep) };
}

/** 点列を上限の数まで間引く。最初と最後は必ず残す。 */
function thinPoints(points: readonly Vec2Tuple[], limit: number): readonly Vec2Tuple[] {
  if (points.length <= limit) {
    return points;
  }
  const kept: Vec2Tuple[] = [];
  const last = points.length - 1;
  for (let index = 0; index < limit; index += 1) {
    kept.push(points[Math.round((index * last) / (limit - 1))]);
  }
  return kept;
}

/** 辺を折れ線へ分解し、作図面の上の点列へ落とす。 */
function sampleEdgeToPlane(
  oc: OpenCascadeInstance,
  edge: TopoDS_Edge,
  basis: PlaneBasis,
  options: TessellationOptions | undefined,
  closed: boolean,
  preservePrecision: boolean,
): PlanePolyline | null {
  // 通常表示のFloat32と、製作用出力のdoubleを入口で分ける。
  // 精密断面では後段の表示用100点への間引きも行わない。
  const polyline = preservePrecision ? curveSampleCoordinates(oc, edge, options, 100_000) : discretizeEdge(oc, edge, options ?? {});
  const points: Vec2Tuple[] = [];
  for (let index = 0; index + 2 < polyline.length; index += 3) {
    const projected = projectPointToPlane(
      [polyline[index], polyline[index + 1], polyline[index + 2]],
      basis,
    );
    // 投影すると重なる点(作図面の法線に沿って並んでいた点)は落とす。
    if (points.length === 0 || distance2(points[points.length - 1], projected) > POINT_EPSILON) {
      points.push(projected);
    }
  }
  // 閉じた曲線は、最後の点が最初の点と重なる。重複はここで落とす(閉じている印は closed が持つ)。
  while (closed && points.length > 1 && distance2(points[0], points[points.length - 1]) <= POINT_EPSILON) {
    points.pop();
  }
  if (points.length < (closed ? 3 : 2)) {
    return null;
  }
  return { kind: 'polyline', points: preservePrecision ? points : thinPoints(points, MAX_POLYLINE_POINTS), closed };
}

/**
 * 辺 1 本を作図面の上の曲線へ落とす。作図面に潰れて線にならないときは null。
 *
 * - 直線 → 線分(両端を投影するだけ)。
 * - 円で、軸が作図面の法線と平行 → 円弧(中心を投影し、半径と掃き角はそのまま)。
 * - それ以外 → 点列。
 */
export function projectEdgeToPlane(
  oc: OpenCascadeInstance,
  edge: TopoDS_Edge,
  basis: PlaneBasis,
  options: TessellationOptions | undefined,
  allocations: Allocations,
  preservePrecision = false,
  existingAdaptor?: BRepAdaptor_Curve,
): PlaneCurve | null {
  const { keep } = allocations;
  // 既に元辺を読んでいる呼び出し側から借りる場合、その所有者が解放する。
  const adaptor = existingAdaptor ?? keep(new oc.BRepAdaptor_Curve_2(edge));
  const curveType = adaptor.GetType();
  const kinds = oc.GeomAbs_CurveType;
  const first = adaptor.FirstParameter();
  const last = adaptor.LastParameter();
  const startPoint = keep(adaptor.Value(first));
  const endPoint = keep(adaptor.Value(last));
  const start: Vec3Tuple = [startPoint.X(), startPoint.Y(), startPoint.Z()];
  const end: Vec3Tuple = [endPoint.X(), endPoint.Y(), endPoint.Z()];
  const closed = Math.hypot(start[0] - end[0], start[1] - end[1], start[2] - end[2]) <= POINT_EPSILON;

  if (curveType === kinds.GeomAbs_Line) {
    const from = projectPointToPlane(start, basis);
    const to = projectPointToPlane(end, basis);
    // 作図面の法線と平行な線分は、投影すると 1 点に潰れる。
    return distance2(from, to) <= POINT_EPSILON ? null : { kind: 'segment', from, to };
  }

  if (curveType === kinds.GeomAbs_Circle) {
    const circle = keep(adaptor.Circle());
    const axis = keep(circle.Axis());
    const axisDirection = keep(axis.Direction());
    const direction: Vec3Tuple = [axisDirection.X(), axisDirection.Y(), axisDirection.Z()];
    const alignment = dot3(direction, basis.normal);
    if (Math.abs(alignment) >= 1 - PARALLEL_EPSILON) {
      // 円の面と作図面が平行なので、投影しても半径の変わらない円弧のまま残る。
      const position = keep(circle.Position());
      const xDirection = keep(position.XDirection());
      const xAxis: Vec3Tuple = [xDirection.X(), xDirection.Y(), xDirection.Z()];
      // 円のパラメータ 0 の向き(第 1 軸)が、作図面の上で何度にあたるか。
      const baseAngle = Math.atan2(dot3(xAxis, basis.axisV), dot3(xAxis, basis.axisU));
      // 軸が法線と逆向きの円は、パラメータが増えると作図面の上では逆回りに進む。
      const turn = alignment > 0 ? 1 : -1;
      const center = keep(circle.Location());
      const angles = normalizeArcAngles(baseAngle + turn * first, baseAngle + turn * last);
      return {
        kind: 'arc',
        center: projectPointToPlane([center.X(), center.Y(), center.Z()], basis),
        radius: normalizeZero(circle.Radius()),
        startAngle: angles.start,
        endAngle: angles.end,
      };
    }
  }

  return sampleEdgeToPlane(oc, edge, basis, options, closed, preservePrecision);
}

/** 曲線の両端(作図面の上の座標)と、それ自身で閉じているか。 */
function curveEnds(curve: PlaneCurve): { start: Vec2Tuple; end: Vec2Tuple; closed: boolean } {
  if (curve.kind === 'segment') {
    return { start: curve.from, end: curve.to, closed: false };
  }
  if (curve.kind === 'arc') {
    const pointAt = (angle: number): Vec2Tuple => [
      curve.center[0] + curve.radius * Math.cos(angle),
      curve.center[1] + curve.radius * Math.sin(angle),
    ];
    return {
      start: pointAt(curve.startAngle),
      end: pointAt(curve.endAngle),
      closed: Math.abs(curve.endAngle - curve.startAngle) >= TAU - FULL_TURN_EPSILON,
    };
  }
  return {
    start: curve.points[0],
    end: curve.points[curve.points.length - 1],
    closed: curve.closed,
  };
}

/**
 * 曲線の向きを逆にする(たどる順を揃えるため)。
 * 円弧は開始角と終了角を入れ替えるだけでよい(掃き角の符号が反転して逆回りになる)。
 */
function reverseCurve(curve: PlaneCurve): PlaneCurve {
  if (curve.kind === 'segment') {
    return { kind: 'segment', from: curve.to, to: curve.from };
  }
  if (curve.kind === 'arc') {
    const angles = normalizeArcAngles(curve.endAngle, curve.startAngle);
    return {
      kind: 'arc',
      center: curve.center,
      radius: curve.radius,
      startAngle: angles.start,
      endAngle: angles.end,
    };
  }
  return { kind: 'polyline', points: [...curve.points].reverse(), closed: curve.closed };
}

/**
 * 曲線をつながる順に並べ替える(必要なら向きも反転する)。
 *
 * OCCT が返す辺の並びは輪郭をたどる順ではない(実測: 40×30 の断面の 4 本は
 * 左辺 → 上辺 → 下辺 → 右辺の順で返った)。そのままでは面の輪郭として使えないので、
 * 端点が一致するものを順につないで輪ごとにまとめる。つながらない曲線は、
 * もとの並びの順に次の輪の先頭になる。
 */
export function orderPlaneCurves(curves: readonly PlaneCurve[]): readonly PlaneCurve[] {
  const remaining = curves.map((curve) => ({ curve, used: false }));
  const ordered: PlaneCurve[] = [];

  for (const seed of remaining) {
    if (seed.used) {
      continue;
    }
    seed.used = true;
    ordered.push(seed.curve);
    let tail = curveEnds(seed.curve);
    if (tail.closed) {
      continue;
    }

    let extended = true;
    while (extended) {
      extended = false;
      for (const candidate of remaining) {
        if (candidate.used) {
          continue;
        }
        const ends = curveEnds(candidate.curve);
        if (ends.closed) {
          continue;
        }
        const forward = distance2(tail.end, ends.start) <= JOIN_TOLERANCE_MM;
        const backward = distance2(tail.end, ends.end) <= JOIN_TOLERANCE_MM;
        if (!forward && !backward) {
          continue;
        }
        const next = forward ? candidate.curve : reverseCurve(candidate.curve);
        candidate.used = true;
        ordered.push(next);
        tail = curveEnds(next);
        extended = true;
        break;
      }
    }
  }

  return ordered;
}

/** 形の中の辺をすべて集める(TopExp.MapShapes_2 の並び)。 */
function collectEdges(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  allocations: Allocations,
): readonly TopoDS_Edge[] {
  const { keep } = allocations;
  const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  if (shape.ShapeType() === edgeType) {
    return [keep(oc.TopoDS.Edge_1(shape))];
  }

  const subShapes = keep(new oc.TopTools_IndexedMapOfShape_1());
  // 第 3・第 4 引数は「向きと位置を親からたどって積み上げる」指定(subShapes.ts と同じ)。
  oc.TopExp.MapShapes_2(shape, subShapes, true, true);
  const edges: TopoDS_Edge[] = [];
  const count = Number(subShapes.Size());
  for (let position = 1; position <= count; position += 1) {
    const subShape = keep(subShapes.FindKey(position));
    if (subShape.ShapeType() === edgeType) {
      edges.push(keep(oc.TopoDS.Edge_1(subShape)));
    }
  }
  return edges;
}

/** 投影のもとになる辺を選び出す(面は外周だけ、それ以外は含まれる辺すべて)。 */
function collectSourceEdges(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  allocations: Allocations,
): readonly TopoDS_Edge[] {
  const { keep } = allocations;
  if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) {
    const face = keep(oc.TopoDS.Face_1(shape));
    const outer = keep(oc.BRepTools.OuterWire(face));
    return collectEdges(oc, outer, allocations);
  }
  return collectEdges(oc, shape, allocations);
}

/**
 * 立体の面・辺を作図面へ直交投影した曲線を作る(FR-325)。
 *
 * 作図面へ潰れて線にならない辺(法線と平行な辺)は結果から落とす。
 * 1 本も残らなければ理由をつけて断る(FR-504、NFR-RE-1)。
 * **引数の形は解放しない。** 呼び出し側(形状キャッシュ)の持ち物のため。
 */
export function makeProjection(oc: OpenCascadeInstance, spec: ProjectionSpec): PlaneCurves {
  const basis = planeBasisOf(spec.plane);
  const allocations = createAllocations();

  try {
    const edges = collectSourceEdges(oc, spec.source, allocations);
    if (edges.length === 0) {
      throw new Error(NO_EDGE_MESSAGE);
    }
    const curves: PlaneCurve[] = [];
    for (const edge of edges) {
      const curve = projectEdgeToPlane(oc, edge, basis, spec.tessellation, allocations);
      if (curve !== null) {
        curves.push(curve);
      }
    }
    if (curves.length === 0) {
      throw new Error(ALL_DEGENERATE_MESSAGE);
    }
    return { curves: orderPlaneCurves(curves) };
  } finally {
    allocations.release();
  }
}
