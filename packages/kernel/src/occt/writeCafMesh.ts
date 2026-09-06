import type { ExportMesh } from './exportMesh.js';
import type { CafMeshFormat } from './readCafMesh.js';
import { DEGENERATE_CROSS_LENGTH_MM2 } from './writeStl.js';
import type { RgbTuple } from './xcafDocument.js';
import type { FaceColorMap } from './xcafFaceColors.js';
import {
  checkExportColor,
  checkFaceColors,
  exportColorKey,
  faceColorNotFoundMessage,
} from './xcafFaceColors.js';

/**
 * OBJ / glTF(.glb)の書き出し(計画書 P6 §2.4・§2.5、タスク13。FR-803 / FR-1106)。
 *
 * ## `RWObj_CafWriter` / `RWGltf_CafWriter` を使わない理由(統括の決定 2026-09-06)
 *
 * 計画書のタスク13 手順 3〜4 は OCCT の XCAF の書き手を想定していた。だが**書き出し用の
 * 三角形は 1 本の経路(タスク11 の `buildExportMesh`)から全形式へ配る**と決めた
 * (タスク12 で STL を JS で組んだのと同じ決定)。理由は 3 つ。
 *
 * 1. **形式ごとに三角形の数が違う、を避ける。** `RWGltf_CafWriter` は渡された形から
 *    自分で三角形を取るので、`forEachExportTriangle`(`writeStl.ts`)が落としている
 *    面積 0 の三角形が glTF にだけ残る。同じ品質を選んだのに STL と glTF で枚数が
 *    違うことになる。
 * 2. **品質の対(長さ + 角度)を渡す口が無い。** 書き出しの品質は「弦のずれ mm と
 *    角度のずれ rad の対」で持つ(`exportMesh.ts` の実測)。XCAF の書き手には形しか
 *    渡せない。
 * 3. **決定性(§0.a-0.62)。** OCCT の書き手はファイルへ生成元や時刻を書き込む。
 *    自分で組めば `asset.generator` を `PointerCAD` に固定でき、**同じ三角形からは
 *    必ず同じバイト列**になる(STEP のように 1 行落として比べる必要が無い)。
 *
 * **実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984。計画書 §1.5-1):**
 * `oc.RWObj_CafWriter` / `oc.RWGltf_CafWriter` はどちらも実行時に関数として存在する
 * (`.test.ts` の 1 件目が毎回確かめる)。**実在は記録するだけで、この実装は使わない。**
 * `Quantity_TOC_sRGB` の意味(渡した値がそのまま sRGB として書かれる)はタスク7 で
 * 実測済み(`xcafDocument.ts` の `resolveColorEnums`)。ここは OCCT を通さないので、
 * 色の解釈は**このファイルが自分で決める**(下の `srgbToLinear`)。
 *
 * `oc`(OpenCascadeInstance)は要らない。**この関数は純関数**で、仮想ファイル(§2.2)も
 * 経由しない。
 *
 * ## 単位(§0.a-0.7)
 *
 * - **OBJ は mm のまま。** OBJ に単位の決まりが無く、`readCafMesh` も倍率を掛けない。
 * - **glTF は m。** glTF の仕様が長さをメートルと定めているので `mm ÷ 1000` で書く。
 *   読み手(`readCafMesh`)は `SetSystemLengthUnit(0.001)` で 1000 倍して mm に戻す。
 *
 * ## 頂点の共有(統括への報告事項)
 *
 * **位置と法線は `ExportMesh` の配列を添字で共有したまま書く。** `writeStl` のように
 * 三角形ごとに 9 座標を書き出すと OBJ の `v` が三角形数 ×3 行に膨らみ、glTF も頂点が
 * 3 倍になる(丸い面の頂点法線も失われる)。**落とすのは面積 0 の三角形だけ**で、
 * 判定は `writeStl.ts` の `DEGENERATE_CROSS_LENGTH_MM2` を輸入して同じ式を使う
 * (三角形の集合が STL と 1 枚も違わないことを検査で固定してある)。
 *
 * **ただし、残った三角形から参照されなくなった頂点は書かない**(添字は振り直す)。
 * 面積 0 の三角形には**座標が `NaN` の頂点**が混じりうる(判定が `!(length > しきい値)` なので
 * `NaN` の三角形は必ず落ちる)。頂点をそのまま残すと、どの三角形も使っていない `NaN` が
 * ファイルへ書かれてしまい、**OBJ は `v NaN …` の行、glTF は accessor の `min` / `max` が
 * `NaN`** になって、どの道具でも開けないファイルになる(`writeStl.ts` が `NaN` の法線を
 * 書かないのと同じ理由)。振り直しは 1 回の走査で済み、ファイルも小さくなる。
 *
 * ## 面ごとの色(タスク13b、§0.a-0.22)
 *
 * 立体 1 つは「材質の添字 + 添字配列の範囲」の**区間の並び**(`MeshSection`)として
 * 書き出す。`CafMeshBody.faceColors`(面の通し番号 → 色)を渡すと、`ExportMesh.faceRanges`
 * (タスク13b で足した、`tessellate` が元から返している面ごとの範囲)で添字を切り分け、
 * **同じ色の面を 1 つの区間へまとめる。** OBJ は `usemtl` が区間ごとに増え、glTF は
 * `primitives` が区間ごとに分かれる。書き出しの本体(`writeObjText` / `writeGlbBytes`)は
 * 1 行も変えていない——区間の並びを作る `prepareScene` だけが広がった。
 *
 * **決まりごと(2026-09-06 実測で確定):**
 *
 * - **区間の並びは面の通し番号の昇順**(同じ色が初めて出た面の番号の順)。同じ表からは
 *   必ず同じバイト列になる(§0.a-0.62)。
 * - **材質は「実際に使った色」だけ作る。** 6 面すべてに色を付ければ材質は 6 つで、
 *   立体の色ぶんの材質は作らない(誰も指していない材質をファイルへ書かない、という
 *   もとからの決まり——`prepareScene` の注釈)。色を付けなかった面が 1 枚でもあれば、
 *   その面のぶんとして立体の色の材質が 1 つできる。
 * - **面の色は立体の色より優先する**(§2.5.1)。
 * - **面の色を渡さない/空の表を渡したときは、タスク13 とまったく同じバイト列。**
 * - 面積 0 の三角形の落とし方と未参照頂点の振り直しは**面ごとに切っても変わらない**
 *   (`compactIndices` を面の範囲ごとに呼び、`compactVertices` は元から複数区間を前提)。
 */

/** 書き出す立体 1 つぶん。 */
export interface CafMeshBody {
  /** 三角形の網(`buildExportMesh` の戻り。単位は mm)。 */
  readonly mesh: ExportMesh;
  /** 立体の名前。`null` か空文字なら形式ごとの通し名(`body_1` など)になる。 */
  readonly name: string | null;
  /** 立体の色(sRGB の 0〜1)。`null` なら既定の色(`DEFAULT_BODY_COLOR`)。 */
  readonly color: RgbTuple | null;
  /**
   * 面ごとの色(**面の通し番号 → 色**。§2.5.1、タスク13b)。**省略できる。**
   *
   * 通し番号は `mesh.faceRanges`(= `subShapes.ts` の `faceAt`)と同じ並び。
   * 載っていない面は立体の色になる。**`mesh.faceRanges` が無い網へ渡すと日本語の
   * 理由で断る**(`MESH_NO_FACE_RANGES_MESSAGE`)。
   */
  readonly faceColors?: FaceColorMap;
}

/** 書き出しの細かい指定。 */
export interface CafMeshWriteOptions {
  /** 書き出す形式。`'gltf'` は**必ず `.glb`**(バイナリ)で組む。 */
  readonly format: CafMeshFormat;
  /**
   * ファイル名の基(拡張子なし。既定 `'model'`)。
   *
   * OBJ は `.obj` と `.mtl` の 2 ファイルになり、`.obj` の `mtllib` の行が `.mtl` の
   * ファイル名を指す。**この 2 つが食い違うと色が付かない**ので、名前は 1 か所から作る。
   */
  readonly baseName?: string;
}

/** 書き出したファイル 1 つ。 */
export interface CafMeshFile {
  /** 保存するときのファイル名(拡張子つき)。 */
  readonly fileName: string;
  /** ファイルの中身。 */
  readonly bytes: Uint8Array;
}

/**
 * 書き出しの結果。
 *
 * **`files` は 1 つとは限らない。** OBJ は `.obj` と `.mtl` の 2 つ(1 つ目が `.obj`)、
 * glTF は `.glb` の 1 つ。利用者へどう渡すか(2 ファイルの保存)はタスク16 の配線が決める。
 *
 * 落とした枚数を戻りに入れた理由は `writeStl.ts` の `StlWriteResult` と同じ——
 * 数え直すと三角形をもう一度全部たどることになり、書いた枚数と食い違いうるため。
 */
export interface CafMeshWriteResult {
  /** 書き出したファイル。OBJ は `[.obj, .mtl]`、glTF は `[.glb]`。 */
  readonly files: readonly CafMeshFile[];
  /** 実際に書いた三角形の枚数(落としたぶんを除く)。 */
  readonly triangleCount: number;
  /** 面積 0(または `NaN`)で落とした三角形の枚数。 */
  readonly droppedTriangleCount: number;
}

/**
 * 色を指定しなかった立体の色(P5 の既定の外観の色 `#b8bfcc` を 255 で割ったもの)。
 *
 * **正本は `packages/model/src/appearance/materialPresets.ts` の `DEFAULT_APPEARANCE.color`
 * (`'#b8bfcc'`)** で、そこから**数値だけ引き写した**。kernel は model へ依存できない
 * (`rules/04-設計の規律.md` の依存方向 `ui → model → kernel`)ので、写しを置くほかない。
 * 引き写した値は `184/255`、`191/255`、`204/255`(計画書 §2.5 の検証表と同じ)。
 *
 * **色を持たない材質を書かない理由:** glTF で `material` を省くと、仕様の既定の材質
 * (`baseColorFactor` が白、`metallicFactor` が 1 = 完全な金属)が使われ、**画面で見た色と
 * まるで違う真っ黒に近い見た目**になる。既定の色を明示して書くほうが利用者の期待に合う。
 */
export const DEFAULT_BODY_COLOR: RgbTuple = [184 / 255, 191 / 255, 204 / 255];

/** ファイル名の基の既定。 */
const DEFAULT_BASE_NAME = 'model';

/** OBJ の座標・法線の小数点以下の桁数(`writeStl.ts` の ASCII と同じ固定桁。決定性)。 */
const OBJ_FRACTION_DIGITS = 6;

/** glTF の長さの単位(m)へ直す割り算(§0.a-0.7)。 */
const MM_PER_METER = 1000;

/** GLB の頭の合言葉 `glTF`(リトルエンディアンの uint32)。 */
const GLB_MAGIC = 0x46546c67;

/** GLB の版(glTF 2.0)。 */
const GLB_VERSION = 2;

/** GLB の JSON チャンクの合言葉。 */
const GLB_CHUNK_JSON = 0x4e4f534a;

/** GLB の BIN チャンクの合言葉(`BIN\0`)。 */
const GLB_CHUNK_BIN = 0x004e4942;

/** GLB の頭の長さ(合言葉 + 版 + 全長)。 */
const GLB_HEADER_LENGTH = 12;

/** GLB のチャンクの頭の長さ(長さ + 種別)。 */
const GLB_CHUNK_HEADER_LENGTH = 8;

/** glTF の成分の種別: 32 ビット浮動小数。 */
const GLTF_COMPONENT_FLOAT = 5126;

/** glTF の成分の種別: 32 ビット符号なし整数。 */
const GLTF_COMPONENT_UINT32 = 5125;

/** glTF の bufferView の用途: 頂点の属性。 */
const GLTF_TARGET_ARRAY_BUFFER = 34962;

/** glTF の bufferView の用途: 添字。 */
const GLTF_TARGET_ELEMENT_ARRAY_BUFFER = 34963;

/** glTF の描き方: 三角形。 */
const GLTF_MODE_TRIANGLES = 4;

/**
 * 立体 1 つの中の「材質 1 つぶんの区間」。
 *
 * 面の色が無ければ立体ごとに 1 つ。面の色があれば**使った色の数だけ**並ぶ(冒頭の注釈)。
 */
interface MeshSection {
  /** 材質の並びの中の位置。 */
  readonly materialIndex: number;
  /** 面積 0 の三角形を落としたあとの添字(3 個ずつ)。 */
  readonly indices: Uint32Array;
}

/** 書き出す準備の済んだ立体 1 つ。 */
interface PreparedBody {
  /** ファイルへ書く名前(空にならない)。 */
  readonly name: string;
  /** 残った三角形が使う頂点だけの位置(mm。glTF はここから m へ直す)。 */
  readonly positions: Float32Array;
  /** 同じ並びの頂点法線。 */
  readonly normals: Float32Array;
  /** 材質ごとの区間。空にならない(三角形が 1 枚も残らない立体は落としてある)。 */
  readonly sections: readonly MeshSection[];
  /** この立体で書く三角形の枚数。 */
  readonly triangleCount: number;
}

/** 材質 1 つ(立体ごとに 1 つ。面の色があれば、その立体で使った色の数だけ)。 */
interface PreparedMaterial {
  /** 材質の名前(OBJ の `newmtl` / `usemtl` に出る)。 */
  readonly name: string;
  /** sRGB の 0〜1。 */
  readonly color: RgbTuple;
}

/** 準備の結果。 */
interface PreparedScene {
  readonly bodies: readonly PreparedBody[];
  readonly materials: readonly PreparedMaterial[];
  readonly triangleCount: number;
  readonly droppedTriangleCount: number;
}

/**
 * 面ごとの色を頼まれたのに、三角形の網が面の区切り(`ExportMesh.faceRanges`)を
 * 持っていないときの断り(NFR-RE-1、FR-504)。
 *
 * 読み込んだファイルの網や、複数の立体を 1 本に連ねた網には B-rep の面の区切りが無い。
 * **黙って立体ごとの色へ落とすと、利用者からは「面の色が消えた」ように見える**ので断る。
 */
export const MESH_NO_FACE_RANGES_MESSAGE =
  'この形には面の区切りが無いので、面ごとの色を書き出せません。';

/**
 * sRGB(0〜1)を線形の値へ直す(計画書 §2.5 の検証表)。
 *
 * glTF の `baseColorFactor` は**線形**と定められている(`KHR` の仕様。画面の色をそのまま
 * 入れると明るすぎる灰色になる)。OBJ の `Kd` は色空間の定めが無く、慣行として画面の色
 * (sRGB)をそのまま書くので、**この変換は glTF にだけ掛ける**。
 *
 * 式は sRGB の逆ガンマ: `c ≤ 0.04045` なら `c / 12.92`、それ以外は `((c + 0.055) / 1.055)^2.4`。
 * `#b8bfcc`(= `184/255`, `191/255`, `204/255`)は
 * `[0.4793201831008268, 0.5209955732043543, 0.6038273388553378]` になる(2026-09-06 実測。
 * 計画書 §2.5 の「先頭は約 0.4793」と一致する)。検査は**この関数を使わずに式を組み直して**
 * 突き合わせる(実装が間違っていても検査が通る、を避けるため)。
 */
function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * ファイル名の基を整える。
 *
 * 空白は `_` へ寄せる。**OBJ の `mtllib` の行は空白で区切るので、名前に空白があると
 * 途中で切れて `.mtl` を見つけられなくなる**(色が付かない)。パスの区切りも落とす
 * (仮想ファイルの外を指させない)。
 *
 * **輸出しているのは、STL の配線(`worker/kernelApi.ts` のタスク16)が同じ規則で
 * `<基>.stl` を組むため。** 書き出しの結果は形式によらず `files: { fileName, bytes }[]`
 * で返す約束にしたので、ファイル名の作り方が形式ごとに食い違うと利用者から見て
 * 「OBJ だけ名前が変わる」ことになる。規則は 1 か所だけに置く。
 */
export function normalizeBaseName(baseName: string | undefined): string {
  if (baseName === undefined) {
    return DEFAULT_BASE_NAME;
  }
  const cleaned = baseName
    .replace(/[\\/]/gu, '_')
    .replace(/\s+/gu, '_')
    .trim();
  return cleaned === '' ? DEFAULT_BASE_NAME : cleaned;
}

/**
 * 面積 0(または `NaN`)の三角形を落として添字を詰める。
 *
 * **判定は `writeStl.ts` の `forEachExportTriangle` とまったく同じ式**(2 辺の外積の長さが
 * `DEGENERATE_CROSS_LENGTH_MM2` を超えるか)。`!(length > しきい値)` と書くので、
 * 座標に `NaN` が混じった三角形も同じ経路で落ちる。**同じ品質を選んだら STL と OBJ と
 * glTF で三角形が 1 枚も違わない**ことを、この 1 か所で保っている。
 *
 * ここでは**添字を元のまま**返す。参照されなくなった頂点を落として番号を振り直すのは
 * 立体の全区間が出そろってから(`compactVertices`)で、区間ごとにやると同じ頂点を
 * 区間の数だけ複製してしまうためである。
 */
function compactIndices(
  positions: Float32Array,
  indices: Uint32Array,
  start: number,
  end: number,
): { readonly kept: Uint32Array; readonly dropped: number } {
  const kept = new Uint32Array(end - start);
  let written = 0;
  let dropped = 0;
  for (let offset = start; offset + 2 < end; offset += 3) {
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
    if (!(Math.hypot(nx, ny, nz) > DEGENERATE_CROSS_LENGTH_MM2)) {
      dropped += 1;
      continue;
    }
    kept[written] = indices[offset];
    kept[written + 1] = indices[offset + 1];
    kept[written + 2] = indices[offset + 2];
    written += 3;
  }
  return { kept: kept.subarray(0, written), dropped };
}

/**
 * 残った三角形が使う頂点だけを集めて、添字を振り直す(冒頭の「頂点の共有」の注釈)。
 *
 * 新しい番号は**元の並びの若い順**に振るので、同じ網からは必ず同じ結果になる(決定性)。
 * 区間の添字は書き換えずに新しい配列へ写す——元の `ExportMesh` は呼び出し側の持ち物で、
 * 同じ網から STL・OBJ・glTF を続けて書けなければならないためである。
 */
function compactVertices(
  mesh: ExportMesh,
  sections: readonly Uint32Array[],
): {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly sections: readonly Uint32Array[];
} {
  const vertexCount = Math.floor(mesh.positions.length / 3);
  const seen = new Uint8Array(vertexCount);
  for (const indices of sections) {
    for (const index of indices) {
      seen[index] = 1;
    }
  }
  // 新しい番号は**元の並びの若い順**に振る(三角形をたどった順に振ると、
  // 区間の切り方を変えただけで頂点の並びが変わってしまう)。
  const renumbered = new Uint32Array(vertexCount);
  const order = new Uint32Array(vertexCount);
  let used = 0;
  for (let index = 0; index < vertexCount; index += 1) {
    if (seen[index] === 1) {
      renumbered[index] = used;
      order[used] = index;
      used += 1;
    }
  }

  const positions = new Float32Array(used * 3);
  const normals = new Float32Array(used * 3);
  for (let target = 0; target < used; target += 1) {
    const source = order[target] * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      positions[target * 3 + axis] = mesh.positions[source + axis];
      normals[target * 3 + axis] = mesh.normals[source + axis];
    }
  }

  return {
    positions,
    normals,
    sections: sections.map((indices) => Uint32Array.from(indices, (index) => renumbered[index])),
  };
}

/** 材質を割り当てる前の区間(色そのものを持つ)。 */
interface RawSection {
  /** この区間の色(sRGB の 0〜1)。 */
  readonly color: RgbTuple;
  /** 面積 0 の三角形を落としたあとの添字(3 個ずつ、元の頂点番号のまま)。 */
  readonly indices: Uint32Array;
}

/**
 * 添字の切れ端を 1 本に連ねる。1 本しか無ければ写さずそのまま返す
 * (面の色を渡さない道で余計な写しを作らない = タスク13 と同じバイト列)。
 */
function concatIndices(parts: readonly Uint32Array[]): Uint32Array {
  if (parts.length === 1) {
    return parts[0];
  }
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const joined = new Uint32Array(total);
  let cursor = 0;
  for (const part of parts) {
    joined.set(part, cursor);
    cursor += part.length;
  }
  return joined;
}

/**
 * 立体 1 つを、色ごとの区間へ切り分ける(タスク13b)。
 *
 * 面の色が無ければ**立体まるごとで 1 区間**——タスク13 とまったく同じ道を通る。
 * 面の色があれば `mesh.faceRanges` で面ごとに切り、**同じ色の面を 1 つの区間へまとめる**
 * (区間の並びは、その色が初めて出た面の通し番号の昇順)。
 */
function splitBody(body: CafMeshBody): {
  readonly sections: readonly RawSection[];
  readonly dropped: number;
} {
  const bodyColor = body.color ?? DEFAULT_BODY_COLOR;
  checkExportColor(bodyColor);

  const faceColors = body.faceColors;
  if (faceColors === undefined || faceColors.size === 0) {
    const { kept, dropped } = compactIndices(
      body.mesh.positions,
      body.mesh.indices,
      0,
      body.mesh.indices.length,
    );
    return { sections: kept.length === 0 ? [] : [{ color: bodyColor, indices: kept }], dropped };
  }

  checkFaceColors(faceColors);
  const faceRanges = body.mesh.faceRanges;
  if (faceRanges === undefined) {
    throw new Error(MESH_NO_FACE_RANGES_MESSAGE);
  }
  for (const faceIndex of faceColors.keys()) {
    if (faceIndex >= faceRanges.length) {
      throw new Error(faceColorNotFoundMessage(faceIndex));
    }
  }

  // 色の値を鍵にした表。`Map` は入れた順を覚えるので、面の通し番号の昇順にたどれば
  // 区間の並びも決まる(§0.a-0.62 の決定性)。
  const groups = new Map<string, { readonly color: RgbTuple; readonly parts: Uint32Array[] }>();
  let dropped = 0;
  for (const [faceIndex, range] of faceRanges.entries()) {
    // 表に載っていない面は立体の色(面の割り当てが立体より優先する。§2.5.1)。
    const color = faceColors.get(faceIndex) ?? bodyColor;
    const start = range.triangleOffset * 3;
    const compacted = compactIndices(
      body.mesh.positions,
      body.mesh.indices,
      start,
      start + range.triangleCount * 3,
    );
    dropped += compacted.dropped;
    if (compacted.kept.length === 0) {
      continue;
    }
    const key = exportColorKey(color);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { color, parts: [compacted.kept] });
    } else {
      group.parts.push(compacted.kept);
    }
  }

  return {
    sections: [...groups.values()].map((group) => ({
      color: group.color,
      indices: concatIndices(group.parts),
    })),
    dropped,
  };
}

/**
 * 立体の一覧を、書き出せる形へ整える(OBJ と glTF が共用する 1 か所)。
 *
 * **三角形が 1 枚も残らない立体は落とす。** glTF は添字が 0 個の accessor を許さず、
 * OBJ も面の無い `o` の塊に意味が無い。落とした立体のぶんは材質も作らないので、
 * `usemtl` / `newmtl` / `materials` の数は**実際に書いた区間の数**と必ず一致する
 * (面の色が無ければ立体の数と同じ。誰も指していない材質は 1 つも書かない)。
 */
function prepareScene(bodies: readonly CafMeshBody[]): PreparedScene {
  const prepared: PreparedBody[] = [];
  const materials: PreparedMaterial[] = [];
  let triangleCount = 0;
  let droppedTriangleCount = 0;

  for (const [index, body] of bodies.entries()) {
    const split = splitBody(body);
    droppedTriangleCount += split.dropped;
    if (split.sections.length === 0) {
      continue;
    }

    // 材質の名前は通し番号で作る。立体の名前をそのまま使うと、日本語や空白を含む名前が
    // OBJ の `usemtl`(空白で区切る 1 語)を壊す。名前は `o` の行のほうへ出す。
    const rawSections: readonly MeshSection[] = split.sections.map((section) => {
      const materialIndex = materials.length;
      materials.push({ name: `material_${String(materialIndex + 1)}`, color: section.color });
      return { materialIndex, indices: section.indices };
    });

    const name =
      body.name !== null && body.name.trim() !== ''
        ? body.name.replace(/\s+/gu, ' ').trim()
        : `body_${String(index + 1)}`;
    let bodyTriangles = 0;
    for (const section of rawSections) {
      bodyTriangles += section.indices.length / 3;
    }
    triangleCount += bodyTriangles;
    const compacted = compactVertices(
      body.mesh,
      rawSections.map((section) => section.indices),
    );
    prepared.push({
      name,
      positions: compacted.positions,
      normals: compacted.normals,
      sections: compacted.sections.map((indices, order) => ({
        materialIndex: rawSections[order].materialIndex,
        indices,
      })),
      triangleCount: bodyTriangles,
    });
  }

  return { bodies: prepared, materials, triangleCount, droppedTriangleCount };
}

/** OBJ の数値 1 つ。桁を固定して決定性を保つ(`writeStl.ts` の ASCII と同じ理由)。 */
function formatObjNumber(value: number): string {
  return value.toFixed(OBJ_FRACTION_DIGITS);
}

/**
 * OBJ(`.obj`)を組む。単位は **mm のまま**(§0.a-0.7)。
 *
 * 並びは「立体ごとに `o` → `usemtl` → `v` → `vn` → `f`」。**添字はファイル全体の通し番号
 * (1 始まり)**なので、立体をまたぐたびに書いた頂点の数だけずらす。`f` は `v//vn` の形で
 * 書く——位置と法線が頂点ごとに 1 対 1 に並んでいるので、番号は同じものを使える
 * (テクスチャ座標は書かないので真ん中は空)。
 */
function writeObjText(scene: PreparedScene, mtlFileName: string): string {
  const lines: string[] = ['# PointerCAD', `mtllib ${mtlFileName}`];
  let vertexBase = 0;

  for (const body of scene.bodies) {
    const { positions, normals } = body;
    const vertexCount = Math.floor(positions.length / 3);
    lines.push(`o ${body.name}`);
    for (let index = 0; index < vertexCount; index += 1) {
      const base = index * 3;
      lines.push(
        `v ${formatObjNumber(positions[base])} ${formatObjNumber(positions[base + 1])} ${formatObjNumber(positions[base + 2])}`,
      );
    }
    for (let index = 0; index < vertexCount; index += 1) {
      const base = index * 3;
      lines.push(
        `vn ${formatObjNumber(normals[base])} ${formatObjNumber(normals[base + 1])} ${formatObjNumber(normals[base + 2])}`,
      );
    }
    for (const section of body.sections) {
      lines.push(`usemtl ${scene.materials[section.materialIndex].name}`);
      for (let offset = 0; offset + 2 < section.indices.length; offset += 3) {
        const a = vertexBase + section.indices[offset] + 1;
        const b = vertexBase + section.indices[offset + 1] + 1;
        const c = vertexBase + section.indices[offset + 2] + 1;
        lines.push(
          `f ${String(a)}//${String(a)} ${String(b)}//${String(b)} ${String(c)}//${String(c)}`,
        );
      }
    }
    vertexBase += vertexCount;
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * 材質のファイル(`.mtl`)を組む。
 *
 * `Kd`(拡散色)だけを書く。**光沢・粗さ・透過率は書かない**(§0.a-0.22。4 形式で意味の
 * 合う変換表を作れないため)。`Kd` は慣行として画面の色(sRGB)をそのまま入れる
 * ——glTF の `baseColorFactor` と違い、MTL に色空間の定めが無い。
 */
function writeMtlText(scene: PreparedScene): string {
  const lines: string[] = ['# PointerCAD'];
  for (const material of scene.materials) {
    lines.push(
      `newmtl ${material.name}`,
      `Kd ${formatObjNumber(material.color[0])} ${formatObjNumber(material.color[1])} ${formatObjNumber(material.color[2])}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** glTF の accessor(`min` / `max` は位置にだけ付ける)。 */
interface GltfAccessor {
  readonly bufferView: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
  readonly min?: readonly number[];
  readonly max?: readonly number[];
}

/** glTF の bufferView。 */
interface GltfBufferView {
  readonly buffer: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly target: number;
}

/** glTF の 1 つの描き単位。 */
interface GltfPrimitive {
  readonly attributes: { readonly POSITION: number; readonly NORMAL: number };
  readonly indices: number;
  readonly material: number;
  readonly mode: number;
}

/** glTF の材質(色だけ)。 */
interface GltfMaterial {
  readonly name: string;
  readonly pbrMetallicRoughness: {
    readonly baseColorFactor: readonly [number, number, number, number];
    readonly metallicFactor: number;
  };
}

/** glTF の JSON チャンクの中身。 */
interface GltfJson {
  readonly asset: { readonly version: string; readonly generator: string };
  readonly scene: number;
  readonly scenes: readonly { readonly nodes: readonly number[] }[];
  readonly nodes: readonly { readonly name: string; readonly mesh: number }[];
  readonly meshes: readonly { readonly name: string; readonly primitives: readonly GltfPrimitive[] }[];
  readonly materials: readonly GltfMaterial[];
  readonly accessors: readonly GltfAccessor[];
  readonly bufferViews: readonly GltfBufferView[];
  readonly buffers?: readonly { readonly byteLength: number }[];
}

/** 4 バイト境界まで詰める長さ。 */
function padTo4(length: number): number {
  return (4 - (length % 4)) % 4;
}

/**
 * 数の並びを、そのままのバイト列として見る(写しは作らない)。
 *
 * `new Uint8Array(array.buffer)` と書くと、`subarray` で切り出した並びのときに
 * **元の buffer 全体**を指してしまう。`byteOffset` と `byteLength` を渡して切り出しの
 * 範囲だけを見る。
 */
function rawBytes(array: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/**
 * GLB(バイナリ glTF)を組む。単位は **m**(§0.a-0.7)。
 *
 * 中身は 12 バイトの頭(`glTF` / 版 2 / 全長)+ JSON チャンク + BIN チャンク。
 * チャンクはどちらも 4 バイト境界まで詰める(JSON は空白 `0x20`、BIN は 0)。
 *
 * **位置は mm ÷ 1000 で書き直す。** `Float32Array` へ入れ直すので、20mm は
 * `0.019999999552965164`(float32 の 0.02)になる。読み手(`readCafMesh`)は OCCT に
 * 1000 倍させるため、**節点を作る前に倍率が掛かって 20.0 へ戻る**(タスク18 の実測)。
 * 法線は向きなので倍率を掛けない。
 *
 * **添字は uint32(5125)で書く。** `ExportMesh.indices` が `Uint32Array` なので、
 * uint16 へ落とすと頂点が 65536 個を超える立体で壊れるうえ、変換のぶん遅くなる。
 *
 * `asset.generator` は `PointerCAD` に固定し、**時刻は 1 バイトも入れない**(§0.a-0.62)。
 */
function writeGlbBytes(scene: PreparedScene): Uint8Array {
  const binChunks: Uint8Array[] = [];
  const bufferViews: GltfBufferView[] = [];
  const accessors: GltfAccessor[] = [];
  const meshes: { readonly name: string; readonly primitives: readonly GltfPrimitive[] }[] = [];
  const nodes: { readonly name: string; readonly mesh: number }[] = [];
  let binLength = 0;

  const pushView = (bytes: Uint8Array, target: number): number => {
    binChunks.push(bytes);
    bufferViews.push({
      buffer: 0,
      byteOffset: binLength,
      byteLength: bytes.byteLength,
      target,
    });
    binLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  for (const body of scene.bodies) {
    const { positions, normals } = body;
    const vertexCount = Math.floor(positions.length / 3);

    // mm → m。新しい配列を作るのは、元の `ExportMesh` を書き換えないため
    // (同じ網から STL と OBJ と glTF を続けて書ける)。
    const meters = new Float32Array(positions.length);
    for (let index = 0; index < positions.length; index += 1) {
      meters[index] = positions[index] / MM_PER_METER;
    }
    // `min` / `max` は**書いたあとの float32 の値**から取る(仕様が実際の値を求めるため。
    // 割り算の結果を float64 のまま入れると、ファイルの中身と 1 ulp ずれることがある)。
    const min: [number, number, number] = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ];
    const max: [number, number, number] = [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (let index = 0; index < meters.length; index += 1) {
      const axis = index % 3;
      min[axis] = Math.min(min[axis], meters[index]);
      max[axis] = Math.max(max[axis], meters[index]);
    }

    const positionView = pushView(rawBytes(meters), GLTF_TARGET_ARRAY_BUFFER);
    const normalView = pushView(rawBytes(normals), GLTF_TARGET_ARRAY_BUFFER);

    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      componentType: GLTF_COMPONENT_FLOAT,
      count: vertexCount,
      type: 'VEC3',
      min,
      max,
    });
    const normalAccessor = accessors.length;
    accessors.push({
      bufferView: normalView,
      componentType: GLTF_COMPONENT_FLOAT,
      count: vertexCount,
      type: 'VEC3',
    });

    const primitives: GltfPrimitive[] = [];
    for (const section of body.sections) {
      const indexView = pushView(rawBytes(section.indices), GLTF_TARGET_ELEMENT_ARRAY_BUFFER);
      const indexAccessor = accessors.length;
      accessors.push({
        bufferView: indexView,
        componentType: GLTF_COMPONENT_UINT32,
        count: section.indices.length,
        type: 'SCALAR',
      });
      primitives.push({
        attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
        indices: indexAccessor,
        material: section.materialIndex,
        mode: GLTF_MODE_TRIANGLES,
      });
    }

    nodes.push({ name: body.name, mesh: meshes.length });
    meshes.push({ name: body.name, primitives });
  }

  const materials: GltfMaterial[] = scene.materials.map((material) => ({
    name: material.name,
    pbrMetallicRoughness: {
      // glTF の `baseColorFactor` は線形(冒頭の `srgbToLinear` の注釈)。
      // 4 つ目は不透明度で、透過率は書かない決定(§0.a-0.22)なので必ず 1。
      baseColorFactor: [
        srgbToLinear(material.color[0]),
        srgbToLinear(material.color[1]),
        srgbToLinear(material.color[2]),
        1,
      ],
      // **`metallicFactor` の既定は 1(完全な金属)** で、そのままだと色がほぼ見えない。
      // P5 の光沢の値を写すのではなく、**glTF の既定を打ち消して色を見せる**ための 0。
      metallicFactor: 0,
    },
  }));

  const json: GltfJson = {
    asset: { version: '2.0', generator: 'PointerCAD' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_node, index) => index) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    // 三角形が 1 枚も無いときは BIN チャンクを作らないので、`buffers` も置かない。
    buffers: binLength > 0 ? [{ byteLength: binLength }] : undefined,
  };

  const jsonRaw = new TextEncoder().encode(JSON.stringify(json));
  const jsonBytes = new Uint8Array(jsonRaw.length + padTo4(jsonRaw.length));
  jsonBytes.fill(0x20);
  jsonBytes.set(jsonRaw);

  const binBytes = new Uint8Array(binLength + padTo4(binLength));
  let cursor = 0;
  for (const chunk of binChunks) {
    binBytes.set(chunk, cursor);
    cursor += chunk.length;
  }

  const hasBin = binLength > 0;
  const total =
    GLB_HEADER_LENGTH +
    GLB_CHUNK_HEADER_LENGTH +
    jsonBytes.length +
    (hasBin ? GLB_CHUNK_HEADER_LENGTH + binBytes.length : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, GLB_CHUNK_JSON, true);
  out.set(jsonBytes, GLB_HEADER_LENGTH + GLB_CHUNK_HEADER_LENGTH);
  if (hasBin) {
    const binChunkStart = GLB_HEADER_LENGTH + GLB_CHUNK_HEADER_LENGTH + jsonBytes.length;
    view.setUint32(binChunkStart, binBytes.length, true);
    view.setUint32(binChunkStart + 4, GLB_CHUNK_BIN, true);
    out.set(binBytes, binChunkStart + GLB_CHUNK_HEADER_LENGTH);
  }
  return out;
}

/**
 * 三角形の網の並びを OBJ / glTF(.glb)のバイト列にする(§2.4・§2.5、FR-803 / FR-1106)。
 *
 * ```ts
 * const mesh = buildExportMesh(oc, shape, 0.1, { angularDeflectionRad: 0.2 });
 * const { files } = writeCafMesh([{ mesh, name: '本体', color: null }], { format: 'obj' });
 * // files[0] が model.obj、files[1] が model.mtl
 * ```
 *
 * **口は 1 つにしてある**(`writeObj` / `writeGltf` に分けない)。読み手(`readCafMesh`)と
 * 同じ形にすることと、タスク16 の配線が拡張子から形式を決めるので分岐が 1 か所で済む
 * ためである。**返るファイルの数が形式で違う**(OBJ は 2 つ、glTF は 1 つ)ので、
 * 呼び出し側は `files` を数えずにそのまま全部保存すればよい。
 *
 * **空の並び・三角形 0 枚は断らずに「中身の無いファイル」を返す**(`writeStl` と同じ判断)。
 * §2.4 の断りの表にある「書き出せる立体がありません」は `packages/model` が立体を選ぶ段で
 * 出すもので、そこを通った先の kernel が同じ判定を重ねると断りの持ち主が 2 か所になる。
 * 0 枚の OBJ / GLB は仕様どおり組み立てられるので、ここで例外にする根拠が無い。
 */
export function writeCafMesh(
  bodies: readonly CafMeshBody[],
  options: CafMeshWriteOptions,
): CafMeshWriteResult {
  const baseName = normalizeBaseName(options.baseName);
  const scene = prepareScene(bodies);
  const encoder = new TextEncoder();

  if (options.format === 'obj') {
    const mtlFileName = `${baseName}.mtl`;
    return {
      files: [
        { fileName: `${baseName}.obj`, bytes: encoder.encode(writeObjText(scene, mtlFileName)) },
        { fileName: mtlFileName, bytes: encoder.encode(writeMtlText(scene)) },
      ],
      triangleCount: scene.triangleCount,
      droppedTriangleCount: scene.droppedTriangleCount,
    };
  }

  return {
    files: [{ fileName: `${baseName}.glb`, bytes: writeGlbBytes(scene) }],
    triangleCount: scene.triangleCount,
    droppedTriangleCount: scene.droppedTriangleCount,
  };
}
