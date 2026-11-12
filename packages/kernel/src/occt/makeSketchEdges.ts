import type { OpenCascadeInstance, TopoDS_Edge } from 'opencascade.js/dist/opencascade.full.js';

import {
  type ArcSpec,
  type CurveSpec,
  type TessellationOptions,
  type Vec3Tuple,
} from '../types.js';
import { createAllocations } from './allocations.js';
import { makeEllipseEdge } from './makeEllipseEdge.js';
import { makeSplineEdge } from './makeSplineEdge.js';
import { curveSampleCoordinates } from './curveSampleCoordinates.js';
import { localFloat32Coordinates, type MeshCoordinateFrame } from './meshCoordinateFrame.js';

/** OCCT の稜線と、そのために確保した領域の解放手続き。 */
export interface OcctEdgeHandle {
  readonly edge: TopoDS_Edge;
  delete(): void;
}

const FULL_TURN = 2 * Math.PI;
/** 角度の幅がこの値だけ 2π に足りなくても全周とみなす。 */
const FULL_TURN_EPSILON = 1e-9;

/** 2 点を結ぶ稜線を作る(FR-304)。 */
export function makeSegmentEdge(
  oc: OpenCascadeInstance,
  from: Vec3Tuple,
  to: Vec3Tuple,
): OcctEdgeHandle {
  const { keep, release } = createAllocations();
  try {
    const start = keep(new oc.gp_Pnt_3(from[0], from[1], from[2]));
    const end = keep(new oc.gp_Pnt_3(to[0], to[1], to[2]));
    const maker = keep(new oc.BRepBuilderAPI_MakeEdge_3(start, end));
    if (!maker.IsDone()) { throw new Error('線分の稜線を作れませんでした。2 点が重なっている可能性があります。'); }
    const edge = keep(maker.Edge());
    return { edge, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 円弧の稜線を作る(FR-305)。角度の幅が 2π に届いていれば全周の円にする。
 * gp_Ax2 は「中心・法線・第1軸」で向きを決め、角度 0 は第1軸の向きになる。
 * BRepBuilderAPI_MakeEdge_9 の角度は**ラジアン**(2026-09-02 に Node 上で実測。
 * 0 〜 π/2 を渡すと半径 10 の円で終点が (0,10,0) になり、度ではないことを確認した)。
 * 成否の判定に Error() の列挙値を使わないのは、opencascade.js の型定義で列挙の各値が
 * 空の型になっており、比較すると強制変換が要るため(tessellate.ts と同じ理由)。
 */
export function makeArcEdge(oc: OpenCascadeInstance, arc: ArcSpec): OcctEdgeHandle {
  if (!(arc.radius > 0)) {
    throw new Error(`円弧の半径は正の数である必要があります: ${String(arc.radius)}`);
  }
  const { keep, release } = createAllocations();
  try {
    const center = keep(new oc.gp_Pnt_3(arc.center[0], arc.center[1], arc.center[2]));
    const normal = keep(new oc.gp_Dir_4(arc.normal[0], arc.normal[1], arc.normal[2]));
    const xAxis = keep(new oc.gp_Dir_4(arc.xAxis[0], arc.xAxis[1], arc.xAxis[2]));
    const axis = keep(new oc.gp_Ax2_2(center, normal, xAxis));
    const circle = keep(new oc.gp_Circ_2(axis, arc.radius));
    const sweep = Math.abs(arc.endAngle - arc.startAngle);
    const maker = keep(sweep >= FULL_TURN - FULL_TURN_EPSILON
      ? new oc.BRepBuilderAPI_MakeEdge_8(circle)
      : new oc.BRepBuilderAPI_MakeEdge_9(circle, Math.min(arc.startAngle, arc.endAngle), Math.max(arc.startAngle, arc.endAngle)));
    if (!maker.IsDone()) { throw new Error('円弧の稜線を作れませんでした。半径か角度を確かめてください。'); }
    const edge = keep(maker.Edge());
    // Create an ascending interval, then reverse topology for a clockwise arc.
    if (arc.endAngle < arc.startAngle) edge.Reverse();
    return { edge, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 曲線の指定から稜線を作る。楕円(FR-318)とスプライン(FR-317)は、
 * それぞれ専用の作り手へ振り分ける(`CurveSpec` は 4 種)。
 */
export function makeCurveEdge(oc: OpenCascadeInstance, curve: CurveSpec): OcctEdgeHandle {
  switch (curve.kind) {
    case 'segment':
      return makeSegmentEdge(oc, curve.from, curve.to);
    case 'arc':
      return makeArcEdge(oc, curve);
    case 'ellipse':
      return makeEllipseEdge(oc, curve);
    case 'spline':
      return makeSplineEdge(oc, curve);
  }
}

/**
 * 稜線を折れ線へ分解する(表示用)。extractEdges.ts と同じ道具立てを使う。
 * NbPoints() の戻り型 Graphic3d_ZLayerId は型定義に無いので、Number() で整数へ直す。
 */
export function discretizeEdge(
  oc: OpenCascadeInstance,
  edge: TopoDS_Edge,
  options: TessellationOptions = {},
  frame?: MeshCoordinateFrame,
): Float32Array {
  const coordinates = curveSampleCoordinates(oc, edge, options);
  return frame === undefined ? new Float32Array(coordinates) : localFloat32Coordinates(coordinates, frame);
}
