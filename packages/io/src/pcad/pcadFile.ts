/**
 * `.pcad` / `.pcada` の ZIP コンテナの読み書き
 * (計画書 docs/plans/P2-ソリッド基礎.md タスク15、P7 §2.2 タスク3、要件§8、FR-801)。
 *
 * `.pcad` は ZIP で、中に次のものを入れる。
 *  - `document.json` … 部品文書の封筒(documentJson.ts が作る文字列を UTF-8 にしたもの)。圧縮する。
 *  - `thumbnail.png` … 画面の縮小画像。作れなければ入れない(§0.a-0.18)。PNG は既に圧縮済みなので無圧縮で入れる。
 *  - **添付**(P6 タスク21、§0.a-0.9・0.24・0.45・0.55。版 7 から)
 *    - `shapes/<shapeRef>.brep` … 読み込んだ B-rep(`importedSolid` が指す。OCCT の `BinTools` のバイト列)。
 *    - `meshes/<meshRef>.bin` … 読み込んだ三角形(`importedMesh` が指す。下の `PCM1` の並び)。
 *    - `canvases/<id>.png` … 下絵の画像(FR-332)。
 *
 * **添付は `rules/04`「導出できるものは保存しない」の承認済みの例外**である(§0.a-0.9 の例外①、
 * §0.a-0.24 の例外②、§0.a-0.55 の例外③)。読み込んだ形も下絵も**再計算では導出できない**
 * ——元のファイルが手元から消えたら二度と作れない——ので、`.pcad` へ抱き込む。
 * `document.json` には id と素性だけを書き、バイト列は 1 バイトも入れない
 * (10 万三角形を JSON にすると 10MB を超える。§2.8)。
 *
 * **決定的にする。** 同じ部品文書と同じ保存時刻からは、いつ・どの計算機で書き出しても
 * 同じバイト列ができる。ZIP のヘッダには「ファイルの最終更新日時」を書く欄があり、
 * 何も指定しないと fflate が実行時の時刻を入れてしまうので、固定の日時を渡す。
 * 保存した時刻は `document.json` の `savedAt` に入っているので、ZIP のほうの日時は
 * 意味を持たせずに固定してよい。日時を固定するとバイト列が計算機の時計にも時間帯にも
 * 左右されなくなり、「中身が同じなら同じファイル」を検査で確かめられる。
 *
 * 固定値は 1980-01-02 12:00(その計算機の時間帯での時刻)。ZIP の日時欄は 1980 年から
 * 2107 年までしか表せず、fflate は範囲外だと例外を投げる。1980-01-01 だと時間帯によっては
 * 1979 年になってしまうため 1 日ずらし、夏時間の切り替えを避けるため正午にしている。
 *
 * **アセンブリ(`.pcada`、P7 タスク3)も同じ ZIP の作りにする**(§0.a-0.1)。違うのは
 * `document.json` の中身(`AssemblyDocument`、`assemblyJson.ts`)と、抱き込んだ部品文書の
 * エントリ `parts/<ref>.json` と、再導出できない部品添付
 * (`parts/<ref>/shapes/*.brep`・`meshes/*.bin`・`canvases/*.png`)が増える。添付の
 * SHA-256 は `parts/<ref>/attachments.sha256` に分離し、部品文書の封筒は変えない。
 *
 * 読み込みは**例外を外へ出さない**(NFR-RE-1)。ZIP でない・`document.json` が無い・
 * 中身が壊れている、のいずれも日本語の理由を添えて返す(FR-504)。
 * 他のアプリが作った圧縮済みの ZIP も読める(fflate が deflate を解ける)。
 */

import {
  attachmentsDigestOf,
  type AssemblyDocument,
  type EmbeddedPartAttachments,
  type EmbeddedPartMesh,
  type LengthUnit,
  type PartDocument,
} from '@pointercad/model';
import { strFromU8, strToU8, zipSync, type Zippable } from 'fflate';

import {
  IO_LIMITS,
  isMeshAllocationWithinLimit,
  meshAllocationByteLength,
} from '../limits.js';
import {
  readAssemblyDocument,
  writeAssemblyDocument,
  type ReadAssemblyDocumentResult,
} from './assemblyJson.js';
import { parseDocument, serializeDocument, type ParseErrorCode } from './documentJson.js';
import {
  PCAD_TEMPLATE_KIND,
  type PcadDocumentKind,
  type PcadPartFile,
  type PcadToolDefaults,
} from './schema.js';
import {
  ARCHIVE_TOO_LARGE_MESSAGE,
  readArchive,
  type ArchiveReadLimits,
} from './readArchive.js';

/** 部品文書を入れる ZIP のエントリ名(要件§8)。 */
export const PCAD_DOCUMENT_ENTRY = 'document.json';
/** サムネイルを入れる ZIP のエントリ名(要件§8)。 */
export const PCAD_THUMBNAIL_ENTRY = 'thumbnail.png';

/**
 * 添付のエントリ名の前後(§0.a-0.55)。名前は `<前>` + 参照の文字列 + `<後>` でできている。
 * 参照の文字列に `/` は入らない前提で、入っているものは添付として扱わない
 * (知らないエントリと同じく黙って読み飛ばす。ZIP の中の入れ子の階層を作らせない)。
 */
export const PCAD_SHAPE_ENTRY_PREFIX = 'shapes/';
export const PCAD_SHAPE_ENTRY_SUFFIX = '.brep';
export const PCAD_MESH_ENTRY_PREFIX = 'meshes/';
export const PCAD_MESH_ENTRY_SUFFIX = '.bin';
export const PCAD_CANVAS_ENTRY_PREFIX = 'canvases/';
export const PCAD_CANVAS_ENTRY_SUFFIX = '.png';

/**
 * アセンブリ(`.pcada`)が抱き込む部品文書のエントリ名の前後(P7 §2.2、タスク3)。
 * 中身は**部品の `document.json` とまったく同じ文字列**(封筒つき)なので、
 * 読み書きは `serializeDocument` / `parseDocument` をそのまま使う(§2.3)。
 * 名前の決まりは添付と同じで、参照に `/` が入るものは部品として扱わない。
 */
export const PCAD_PART_ENTRY_PREFIX = 'parts/';
export const PCAD_PART_ENTRY_SUFFIX = '.json';
/** 部品ごとの添付ダイジェストを、その部品の名前空間へ置く固定名。 */
export const PCAD_PART_ATTACHMENTS_DIGEST_ENTRY = 'attachments.sha256';

/**
 * ZIP のヘッダへ書く固定の日時。年・月・日・時・分・秒がそのまま書かれるので、
 * 時間帯に依らず同じ値になるよう、実行環境の時間帯での日時として組み立てる。
 *
 * **3MF の書き出し(`threemf/writeThreeMf.ts`)も同じ値を使う**(計画書 P6 §2.6。
 * 決定性の決めを 2 か所に書かないため)ので、このファイルから輸出している。
 */
export const FIXED_ENTRY_MTIME = new Date(1980, 0, 2, 12, 0, 0, 0);

/** `document.json` の圧縮の強さ。6 は fflate の既定で、速さと大きさの釣り合いが良い。 */
const DOCUMENT_LEVEL = 6;
/** `thumbnail.png` の圧縮の強さ。PNG は既に圧縮済みなので、掛け直さない。 */
const THUMBNAIL_LEVEL = 0;
/**
 * 添付の圧縮の強さ(§0.a-0.55 の手順 5。**担当が実測して決めた**)。
 *
 * `.brep` と `.bin` は素の数値の並びなので deflate が良く効く
 * (実測: 20³ の箱の `BinTools` は 4,494 → 694 バイト(§0.a-0.10)。
 * 10 万三角形の `.bin` は 2,400,012 → 実測値を `pcadFile.test.ts` に記録)。
 * `.png` は既に圧縮済みなので `thumbnail.png` と同じく掛け直さない。
 */
const ATTACHMENT_BINARY_LEVEL = 6;
const ATTACHMENT_IMAGE_LEVEL = 0;

/**
 * 読み込んだ三角形の中身(`meshes/<meshRef>.bin` の中身。§2.8)。
 *
 * 位置・法線は頂点 1 つにつき 3 つ、添字は三角形 1 つにつき 3 つ。
 * **B-rep にはしない**(§0.a-0.23)ので、この 3 本の配列がそのまま形の正本になる。
 */
export type ImportedMeshBytes = EmbeddedPartMesh;

/**
 * `.pcad` に入っている添付の表(§0.a-0.55)。鍵は**エントリ名ではなく参照の文字列**
 * (`ImportedSolidFeature.shapeRef` / `ImportedMeshFeature.meshRef` / 下絵の id)なので、
 * `shapes` は**そのまま `PartRecomputeOptions.importedShapes` へ渡せる**(タスク20 の形)。
 *
 * 3 つとも「空の表」を持つ(欄ごと無くさない)。読み手が毎回 `undefined` を確かめずに
 * 済み、添付を持たない `.pcad`(版 6 までのファイル)も同じ形で扱えるため。
 */
export type PcadAttachments = EmbeddedPartAttachments;

/** 添付を 1 つも持たない表。版 6 までのファイルを読んだときの値でもある。 */
export function emptyPcadAttachments(): PcadAttachments {
  return { shapes: new Map(), meshes: new Map(), canvases: new Map() };
}

// ---------------------------------------------------------------------------
// `meshes/<id>.bin` の並び(§2.8)
// ---------------------------------------------------------------------------

/**
 * 頭(ヘッダ)の形。**12 バイト固定**で、内訳は次のとおり(すべてリトルエンディアン)。
 *
 * ```
 *  0〜 3  マジック 'PCM1'(0x50 0x43 0x4d 0x31。'PointerCAD Mesh 1')
 *  4〜 7  頂点の数 n(uint32)
 *  8〜11  三角形の数 m(uint32)
 * 12〜    位置(float32 × 3n) → 法線(float32 × 3n) → 添字(uint32 × 3m)
 * ```
 *
 * **なぜマジックを置くか:** ZIP のエントリ名は他のアプリでも書き換えられるので、
 * 名前だけを信じない。**なぜ 2 つの数を頭に置くか:** 位置と法線の境目が n から、
 * 添字の始まりが 2n から決まり、**残りの長さを数えなくても切り出せる**ため。
 * **なぜ位置 → 法線 → 添字の順か:** 計画書 §2.8 の並びをそのまま守る(表示は
 * 位置と法線を先に要り、添字は最後にあれば足りる)。
 *
 * 全体の長さは `12 + 12n + 12n + 12m` バイトになる(float32 も uint32 も 4 バイト × 3)。
 * 10 万三角形・頂点 5 万なら 2,400,012 バイト(§2.8 の見積もりと同じ)。
 */
const MESH_HEADER_BYTES = 12;
/** マジックの 4 バイト。'PCM1' を UTF-8(= ASCII)にしたもの。 */
const MESH_MAGIC: readonly number[] = [0x50, 0x43, 0x4d, 0x31];
/** リトルエンディアンで読み書きする(`DataView` の `littleEndian` 引数)。 */
const MESH_LITTLE_ENDIAN = true;

/**
 * 三角形を `meshes/<id>.bin` のバイト列にする。
 *
 * **`DataView` で 1 つずつ書く**のは、TypedArray をそのままバイト列にすると
 * 走らせた計算機のバイト順(エンディアン)に左右され、**同じ形から同じファイルが
 * できる保証が消える**ため(決定性は `.pcad` の約束。このファイル冒頭)。
 * 長さの食い違い(位置と法線の要素数が違う等)は呼び出し側の作りの誤りなので、
 * ここでは**位置の長さを正**として法線を同じ長さとして扱い、足りない分は 0 で埋める
 * ——のではなく、**そろっていないものは受け取らない**(`null` を返す)。
 */
export function encodeImportedMeshBytes(mesh: ImportedMeshBytes): Uint8Array | null {
  const vertexCount = mesh.positions.length / 3;
  const triangleCount = mesh.indices.length / 3;
  if (!Number.isInteger(vertexCount) || !Number.isInteger(triangleCount)) {
    return null;
  }
  if (mesh.normals.length !== mesh.positions.length) {
    return null;
  }
  const bytes = new Uint8Array(
    MESH_HEADER_BYTES + mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength,
  );
  bytes.set(MESH_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, vertexCount, MESH_LITTLE_ENDIAN);
  view.setUint32(8, triangleCount, MESH_LITTLE_ENDIAN);
  let offset = MESH_HEADER_BYTES;
  for (const value of mesh.positions) {
    view.setFloat32(offset, value, MESH_LITTLE_ENDIAN);
    offset += 4;
  }
  for (const value of mesh.normals) {
    view.setFloat32(offset, value, MESH_LITTLE_ENDIAN);
    offset += 4;
  }
  for (const value of mesh.indices) {
    view.setUint32(offset, value, MESH_LITTLE_ENDIAN);
    offset += 4;
  }
  return bytes;
}

/**
 * `meshes/<id>.bin` のバイト列から三角形を取り出す。読めなければ `null`
 * (**例外を投げない**。NFR-RE-1)。
 *
 * マジック・長さ・確保予算に加え、位置と法線が finite であること、添字が頂点数の
 * 範囲内であることを確かめる。壊れた値を描画・計測へ渡さないため、1 つでも違えば
 * 添付全体を `null` で断る。
 */
export function decodeImportedMeshBytes(bytes: Uint8Array): ImportedMeshBytes | null {
  const header = inspectImportedMeshBytes(bytes);
  if (
    header === null ||
    !isMeshAllocationWithinLimit(header.vertexCount, header.triangleCount)
  ) {
    return null;
  }
  const { view, vertexCount, triangleCount } = header;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);
  let offset = MESH_HEADER_BYTES;
  for (let index = 0; index < positions.length; index += 1) {
    const value = view.getFloat32(offset, MESH_LITTLE_ENDIAN);
    if (!Number.isFinite(value)) {
      return null;
    }
    positions[index] = value;
    offset += 4;
  }
  for (let index = 0; index < normals.length; index += 1) {
    const value = view.getFloat32(offset, MESH_LITTLE_ENDIAN);
    if (!Number.isFinite(value)) {
      return null;
    }
    normals[index] = value;
    offset += 4;
  }
  for (let index = 0; index < indices.length; index += 1) {
    const value = view.getUint32(offset, MESH_LITTLE_ENDIAN);
    if (!Number.isInteger(value) || value >= vertexCount) {
      return null;
    }
    indices[index] = value;
    offset += 4;
  }
  return { positions, normals, indices };
}

interface ImportedMeshHeader {
  readonly view: DataView;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

/** 配列を確保せずに `PCM1` の頭と宣言された全長を確かめる。 */
function inspectImportedMeshBytes(bytes: Uint8Array): ImportedMeshHeader | null {
  if (bytes.length < MESH_HEADER_BYTES) {
    return null;
  }
  for (let index = 0; index < MESH_MAGIC.length; index += 1) {
    if (bytes[index] !== MESH_MAGIC[index]) {
      return null;
    }
  }
  // ZIP から取り出したバイト列は 4 の倍数の位置から始まるとは限らないので、
  // TypedArray を直接かぶせず、`byteOffset` を足した `DataView` で読む。
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertexCount = view.getUint32(4, MESH_LITTLE_ENDIAN);
  const triangleCount = view.getUint32(8, MESH_LITTLE_ENDIAN);
  const bodyBytes = meshAllocationByteLength(vertexCount, triangleCount);
  if (bodyBytes === null || bytes.byteLength !== MESH_HEADER_BYTES + bodyBytes) {
    return null;
  }
  return { view, vertexCount, triangleCount };
}

export interface WritePcadFileOptions {
  /** 保存時刻(ISO 8601)。検査で時刻を固定するための口。既定は今の時刻。 */
  readonly savedAt?: string;
  /** サムネイルの PNG。作れなかったときは渡さない(そのときは ZIP へ入れない)。 */
  readonly thumbnailPng?: Uint8Array;
  /**
   * 封筒に書く種別(§0.a-0.35)。既定は部品、ひな形(`.pcadt`)のときだけ
   * `PCAD_TEMPLATE_KIND` を渡す。ZIP の作りは種別で 1 文字も変わらない。
   */
  readonly kind?: PcadDocumentKind;
  /**
   * ひな形が持ち運ぶ表示の長さの単位(FR-814、§2.10。P6 タスク27)。
   * **ひな形として書き出すときだけ渡す。** 渡さなければ封筒にこの欄は出ない
   * (部品の `.pcad` のバイト列はタスク27 の前後で 1 バイトも変わらない)。
   */
  readonly lengthUnit?: LengthUnit;
  /** ひな形が持ち運ぶ道具の既定値(FR-814)。`lengthUnit` と同じ扱い。 */
  readonly toolDefaults?: PcadToolDefaults;
  /**
   * 添付(§0.a-0.55)。渡さなければ添付のエントリは 1 つも入らない。
   *
   * **文書が参照しているものだけを渡す責任は呼び出し側にある。** ここで文書と突き合わせて
   * 落とさないのは、①書き出しは断れない(戻り値がバイト列だけ)、②未参照の添付を捨てると
   * 「まだ欄になっていない下絵」(タスク38)を往復で失う、の 2 つによる。
   * 欠けているほうは読み手が `missingField` で断る。
   */
  readonly attachments?: PcadAttachments;
}

/**
 * 添付を ZIP のエントリへ並べる。**名前の順に並べる**(表の並び順は作った側の都合で
 * 変わるので、同じ中身から同じバイト列ができる約束を守るために毎回そろえる)。
 * 中身を組み立てられなかった三角形は**黙って落とす**(書き出しは断れないため。
 * 呼び出し側が壊れた配列を渡さない限り起きない)。
 */
function appendAttachments(
  entries: Zippable,
  attachments: PcadAttachments,
  entryPrefix = '',
): void {
  for (const [ref, bytes] of sortedEntries(attachments.shapes)) {
    entries[`${entryPrefix}${PCAD_SHAPE_ENTRY_PREFIX}${ref}${PCAD_SHAPE_ENTRY_SUFFIX}`] = [
      bytes,
      { level: ATTACHMENT_BINARY_LEVEL, mtime: FIXED_ENTRY_MTIME },
    ];
  }
  for (const [ref, mesh] of sortedEntries(attachments.meshes)) {
    const bytes = encodeImportedMeshBytes(mesh);
    if (bytes === null) {
      continue;
    }
    entries[`${entryPrefix}${PCAD_MESH_ENTRY_PREFIX}${ref}${PCAD_MESH_ENTRY_SUFFIX}`] = [
      bytes,
      { level: ATTACHMENT_BINARY_LEVEL, mtime: FIXED_ENTRY_MTIME },
    ];
  }
  for (const [ref, bytes] of sortedEntries(attachments.canvases)) {
    entries[`${entryPrefix}${PCAD_CANVAS_ENTRY_PREFIX}${ref}${PCAD_CANVAS_ENTRY_SUFFIX}`] = [
      bytes,
      { level: ATTACHMENT_IMAGE_LEVEL, mtime: FIXED_ENTRY_MTIME },
    ];
  }
}

/** 表を鍵の順(コード単位の昇順)に並べ替えた組の配列にする。 */
function sortedEntries<T>(table: ReadonlyMap<string, T>): readonly (readonly [string, T])[] {
  const pairs: (readonly [string, T])[] = [];
  for (const pair of table) {
    pairs.push(pair);
  }
  return pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

/**
 * 部品文書(と、あればサムネイル・添付)を `.pcad` のバイト列にする。
 * 例外を投げない。TypedArray と純データしか扱わない。
 *
 * エントリの並びは `document.json` → `thumbnail.png` → 添付(`shapes` → `meshes` →
 * `canvases`、それぞれ名前順)で固定する(決定性)。
 */
export function writePcadFile(
  document: PartDocument,
  options: WritePcadFileOptions = {},
): Uint8Array {
  const text = serializeDocument(document, {
    savedAt: options.savedAt,
    kind: options.kind,
    lengthUnit: options.lengthUnit,
    toolDefaults: options.toolDefaults,
  });
  const entries: Zippable = {
    [PCAD_DOCUMENT_ENTRY]: [strToU8(text), { level: DOCUMENT_LEVEL, mtime: FIXED_ENTRY_MTIME }],
  };
  if (options.thumbnailPng !== undefined) {
    entries[PCAD_THUMBNAIL_ENTRY] = [
      options.thumbnailPng,
      { level: THUMBNAIL_LEVEL, mtime: FIXED_ENTRY_MTIME },
    ];
  }
  if (options.attachments !== undefined) {
    appendAttachments(entries, options.attachments);
  }
  return zipSync(entries);
}

/**
 * 読み込めなかった理由。`notZip` と `missingDocument` はこの層で見つけたもの、
 * それ以外は `document.json` の読み手(documentJson.ts)の理由をそのまま通したもの。
 */
export type ReadPcadFileErrorCode = ParseErrorCode | 'notZip' | 'missingDocument';

/** 読み込めなかった理由。`message` はそのまま利用者へ見せる日本語(NFR-UX-5)。 */
export interface ReadPcadFileError {
  readonly code: ReadPcadFileErrorCode;
  readonly message: string;
}

export type ReadPcadFileResult =
  | {
      readonly ok: true;
      readonly document: PartDocument;
      readonly savedAt: string;
      /** 封筒の種別(部品かひな形か、§0.a-0.35)。判断は上の層(タスク27)がする。 */
      readonly kind: PcadDocumentKind;
      /**
       * ひな形が持ち運んでいた表示の長さの単位(FR-814、§2.10)。**欄が無ければ `undefined`。**
       * 既定(`'mm'`)で埋めるのは model の `openTemplate` の仕事(`documentJson.ts` の注記)。
       */
      readonly lengthUnit?: LengthUnit;
      /** ひな形が持ち運んでいた道具の既定値(FR-814)。`lengthUnit` と同じく、無ければ `undefined`。 */
      readonly toolDefaults?: PcadToolDefaults;
      /**
       * ZIP に入っていた添付(§0.a-0.55)。**未参照のものも捨てずに返す。**
       * 版 7 のファイルに、この版の読み手がまだ知らない参照(下絵、タスク38)が
       * 入っていることがあり、捨てると往復でその添付を失うため。
       */
      readonly attachments: PcadAttachments;
      /** サムネイルが入っていたときだけ付く。 */
      readonly thumbnailPng?: Uint8Array;
    }
  | { readonly ok: false; readonly error: ReadPcadFileError };

const NOT_ZIP_MESSAGE = 'ファイルを開けませんでした。壊れているかもしれません。';
const MISSING_DOCUMENT_MESSAGE =
  'PointerCAD のファイルではないようです(document.json が入っていません)。';

function fail(code: ReadPcadFileErrorCode, message: string): ReadPcadFileResult {
  return { ok: false, error: { code, message } };
}

/**
 * エントリを取り出す。共通入口は Map へ安全な名前だけを入れるので、値の有無だけを見る。
 */
function findEntry(entries: ReadonlyMap<string, Uint8Array>, name: string): Uint8Array | null {
  return entries.get(name) ?? null;
}

/** UTF-8 として読む。読めない並びは置き換え文字になるだけで例外にはならないが、念のため受け止める。 */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strFromU8(bytes);
  } catch {
    return null;
  }
}

/**
 * エントリ名が添付のものなら、その参照の文字列を返す(違えば null)。
 * 参照に `/` が入る名前(`shapes/a/b.brep`)は添付として扱わない(このファイル冒頭)。
 */
function attachmentRef(name: string, prefix: string, suffix: string): string | null {
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
    return null;
  }
  const ref = name.slice(prefix.length, name.length - suffix.length);
  if (ref.length === 0 || ref.includes('/')) {
    return null;
  }
  return ref;
}

function isPcadArchiveEntry(name: string): boolean {
  return (
    name === PCAD_DOCUMENT_ENTRY ||
    name === PCAD_THUMBNAIL_ENTRY ||
    attachmentRef(name, PCAD_SHAPE_ENTRY_PREFIX, PCAD_SHAPE_ENTRY_SUFFIX) !== null ||
    attachmentRef(name, PCAD_MESH_ENTRY_PREFIX, PCAD_MESH_ENTRY_SUFFIX) !== null ||
    attachmentRef(name, PCAD_CANVAS_ENTRY_PREFIX, PCAD_CANVAS_ENTRY_SUFFIX) !== null
  );
}

function isPcadaArchiveEntry(name: string): boolean {
  return (
    name === PCAD_DOCUMENT_ENTRY ||
    name === PCAD_THUMBNAIL_ENTRY ||
    name.startsWith(PCAD_PART_ENTRY_PREFIX)
  );
}

/**
 * ZIP のエントリから添付の表を組み立てる。三角形の並びが壊れていたエントリ名を
 * 一緒に返し、呼び出し側に `invalidField` で断らせる(**エラーコードを増やさない**)。
 */
function collectAttachments(
  entries: ReadonlyMap<string, Uint8Array>,
  meshAllocationLimit = IO_LIMITS.meshAllocationBytes,
): {
  readonly attachments: PcadAttachments;
  readonly brokenMeshEntry: string | null;
  readonly tooLargeMeshEntry: string | null;
  readonly allocatedMeshBytes: number;
} {
  const shapes = new Map<string, Uint8Array>();
  const meshes = new Map<string, ImportedMeshBytes>();
  const canvases = new Map<string, Uint8Array>();
  let brokenMeshEntry: string | null = null;
  let tooLargeMeshEntry: string | null = null;
  let allocatedMeshBytes = 0;
  for (const [name, bytes] of entries) {
    const shapeRef = attachmentRef(name, PCAD_SHAPE_ENTRY_PREFIX, PCAD_SHAPE_ENTRY_SUFFIX);
    if (shapeRef !== null) {
      shapes.set(shapeRef, bytes);
      continue;
    }
    const meshRef = attachmentRef(name, PCAD_MESH_ENTRY_PREFIX, PCAD_MESH_ENTRY_SUFFIX);
    if (meshRef !== null) {
      const header = inspectImportedMeshBytes(bytes);
      if (header === null) {
        brokenMeshEntry ??= name;
        break;
      }
      const meshBytes = meshAllocationByteLength(header.vertexCount, header.triangleCount);
      if (
        meshBytes === null ||
        allocatedMeshBytes + meshBytes > meshAllocationLimit
      ) {
        tooLargeMeshEntry ??= name;
        break;
      }
      const mesh = decodeImportedMeshBytes(bytes);
      if (mesh === null) {
        brokenMeshEntry ??= name;
        break;
      }
      allocatedMeshBytes += meshBytes;
      meshes.set(meshRef, mesh);
      continue;
    }
    const canvasRef = attachmentRef(name, PCAD_CANVAS_ENTRY_PREFIX, PCAD_CANVAS_ENTRY_SUFFIX);
    if (canvasRef !== null) {
      canvases.set(canvasRef, bytes);
    }
    // どれでもない名前は知らないエントリとして読み飛ばす(P2 からの決めごと)。
  }
  return {
    attachments: { shapes, meshes, canvases },
    brokenMeshEntry,
    tooLargeMeshEntry,
    allocatedMeshBytes,
  };
}

/**
 * 文書が指している添付が全部そろっているかを確かめ、欠けている 1 つ目のエントリ名を返す
 * (そろっていれば null)。
 *
 * 欠けたまま開くと、履歴の先頭のベースボディが**形の無い段**になって再計算が通らない
 * (FR-802)。読み込みの時点で断ったほうが、何が起きたかを利用者へ伝えられる。
 * 断りは既存の `missingField`(**エラーコードを増やさない**。
 * `docs/報告記録.md` 2026-09-04 01:40 の③)。
 *
 * **下絵(`canvases`、FR-332、タスク38)も同じ扱いにする。** 画像が欠けた下絵は
 * 何も描けない枠だけになり、そのまま保存し直すと欄だけが残って**画像を永久に失う**。
 * 読み込みの時点で断れば、利用者は元の `.pcad` を残したまま作り直せる(FR-504)。
 */
function findMissingAttachment(
  document: PartDocument,
  attachments: PcadAttachments,
): string | null {
  for (const feature of document.solids) {
    if (feature.kind === 'importedSolid' && !attachments.shapes.has(feature.shapeRef)) {
      return `${PCAD_SHAPE_ENTRY_PREFIX}${feature.shapeRef}${PCAD_SHAPE_ENTRY_SUFFIX}`;
    }
    if (feature.kind === 'importedMesh' && !attachments.meshes.has(feature.meshRef)) {
      return `${PCAD_MESH_ENTRY_PREFIX}${feature.meshRef}${PCAD_MESH_ENTRY_SUFFIX}`;
    }
  }
  for (const canvas of document.canvases) {
    if (!attachments.canvases.has(canvas.imageId)) {
      return `${PCAD_CANVAS_ENTRY_PREFIX}${canvas.imageId}${PCAD_CANVAS_ENTRY_SUFFIX}`;
    }
  }
  return null;
}

/**
 * `.pcad` のバイト列から部品文書と添付を取り出す。
 * 壊れていても例外を投げず、日本語の理由を返す(FR-504、NFR-RE-1)。
 */
export function readPcadFile(bytes: Uint8Array): ReadPcadFileResult {
  const archive = readArchive(bytes, { shouldExtract: isPcadArchiveEntry });
  if (!archive.ok) {
    const message =
      archive.error.kind === 'compressedInput' ||
      archive.error.kind === 'entryCount' ||
      archive.error.kind === 'entryExpanded' ||
      archive.error.kind === 'totalExpanded'
        ? archive.error.reason
        : NOT_ZIP_MESSAGE;
    return fail('notZip', message);
  }
  const entries = archive.entries;
  const documentEntry = findEntry(entries, PCAD_DOCUMENT_ENTRY);
  if (documentEntry === null) {
    return fail('missingDocument', MISSING_DOCUMENT_MESSAGE);
  }
  const text = decodeUtf8(documentEntry);
  if (text === null) {
    return fail('notZip', NOT_ZIP_MESSAGE);
  }
  const parsed = parseDocument(text);
  if (!parsed.ok) {
    // 中身の理由(版が古い・種別が違う・欄が壊れている等)はそのまま通す。
    return { ok: false, error: parsed.error };
  }
  const collected = collectAttachments(entries);
  if (collected.tooLargeMeshEntry !== null) {
    return fail('invalidField', ARCHIVE_TOO_LARGE_MESSAGE);
  }
  if (collected.brokenMeshEntry !== null) {
    return fail(
      'invalidField',
      `ファイルの中身が壊れています(${collected.brokenMeshEntry} の形が違います)。`,
    );
  }
  const missing = findMissingAttachment(parsed.document, collected.attachments);
  if (missing !== null) {
    return fail('missingField', `ファイルの中身が壊れています(${missing} が見つかりません)。`);
  }
  const thumbnail = findEntry(entries, PCAD_THUMBNAIL_ENTRY);
  if (thumbnail === null) {
    return {
      ok: true,
      document: parsed.document,
      savedAt: parsed.savedAt,
      kind: parsed.kind,
      lengthUnit: parsed.lengthUnit,
      toolDefaults: parsed.toolDefaults,
      attachments: collected.attachments,
    };
  }
  return {
    ok: true,
    document: parsed.document,
    savedAt: parsed.savedAt,
    kind: parsed.kind,
    lengthUnit: parsed.lengthUnit,
    toolDefaults: parsed.toolDefaults,
    attachments: collected.attachments,
    thumbnailPng: thumbnail,
  };
}

/**
 * 読んだファイルがひな形(`.pcadt`)か(FR-814、§0.a-0.35)。
 *
 * **拡張子ではなく封筒の種別で判断する**(名前はいくらでも変えられる)。ここに
 * 述語を置いておくと、「どの種別がひな形か」を知っているのが `schema.ts` と
 * この 1 行だけで済み、呼び出し側(ui のタスク33、model の `openTemplate` へ渡す真偽)が
 * 種別の文字列を写さずに書ける。
 *
 * ひな形でないファイルを断るのは呼び出し側で、**断りのコードは増やさない**
 * ——`.pcad` の種別違いと同じ `file.error.wrongKind` の文言に寄せる
 * (`docs/報告記録.md` 2026-09-04 01:40 の③、統括の決定 2026-09-06 09:0x)。
 */
export function isTemplateKind(kind: PcadDocumentKind): boolean {
  return kind === PCAD_TEMPLATE_KIND;
}

// ---------------------------------------------------------------------------
// アセンブリ(`.pcada`)の ZIP コンテナ(P7 §2.2、タスク3)
// ---------------------------------------------------------------------------

export interface WritePcadaFileOptions {
  /** 保存時刻(ISO 8601)。検査で時刻を固定するための口。既定は今の時刻。 */
  readonly savedAt?: string;
  /** サムネイルの PNG。作れなかったときは渡さない(そのときは ZIP へ入れない)。 */
  readonly thumbnailPng?: Uint8Array;
  /** 抱き込んだ部品の素性(要件§8)。`parts` と揃えて渡すのは呼び出し側の責任。 */
  readonly partFiles?: readonly PcadPartFile[];
  /**
   * 抱き込んだ部品文書。鍵は `parts/<ref>.json` の `<ref>`(= `ComponentSource.partRef`)。
   *
   * **文書が指しているものを渡す責任は呼び出し側にある**(`writePcadFile` の添付と同じ)。
   * 書き出しは断れない(戻り値がバイト列だけ)ので、ここで文書と突き合わせて落とさない。
   * 欠けているほうは読み手が「部品が見つかりません」で断る。
   */
  readonly parts?: ReadonlyMap<string, PartDocument>;
  /** 部品ごとの再導出できない添付。鍵は `parts` と同じ `partRef`。 */
  readonly partAttachments?: ReadonlyMap<string, PcadAttachments>;
}

/**
 * 抱き込んだ部品文書を ZIP のエントリへ並べる。**名前の順に並べる**(表の並び順は作った側の
 * 都合で変わるので、同じ中身から同じバイト列ができる約束を守るために毎回そろえる)。
 *
 * 1 つ 1 つの中身は**部品の `document.json` とまったく同じ文字列**にする
 * (`serializeDocument`)。こうしておくと読み手が既存の `parseDocument` をそのまま使え、
 * 部品文書の読み書きを 2 か所に持たずに済む(§2.3)。**保存時刻はアセンブリの封筒と
 * 同じ値**を書く——抱き込んだ部品ごとに違う時刻を入れると、同じアセンブリから
 * 書き出したバイト列が呼ぶたびに変わってしまうため(決定性。このファイル冒頭)。
 */
function appendParts(
  entries: Zippable,
  parts: ReadonlyMap<string, PartDocument>,
  savedAt: string,
): void {
  for (const [ref, document] of sortedEntries(parts)) {
    const text = serializeDocument(document, { savedAt });
    entries[`${PCAD_PART_ENTRY_PREFIX}${ref}${PCAD_PART_ENTRY_SUFFIX}`] = [
      strToU8(text),
      { level: DOCUMENT_LEVEL, mtime: FIXED_ENTRY_MTIME },
    ];
  }
}

/** 部品添付を一時表へ集め、完全なエントリ名の順に本表へ足す。 */
async function appendPartAttachments(
  entries: Zippable,
  partAttachments: ReadonlyMap<string, PcadAttachments>,
): Promise<void> {
  const staged: Zippable = {};
  for (const [ref, attachments] of sortedEntries(partAttachments)) {
    const prefix = `${PCAD_PART_ENTRY_PREFIX}${ref}/`;
    const digest = await attachmentsDigestOf(attachments);
    staged[`${prefix}${PCAD_PART_ATTACHMENTS_DIGEST_ENTRY}`] = [
      strToU8(digest),
      { level: DOCUMENT_LEVEL, mtime: FIXED_ENTRY_MTIME },
    ];
    appendAttachments(staged, attachments, prefix);
  }
  for (const name of Object.keys(staged).sort()) {
    const entry = staged[name];
    if (entry !== undefined) {
      entries[name] = entry;
    }
  }
}

/**
 * アセンブリ文書(と、あればサムネイル・抱き込んだ部品)を `.pcada` のバイト列にする。
 * 例外を投げない。
 *
 * エントリの並びは `document.json` → `thumbnail.png` → `parts/*.json`(名前順) →
 * `parts/<ref>/...`(完全な名前順)で固定する(決定性)。
 */
export async function writePcadaFile(
  document: AssemblyDocument,
  options: WritePcadaFileOptions = {},
): Promise<Uint8Array> {
  // 封筒と抱き込んだ部品で**同じ保存時刻**を使うため、既定値をここで 1 回だけ決める。
  const savedAt = options.savedAt ?? new Date().toISOString();
  const text = writeAssemblyDocument(document, { savedAt, partFiles: options.partFiles });
  const entries: Zippable = {
    [PCAD_DOCUMENT_ENTRY]: [strToU8(text), { level: DOCUMENT_LEVEL, mtime: FIXED_ENTRY_MTIME }],
  };
  if (options.thumbnailPng !== undefined) {
    entries[PCAD_THUMBNAIL_ENTRY] = [
      options.thumbnailPng,
      { level: THUMBNAIL_LEVEL, mtime: FIXED_ENTRY_MTIME },
    ];
  }
  if (options.parts !== undefined) {
    appendParts(entries, options.parts, savedAt);
  }
  if (options.partAttachments !== undefined) {
    await appendPartAttachments(entries, options.partAttachments);
  }
  return zipSync(entries);
}

export type ReadPcadaFileResult =
  | {
      readonly ok: true;
      readonly document: AssemblyDocument;
      readonly savedAt: string;
      /** 抱き込んだ部品の素性(要件§8)。元のファイルを追いかける判断は上の層がする。 */
      readonly partFiles: readonly PcadPartFile[];
      /**
       * 抱き込んだ部品文書。鍵は `parts/<ref>.json` の `<ref>`。
       * **`partFiles` に素性が無いものも捨てずに返す**(`writePcadFile` の添付と同じ理由。
       * この版の読み手がまだ知らない参照を往復で失わないため)。
       */
      readonly parts: ReadonlyMap<string, PartDocument>;
      /** 抱き込んだ部品ごとの添付。鍵は `partRef`。 */
      readonly partAttachments: ReadonlyMap<string, PcadAttachments>;
      /** 読み込み時に照合済みの添付 SHA-256。古いファイルでは内容から補う。 */
      readonly partAttachmentDigests: ReadonlyMap<string, string>;
      /** サムネイルが入っていたときだけ付く。 */
      readonly thumbnailPng?: Uint8Array;
    }
  | { readonly ok: false; readonly error: ReadPcadFileError };

function failPcada(code: ReadPcadFileErrorCode, message: string): ReadPcadaFileResult {
  return { ok: false, error: { code, message } };
}

/**
 * ZIP のエントリから抱き込んだ部品文書を取り出す。1 つでも読めなければ、そのエントリ名と
 * 中身の理由を添えて断る(**読めない欄が 1 つでもあればファイル全体を断る**。
 * `documentJson.ts` 冒頭の決めごと)。**エラーコードは中身の理由をそのまま通す**
 * (増やさない。`docs/報告記録.md` 2026-09-04 01:40 の③)。
 */
type CollectPartsResult =
  | { readonly ok: true; readonly parts: ReadonlyMap<string, PartDocument> }
  | { readonly ok: false; readonly error: ReadPcadFileError };

function collectParts(entries: ReadonlyMap<string, Uint8Array>): CollectPartsResult {
  const parts = new Map<string, PartDocument>();
  for (const [name, bytes] of entries) {
    const ref = attachmentRef(name, PCAD_PART_ENTRY_PREFIX, PCAD_PART_ENTRY_SUFFIX);
    if (ref === null) {
      // どれでもない名前は知らないエントリとして読み飛ばす(P2 からの決めごと)。
      continue;
    }
    const text = decodeUtf8(bytes);
    if (text === null) {
      return { ok: false, error: { code: 'notZip', message: NOT_ZIP_MESSAGE } };
    }
    const parsed = parseDocument(text);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          code: parsed.error.code,
          message: `抱き込んだ部品を読めませんでした(${name})。${parsed.error.message}`,
        },
      };
    }
    parts.set(ref, parsed.document);
  }
  return { ok: true, parts };
}

interface PartAttachmentEntries {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly storedDigest?: string;
}

/** `parts/<ref>/...` を部品ごとの相対名へ戻す。未知の相対名は後段が読み飛ばす。 */
function collectPartAttachmentEntries(
  entries: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, PartAttachmentEntries> {
  const grouped = new Map<string, { entries: Map<string, Uint8Array>; storedDigest?: string }>();
  for (const [name, bytes] of entries) {
    if (!name.startsWith(PCAD_PART_ENTRY_PREFIX)) {
      continue;
    }
    const relative = name.slice(PCAD_PART_ENTRY_PREFIX.length);
    const separator = relative.indexOf('/');
    if (separator <= 0) {
      continue;
    }
    const ref = relative.slice(0, separator);
    const attachmentName = relative.slice(separator + 1);
    const isKnownAttachment =
      attachmentRef(attachmentName, PCAD_SHAPE_ENTRY_PREFIX, PCAD_SHAPE_ENTRY_SUFFIX) !== null ||
      attachmentRef(attachmentName, PCAD_MESH_ENTRY_PREFIX, PCAD_MESH_ENTRY_SUFFIX) !== null ||
      attachmentRef(attachmentName, PCAD_CANVAS_ENTRY_PREFIX, PCAD_CANVAS_ENTRY_SUFFIX) !== null;
    if (attachmentName !== PCAD_PART_ATTACHMENTS_DIGEST_ENTRY && !isKnownAttachment) {
      continue;
    }
    const current = grouped.get(ref) ?? { entries: new Map<string, Uint8Array>() };
    if (attachmentName === PCAD_PART_ATTACHMENTS_DIGEST_ENTRY) {
      current.storedDigest = decodeUtf8(bytes) ?? '';
    } else {
      current.entries.set(attachmentName, bytes);
    }
    grouped.set(ref, current);
  }
  return grouped;
}

interface CollectedPartAttachments {
  readonly attachments: ReadonlyMap<string, PcadAttachments>;
  readonly digests: ReadonlyMap<string, string>;
}

async function collectPartAttachments(
  entries: ReadonlyMap<string, Uint8Array>,
  parts: ReadonlyMap<string, PartDocument>,
): Promise<CollectedPartAttachments | ReadPcadFileError> {
  const grouped = collectPartAttachmentEntries(entries);
  const refs = new Set<string>([...parts.keys(), ...grouped.keys()]);
  const attachments = new Map<string, PcadAttachments>();
  const digests = new Map<string, string>();
  let allocatedMeshBytes = 0;
  for (const ref of [...refs].sort()) {
    const group = grouped.get(ref);
    const collected = collectAttachments(
      group?.entries ?? new Map(),
      IO_LIMITS.meshAllocationBytes - allocatedMeshBytes,
    );
    if (collected.tooLargeMeshEntry !== null) {
      return { code: 'invalidField', message: ARCHIVE_TOO_LARGE_MESSAGE };
    }
    if (collected.brokenMeshEntry !== null) {
      return {
        code: 'invalidField',
        message: `ファイルの中身が壊れています(${PCAD_PART_ENTRY_PREFIX}${ref}/${collected.brokenMeshEntry} の形が違います)。`,
      };
    }
    allocatedMeshBytes += collected.allocatedMeshBytes;
    const document = parts.get(ref);
    if (document !== undefined) {
      const missing = findMissingAttachment(document, collected.attachments);
      if (missing !== null) {
        return {
          code: 'missingField',
          message: `ファイルの中身が壊れています(${PCAD_PART_ENTRY_PREFIX}${ref}/${missing} が見つかりません)。`,
        };
      }
    }
    const digest = await attachmentsDigestOf(collected.attachments);
    const hasAttachmentEntries = (group?.entries.size ?? 0) > 0;
    if (group?.storedDigest === undefined && hasAttachmentEntries) {
      return {
        code: 'missingField',
        message: `ファイルの中身が壊れています(${PCAD_PART_ENTRY_PREFIX}${ref}/${PCAD_PART_ATTACHMENTS_DIGEST_ENTRY} が見つかりません)。`,
      };
    }
    if (group?.storedDigest !== undefined && group.storedDigest !== digest) {
      return {
        code: 'missingField',
        message: `ファイルの中身が壊れています(${PCAD_PART_ENTRY_PREFIX}${ref} の添付ダイジェストが一致しません)。`,
      };
    }
    attachments.set(ref, collected.attachments);
    digests.set(ref, digest);
  }
  return { attachments, digests };
}

/**
 * 文書が指している部品がそろっているかを確かめ、欠けている 1 つ目の `partRef` を返す
 * (そろっていれば null)。
 *
 * 欠けたまま開くと、その部品だけ形の無いインスタンスになって組み立てが通らない。
 * 読み込みの時点で断ったほうが、何が起きたかを利用者へ伝えられる(FR-504。
 * `.pcad` の添付が欠けたときとまったく同じ判断)。
 *
 * **サブアセンブリ(`assemblyRef`)と規格部品はここでは見ない。** 前者の中身は
 * アセンブリ文書で、読み手が別(P7 タスク36・37 の担当)。後者は寸法表から組み立てるので
 * 抱き込む文書がそもそも無い(§0.a-0.35)。
 */
function findMissingPart(
  document: AssemblyDocument,
  parts: ReadonlyMap<string, PartDocument>,
): string | null {
  for (const component of document.components) {
    if (component.source.kind === 'part' && !parts.has(component.source.partRef)) {
      return component.source.partRef;
    }
  }
  return null;
}

/**
 * `.pcada` のバイト列からアセンブリ文書と抱き込んだ部品を取り出す。
 * 壊れていても例外を投げず、日本語の理由を返す(FR-504、NFR-RE-1)。
 */
export interface ReadPcadaFileOptions {
  /** 小さな上限を注入し、部品名前空間にも共通の展開量制限が効くことを検査する口。 */
  readonly limits?: ArchiveReadLimits;
}

export async function readPcadaFile(
  bytes: Uint8Array,
  options: ReadPcadaFileOptions = {},
): Promise<ReadPcadaFileResult> {
  const archive = readArchive(bytes, {
    shouldExtract: isPcadaArchiveEntry,
    limits: options.limits,
  });
  if (!archive.ok) {
    const message =
      archive.error.kind === 'compressedInput' ||
      archive.error.kind === 'entryCount' ||
      archive.error.kind === 'entryExpanded' ||
      archive.error.kind === 'totalExpanded'
        ? archive.error.reason
        : NOT_ZIP_MESSAGE;
    return failPcada('notZip', message);
  }
  const entries = archive.entries;
  const documentEntry = findEntry(entries, PCAD_DOCUMENT_ENTRY);
  if (documentEntry === null) {
    return failPcada('missingDocument', MISSING_DOCUMENT_MESSAGE);
  }
  const text = decodeUtf8(documentEntry);
  if (text === null) {
    return failPcada('notZip', NOT_ZIP_MESSAGE);
  }
  const parsed: ReadAssemblyDocumentResult = readAssemblyDocument(text);
  if (!parsed.ok) {
    // 中身の理由(版が古い・種別が違う・欄が壊れている等)はそのまま通す。
    return { ok: false, error: parsed.error };
  }
  const collected = collectParts(entries);
  if (!collected.ok) {
    return { ok: false, error: collected.error };
  }
  const missing = findMissingPart(parsed.document, collected.parts);
  if (missing !== null) {
    return failPcada(
      'missingField',
      `部品が見つかりません(${PCAD_PART_ENTRY_PREFIX}${missing}${PCAD_PART_ENTRY_SUFFIX})。`,
    );
  }
  const collectedAttachments = await collectPartAttachments(entries, collected.parts);
  if ('code' in collectedAttachments) {
    return { ok: false, error: collectedAttachments };
  }
  const thumbnail = findEntry(entries, PCAD_THUMBNAIL_ENTRY);
  if (thumbnail === null) {
    return {
      ok: true,
      document: parsed.document,
      savedAt: parsed.savedAt,
      partFiles: parsed.partFiles,
      parts: collected.parts,
      partAttachments: collectedAttachments.attachments,
      partAttachmentDigests: collectedAttachments.digests,
    };
  }
  return {
    ok: true,
    document: parsed.document,
    savedAt: parsed.savedAt,
    partFiles: parsed.partFiles,
    parts: collected.parts,
    partAttachments: collectedAttachments.attachments,
    partAttachmentDigests: collectedAttachments.digests,
    thumbnailPng: thumbnail,
  };
}
