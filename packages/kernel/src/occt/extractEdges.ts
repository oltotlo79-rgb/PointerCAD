import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import {
  DEFAULT_ANGULAR_DEFLECTION,
  DEFAULT_LINEAR_DEFLECTION,
  type TessellationOptions,
} from '../types.js';
import { createAllocations } from './allocations.js';

/**
 * 辺 1 本ぶんの線分の位置。positions の線分単位(6 個で 1 本)で数える。
 *
 * 辺 i の線分は positions[segmentOffset * 6] から segmentCount * 6 個ぶん並ぶ。
 * 辺の当たり判定と強調表示がこの範囲を使う。
 */
export interface EdgeSegmentRange {
  readonly segmentOffset: number;
  readonly segmentCount: number;
}

export interface EdgeLines {
  /** 線分1本あたり 6 個(始点 xyz + 終点 xyz)。 */
  readonly positions: Float32Array;
  /** 辺の本数。折れ線が作れなかった辺も 1 本として数える(edgeRanges.length と必ず一致)。 */
  readonly edgeCount: number;
  /**
   * TopExp.MapShapes_2 の順に並ぶ、辺ごとの線分の範囲。
   * 折れ線が作れなかった辺も segmentCount: 0 で必ず 1 つ積む
   * (積まないと通し番号がずれ、subShapes.ts の辺の番号と対応しなくなる)。
   */
  readonly edgeRanges: readonly EdgeSegmentRange[];
}

/**
 * 稜線を折れ線へ分解する(FR-105 のワイヤーフレーム/シェーディング+エッジ表示に使う)。
 *
 * あわせて「辺ごとに線分がどこから何本あるか」の範囲表(edgeRanges)を返す。
 * 並びは下の MapShapes_2 の順で、tessellate の faceRanges と同じく
 * subShapes.ts が数える辺の通し番号と 1 対 1 に対応する。
 *
 * TopExp_Explorer ではなく TopExp.MapShapes_2 を使う理由は2つある。
 * 1. TopExp_Explorer は面ごとに稜線をたどるため、隣り合う2面が共有する稜線を
 *    2回返す(箱なら 12 本が 24 回)。同じ稜線を1本として数えるには重複を
 *    取り除く TopTools_IndexedMapOfShape が要る。
 * 2. opencascade.js の型定義では列挙の各値(TopAbs_EDGE 等)が空の型 `{}` になっており、
 *    列挙を引数に取る TopExp_Explorer.Init は強制変換なしでは型検査を通せない
 *    (詳しくは tessellate.ts の説明)。
 */
export function extractEdges(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  options: TessellationOptions = {},
): EdgeLines {
  const linearDeflection = options.linearDeflection ?? DEFAULT_LINEAR_DEFLECTION;
  const angularDeflection = options.angularDeflection ?? DEFAULT_ANGULAR_DEFLECTION;

  const segments: number[] = [];
  const edgeRanges: EdgeSegmentRange[] = [];

  const shared = createAllocations();

  try {
    // 第3・第4引数は「向きと位置を親からたどって積み上げる」指定で、
    // TopExp_Explorer と同じ結果になる既定値。
    const subShapes = shared.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
    const subShapeCount = subShapes.Size();

    for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
      const subShape = subShapes.FindKey(subShapeIndex);
      if (subShape.ShapeType() !== edgeType) {
        continue;
      }

      // この辺の線分は、いま積み終わっている線分の次から始まる。
      const segmentOffset = segments.length / 6;
      const perEdge = createAllocations();

      try {
        const edge = perEdge.keep(oc.TopoDS.Edge_1(subShape));
        const adaptor = perEdge.keep(new oc.BRepAdaptor_Curve_2(edge));
        const discretizer = perEdge.keep(
          new oc.GCPnts_TangentialDeflection_2(
            adaptor,
            angularDeflection,
            linearDeflection,
            2,
            1.0e-9,
            1.0e-7,
          ),
        );

        // 個数の型 Graphic3d_ZLayerId は型定義のどこにも無いので整数へ直してから使う
        // (tessellate.ts の NbNodes() と同じ理由)。点が 1 つ以下の辺は線分が 0 本になり、
        // 範囲表には 0 本として積まれる。
        const pointCount = Number(discretizer.NbPoints());
        for (let i = 1; i < pointCount; i += 1) {
          const from = discretizer.Value(i);
          const to = discretizer.Value(i + 1);
          segments.push(from.X(), from.Y(), from.Z(), to.X(), to.Y(), to.Z());
          from.delete();
          to.delete();
        }
      } finally {
        perEdge.release();
      }

      edgeRanges.push({
        segmentOffset,
        segmentCount: segments.length / 6 - segmentOffset,
      });
    }
  } finally {
    shared.release();
  }

  return {
    positions: new Float32Array(segments),
    edgeCount: edgeRanges.length,
    edgeRanges,
  };
}
