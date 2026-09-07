import type {
  Handle_Poly_Triangulation,
  OpenCascadeInstance,
  Poly_Triangulation,
  TColgp_Array1OfDir,
  TopLoc_Location,
  TopoDS_Face,
  TopoDS_Shape,
  gp_Trsf,
} from 'opencascade.js/dist/opencascade.full.js';

import {
  DEFAULT_ANGULAR_DEFLECTION,
  DEFAULT_LINEAR_DEFLECTION,
  type TessellationOptions,
} from '../types.js';
import type { Allocations } from './allocations.js';
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
  /** 三角形が 0 枚だった面の数。退化面かどうかを面積で選別せず、欠けを過小報告しない。 */
  readonly missingTriangulationFaces: number;
  /** `BRepMesh_IncrementalMesh.IsDone()`。メッシャーが処理を完了したかを表す。 */
  readonly mesherDone: boolean;
  /** `BRepMesh_IncrementalMesh.GetStatusFlags()` の数値。0 は報告された異常なし。 */
  readonly mesherStatus: number;
  /**
   * TopExp.MapShapes_2 の順に並ぶ、面ごとの三角形の範囲。
   * 三角形分割が付かなかった面も triangleCount: 0 で必ず 1 つ積む
   * (積まないと通し番号がずれ、subShapes.ts の面の番号と対応しなくなる)。
   */
  readonly faceRanges: readonly FaceTriangleRange[];
}

/**
 * 面に付いた位置(`TopLoc_Location`)を、節点と法線へどう掛けるか。
 *
 * ## なぜ位置ごとに 1 回だけ決めるのか(P6 タスク11b、2026-09-06 実測)
 *
 * 元の走査は節点 1 個につき `Node(i)` → `Transformed(transformation)` → `X()/Y()/Z()`
 * → `delete()` × 2 と、embind をまたぐ呼び出しを 7 回していた。`Transformed` は
 * OCCT 側に `gp_Pnt` をもう 1 つ確保して JS の包みを作るので、**節点あたり 2 つの
 * 確保と 2 つの解放**が要る。法線(`gp_Dir`)も同じだった。10 万三角形(球 103 個・
 * 偏差 0.1)の走査は 3 回測って 454 / 410 / 411 ms、内訳は節点 108 / 法線 176 /
 * 添字 118 ms。**確保と解放が走査の主費用**である。
 *
 * そこで位置の中身(`gp_Trsf` の 12 成分)を**面 1 枚につき 1 回だけ**読み出し、
 * 節点ごとの掛け算は JS の double で行う。同じ形の走査は 335 / 322 / 318 ms になり、
 * **走査が 4 分の 3 以下に縮む**(前後の実測は `tessellate.test.ts` が毎回記録する)。
 * 添字の分も縮むのは、確保が減って回収の負担が下がるためで、添字の処理は変えていない。
 *
 * 採らなかった手も残しておく。①`Poly_Triangulation.MapNodeArray()` と
 * `InternalNodes()` で節点をまとめて取り出す道は、opencascade.js が中身の型
 * (`TColgp_HArray1OfPnt` / `NCollection_AliasedArray`)を結んでいないため
 * **呼ぶと例外**になる(2026-09-06 実測)。②出力を `number[]` ではなく先に数えた
 * 長さの `Float32Array` へ直接書く道は、同じ形で 297 / 285 / 291 ms と 2〜5% しか
 * 変わらず、面を 2 度走査する複雑さに見合わないので採らない。
 *
 * ## 出力を 1 ビットも変えないための場合分け
 *
 * `gp_Pnt::Transform` と `gp_Dir::Transform` は `gp_Trsf` の種別(`Form()`)で
 * 計算の道を変える。ここでも**同じ種別ごとに同じ順序の演算**を書く。
 *
 * - `keep` … 位置が恒等。OCCT も何もしないので、節点の値をそのまま読む。
 * - `translate` … 平行移動だけ。OCCT は座標に移動量を足すだけで、法線は動かさない。
 * - `rigid` … 回転を含む剛体移動。OCCT は「行列を掛ける → 拡大率が 1 なら飛ばす →
 *   移動量を足す」の順に計算する(`gp_Trsf::Transforms`)。法線は行列を掛けてから
 *   長さ `sqrt(x²+y²+z²)` で割り直す(`gp_Dir::Transform` の既定の道)。
 * - `occt` … 上のどれでもないとき。`Transformed` をそのまま呼ぶ。
 *   `TopLoc_Datum3D` は拡大・反転した変換を受け付けないので実際には起きないが、
 *   起きたときに数値がずれるより OCCT に任せるほうが安全である。
 *
 * 12 成分を `gp_Trsf.Value(row, col)` から読むのは、`Value` が列 1〜3 で
 * `拡大率 × 行列` を、列 4 で移動量を返すためで、**拡大率が 1 のときだけ**
 * この読み方が行列そのものと一致する(`rigid` に入る条件に拡大率 1 を入れてある)。
 */
type NodePlacement =
  | { readonly kind: 'keep' }
  | { readonly kind: 'translate'; readonly tx: number; readonly ty: number; readonly tz: number }
  | {
      readonly kind: 'rigid';
      readonly a11: number;
      readonly a12: number;
      readonly a13: number;
      readonly a14: number;
      readonly a21: number;
      readonly a22: number;
      readonly a23: number;
      readonly a24: number;
      readonly a31: number;
      readonly a32: number;
      readonly a33: number;
      readonly a34: number;
    }
  | { readonly kind: 'occt'; readonly transformation: gp_Trsf };

/** 位置が恒等のときの手。作り直す必要が無いので 1 つを使い回す。 */
const KEEP_PLACEMENT: NodePlacement = { kind: 'keep' };

/**
 * 面に付いた位置から、節点と法線を動かす手を 1 つ決める。
 *
 * `location.Transformation()` は OCCT 側に `gp_Trsf` を確保するので、恒等でないときだけ
 * 呼んで控え(`keep`)へ積む。`occt` の手を返したときは、その `gp_Trsf` を節点ごとに
 * 使い続けるので、面の走査が終わるまで解放してはならない(控えが面の最後に解放する)。
 */
function readNodePlacement(
  oc: OpenCascadeInstance,
  location: TopLoc_Location,
  keep: Allocations['keep'],
): NodePlacement {
  if (location.IsIdentity()) {
    return KEEP_PLACEMENT;
  }

  const transformation = keep(location.Transformation());
  const form = transformation.Form();
  const forms = oc.gp_TrsfForm;
  if (form === forms.gp_Identity) {
    return KEEP_PLACEMENT;
  }
  // 拡大率が 1 でないと、gp_Pnt も gp_Dir も別の道(拡大・反転)を通るうえ、
  // Value(row, col) が行列そのものを返さなくなる。まとめて OCCT に任せる。
  if (transformation.ScaleFactor() !== 1) {
    return { kind: 'occt', transformation };
  }
  if (form === forms.gp_Translation) {
    return {
      kind: 'translate',
      tx: transformation.Value(1, 4),
      ty: transformation.Value(2, 4),
      tz: transformation.Value(3, 4),
    };
  }
  return {
    kind: 'rigid',
    a11: transformation.Value(1, 1),
    a12: transformation.Value(1, 2),
    a13: transformation.Value(1, 3),
    a14: transformation.Value(1, 4),
    a21: transformation.Value(2, 1),
    a22: transformation.Value(2, 2),
    a23: transformation.Value(2, 3),
    a24: transformation.Value(2, 4),
    a31: transformation.Value(3, 1),
    a32: transformation.Value(3, 2),
    a33: transformation.Value(3, 3),
    a34: transformation.Value(3, 4),
  };
}

/**
 * 面 1 枚ぶんの節点を動かして位置のバッファへ積む(`gp_Pnt::Transform` と同じ順序の演算)。
 *
 * **場合分けは繰り返しの外に 1 回だけ置き、手ごとに専用の繰り返しを書く。**
 * 節点ごとに `placement` の中身を読むと、面によって形の違う 4 種類の入れ物を
 * 同じ場所から読むことになり、JavaScript の実行時が読み出しを最適化できない。
 * 10 万三角形では読み出しが 30 万回を超えるので、ここは短さより速さを採る。
 */
function appendPlacedNodes(
  placement: NodePlacement,
  triangulation: Poly_Triangulation,
  nodeCount: number,
  positions: number[],
): void {
  switch (placement.kind) {
    case 'keep':
      for (let i = 1; i <= nodeCount; i += 1) {
        const node = triangulation.Node(i);
        positions.push(node.X(), node.Y(), node.Z());
        node.delete();
      }
      return;
    case 'translate': {
      const { tx, ty, tz } = placement;
      for (let i = 1; i <= nodeCount; i += 1) {
        const node = triangulation.Node(i);
        positions.push(node.X() + tx, node.Y() + ty, node.Z() + tz);
        node.delete();
      }
      return;
    }
    case 'rigid': {
      const { a11, a12, a13, a14, a21, a22, a23, a24, a31, a32, a33, a34 } = placement;
      for (let i = 1; i <= nodeCount; i += 1) {
        const node = triangulation.Node(i);
        const x = node.X();
        const y = node.Y();
        const z = node.Z();
        node.delete();
        positions.push(
          a11 * x + a12 * y + a13 * z + a14,
          a21 * x + a22 * y + a23 * z + a24,
          a31 * x + a32 * y + a33 * z + a34,
        );
      }
      return;
    }
    case 'occt': {
      const { transformation } = placement;
      for (let i = 1; i <= nodeCount; i += 1) {
        const node = triangulation.Node(i);
        const moved = node.Transformed(transformation);
        positions.push(moved.X(), moved.Y(), moved.Z());
        node.delete();
        moved.delete();
      }
      return;
    }
  }
}

/**
 * 面 1 枚ぶんの法線を動かして法線のバッファへ積む(`gp_Dir::Transform` と同じ順序の演算)。
 *
 * 平行移動は向きを変えないので `keep` と同じ扱いにする。回転では行列を掛けたあと
 * 長さ `sqrt(x²+y²+z²)` で割り直す——単位ベクトルに回転行列を掛ければ長さは 1 の
 * はずだが、OCCT が割っているので**同じ丸めを踏むために同じ割り算をする**。
 */
function appendPlacedNormals(
  placement: NodePlacement,
  nodeNormals: TColgp_Array1OfDir,
  normals: number[],
): void {
  const lower = nodeNormals.Lower();
  const upper = nodeNormals.Upper();
  switch (placement.kind) {
    case 'keep':
    case 'translate':
      for (let i = lower; i <= upper; i += 1) {
        const direction = nodeNormals.Value(i);
        normals.push(direction.X(), direction.Y(), direction.Z());
        direction.delete();
      }
      return;
    case 'rigid': {
      const { a11, a12, a13, a21, a22, a23, a31, a32, a33 } = placement;
      for (let i = lower; i <= upper; i += 1) {
        const direction = nodeNormals.Value(i);
        const x = direction.X();
        const y = direction.Y();
        const z = direction.Z();
        direction.delete();
        const nx = a11 * x + a12 * y + a13 * z;
        const ny = a21 * x + a22 * y + a23 * z;
        const nz = a31 * x + a32 * y + a33 * z;
        const modulus = Math.sqrt(nx * nx + ny * ny + nz * nz);
        normals.push(nx / modulus, ny / modulus, nz / modulus);
      }
      return;
    }
    case 'occt': {
      const { transformation } = placement;
      for (let i = lower; i <= upper; i += 1) {
        const direction = nodeNormals.Value(i);
        const moved = direction.Transformed(transformation);
        normals.push(moved.X(), moved.Y(), moved.Z());
        direction.delete();
        moved.delete();
      }
      return;
    }
  }
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
    const placement = readNodePlacement(oc, location, keep);

    appendPlacedNodes(placement, triangulation, nodeCount, positions);

    const polyConnect = keep(new oc.Poly_Connect_2(triangulationHandle));
    const nodeNormals = keep(new oc.TColgp_Array1OfDir_2(1, nodeCount));
    oc.StdPrs_ToolTriangulatedShape.Normal(face, polyConnect, nodeNormals);
    appendPlacedNormals(placement, nodeNormals, normals);

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
  let missingTriangulationFaces = 0;
  let mesherDone: boolean;
  let mesherStatus: number;

  const shared = createAllocations();

  try {
    const mesher = shared.keep(
      new oc.BRepMesh_IncrementalMesh_2(shape, linearDeflection, false, angularDeflection, false),
    );
    mesherDone = mesher.IsDone();
    // opencascade.js は戻り値を未定義の Graphic3d_ZLayerId と束縛しているため、
    // 実体である整数へ実行時変換してから外へ返す。
    mesherStatus = Number(mesher.GetStatusFlags());

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

      const faceTriangleCount = indices.length / 3 - triangleOffset;
      if (faceTriangleCount === 0) {
        missingTriangulationFaces += 1;
      }
      faceRanges.push({
        triangleOffset,
        triangleCount: faceTriangleCount,
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
    missingTriangulationFaces,
    mesherDone,
    mesherStatus,
    faceRanges,
  };
}
