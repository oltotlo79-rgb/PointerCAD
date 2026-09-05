import type {
  Handle_Poly_Triangulation,
  OpenCascadeInstance,
  TopLoc_Location,
  TopoDS_Face,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { ImportedMeshData } from './readStl.js';
import { withVirtualFileInput } from './virtualFile.js';

/**
 * OBJ / glTF の読み込み(計画書 P6 §2.8、タスク18。FR-802 / FR-809)。
 *
 * **`RWObj_CafReader` / `RWGltf_CafReader` を使う**(§0.a-0.26)。どちらも親の
 * `RWMesh_CafReader` が持つ `Perform(theFile, theProgress)` と `SingleShape()` だけで
 * 読めるので、**列挙を 1 つも取らない**(述語ガードを増やさない)。
 *
 * **読んだ三角形は B-rep へ戻さない**(§0.a-0.23)。返すのは STL の読み込み(タスク17)と
 * **同じ `ImportedMeshData`**(位置・法線・添字・三角形数・体積)で、`tessellate.ts` の
 * `SurfaceMesh` と同じ並びに揃えてある。
 *
 * ---
 *
 * **実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984。計画書 §1.5-1、-12、-7):**
 *
 * - `oc.RWObj_CafReader` / `oc.RWGltf_CafReader` / `oc.RWMesh_CafReader` は実行時に関数
 *   (`.test.ts` の 1 件目が毎回確かめる)。`RWObj_CafWriter` / `RWGltf_CafWriter` も同様に
 *   実在する(書き出しはタスク13 の担当)。
 * - **§1.5-12 の答え: `SetDocument` を呼ばずに `Perform` は成功する。** 文書を渡さない
 *   まま `Perform` が `true` を返し、`SingleShape()` が中身のある形を返した。
 *   **XCAF の文書(タスク7)は読み込みには要らない。**
 * - **⚠️ `Perform` の第 1 引数に JavaScript の文字列を渡すと落ちる。** 型定義の
 *   `XCAFDoc_PartId` は宣言が無く `any` に解けるが(§1.4-1)、実行時の束縛は
 *   `TCollection_AsciiString` で、素の文字列を渡すと
 *   `BindingError: Cannot pass "/pointercad/1-probe.obj" as a TCollection_AsciiString` に
 *   なる。**`new oc.TCollection_AsciiString_2(path)` に包んで渡す**(STEP の
 *   `STEPCAFControl_Reader.Perform_2` は `Standard_CString` なので素の文字列でよかった。
 *   **口ごとに違う**ので、型定義ではなく実行時の挙動で決める)。
 * - **読んだ形には三角形分割が最初から付いている**(手順 2 の実測)。20³ の箱の OBJ を
 *   読むと面 1 枚・節点 8・三角形 12 で、`BRep_Tool.Triangulation` が空でない Handle を
 *   返した。**`BRepMesh_IncrementalMesh` は掛けない**——面には幾何(曲面)が無いので
 *   掛けても意味が無く、掛ける道は付いている三角形を捨てる危険がある。
 * - **法線はファイルに書いてあれば残る。** `vn` の無い OBJ と、`NORMAL` を持たない glb は
 *   `HasNormals()` が false になる。**`vn` を書いた OBJ は `HasNormals()` が true** になり、
 *   このとき OCCT は**節点を分ける**(20³ の箱で節点 8 → 36、三角形は 12 のまま)ので、
 *   面ごとに違う向きが正しく入る(`Normal_1(1)` は底面の `(0, 0, -1)`)。
 *   → **ある面はファイルの法線を使い、無い面だけ三角形から計算する**(下の
 *   `computeVertexNormals`)。面ごとに節点の範囲が重ならないので、混ざっていても
 *   互いに影響しない。
 * - **§1.5-7 の答え(読み込み側): `SetSystemLengthUnit(0.001)` で mm になる。** 一辺
 *   0.02(m)の箱の glb を読むと、既定(`SystemLengthUnit()` が `-1`)では 0.02 のまま、
 *   `0.001` を渡すと**ちょうど 20**、`1000` を渡すと 0.00002 になった。つまり倍率は
 *   `FileLengthUnit / SystemLengthUnit` で掛かる。glb の `FileLengthUnit()` は読む前から
 *   `1`(= 1m。glTF の仕様どおり)なので、**0.001 を渡すと 1000 倍**になる。
 *   **自分で 1000 倍しない**——OCCT が節点を作る前に倍率を掛けるため、float32 への
 *   丸めが 1 度で済み、0.02 の箱がちょうど 20.0 になる(自分で掛けると
 *   19.999999552965164 になる)。
 * - **OBJ は単位を持たない**(`FileLengthUnit()` も `SystemLengthUnit()` も `-1`)ので、
 *   **何も設定しない**(倍率が掛からず、ファイルの数がそのまま mm になる)。取り込みの
 *   単位を利用者に訊くのは model / ui の仕事(§0.a-0.6)。
 * - **座標系は変換されない。** `HasSystemCoordinateSystem()` は最初から false で、
 *   glb の `HasFileCoordinateSystem()` は true(glTF は Y 上)だが、**受け手側の座標系を
 *   設定しない限り回転は掛からない**(実測で箱の軸がそのまま入った)。受け手側を決める
 *   `SetSystemCoordinateSystem_2` は列挙 `RWMesh_CoordinateSystem` を取るが、**呼ばない
 *   ので述語ガードは増えない**(§4 の上限に触れない)。
 * - **壊れた glb は `Perform` が false を返す**(例外は飛ばず、OCCT が
 *   `defines invalid JSON document!` を出力へ書くだけ)。→ 断りは戻り値で判定する。
 * - **形の入っていない OBJ(面が 1 つも無い)は `Perform` が true を返し、
 *   `SingleShape()` が空になる。** → 断りは `IsNull()` でも判定する(NFR-RE-1)。
 *
 * **持ち主の見分け(`rules/06-過去の失敗と対策.md` 10.13):**
 * - 読み手(`RWObj_CafReader` / `RWGltf_CafReader`)は `new` したものなので `delete()` する。
 * - `SingleShape()` / `TopTools_IndexedMapOfShape.FindKey()` / `BRep_Tool.Triangulation()` の
 *   戻りは値または `const T&` なので **embind の複製**。控えへ積んで必ず返す。
 * - `handle.get()` の戻りは**借り物**なので `delete()` しない(積まない)。
 * - `Node(i)` / `Normal_1(i)` / `triangles.Value(i)` の戻りはその場で `delete()` する
 *   (`tessellate.ts` と同じ)。
 */

/** 読み込める形式。`'gltf'` は `.gltf`(JSON)と `.glb`(バイナリ)の両方を指す。 */
export type CafMeshFormat = 'obj' | 'gltf';

/**
 * 読めなかったとき(壊れている・その形式でない)の断り(計画書 §2.8 の表)。
 *
 * **タスク17 の `STL_READ_FAILED_MESSAGE` と 1 字も違わない。** 同じ文言を 2 か所に
 * 置いているのは、17 のファイル(`readStl.ts`)がコミット待ちで触れないためで、
 * **タスク16 が輸出と型を整理するときに共有の置き場へ寄せる**(§2.8 の断りの表は
 * ひとまとまりの正本になる)。
 */
export const CAF_MESH_READ_FAILED_MESSAGE =
  'このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。';

/**
 * 読めたが形が 1 つも入っていなかったときの断り(計画書 §2.8 の表)。
 *
 * `readStep.ts` の `STEP_NO_SHAPE_MESSAGE` と同じ文言。**寄せ先はタスク16**(上と同じ理由)。
 */
export const CAF_MESH_NO_SHAPE_MESSAGE = 'このファイルには形が入っていません。';

/**
 * 開ける三角形の上限(計画書 §2.8 の断りの表。タスク17 の `STL_MAX_TRIANGLE_COUNT` と同値)。
 *
 * 10 万三角形で約 2.4MB(§2.8 の見積もり)なので、500 万なら約 120MB。
 */
export const CAF_MESH_MAX_TRIANGLE_COUNT = 5_000_000;

/** 三角形が多すぎて開けないときの断り(計画書 §2.8 の表。個数を文言に入れる)。 */
export function cafMeshTooLargeMessage(triangleCount: number): string {
  return `この形は大きすぎて開けません(三角形が ${String(triangleCount)} 個)。`;
}

/** 読み込みの細かい指定。 */
export interface CafMeshReadOptions {
  /** ファイルの形式。読み手(`RWObj_CafReader` / `RWGltf_CafReader`)を決める。 */
  readonly format: CafMeshFormat;
  /**
   * 仮想ファイルへ置くときの名前(既定は形式ごとに `'import.obj'` / `'import.glb'`)。
   * 拡張子は残す(OCCT の読み手が拡張子で中身の並びを見分けることがある)。
   */
  readonly fileName?: string;
}

/** 形式ごとの既定のファイル名。 */
const DEFAULT_FILE_NAMES: Readonly<Record<CafMeshFormat, string>> = {
  obj: 'import.obj',
  gltf: 'import.glb',
};

/**
 * glTF を mm で受け取るために渡す「受け手側の長さの単位」(m で表した 1mm)。
 *
 * 倍率は `FileLengthUnit / SystemLengthUnit` で掛かる(冒頭の実測)。glb の
 * `FileLengthUnit()` は 1(= 1m)なので、0.001 を渡すと 1000 倍されて mm になる。
 */
const GLTF_SYSTEM_LENGTH_UNIT_M = 0.001;

/**
 * 面 1 枚ぶんの読み取り口(2 度の走査で使い回す)。
 *
 * 1 度目で三角形の数を数え、**大きすぎるファイルを配列を確保する前に断る**
 * (§2.8 の門。読んでから断ると 500 万三角形ぶんの JS の配列を作ってしまう)。
 * 2 度目で位置と添字を書き込む。取り出したものは呼び出し側の控えが持ち続ける。
 */
interface FaceMeshSource {
  readonly face: TopoDS_Face;
  readonly handle: Handle_Poly_Triangulation;
  readonly location: TopLoc_Location;
  readonly nodeCount: number;
  readonly triangleCount: number;
  /** ファイルに法線が書いてあったか(無ければ三角形から計算する)。 */
  readonly hasNormals: boolean;
}

/**
 * 形の中の面をたどって、三角形分割の付いている面だけを集める(`tessellate.ts` と同じ走査)。
 *
 * 面の取り出しに `TopExp_Explorer` を使わず `TopExp.MapShapes_2` を使う理由は
 * `tessellate.ts` と同じ——列挙 `TopAbs_ShapeEnum` を引数に取らない口だから
 * (値どうしの比較で面を選ぶ)。
 *
 * `tessellate.ts` と違って**三角形分割の付かない面は積まない**。あちらは面の通し番号を
 * 加工フィーチャーの指定に使うので 0 枚でも積む必要があったが、読み込んだメッシュは
 * 面を指定できない(§0.a-0.23)ので、番号を揃える相手がいない。
 */
function collectFaceMeshes(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  keep: Allocations['keep'],
): FaceMeshSource[] {
  const subShapes = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, subShapes, true, true);
  const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const sources: FaceMeshSource[] = [];

  const subShapeCount = subShapes.Size();
  for (let index = 1; index <= subShapeCount; index += 1) {
    // `FindKey` の戻りは embind の複製(rules/06 10.13 の ③)なので控えへ積む。
    const subShape = keep(subShapes.FindKey(index));
    if (subShape.ShapeType() !== faceType) {
      continue;
    }
    const face = keep(oc.TopoDS.Face_1(subShape));
    const location = keep(new oc.TopLoc_Location_1());
    const handle = keep(oc.BRep_Tool.Triangulation(face, location, 0));
    if (handle.IsNull()) {
      continue;
    }
    // `.get()` の戻りは借り物なので控えへ積まない(rules/06 10.13 の ①)。
    const triangulation = handle.get();
    sources.push({
      face,
      handle,
      location,
      // 個数の型 `Graphic3d_ZLayerId` はどこにも定義が無いので、整数へ直してから使う(§1.4)。
      nodeCount: Number(triangulation.NbNodes()),
      triangleCount: Number(triangulation.NbTriangles()),
      hasNormals: triangulation.HasNormals(),
    });
  }
  return sources;
}

/**
 * 面 1 枚ぶんの節点・法線・添字を、共有のバッファへ書き込む。
 *
 * **位置(`TopLoc_Location`)が恒等なら節点をそのまま読む。** 恒等でないときだけ
 * `gp_Pnt.Transformed` / `gp_Dir.Transformed` を使う——`tessellate.ts` は速さのために
 * 変換の種別ごとに手を分けているが、**読み込んだメッシュの面はほぼ必ず恒等**
 * (実測: 箱の OBJ も glb も `IsIdentity()` が true)なので、ここは分けずに OCCT に
 * 任せる。分けたぶんの速さより、掛け算の順序を写し間違えない安全さを採る。
 *
 * 法線はファイルに書いてあるときだけ書き込む(冒頭の実測)。無い面は呼び出し側が
 * まとめて三角形から計算する。
 */
function writeFaceMesh(
  oc: OpenCascadeInstance,
  source: FaceMeshSource,
  nodeOffset: number,
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  triangleOffset: number,
): void {
  const { keep, release } = createAllocations();
  try {
    const triangulation = source.handle.get();
    const identity = source.location.IsIdentity();
    const transformation = identity ? null : keep(source.location.Transformation());

    for (let index = 1; index <= source.nodeCount; index += 1) {
      const node = triangulation.Node(index);
      const base = (nodeOffset + index - 1) * 3;
      if (transformation === null) {
        positions[base] = node.X();
        positions[base + 1] = node.Y();
        positions[base + 2] = node.Z();
        node.delete();
      } else {
        const moved = node.Transformed(transformation);
        positions[base] = moved.X();
        positions[base + 1] = moved.Y();
        positions[base + 2] = moved.Z();
        node.delete();
        moved.delete();
      }
    }

    if (source.hasNormals) {
      for (let index = 1; index <= source.nodeCount; index += 1) {
        const direction = triangulation.Normal_1(index);
        const base = (nodeOffset + index - 1) * 3;
        if (transformation === null) {
          normals[base] = direction.X();
          normals[base + 1] = direction.Y();
          normals[base + 2] = direction.Z();
          direction.delete();
        } else {
          const moved = direction.Transformed(transformation);
          normals[base] = moved.X();
          normals[base + 1] = moved.Y();
          normals[base + 2] = moved.Z();
          direction.delete();
          moved.delete();
        }
      }
    }

    // 面の向きが反転している場合は、三角形の頂点順を入れ替えて表を外向きに揃える
    // (`tessellate.ts` と同じ扱い。体積の符号と法線の向きがここで決まる)。
    const reversed = source.face.Orientation_1() !== oc.TopAbs_Orientation.TopAbs_FORWARD;
    // `Triangles()` は `const T&` を返すので embind の複製。使い終わったら解放が要る
    // (rules/06 10.13 の ③。忘れると読み込みのたびに溜まって目に見えて遅くなる)。
    const triangles = keep(triangulation.Triangles());
    for (let index = 1; index <= source.triangleCount; index += 1) {
      const triangle = triangles.Value(index);
      const base = (triangleOffset + index - 1) * 3;
      // OCCT の配列は 1 始まり、three.js の頂点番号は 0 始まりなので 1 を引く。
      const a = nodeOffset + triangle.Value(1) - 1;
      const b = nodeOffset + triangle.Value(2) - 1;
      const c = nodeOffset + triangle.Value(3) - 1;
      indices[base] = reversed ? b : a;
      indices[base + 1] = reversed ? a : b;
      indices[base + 2] = c;
      triangle.delete();
    }
  } finally {
    release();
  }
}

/**
 * 三角形から頂点の法線を作る(ファイルに法線が書いていない面のため。冒頭の実測)。
 *
 * **これはタスク17 の `readStl.ts` にある同名の関数の写しである。** 向こうが
 * export していないうえ、あちらのファイルはコミット待ちで触れないため、同じ計算を
 * こちらへ置いた。**タスク16 で共有の場所へ寄せる**(2 か所に置いたままにしない)。
 *
 * 各三角形の 2 辺の外積を、その 3 頂点へ足し込んでから正規化する。外積の長さは
 * 三角形の面積の 2 倍なので、**正規化せずに足すと自然に面積の重みが付く**。
 * 長さが 0 になるのは、その頂点に付く三角形が全部つぶれている(面積 0)ときだけ。
 * `NaN` を画面へ流すと three.js の描画が黙って壊れるので、そのときは Z の向きを置く。
 */
function computeVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const ia = indices[offset] * 3;
    const ib = indices[offset + 1] * 3;
    const ic = indices[offset + 2] * 3;
    const ux = positions[ib] - positions[ia];
    const uy = positions[ib + 1] - positions[ia + 1];
    const uz = positions[ib + 2] - positions[ia + 2];
    const vx = positions[ic] - positions[ia];
    const vy = positions[ic + 1] - positions[ia + 1];
    const vz = positions[ic + 2] - positions[ia + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const base of [ia, ib, ic]) {
      normals[base] += nx;
      normals[base + 1] += ny;
      normals[base + 2] += nz;
    }
  }
  for (let base = 0; base < normals.length; base += 3) {
    const length = Math.hypot(normals[base], normals[base + 1], normals[base + 2]);
    if (length === 0) {
      normals[base + 2] = 1;
      continue;
    }
    normals[base] /= length;
    normals[base + 1] /= length;
    normals[base + 2] /= length;
  }
  return normals;
}

/**
 * 三角形の束から体積を求める(発散定理。符号付き四面体の和)。
 *
 * **これもタスク17 の `readStl.ts` からの写し**で、**タスク16 で寄せる**(上と同じ理由)。
 * 原点と三角形が作る四面体の符号付き体積 `(v₁ × v₂)·v₃ / 6` を全部足すと、
 * 閉じた形なら中身の体積になる。表裏が揃っていないファイルがあるので**絶対値を取る**。
 * 開いた形では意味を持たないが、「読んだ形の目安」としてプロパティパネルへ出す(§2.18)。
 */
function computeVolume(positions: Float32Array, indices: Uint32Array): number {
  let sum = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const ia = indices[offset] * 3;
    const ib = indices[offset + 1] * 3;
    const ic = indices[offset + 2] * 3;
    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];
    const bx = positions[ib];
    const by = positions[ib + 1];
    const bz = positions[ib + 2];
    const cx = positions[ic];
    const cy = positions[ic + 1];
    const cz = positions[ic + 2];
    sum += (ay * bz - az * by) * cx + (az * bx - ax * bz) * cy + (ax * by - ay * bx) * cz;
  }
  return Math.abs(sum) / 6;
}

/**
 * OBJ / glTF のバイト列を読んで、三角形の束を返す(§2.8、FR-802 / FR-809)。
 *
 * ```ts
 * const mesh = readCafMesh(oc, bytes, { format: 'gltf' });
 * // mesh.positions / mesh.normals / mesh.indices をそのまま three.js へ渡せる
 * ```
 *
 * **口は 1 つにしてある**(`readObj` / `readGltf` に分けない)。分けても中身は読み手の
 * `new` と単位の設定しか変わらず、呼び出し側(タスク16 の配線)は拡張子から形式を
 * 決めるので、形式を値で受け取るほうが分岐が 1 か所で済む。
 *
 * **glTF は mm へ直して返す**(OCCT に 1000 倍させる。冒頭の実測)。
 * **OBJ は単位を持たない**ので、ファイルの数がそのまま mm になる(§0.a-0.6)。
 *
 * 読めなかったとき・形が入っていないとき・三角形が多すぎるときは**日本語の理由**で断る
 * (NFR-RE-1。呼び出し側は例外を受けて断りの文言をそのまま見せられる)。
 * 仮想ファイルは `withVirtualFileInput` が必ず片付ける(§2.2)。
 *
 * 返る値はただの JS の並びなので、呼び出し側に解放の責任は無い(OCCT が確保したものは
 * この関数の中で全部返す)。
 */
export function readCafMesh(
  oc: OpenCascadeInstance,
  bytes: Uint8Array,
  options: CafMeshReadOptions,
): ImportedMeshData {
  const fileName = options.fileName ?? DEFAULT_FILE_NAMES[options.format];

  return withVirtualFileInput(oc, fileName, bytes, (path) => {
    const { keep, release } = createAllocations();
    try {
      const reader = keep(
        options.format === 'obj' ? new oc.RWObj_CafReader() : new oc.RWGltf_CafReader(),
      );
      if (options.format === 'gltf') {
        // 受け手側の単位を mm にすると、OCCT が節点を作る前に 1000 倍する(冒頭の実測)。
        reader.SetSystemLengthUnit(GLTF_SYSTEM_LENGTH_UNIT_M);
      }

      const range = keep(new oc.Message_ProgressRange_1());
      // 第 1 引数は実行時には `TCollection_AsciiString`。素の文字列は通らない(冒頭の実測)。
      const fileArgument = keep(new oc.TCollection_AsciiString_2(path));
      // `SetDocument` は呼ばない(§1.5-12 の実測。文書なしで読める)。
      if (!reader.Perform(fileArgument, range)) {
        // 壊れたファイルでも例外は飛ばず false が返る(冒頭の実測)。
        throw new Error(CAF_MESH_READ_FAILED_MESSAGE);
      }

      const shape = keep(reader.SingleShape());
      if (shape.IsNull()) {
        // 面の無い OBJ は Perform が true を返して空の形になる(冒頭の実測)。
        throw new Error(CAF_MESH_NO_SHAPE_MESSAGE);
      }

      const sources = collectFaceMeshes(oc, shape, keep);
      let totalNodes = 0;
      let totalTriangles = 0;
      for (const source of sources) {
        totalNodes += source.nodeCount;
        totalTriangles += source.triangleCount;
      }
      if (totalTriangles === 0) {
        throw new Error(CAF_MESH_NO_SHAPE_MESSAGE);
      }
      if (totalTriangles > CAF_MESH_MAX_TRIANGLE_COUNT) {
        // **数え方:** OBJ にも glTF にも「三角形の数」を安く読める頭が無い(STL の
        // ような固定長の頭が無く、OBJ は面の行を、glTF は accessor を全部見ないと
        // 数えられない)。だから**読んでから、JS の配列を確保する前に**数える。
        // ここまでで確保されているのは OCCT 側の三角形分割だけで、控えが必ず返す。
        throw new Error(cafMeshTooLargeMessage(totalTriangles));
      }

      const positions = new Float32Array(totalNodes * 3);
      const normals = new Float32Array(totalNodes * 3);
      const indices = new Uint32Array(totalTriangles * 3);
      // 法線の書いていない面の節点の範囲(あとでまとめて計算して埋める)。
      const computedRanges: { readonly start: number; readonly end: number }[] = [];
      let nodeOffset = 0;
      let triangleOffset = 0;
      for (const source of sources) {
        writeFaceMesh(oc, source, nodeOffset, positions, normals, indices, triangleOffset);
        if (!source.hasNormals) {
          computedRanges.push({
            start: nodeOffset * 3,
            end: (nodeOffset + source.nodeCount) * 3,
          });
        }
        nodeOffset += source.nodeCount;
        triangleOffset += source.triangleCount;
      }

      if (computedRanges.length > 0) {
        // 面ごとに節点の範囲は重ならないので、全体で計算した値のうち
        // 「法線の書いていない面の範囲」だけを写せば、面をまたいだ混ざりは起きない。
        const computed = computeVertexNormals(positions, indices);
        for (const range of computedRanges) {
          normals.set(computed.subarray(range.start, range.end), range.start);
        }
      }

      return {
        positions,
        normals,
        indices,
        triangleCount: totalTriangles,
        volume: computeVolume(positions, indices),
      };
    } finally {
      // 返す値は JS の並びだけなので、OCCT が確保したものはここで全部返してよい。
      release();
    }
  });
}
