import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import {
  DEFAULT_ANGULAR_DEFLECTION,
  DEFAULT_LINEAR_DEFLECTION,
  type TessellationOptions,
} from '../types.js';

export interface SurfaceMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
  readonly faceCount: number;
}

/**
 * 形状の全ての面を三角形メッシュへ変換し、1つのバッファへまとめる。
 * OCCT の配列は 1 始まり、three.js の頂点番号は 0 始まりなので変換時に 1 を引く。
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
  let faceCount = 0;

  const incrementalMesh = new oc.BRepMesh_IncrementalMesh_2(
    shape,
    linearDeflection,
    false,
    angularDeflection,
    false,
  );

  // 第3・第4引数は「向きと位置を親からたどって積み上げる」指定で、
  // TopExp_Explorer と同じ結果になる既定値。
  const subShapes = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_2(shape, subShapes, true, true);
  const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const subShapeCount = subShapes.Size();

  for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
    const subShape = subShapes.FindKey(subShapeIndex);
    if (subShape.ShapeType() !== faceType) {
      continue;
    }

    const face = oc.TopoDS.Face_1(subShape);
    const location = new oc.TopLoc_Location_1();
    const triangulationHandle = oc.BRep_Tool.Triangulation(face, location, 0);

    if (triangulationHandle.IsNull()) {
      triangulationHandle.delete();
      location.delete();
      face.delete();
      continue;
    }

    const triangulation = triangulationHandle.get();
    // opencascade.js の型定義は個数の型を Graphic3d_ZLayerId と書きながら、その名前を
    // どこにも定義していない。型が付かない値のまま使うと下流で型が崩れるため、
    // 実体である整数へ明示的に直してから使う(強制変換ではなく実行時の変換)。
    const nodeCount = Number(triangulation.NbNodes());
    const nodeOffset = positions.length / 3;
    const transformation = location.Transformation();

    for (let i = 1; i <= nodeCount; i += 1) {
      const node = triangulation.Node(i);
      const moved = node.Transformed(transformation);
      positions.push(moved.X(), moved.Y(), moved.Z());
      node.delete();
      moved.delete();
    }

    const polyConnect = new oc.Poly_Connect_2(triangulationHandle);
    const nodeNormals = new oc.TColgp_Array1OfDir_2(1, nodeCount);
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
    const triangles = triangulation.Triangles();
    for (let i = 1; i <= triangulation.NbTriangles(); i += 1) {
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

    triangles.delete();
    nodeNormals.delete();
    polyConnect.delete();
    transformation.delete();
    triangulationHandle.delete();
    location.delete();
    face.delete();
    faceCount += 1;
  }

  subShapes.delete();
  incrementalMesh.delete();

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    triangleCount: indices.length / 3,
    faceCount,
  };
}
