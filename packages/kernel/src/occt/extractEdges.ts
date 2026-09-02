import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import {
  DEFAULT_ANGULAR_DEFLECTION,
  DEFAULT_LINEAR_DEFLECTION,
  type TessellationOptions,
} from '../types.js';

export interface EdgeLines {
  /** 線分1本あたり 6 個(始点 xyz + 終点 xyz)。 */
  readonly positions: Float32Array;
  readonly edgeCount: number;
}

/**
 * 稜線を折れ線へ分解する(FR-105 のワイヤーフレーム/シェーディング+エッジ表示に使う)。
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
  let edgeCount = 0;

  // 第3・第4引数は「向きと位置を親からたどって積み上げる」指定で、
  // TopExp_Explorer と同じ結果になる既定値。
  const subShapes = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_2(shape, subShapes, true, true);
  const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const subShapeCount = subShapes.Size();

  for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
    const subShape = subShapes.FindKey(subShapeIndex);
    if (subShape.ShapeType() !== edgeType) {
      continue;
    }

    const edge = oc.TopoDS.Edge_1(subShape);
    const adaptor = new oc.BRepAdaptor_Curve_2(edge);
    const discretizer = new oc.GCPnts_TangentialDeflection_2(
      adaptor,
      angularDeflection,
      linearDeflection,
      2,
      1.0e-9,
      1.0e-7,
    );

    for (let i = 1; i < discretizer.NbPoints(); i += 1) {
      const from = discretizer.Value(i);
      const to = discretizer.Value(i + 1);
      segments.push(from.X(), from.Y(), from.Z(), to.X(), to.Y(), to.Z());
      from.delete();
      to.delete();
    }

    discretizer.delete();
    adaptor.delete();
    edge.delete();
    edgeCount += 1;
  }
  subShapes.delete();

  return { positions: new Float32Array(segments), edgeCount };
}
