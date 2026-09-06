import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations } from './allocations.js';
import type { ImportedMeshData } from './exchangeShared.js';
import {
  MESH_MAX_TRIANGLE_COUNT,
  MESH_NO_FACE_MESSAGE,
  MESH_READ_FAILED_MESSAGE,
  computeVertexNormals,
  computeVolume,
  meshTooLargeMessage,
} from './exchangeShared.js';
import { withVirtualFileInput } from './virtualFile.js';

/**
 * STL の読み込み(計画書 P6 §2.8、タスク17。FR-802)。
 *
 * **`RWStl.ReadFile_2(theFile, theProgress): Handle_Poly_Triangulation` を使う**
 * (§0.a-0.25)。`StlAPI_Reader.Read(theShape, theFileName)` を使わないのは、第 1 引数が
 * C++ の参照渡し(out 引数)で、embind で書き換えが JS へ返るかを型定義から判断できない
 * ため(P5 §1.4-12)。**回避策があるので最初から回避策で書く。**
 *
 * **読んだ三角形は B-rep へ戻さない**(§0.a-0.23)。10 万三角形から面を張り直すと面が
 * 10 万枚でき、その上のフィレットも穴も実用にならない。だからこの関数が返すのは
 * 「画面へ出して測れるだけの三角形の束」であり、`tessellate.ts` の `SurfaceMesh` と
 * 同じ並び(位置・法線・添字)に揃えてある。
 *
 * ---
 *
 * **実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984。計画書 §1.5-1、-13):**
 *
 * - `oc.RWStl` は実行時に関数で、`ReadFile_2` / `WriteBinary` / `WriteAscii` も関数
 *   (`.test.ts` の 1 件目が毎回確かめる)。
 * - **§1.5-13 の答え: `Normal_1(i)` は呼べない。** `RWStl.ReadFile_2` が返す
 *   `Poly_Triangulation` は **`HasNormals()` が `false`** で(バイナリ・ASCII とも実測)、
 *   `Normal_1(1)` は `Error` ではなく**数値(WASM の番地。実測 18940064)**を投げる。
 *   STL のファイルには面ごとの法線が書いてあるが、OCCT の読み手はそれを捨てて頂点を
 *   束ねるためである。→ **この実装は三角形から法線を計算する**(2 辺の外積を足し合わせ、
 *   最後に正規化。外積の長さが三角形の面積の 2 倍なので、足すだけで面積の重みが付く)。
 * - **壊れたファイルでも例外は飛ばない。** `IsNull()` が `true` になり、OCCT が
 *   `Error: Corrupted binary STL file` / `Error: premature end of file` を**出力へ書くだけ**。
 *   だから断りは `IsNull()` で判定する(NFR-RE-1)。
 * - **三角形 0 枚(84 バイトちょうど・頭の個数が 0)のバイナリも `IsNull()` が `true`** に
 *   なる(「premature end of file」)。読み手からは「壊れている」と区別が付かないので、
 *   **0 枚の判定は読む前に自分でバイト列の頭を見る**(下の `inspectHeader`)。
 * - 頂点は束ねられる。20³ の箱の 12 枚(頂点 36 個ぶん書いてある)を読むと
 *   `NbNodes()` は 8、`NbTriangles()` は 12 になった。
 *
 * **持ち主の見分け(`rules/06-過去の失敗と対策.md` 10.13):**
 * - `RWStl.ReadFile_2` の戻りの `Handle_Poly_Triangulation` は**新しい Handle** なので
 *   使い終わったら `delete()` する(控えへ積む)。
 * - `handle.get()` の戻りは**借り物**なので `delete()` しない(積まない)。
 * - `triangulation.Triangles()` は C++ の `const T&` を返すので **embind の複製**。積む。
 * - `Node(i)` / `triangles.Value(i)` の戻りも値なので、その場で `delete()` する
 *   (`tessellate.ts` と同じ書き方)。
 */

/**
 * 断りの文言・上限・三角形の束の型は `exchangeShared.ts` が正本(タスク16 で寄せた)。
 *
 * **STL だけの名前でも引けるように、ここから名前を変えて中継する。** 画面や検査が
 * 「STL の断り」として引いている名前を残しつつ、値の持ち主は 1 つだけにするためで、
 * `readCafMesh.ts`(OBJ / glTF)も同じ値を別名で中継している。
 */
export {
  MESH_MAX_TRIANGLE_COUNT as STL_MAX_TRIANGLE_COUNT,
  MESH_NO_FACE_MESSAGE as STL_NO_FACE_MESSAGE,
  MESH_READ_FAILED_MESSAGE as STL_READ_FAILED_MESSAGE,
  meshTooLargeMessage as stlTooLargeMessage,
  type ImportedMeshData,
} from './exchangeShared.js';

/** 読み込みの細かい指定。 */
export interface StlReadOptions {
  /** 仮想ファイルへ置くときの名前(既定 `'import.stl'`)。拡張子は残す。 */
  readonly fileName?: string;
}

/** バイナリ STL の頭(80 バイトの見出し + 三角形の数 4 バイト)の長さ。 */
const BINARY_HEADER_LENGTH = 84;

/** バイナリ STL の三角形 1 枚の長さ(法線 3 + 頂点 9 の float32 = 48 + 属性 2)。 */
const BINARY_TRIANGLE_LENGTH = 50;

/** 三角形の数が書いてある位置(80 バイトの見出しの直後、uint32 リトルエンディアン)。 */
const BINARY_TRIANGLE_COUNT_OFFSET = 80;

/** ASCII の STL の先頭に必ず現れる語(`solid`)のバイト列。 */
const ASCII_SOLID_BYTES = [0x73, 0x6f, 0x6c, 0x69, 0x64];

/** 頭を見て分かったこと。`triangleCount` はバイナリのときだけ意味を持つ。 */
interface StlHeader {
  readonly binary: boolean;
  readonly triangleCount: number;
}

/** バイト列が `solid` で始まるか。 */
function startsWithSolid(bytes: Uint8Array): boolean {
  if (bytes.length < ASCII_SOLID_BYTES.length) {
    return false;
  }
  for (let index = 0; index < ASCII_SOLID_BYTES.length; index += 1) {
    if (bytes[index] !== ASCII_SOLID_BYTES[index]) {
      return false;
    }
  }
  return true;
}

/**
 * 読む前にバイト列の頭を確かめる(計画書 §0.a-0.27 の 3 段構えの ①)。
 *
 * **なぜ読む前に見るのか。** ①84 バイト未満は STL の頭すら入っていないので、OCCT へ渡す
 * までもなく断れる。②三角形 0 枚のバイナリは OCCT からは「壊れている」と区別が付かない
 * (冒頭の実測)ので、頭の個数で見分けるほかない。③**三角形 500 万超の断りは、頭に書いて
 * ある個数だけで出す。** 実際に 500 万枚ぶんのバイト列(約 250MB)を OCCT へ渡すと、断る
 * ためだけに WASM の記憶を食い尽くす。頭の個数と実際の長さが合わない偽物でも、
 * 「大きすぎる」と答えるほうが利用者にとって正しい(開けないことに変わりはない)。
 *
 * バイナリかどうかは**長さで見分ける**。バイナリ STL の見出し 80 バイトは中身が自由で、
 * `solid` で始まるバイナリを書き出す道具が実在するため、先頭の語だけでは決められない。
 * `84 + 50 × 個数` が長さと一致すればバイナリで確定、しなければ `solid` で始まるものを
 * ASCII とみなす(それ以外は、長さの合わないバイナリとして頭の個数で断りを判定する)。
 */
function inspectHeader(bytes: Uint8Array): StlHeader {
  if (bytes.length < BINARY_HEADER_LENGTH) {
    throw new Error(MESH_READ_FAILED_MESSAGE);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(BINARY_TRIANGLE_COUNT_OFFSET, true);
  const sizedAsBinary =
    BINARY_HEADER_LENGTH + BINARY_TRIANGLE_LENGTH * triangleCount === bytes.length;
  const binary = sizedAsBinary || !startsWithSolid(bytes);
  if (binary) {
    if (triangleCount > MESH_MAX_TRIANGLE_COUNT) {
      throw new Error(meshTooLargeMessage(triangleCount));
    }
    if (triangleCount === 0) {
      throw new Error(MESH_NO_FACE_MESSAGE);
    }
  }
  return { binary, triangleCount };
}

/**
 * STL のバイト列を読んで、三角形の束を返す(§2.8、FR-802)。
 *
 * ```ts
 * const mesh = readStl(oc, bytes);
 * // mesh.positions / mesh.normals / mesh.indices をそのまま three.js へ渡せる
 * ```
 *
 * 読めなかったとき・三角形が 0 枚のとき・多すぎるときは**日本語の理由**で断る
 * (NFR-RE-1。呼び出し側は例外を受けて断りの文言をそのまま見せられる)。
 * 仮想ファイルは `withVirtualFileInput` が必ず片付ける(§2.2)。
 *
 * 返る値はただの JS の並びなので、呼び出し側に解放の責任は無い(OCCT が確保したものは
 * この関数の中で全部返す)。
 */
export function readStl(
  oc: OpenCascadeInstance,
  bytes: Uint8Array,
  options: StlReadOptions = {},
): ImportedMeshData {
  const fileName = options.fileName ?? 'import.stl';
  // 読む前の門(84 バイト未満・三角形 0 枚・多すぎる)。OCCT へ渡す前に断る理由は上の注釈。
  inspectHeader(bytes);

  return withVirtualFileInput(oc, fileName, bytes, (path) => {
    const { keep, release } = createAllocations();
    try {
      const range = keep(new oc.Message_ProgressRange_1());
      const handle = keep(oc.RWStl.ReadFile_2(path, range));
      if (handle.IsNull()) {
        // 壊れたファイルでも例外は飛ばず、空の Handle が返る(冒頭の実測)。
        throw new Error(MESH_READ_FAILED_MESSAGE);
      }
      // `.get()` の戻りは借り物なので控えへ積まない(rules/06 10.13 の ①)。
      const triangulation = handle.get();
      // 個数の型 `Graphic3d_ZLayerId` はどこにも定義が無いので、整数へ直してから使う(§1.4)。
      const nodeCount = Number(triangulation.NbNodes());
      const triangleCount = Number(triangulation.NbTriangles());
      if (nodeCount === 0 || triangleCount === 0) {
        throw new Error(MESH_NO_FACE_MESSAGE);
      }
      if (triangleCount > MESH_MAX_TRIANGLE_COUNT) {
        // 頭の個数と実際の枚数が食い違うファイル(ASCII など)は、ここで初めて分かる。
        throw new Error(meshTooLargeMessage(triangleCount));
      }

      const positions = new Float32Array(nodeCount * 3);
      for (let index = 1; index <= nodeCount; index += 1) {
        const node = triangulation.Node(index);
        const base = (index - 1) * 3;
        positions[base] = node.X();
        positions[base + 1] = node.Y();
        positions[base + 2] = node.Z();
        node.delete();
      }

      const indices = new Uint32Array(triangleCount * 3);
      // `Triangles()` は `const T&` を返すので embind の複製。使い終わったら解放が要る
      // (rules/06 10.13 の ③。忘れると読み込みのたびに溜まって目に見えて遅くなる)。
      const triangles = keep(triangulation.Triangles());
      for (let index = 1; index <= triangleCount; index += 1) {
        const triangle = triangles.Value(index);
        const base = (index - 1) * 3;
        // OCCT の配列は 1 始まり、three.js の頂点番号は 0 始まりなので 1 を引く。
        indices[base] = triangle.Value(1) - 1;
        indices[base + 1] = triangle.Value(2) - 1;
        indices[base + 2] = triangle.Value(3) - 1;
        triangle.delete();
      }

      return {
        positions,
        normals: computeVertexNormals(positions, indices),
        indices,
        triangleCount,
        volume: computeVolume(positions, indices),
      };
    } finally {
      // 返す値は JS の並びだけなので、OCCT が確保したものはここで全部返してよい。
      release();
    }
  });
}
