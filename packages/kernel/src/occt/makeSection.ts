/**
 * 立体と作図面の交わり(断面の輪郭)を作る(FR-325、計画書 P4 §2.7・タスク26)。
 *
 * ## 採った API(2026-09-04 に Node 上で実測)
 *
 * `BRepAlgoAPI_Section_5(shape, gp_Pln, PerformNow = true)` を使う。構築した時点で計算が終わり、
 * 進捗の入れ物(`Message_ProgressRange`)も列挙の引数も要らない。実測した振る舞いは次のとおり。
 *
 * - 40×30×10 の箱を z=5 で切る → `IsDone()` true、結果は COMPOUND、直線の辺 4 本。
 * - 半径 10・高さ 20 の円柱を z=10(軸に垂直)で切る → 円の辺 1 本(中心 (0,0,10)・半径 10)。
 * - 交わらない平面(z=50)で切る → **例外にならず** `IsDone()` true・辺 0 本。
 *   「交わりません」と断るのは呼び出し側の役目なので、ここでは空の結果を返す。
 * - 円柱を 45 度傾けた平面で切る → 楕円の辺 3 本(長半径 14.142・短半径 10)。
 *   楕円は線分・円弧に収まらないので点列で返す(makeProjection.ts の落とし方と同じ)。
 *
 * 結果の辺は作図面の上に乗っているので、2 次元への変換は makeProjection.ts の
 * `projectEdgeToPlane`(直交投影)をそのまま使える。投影の距離が 0 なので誤差も入らない。
 *
 * OCCT が返す辺の並びは輪郭をたどる順ではない(実測: 40×30 の断面は
 * 左辺 → 上辺 → 下辺 → 右辺の順)ため、`orderPlaneCurves` でつながる順に並べ替えてから返す。
 */

import type { OpenCascadeInstance, TopoDS_Edge, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { TessellationOptions } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import {
  orderPlaneCurves,
  planeBasisOf,
  projectEdgeToPlane,
  type PlaneCurve,
  type PlaneCurves,
  type SketchPlaneFrame,
} from './makeProjection.js';

/** 交差の依頼。 */
export interface PlaneSectionSpec {
  /** 断面を取る立体(面や殻でもよい)。 */
  readonly target: TopoDS_Shape;
  /** 切る作図面。 */
  readonly plane: SketchPlaneFrame;
  /** 点列へ落とすときの粗さ。省略時は表示と同じ既定値。 */
  readonly tessellation?: TessellationOptions;
  /** 精密出力の弦誤差。指定時はdoubleを保ち、点数を間引かない。 */
  readonly curveToleranceMm?: number;
}

/** 交差そのものが成立しなかったとき(FR-504、NFR-RE-1)。 */
const SECTION_FAILED_MESSAGE =
  '立体と作図面の交わりを求められませんでした。作図面の位置を見直してください。';

/** 結果の形の中の辺をすべて集める。 */
function collectSectionEdges(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  allocations: Allocations,
): readonly TopoDS_Edge[] {
  const { keep } = allocations;
  const subShapes = keep(new oc.TopTools_IndexedMapOfShape_1());
  // 第 3・第 4 引数は「向きと位置を親からたどって積み上げる」指定(subShapes.ts と同じ)。
  oc.TopExp.MapShapes_2(shape, subShapes, true, true);
  const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
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

/**
 * 立体と作図面の交線(断面の輪郭)を作る(FR-325)。
 *
 * 交わらないときは**エラーにせず空の結果**を返す(「交わりません」と伝えるのは呼び出し側)。
 * **引数の形は解放しない。** 呼び出し側(形状キャッシュ)の持ち物のため。
 *
 * 成否は `HasErrors()` と `IsDone()` だけで見る。`Error()` の戻り値は型定義で空の型 `{}` に
 * なっており、比較に強制変換が要るため使わない(booleanOp.ts と同じ理由)。
 */
export function makeSection(oc: OpenCascadeInstance, spec: PlaneSectionSpec): PlaneCurves {
  const tolerance = spec.curveToleranceMm;
  if (tolerance !== undefined && (!Number.isFinite(tolerance) || tolerance < 1e-7)) throw new Error('断面の出力精度は1e-7mm以上の有限値を指定してください。');
  // 断面曲線自体のOCCT近似にも誤差があるため、弦近似へ全予算を使わない。
  const options = tolerance === undefined ? spec.tessellation : { ...spec.tessellation, linearDeflection: tolerance / 2 };
  const basis = planeBasisOf(spec.plane);
  const allocations = createAllocations();
  const { keep, release } = allocations;

  try {
    const origin = keep(new oc.gp_Pnt_3(basis.origin[0], basis.origin[1], basis.origin[2]));
    const normal = keep(new oc.gp_Dir_4(basis.normal[0], basis.normal[1], basis.normal[2]));
    const plane = keep(new oc.gp_Pln_3(origin, normal));

    const maker = keep(new oc.BRepAlgoAPI_Section_5(spec.target, plane, true));
    if (maker.HasErrors() || !maker.IsDone()) {
      throw new Error(SECTION_FAILED_MESSAGE);
    }

    const shape = keep(maker.Shape());
    const curves: PlaneCurve[] = [];
    for (const edge of collectSectionEdges(oc, shape, allocations)) {
      const curve = projectEdgeToPlane(oc, edge, basis, options, allocations, tolerance !== undefined);
      if (curve !== null) {
        curves.push(curve);
      }
    }
    return { curves: orderPlaneCurves(curves) };
  } finally {
    release();
  }
}
