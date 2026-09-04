import type { OpenCascadeInstance, TopoDS_Edge } from 'opencascade.js/dist/opencascade.full.js';

import {
  DEFAULT_ANGULAR_DEFLECTION,
  DEFAULT_LINEAR_DEFLECTION,
  type ArcSpec,
  type CurveSpec,
  type TessellationOptions,
  type Vec3Tuple,
} from '../types.js';
import { makeEllipseEdge } from './makeEllipseEdge.js';
import { makeSplineEdge } from './makeSplineEdge.js';

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
  const start = new oc.gp_Pnt_3(from[0], from[1], from[2]);
  const end = new oc.gp_Pnt_3(to[0], to[1], to[2]);
  const maker = new oc.BRepBuilderAPI_MakeEdge_3(start, end);
  if (!maker.IsDone()) {
    maker.delete();
    end.delete();
    start.delete();
    throw new Error('線分の稜線を作れませんでした。2 点が重なっている可能性があります。');
  }
  const edge = maker.Edge();
  return {
    edge,
    delete(): void {
      edge.delete();
      maker.delete();
      end.delete();
      start.delete();
    },
  };
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
  const center = new oc.gp_Pnt_3(arc.center[0], arc.center[1], arc.center[2]);
  const normal = new oc.gp_Dir_4(arc.normal[0], arc.normal[1], arc.normal[2]);
  const xAxis = new oc.gp_Dir_4(arc.xAxis[0], arc.xAxis[1], arc.xAxis[2]);
  const axis = new oc.gp_Ax2_2(center, normal, xAxis);
  const circle = new oc.gp_Circ_2(axis, arc.radius);

  const sweep = Math.abs(arc.endAngle - arc.startAngle);
  const maker =
    sweep >= FULL_TURN - FULL_TURN_EPSILON
      ? new oc.BRepBuilderAPI_MakeEdge_8(circle)
      : new oc.BRepBuilderAPI_MakeEdge_9(circle, arc.startAngle, arc.endAngle);

  const cleanup = (): void => {
    maker.delete();
    circle.delete();
    axis.delete();
    xAxis.delete();
    normal.delete();
    center.delete();
  };

  if (!maker.IsDone()) {
    cleanup();
    throw new Error('円弧の稜線を作れませんでした。半径か角度を確かめてください。');
  }
  const edge = maker.Edge();
  return {
    edge,
    delete(): void {
      edge.delete();
      cleanup();
    },
  };
}

/**
 * 曲線の指定から稜線を作る。楕円(FR-318)とスプライン(FR-317)は、
 * それぞれ専用の作り手へ振り分ける(P4 タスク5 で `CurveSpec` を 4 種へ広げた)。
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
): Float32Array {
  const linearDeflection = options.linearDeflection ?? DEFAULT_LINEAR_DEFLECTION;
  const angularDeflection = options.angularDeflection ?? DEFAULT_ANGULAR_DEFLECTION;

  const adaptor = new oc.BRepAdaptor_Curve_2(edge);
  const discretizer = new oc.GCPnts_TangentialDeflection_2(
    adaptor,
    angularDeflection,
    linearDeflection,
    2,
    1.0e-9,
    1.0e-7,
  );

  const values: number[] = [];
  const count = Number(discretizer.NbPoints());
  for (let index = 1; index <= count; index += 1) {
    const point = discretizer.Value(index);
    values.push(point.X(), point.Y(), point.Z());
    point.delete();
  }

  discretizer.delete();
  adaptor.delete();
  return new Float32Array(values);
}
