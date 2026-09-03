import type {
  Handle_Poly_Triangulation,
  OpenCascadeInstance,
  TopLoc_Location,
  TopoDS_Face,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import {
  DEFAULT_ANGULAR_DEFLECTION,
  DEFAULT_LINEAR_DEFLECTION,
  type TessellationOptions,
} from '../types.js';
import { createAllocations } from './allocations.js';

/**
 * 面 1 枚ぶんの三角形の位置。indices の三角形単位(3 個で 1 枚)で数える。
 *
 * 面 i の三角形は indices[triangleOffset * 3] から triangleCount * 3 個ぶん並ぶ。
 * 当たり判定(クリックした三角形から面を引く)と強調表示(面の三角形だけを取り出す)
 * の両方がこの範囲を使う。
 */
export interface FaceTriangleRange {
  readonly triangleOffset: number;
  readonly triangleCount: number;
}

export interface SurfaceMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
  /** 面の枚数。三角形分割が付かなかった面も 1 枚として数える(faceRanges.length と必ず一致)。 */
  readonly faceCount: number;
  /**
   * TopExp.MapShapes_2 の順に並ぶ、面ごとの三角形の範囲。
   * 三角形分割が付かなかった面も triangleCount: 0 で必ず 1 つ積む
   * (積まないと通し番号がずれ、subShapes.ts の面の番号と対応しなくなる)。
   */
  readonly faceRanges: readonly FaceTriangleRange[];
}

/**
 * 三角形分割が付いている面 1 枚を、共有のバッファへ積む。
 *
 * 確保したものはこの関数の中で作った順の逆に解放する。呼び出し側が持っている
 * face / location / triangulationHandle は、この関数が返ったあとで解放されるので、
 * 全体としても「作った順の逆」が保たれる。
 */
function appendFaceMesh(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  triangulationHandle: Handle_Poly_Triangulation,
  location: TopLoc_Location,
  positions: number[],
  normals: number[],
  indices: number[],
): void {
  const { keep, release } = createAllocations();

  try {
    const triangulation = triangulationHandle.get();
    // opencascade.js の型定義は個数の型を Graphic3d_ZLayerId と書きながら、その名前を
    // どこにも定義していない。型が付かない値のまま使うと下流で型が崩れるため、
    // 実体である整数へ明示的に直してから使う(強制変換ではなく実行時の変換)。
    const nodeCount = Number(triangulation.NbNodes());
    const nodeOffset = positions.length / 3;
    const transformation = keep(location.Transformation());

    for (let i = 1; i <= nodeCount; i += 1) {
      const node = triangulation.Node(i);
      const moved = node.Transformed(transformation);
      positions.push(moved.X(), moved.Y(), moved.Z());
      node.delete();
      moved.delete();
    }

    const polyConnect = keep(new oc.Poly_Connect_2(triangulationHandle));
    const nodeNormals = keep(new oc.TColgp_Array1OfDir_2(1, nodeCount));
    oc.StdPrs_ToolTriangulatedShape.Normal(face, polyConnect, nodeNormals);
    for (let i = nodeNormals.Lower(); i <= nodeNormals.Upper(); i += 1) {
      const direction = nodeNormals.Value(i);
      const moved = direction.Transformed(transformation);
      normals.push(moved.X(), moved.Y(), moved.Z());
      direction.delete();
      moved.delete();
    }

    // 面の向きが反転している場合は、三角形の頂点順を入れ替えて表を外向きに揃える。
    const reversed = face.Orientation_1() !== oc.TopAbs_Orientation.TopAbs_FORWARD;
    const triangles = keep(triangulation.Triangles());
    const triangleCount = Number(triangulation.NbTriangles());
    for (let i = 1; i <= triangleCount; i += 1) {
      const triangle = triangles.Value(i);
      const a = nodeOffset + triangle.Value(1) - 1;
      const b = nodeOffset + triangle.Value(2) - 1;
      const c = nodeOffset + triangle.Value(3) - 1;
      if (reversed) {
        indices.push(b, a, c);
      } else {
        indices.push(a, b, c);
      }
      triangle.delete();
    }
  } finally {
    release();
  }
}

/**
 * 形状の全ての面を三角形メッシュへ変換し、1つのバッファへまとめる。
 * OCCT の配列は 1 始まり、three.js の頂点番号は 0 始まりなので変換時に 1 を引く。
 *
 * あわせて「面ごとに三角形がどこから何枚あるか」の範囲表(faceRanges)を返す。
 * 並びは下の MapShapes_2 の順で、subShapes.ts が数える面の通し番号と 1 対 1 に対応する。
 * この対応が加工フィーチャー(穴・ねじ・面取り)の面の指定の土台になるので、
 * **三角形分割が付かなかった面も飛ばさずに 0 枚で積む**。
 *
 * 面の取り出しに TopExp_Explorer を使わず TopExp.MapShapes_2 を使う理由:
 * opencascade.js が配る型定義では列挙の各値(TopAbs_FACE 等)が空の型 `{}` になっており、
 * `TopExp_Explorer.Init(S, ToFind, ToAvoid)` の引数型 `TopAbs_ShapeEnum`(9個の値を
 * まとめた入れ物の型)へ渡すと型検査が通らない。強制変換を使わずに済ませるため、
 * 列挙を引数に取らない MapShapes_2 で部分形状を集め、値どうしの比較で面を選ぶ。
 * 比較で判別できるのは、列挙の値が実行時に同一のオブジェクトになるためで、
 * 面の向きを調べる Orientation_1() の比較と同じ仕組みである。
 */
export function tessellate(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  options: TessellationOptions = {},
): SurfaceMesh {
  const linearDeflection = options.linearDeflection ?? DEFAULT_LINEAR_DEFLECTION;
  const angularDeflection = options.angularDeflection ?? DEFAULT_ANGULAR_DEFLECTION;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: FaceTriangleRange[] = [];

  const shared = createAllocations();

  try {
    shared.keep(
      new oc.BRepMesh_IncrementalMesh_2(shape, linearDeflection, false, angularDeflection, false),
    );

    // 第3・第4引数は「向きと位置を親からたどって積み上げる」指定で、
    // TopExp_Explorer と同じ結果になる既定値。
    const subShapes = shared.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
    const subShapeCount = subShapes.Size();

    for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
      const subShape = subShapes.FindKey(subShapeIndex);
      if (subShape.ShapeType() !== faceType) {
        continue;
      }

      // この面の三角形は、いま積み終わっている三角形の次から始まる。
      const triangleOffset = indices.length / 3;
      const perFace = createAllocations();

      try {
        const face = perFace.keep(oc.TopoDS.Face_1(subShape));
        const location = perFace.keep(new oc.TopLoc_Location_1());
        const triangulationHandle = perFace.keep(oc.BRep_Tool.Triangulation(face, location, 0));

        // 三角形分割が付かなかった面(細すぎる面など)は三角形を 1 枚も積まないが、
        // 範囲表には 0 枚として積む(下の push)。飛ばすと以降の面の通し番号がずれる。
        if (!triangulationHandle.IsNull()) {
          appendFaceMesh(oc, face, triangulationHandle, location, positions, normals, indices);
        }
      } finally {
        perFace.release();
      }

      faceRanges.push({
        triangleOffset,
        triangleCount: indices.length / 3 - triangleOffset,
      });
    }
  } finally {
    shared.release();
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    triangleCount: indices.length / 3,
    faceCount: faceRanges.length,
    faceRanges,
  };
}
