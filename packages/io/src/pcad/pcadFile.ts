import type { ArchiveReadSource } from './archiveReadSource.js';
import { fileFailure as fail } from './codedFailure.js';
import { sheetFlatReferenceIssue, canonicalDrawingSourceText, crossLevelGearTreeFailure, crossLevelCamTreeFailure } from '@pointercad/model';
/**
 * `.pcad` / `.pcada` の ZIP コンテナの読み書き
 * (要件§8、FR-801)。
 *
 * `.pcad` は ZIP で、中に次のものを入れる。
 *  - `document.json` … 部品文書の封筒(documentJson.ts が作る文字列を UTF-8 にしたもの)。圧縮する。
 *  - `thumbnail.png` … 画面の縮小画像。作れなければ入れない。PNG は既に圧縮済みなので無圧縮で入れる。
 *  - **添付**(版 7 から)
 *    - `shapes/<shapeRef>.brep` … 読み込んだ B-rep(`importedSolid` が指す。OCCT の `BinTools` のバイト列)。
 *    - `meshes/<meshRef>.bin` … 読み込んだ三角形(`importedMesh` が指す。下の `PCM1` の並び)。
 *    - `canvases/<id>.png` … 下絵の画像(FR-332)。
 *
 * **添付は `rules/04`「導出できるものは保存しない」の承認済みの例外**である(例外①、
 * 例外②、例外③)。読み込んだ形も下絵も**再計算では導出できない**
 * ——元のファイルが手元から消えたら二度と作れない——ので、`.pcad` へ抱き込む。
 * `document.json` には id と素性だけを書き、バイト列は 1 バイトも入れない
 * (10 万三角形を JSON にすると 10MB を超える)。
 *
 * 例外④: 梁の静解析結果を任意の analysis-results/<analysisId>.json に圧縮して保存する。
 * 再解析に時間がかかるため、保存した入力の SHA-256 を照合できた結果だけを復元する。
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
 * **アセンブリ(`.pcada`)も同じ ZIP の作りにする**。違うのは
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
  importedShapeOf,
  createPartDocumentBundle,
  createAssemblyDocumentBundle,
  detectSubAssemblyProblem,
  MAX_SUB_ASSEMBLY_DEPTH,
  partAttachmentReferences,
  partLibraryOfBundle,
  type DocumentBundle,
  type AssemblyDocument,
  type DrawingDocument,
  type DrawingSourceInput,
  type AssemblyDocumentBundle,
  type EmbeddedPartAttachments,
  type EmbeddedPartMesh,
  type LengthUnit,
  type PartDocument,
  type PartLibrary,
  type SubAssemblyProblem,
} from '@pointercad/model';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { decodeUtf8 } from '../decodeUtf8.js';
import { hasSteppedZipEntry, restoreZipStoredPrefixes, zipEntriesPartsAsync, zipEntriesSync, ZIP_STEP_BYTES, type ZipChunkedBytes, type ZipStepEntry, type ZipStepsControl } from './zipSteps.js';

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
import { parseDrawing, serializeDrawing } from './drawingJson.js';
import {
  PCAD_TEMPLATE_KIND,
  type PcadDocumentKind,
  type PcadPartFile,
  type PcadToolDefaults,
} from './schema.js';
import {
  ARCHIVE_TOO_LARGE_MESSAGE,
  openArchiveSource,
  readArchive,
  type ArchiveReadError,
  type ArchiveReadLimits,
} from './readArchive.js';
import type { SavedAnalysisResult } from '@pointercad/model/beam-analysis';
import { analysisResultBinding } from './analysisResultBinding.js';
import { readAnalysisResult, serializeAnalysisResult, type AnalysisResultIssue } from './codecs/analysisResult.js';
import { SOLID_RESULT_MAX_BYTES } from './codecs/solidResultBinary.js';
import { zipCrc32 } from './zipCrc32.js';
import { isSafeZipEntryName, zipDirectory, ZipDirectoryError } from './zipDirectory.js';

/** 部品文書を入れる ZIP のエントリ名(要件§8)。 */
export const PCAD_DOCUMENT_ENTRY = 'document.json';
/** サムネイルを入れる ZIP のエントリ名(要件§8)。 */
export const PCAD_THUMBNAIL_ENTRY = 'thumbnail.png';
const PCAD_ANALYSIS_RESULT_ENTRY_PREFIX = 'analysis-results/';
const PCAD_ANALYSIS_RESULT_ENTRY_SUFFIX = '.json';
const RESULT_BINARY_SUFFIX = '.bin';
/** 図面が抱き込む参照元文書のエントリ名。 */
export const PCAD_SOURCE_ENTRY_PREFIX = 'source/';
export const PCAD_SOURCE_ENTRY_SUFFIX = '.json';

/**
 * 添付のエントリ名の前後。名前は `<前>` + 参照の文字列 + `<後>` でできている。
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
 * アセンブリ(`.pcada`)が抱き込む部品文書のエントリ名の前後。
 * 中身は**部品の `document.json` とまったく同じ文字列**(封筒つき)なので、
 * 読み書きは `serializeDocument` / `parseDocument` をそのまま使う。
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
 * **3MF の書き出し(`threemf/writeThreeMf.ts`)も同じ値を使う**(
 * 決定性の決めを 2 か所に書かないため)ので、このファイルから輸出している。
 */
export const FIXED_ENTRY_MTIME = new Date(1980, 0, 2, 12, 0, 0, 0);

/** `document.json` の圧縮の強さ。6 は fflate の既定で、速さと大きさの釣り合いが良い。 */
const DOCUMENT_LEVEL = 6;
/** `thumbnail.png` の圧縮の強さ。PNG は既に圧縮済みなので、掛け直さない。 */
const THUMBNAIL_LEVEL = 0;
/**
 * 添付の圧縮の強さ(**実測して決めた**)。
 *
 * `.brep` と `.bin` は素の数値の並びなので deflate が良く効く
 * (実測: 20³ の箱の `BinTools` は 4,494 → 694 バイト。
 * 10 万三角形の `.bin` は 2,400,012 → 実測値を `pcadFile.test.ts` に記録)。
 * `.png` は既に圧縮済みなので `thumbnail.png` と同じく掛け直さない。
 */
const ATTACHMENT_BINARY_LEVEL = 6;
const ATTACHMENT_IMAGE_LEVEL = 0;

/**
 * ZIP へ入れる 1 項目(中身と圧縮の指定)。
 *
 * **文書から項目を作る処理と、最後の圧縮を分ける**。図面の束
 * (`drawingBundle.ts`)は参照元の部品・アセンブリの項目をこの形のまま結合し、
 * 圧縮してから展開し直す往復をしない。
 */
export type PcadZipEntry = ZipStepEntry;
/**
 * 項目の表。**挿入の順がそのまま ZIP の項目の順になる**(同じ名前を入れ直したときは
 * 最初の位置のまま中身だけ替わる。以前の平たいオブジェクトと同じ振る舞い)。
 */
export type PcadZipEntries<Extra = never> = Map<string, ZipStepEntry<Uint8Array | Extra>>;
type SaveEntryBytes = Uint8Array | ZipChunkedBytes;
type MeshEntryEncoder<Extra> = (mesh: ImportedMeshBytes) => Uint8Array | Extra | null;

function zipEntry<Bytes extends SaveEntryBytes>(bytes: Bytes, level: 0 | 6): ZipStepEntry<Bytes> {
  return [bytes, { level, mtime: FIXED_ENTRY_MTIME }];
}

/** A ZIP with isolated prefixes can use the one-shot packer only within one chunk's memory budget. */
function needsSteppedPcadZip(entries: ReadonlyMap<string, PcadZipEntry>): boolean {
  if (hasSteppedZipEntry(entries)) return true;
  let total = 0;
  let hasPrefix = false;
  for (const [bytes, , prefix] of entries.values()) {
    total += bytes.length;
    hasPrefix ||= prefix !== undefined;
  }
  return hasPrefix && total > ZIP_STEP_BYTES;
}

/**
 * 項目の表を**1 回だけ**圧縮して ZIP のバイト列にする。`.pcad` 系の書き手が
 * `zipSync` を呼ぶのはここだけにする(`zipPasses.test.ts` が回数と置き場所を照合する)。
 */
export function zipPcadEntries(entries: ReadonlyMap<string, PcadZipEntry>): Uint8Array {
  // 1MiB を超える項目は保存 Worker と同じ区切りで圧縮する(`zipSteps.ts`。取消を1秒以内に効かせる)。
  if (needsSteppedPcadZip(entries)) return zipEntriesSync(entries);
  const zippable: Zippable = {};
  let hasPrefix = false;
  for (const [name, [bytes, options, prefix]] of entries) {
    hasPrefix ||= prefix !== undefined;
    const payload = prefix === undefined ? bytes : bytes.subarray(prefix);
    Object.defineProperty(zippable, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: [payload, options],
    });
  }
  const packed = zipSync(zippable);
  return hasPrefix ? restoreZipStoredPrefixes(entries, packed) : packed;
}

/**
 * 保存 Worker の圧縮。順につなぐと `zipPcadEntries` と同じバイト列になる部分の並びを作り、1MiB を超える項目は
 * 1MiB ごとに処理を返す(Worker の終了要求と取消をその間に受け付ける)。小さい ZIP は一括の書き手の出力 1 つ。
 */
export async function zipPcadEntriesPartsAsync(entries: ReadonlyMap<string, PcadZipEntry>,
  control: ZipStepsControl = {}): Promise<Uint8Array[]> {
  control.signal?.throwIfAborted();
  return needsSteppedPcadZip(entries) ? zipEntriesPartsAsync(entries, control) : [zipPcadEntries(entries)];
}

/**
 * 読み込んだ三角形の中身(`meshes/<meshRef>.bin` の中身)。
 *
 * 位置・法線は頂点 1 つにつき 3 つ、添字は三角形 1 つにつき 3 つ。
 * **B-rep にはしない**ので、この 3 本の配列がそのまま形の正本になる。
 */
export type ImportedMeshBytes = EmbeddedPartMesh;

/**
 * `.pcad` に入っている添付の表。鍵は**エントリ名ではなく参照の文字列**
 * (`ImportedSolidFeature.shapeRef` / `ImportedMeshFeature.meshRef` / 下絵の id)なので、
 * `shapes` は**そのまま `PartRecomputeOptions.importedShapes` へ渡せる**。
 *
 * 3 つとも「空の表」を持つ(欄ごと無くさない)。読み手が毎回 `undefined` を確かめずに
 * 済み、添付を持たない `.pcad`(版 6 までのファイル)も同じ形で扱えるため。
 */
export type PcadAttachments = EmbeddedPartAttachments & {
  /** 各原本の SHA-256。古い ZIP でも読み込み時に計算して補う。 */
  readonly shapeDigests?: ReadonlyMap<string, string>;
};

/** 添付を 1 つも持たない表。版 6 までのファイルを読んだときの値でもある。 */
export function emptyPcadAttachments(): PcadAttachments {
  return { shapes: new Map(), meshes: new Map(), canvases: new Map() };
}

interface SavedResultFields {
  readonly analysisResults?: ReadonlyMap<string, SavedAnalysisResult>;
  readonly analysisResultIssue?: AnalysisResultIssue;
}

interface ResultWriteOptions {
  readonly onAnalysisResultIssue?: (analysisId: string, issue: AnalysisResultIssue) => void;
}

export interface WriteDocumentBundleOptions extends ResultWriteOptions {
  readonly savedAt?: string;
  readonly thumbnailPng?: Uint8Array;
}

/** 文書と原本を既存のZIP形式へ平坦化する。封筒とparts/*.jsonの形式は変えない。 */
export async function writeDocumentBundle(
  bundle: DocumentBundle,
  options: WriteDocumentBundleOptions = {},
): Promise<Uint8Array> {
  // 部品は以前と同じく待たずに書く(完了までの待ちの段数を変えない。自動保存の検査が段数に依る)。
  if (bundle.kind === 'part') {
    return zipPcadEntries(pcadEntries(bundle.document, { ...options, attachments: bundle.attachments, analysisResults: bundle.analysisResults }));
  }
  return zipPcadEntries(await documentBundleEntries(bundle, options));
}

/** `writeDocumentBundle` の圧縮前の項目。図面の束が項目のまま抱き込むための口。 */
export function documentBundleEntries(
  bundle: DocumentBundle,
  options: WriteDocumentBundleOptions = {},
): Promise<PcadZipEntries> {
  return bundleEntriesWithMeshes<never>(bundle, options, encodeImportedMeshBytes);
}

export async function bundleEntriesWithMeshes<Extra extends ZipChunkedBytes>(
  bundle: DocumentBundle,
  options: WriteDocumentBundleOptions,
  encodeMesh: MeshEntryEncoder<Extra>,
  digestAttachments: typeof attachmentsDigestOf = attachmentsDigestOf,
): Promise<PcadZipEntries<Extra>> {
  if (bundle.kind === 'part') {
    return partEntriesWithMeshes(bundle.document, { ...options, attachments: bundle.attachments, analysisResults: bundle.analysisResults }, encodeMesh);
  }
  // 現行pcadaで原本を持つのは抱き込んだ部品。保存できない原本を黙って捨てない。
  if (bundle.attachments.shapes.size + bundle.attachments.meshes.size + bundle.attachments.canvases.size > 0) {
    throw new Error('Assembly attachments must belong to an embedded part');
  }
  const library = partLibraryOfBundle(bundle);
  const pending = pcadaEntries(bundle.document, {
    ...options,
    partFiles: library.partFiles,
    parts: library.parts,
    assemblies: library.assemblies,
    partAttachments: library.attachments,
    analysisResults: bundle.analysisResults,
  }, encodeMesh, digestAttachments);
  const legacy = legacyAssemblyZipLayouts.get(bundle);
  if (legacy === undefined || options.savedAt !== legacy.savedAt) return pending;
  const entries = await pending;
  stripLegacyAssemblyPrefixes(entries, legacy);
  return entries;
}

export type ReadDocumentBundleResult =
  | {
      readonly ok: true;
      readonly bundle: DocumentBundle;
      readonly analysisResultIssue?: AnalysisResultIssue;
      readonly savedAt: string;
      readonly thumbnailPng?: Uint8Array;
    }
  | { readonly ok: false; readonly error: ReadPcadFileError };

interface LegacyAssemblyZipLayout {
  readonly savedAt: string;
  readonly entries: ReadonlyMap<string, { readonly length: number; readonly crc: number; readonly method: 0 | 8 }>;
}

// Only the bundle returned by the successful byte reader carries the layout. No archive bytes are retained.
const legacyAssemblyZipLayouts = new WeakMap<DocumentBundle, LegacyAssemblyZipLayout>();

function hasIsolatedTimestamp(compressed: Uint8Array, savedAt: string): boolean {
  // The current writer starts with a byte-aligned non-final stored block through savedAt.
  if (compressed.length < 6 || compressed[0] !== 0 || compressed[5] !== 0x7b) return false;
  const length = compressed[1] + 256 * compressed[2];
  const inverse = compressed[3] + 256 * compressed[4];
  const suffix = strToU8(`\n  "savedAt": ${JSON.stringify(savedAt)}`);
  return (length ^ inverse) === 65_535 && length >= suffix.length && 5 + length < compressed.length
    && suffix.every((byte, index) => compressed[5 + length - suffix.length + index] === byte);
}

function rememberLegacyAssemblyZip(bytes: Uint8Array, result: ReadDocumentBundleResult): void {
  if (!result.ok || result.bundle.kind !== 'assembly' || bytes.length > ZIP_STEP_BYTES) return;
  try {
    const regions = zipDirectory(bytes, IO_LIMITS.archiveEntryCount);
    const document = regions.find(region => region.name === PCAD_DOCUMENT_ENTRY);
    if (document?.method !== 8 || hasIsolatedTimestamp(document.compressed, result.savedAt)
      || regions.reduce((total, region) => total + region.expandedSize, 0) > ZIP_STEP_BYTES) return;
    legacyAssemblyZipLayouts.set(result.bundle, {
      savedAt: result.savedAt, entries: new Map(regions.map(({ name, method, expandedSize, crc32 }) =>
        [name, { method, length: expandedSize, crc: crc32 }])),
    });
  } catch (error) {
    if (!(error instanceof ZipDirectoryError)) throw error;
    // Compatibility metadata is optional. The primary reader already validated the file.
  }
}

function stripLegacyAssemblyPrefixes<Extra extends ZipChunkedBytes>(
  entries: PcadZipEntries<Extra>, layout: LegacyAssemblyZipLayout,
): void {
  if (entries.size !== layout.entries.size) return;
  const original = layout.entries.entries();
  for (const [name, [bytes, options]] of entries) {
    const step = original.next();
    if (step.done === true || step.value[0] !== name || !(bytes instanceof Uint8Array)) return;
    const expected = step.value[1];
    if (expected.method !== (options.level === 0 ? 0 : 8) || expected.length !== bytes.length
      || expected.crc !== zipCrc32(bytes)) return;
  }
  for (const [name, [bytes, options, prefix]] of entries) {
    if (prefix !== undefined) entries.set(name, [bytes, options]);
  }
}

/** 種別を明示して既存の読み手を通す。未来版や欠損の理由は既存の値のまま返す。 */
export async function readDocumentBundle(
  bytes: Uint8Array,
  kind: DocumentBundle['kind'],
  options: ReadPcadaFileOptions = {},
): Promise<ReadDocumentBundleResult> {
  if (kind === 'part') return partBundleResult(readPcadFile(bytes, options));
  // 待ちの段数を以前と同じに保つため、ダイジェストを待つ所だけをこの関数の中に置く。
  const result = await readPcadaFile(bytes, options);
  if (!result.ok) return result;
  const read = assemblyBundleOf(result, await partFilesWithDigests(result));
  rememberLegacyAssemblyZip(bytes, read);
  return read;
}

/**
 * `readArchive` が取り出した項目の表から、部品・アセンブリの束を読む(図面の束の参照元)。
 *
 * ZIP を作り直して読み直さずに、`readDocumentBundle` と同じ検査を通す。以前の図面の読み手は
 * 項目名を戻した ZIP を作り直していたので、そのときの項目名の検査(空・絶対パス等を断る)も
 * ここで同じ判定で行う。
 */
export async function readDocumentBundleEntries(
  entries: ReadonlyMap<string, Uint8Array>,
  kind: DocumentBundle['kind'],
): Promise<ReadDocumentBundleResult> {
  for (const name of entries.keys()) {
    if (!isSafeZipEntryName(name)) return { ok: false, error: { code: 'notZip', message: NOT_ZIP_MESSAGE } };
  }
  if (kind === 'part') return partBundleResult(readPcadEntries(pickEntries(entries, isPcadArchiveEntry)));
  const result = await readPcadaEntries(pickEntries(entries, isPcadaArchiveEntry));
  if (!result.ok) return result;
  return assemblyBundleOf(result, await partFilesWithDigests(result));
}

/** 読み手が取り出す名前だけを、元の順のまま残す(`readArchive` の `shouldExtract` と同じ選び方)。 */
function pickEntries(
  entries: ReadonlyMap<string, Uint8Array>,
  shouldExtract: (name: string) => boolean,
): ReadonlyMap<string, Uint8Array> {
  const picked = new Map<string, Uint8Array>();
  for (const [name, bytes] of entries) {
    if (shouldExtract(name)) picked.set(name, bytes);
  }
  return picked;
}

function partBundleResult(result: ReadPcadFileResult): ReadDocumentBundleResult {
  if (!result.ok) return result;
  return {
    ok: true,
    bundle: createPartDocumentBundle(result.document, result.attachments, result.analysisResults),
    ...(result.analysisResultIssue === undefined ? {} : { analysisResultIssue: result.analysisResultIssue }),
    savedAt: result.savedAt,
    thumbnailPng: result.thumbnailPng,
  };
}

type ReadPcadaFileSuccess = Extract<ReadPcadaFileResult, { readonly ok: true }>;
type EmbeddedPartFile = PartLibrary['partFiles'][number];

/** 素性へ照合済みの添付ダイジェストを付ける(古いファイルは空の添付の値で補う)。 */
function partFilesWithDigests(result: ReadPcadaFileSuccess): Promise<EmbeddedPartFile[]> {
  return Promise.all(result.partFiles.map(async (file) => ({
    ...file,
    attachmentsDigest: result.partAttachmentDigests.get(file.ref)
      ?? await attachmentsDigestOf(emptyPcadAttachments()),
  })));
}

function assemblyBundleOf(
  result: ReadPcadaFileSuccess,
  partFiles: readonly EmbeddedPartFile[],
): ReadDocumentBundleResult {
  return {
    ok: true,
    bundle: createAssemblyDocumentBundle(result.document, {
      partFiles,
      parts: result.parts,
      attachments: result.partAttachments,
      assemblies: result.assemblies,
    }, result.analysisResults),
    ...(result.analysisResultIssue === undefined ? {} : { analysisResultIssue: result.analysisResultIssue }),
    savedAt: result.savedAt,
    thumbnailPng: result.thumbnailPng,
  };
}

// ---------------------------------------------------------------------------
// `meshes/<id>.bin` の並び
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
 * **なぜ位置 → 法線 → 添字の順か:** 決めた並びをそのまま守る(表示は
 * 位置と法線を先に要り、添字は最後にあれば足りる)。
 *
 * 全体の長さは `12 + 12n + 12n + 12m` バイトになる(float32 も uint32 も 4 バイト × 3)。
 * 10 万三角形・頂点 5 万なら 2,400,012 バイト(見積もりと同じ)。
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
function meshCounts(mesh: ImportedMeshBytes): { readonly vertexCount: number; readonly triangleCount: number } | null {
  const vertexCount = mesh.positions.length / 3;
  const triangleCount = mesh.indices.length / 3;
  if (!Number.isInteger(vertexCount) || !Number.isInteger(triangleCount)) {
    return null;
  }
  if (mesh.normals.length !== mesh.positions.length) {
    return null;
  }
  return { vertexCount, triangleCount };
}

export function encodeImportedMeshBytes(mesh: ImportedMeshBytes): Uint8Array | null {
  const counts = importedMeshCounts(mesh);
  if (counts === null) {
    return null;
  }
  const { vertexCount, triangleCount } = counts;
  const bytes = new Uint8Array(counts.byteLength);
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

/** 三角形の頂点の数・三角形の数と、`meshes/<id>.bin` の全体の長さ。そろっていない三角形は `null`(書き手は項目ごと省く)。 */
function importedMeshCounts(mesh: ImportedMeshBytes): { vertexCount: number; triangleCount: number; byteLength: number } | null {
  const counts = meshCounts(mesh);
  if (counts === null) return null;
  return { ...counts,
    byteLength: MESH_HEADER_BYTES + mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength };
}

/** 区切りへ順に書く位置(A-10)。区切りは 1 つずつ、書く値が来た時に確保する。 */
interface MeshChunkCursor {
  readonly total: number;
  readonly chunks: Uint8Array[];
  view: DataView;
  at: number;
  allocated: number;
}

function nextMeshChunk(cursor: MeshChunkCursor): void {
  const chunk = new Uint8Array(Math.min(ZIP_STEP_BYTES, cursor.total - cursor.allocated));
  cursor.chunks.push(chunk);
  cursor.view = new DataView(chunk.buffer);
  cursor.at = 0;
  cursor.allocated += chunk.length;
}

/** 位置・法線(float32)か添字(uint32)の成分を、`encodeImportedMeshBytes` と同じ DataView の書き方で区切りへ続けて書く。 */
function writeMeshComponent(cursor: MeshChunkCursor, values: Float32Array | Uint32Array): void {
  let from = 0;
  while (from < values.length) {
    if (cursor.at === cursor.view.byteLength) nextMeshChunk(cursor);
    const part = values.subarray(from, from + Math.min(values.length - from, (cursor.view.byteLength - cursor.at) / 4));
    let at = cursor.at;
    if (part instanceof Float32Array) {
      for (const value of part) { cursor.view.setFloat32(at, value, MESH_LITTLE_ENDIAN); at += 4; }
    } else {
      for (const value of part) { cursor.view.setUint32(at, value, MESH_LITTLE_ENDIAN); at += 4; }
    }
    cursor.at = at;
    from += part.length;
  }
}

/**
 * 保存 Worker の持ち主の道で、三角形を `meshes/<id>.bin` の中身にする(A-10)。バイトは `encodeImportedMeshBytes` と同じで、
 * 項目の先頭から 1MiB ごとの独立した領域(最後だけ短い)に分けて書く。1MiB と全部の欄は 4 バイトの倍数なので、
 * 1 つの値が区切りをまたがない。成分(位置・法線・添字)を書き終えるたびに `onComponentWritten` を呼ぶ
 * (呼び出し側は、その成分の領域をほかに読む物が無ければ、ここで手放せる)。そろっていない三角形は `null`。
 */
function encodeImportedMeshChunks(mesh: ImportedMeshBytes,
  onComponentWritten: ((component: Float32Array | Uint32Array) => void) | undefined): ZipChunkedBytes | null {
  const counts = importedMeshCounts(mesh);
  if (counts === null) {
    return null;
  }
  const cursor: MeshChunkCursor = { total: counts.byteLength, chunks: [], view: new DataView(new ArrayBuffer(0)), at: 0, allocated: 0 };
  nextMeshChunk(cursor);
  new Uint8Array(cursor.view.buffer).set(MESH_MAGIC, 0);
  cursor.view.setUint32(4, counts.vertexCount, MESH_LITTLE_ENDIAN);
  cursor.view.setUint32(8, counts.triangleCount, MESH_LITTLE_ENDIAN);
  cursor.at = MESH_HEADER_BYTES;
  for (const component of [mesh.positions, mesh.normals, mesh.indices]) {
    writeMeshComponent(cursor, component);
    onComponentWritten?.(component);
  }
  if (cursor.allocated !== cursor.total || cursor.at !== cursor.view.byteLength) {
    throw new Error('三角形の区切りの長さが合いません。');
  }
  return { length: cursor.total, pending: cursor.chunks };
}

/** 持ち主の道で、1MiB を超える三角形だけを区切りの並びにする(1MiB 以下は今の道と同じ 1 本のバイト列)。 */
export function ownedMeshEntryBytes(mesh: ImportedMeshBytes,
  onComponentWritten: ((component: Float32Array | Uint32Array) => void) | undefined): Uint8Array | ZipChunkedBytes | null {
  const counts = importedMeshCounts(mesh);
  return counts !== null && counts.byteLength > ZIP_STEP_BYTES ? encodeImportedMeshChunks(mesh, onComponentWritten)
    : encodeImportedMeshBytes(mesh);
}

/**
 * `meshes/<id>.bin` のバイト列から三角形を取り出す。読めなければ `null`
 * (**例外を投げない**。NFR-RE-1)。
 *
 * マジック・長さ・確保予算に加え、位置と法線が finite であること、添字が頂点数の
 * 範囲内であることを確かめる。壊れた値を描画・計測へ渡さないため、1 つでも違えば
 * 添付全体を `null` で断る。
 */
function meshVertexIndexValid(value: number, vertexCount: number): boolean {
  return Number.isInteger(value) && value < vertexCount;
}

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
    if (!meshVertexIndexValid(value, vertexCount)) {
      return null;
    }
    indices[index] = value;
    offset += 4;
  }
  return { positions, normals, indices };
}

/** Archive owns this entire output buffer; public entry parsers retain borrowed semantics. */
function decodeOwnedArchiveMesh(bytes: Uint8Array): ImportedMeshBytes | null {
  const header = inspectImportedMeshBytes(bytes);
  if (header === null || !isMeshAllocationWithinLimit(header.vertexCount, header.triangleCount)) return null;
  const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  if (!little || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0
    || bytes.byteLength !== bytes.buffer.byteLength) return decodeImportedMeshBytes(bytes);
  const count = header.vertexCount * 3, indexCount = header.triangleCount * 3;
  const positions = new Float32Array(bytes.buffer, MESH_HEADER_BYTES, count);
  const normals = new Float32Array(bytes.buffer, MESH_HEADER_BYTES + count * 4, count);
  const indices = new Uint32Array(bytes.buffer, MESH_HEADER_BYTES + count * 8, indexCount);
  const mesh = { positions, normals, indices };
  return meshValuesValid(mesh, header.vertexCount) ? mesh : null;
}

function meshValuesValid(mesh: ImportedMeshBytes, vertexCount: number): boolean {
  for (const value of mesh.positions) if (!Number.isFinite(value)) return false;
  for (const value of mesh.normals) if (!Number.isFinite(value)) return false;
  for (const value of mesh.indices) if (!meshVertexIndexValid(value, vertexCount)) return false;
  return true;
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

export interface WritePcadFileOptions extends ResultWriteOptions {
  readonly analysisResults?: ReadonlyMap<string, SavedAnalysisResult>;
  /** 保存時刻(ISO 8601)。検査で時刻を固定するための口。既定は今の時刻。 */
  readonly savedAt?: string;
  /** サムネイルの PNG。作れなかったときは渡さない(そのときは ZIP へ入れない)。 */
  readonly thumbnailPng?: Uint8Array;
  /**
   * 封筒に書く種別。既定は部品、ひな形(`.pcadt`)のときだけ
   * `PCAD_TEMPLATE_KIND` を渡す。ZIP の作りは種別で 1 文字も変わらない。
   */
  readonly kind?: PcadDocumentKind;
  /**
   * ひな形が持ち運ぶ表示の長さの単位(FR-814)。
   * **ひな形として書き出すときだけ渡す。** 渡さなければ封筒にこの欄は出ない
   * (部品の `.pcad` のバイト列はひな形の欄を足す前と 1 バイトも変わらない)。
   */
  readonly lengthUnit?: LengthUnit;
  /** ひな形が持ち運ぶ道具の既定値(FR-814)。`lengthUnit` と同じ扱い。 */
  readonly toolDefaults?: PcadToolDefaults;
  /**
   * 添付。渡さなければ添付のエントリは 1 つも入らない。
   *
   * **文書が参照しているものだけを渡す責任は呼び出し側にある。** ここで文書と突き合わせて
   * 落とさないのは、①書き出しは断れない(戻り値がバイト列だけ)、②未参照の添付を捨てると
   * 「まだ欄になっていない下絵」を往復で失う、の 2 つによる。
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
function attachmentEntryName(kind: keyof EmbeddedPartAttachments, ref: string): string {
  if (kind === 'shapes') return `${PCAD_SHAPE_ENTRY_PREFIX}${ref}${PCAD_SHAPE_ENTRY_SUFFIX}`;
  if (kind === 'meshes') return `${PCAD_MESH_ENTRY_PREFIX}${ref}${PCAD_MESH_ENTRY_SUFFIX}`;
  return `${PCAD_CANVAS_ENTRY_PREFIX}${ref}${PCAD_CANVAS_ENTRY_SUFFIX}`;
}

function appendAttachments<Extra extends ZipChunkedBytes>(
  entries: PcadZipEntries<Extra>,
  attachments: PcadAttachments,
  encodeMesh: MeshEntryEncoder<Extra>,
  entryPrefix = '',
): void {
  for (const [ref, bytes] of sortedEntries(attachments.shapes)) {
    entries.set(
      entryPrefix + attachmentEntryName('shapes', ref),
      zipEntry(bytes, ATTACHMENT_BINARY_LEVEL),
    );
  }
  for (const [ref, mesh] of sortedEntries(attachments.meshes)) {
    const bytes = encodeMesh(mesh);
    if (bytes === null) {
      continue;
    }
    entries.set(
      entryPrefix + attachmentEntryName('meshes', ref),
      zipEntry(bytes, ATTACHMENT_BINARY_LEVEL),
    );
  }
  for (const [ref, bytes] of sortedEntries(attachments.canvases)) {
    entries.set(
      entryPrefix + attachmentEntryName('canvases', ref),
      zipEntry(bytes, ATTACHMENT_IMAGE_LEVEL),
    );
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
  return zipPcadEntries(pcadEntries(document, options));
}

/** `writePcadFile` の圧縮前の項目(並びと圧縮の指定は `writePcadFile` の説明のとおり)。 */
export function pcadEntries(document: PartDocument, options: WritePcadFileOptions): PcadZipEntries {
  return partEntriesWithMeshes<never>(document, options, encodeImportedMeshBytes);
}

export function partEntriesWithMeshes<Extra extends ZipChunkedBytes>(document: PartDocument, options: WritePcadFileOptions,
  encodeMesh: MeshEntryEncoder<Extra>): PcadZipEntries<Extra> {
  const text = serializeDocument(document, {
    savedAt: options.savedAt,
    kind: options.kind,
    lengthUnit: options.lengthUnit,
    toolDefaults: options.toolDefaults,
  });
  const entries: PcadZipEntries<Extra> = new Map([
    [PCAD_DOCUMENT_ENTRY, zipEntry(strToU8(text), DOCUMENT_LEVEL)],
  ]);
  if (options.thumbnailPng !== undefined) {
    entries.set(PCAD_THUMBNAIL_ENTRY, zipEntry(options.thumbnailPng, THUMBNAIL_LEVEL));
  }
  if (options.attachments !== undefined) {
    appendAttachments(entries, options.attachments, encodeMesh);
  }
  if (options.kind !== PCAD_TEMPLATE_KIND) appendAnalysisResults(entries, options);
  return entries;
}

/**
 * 読み込めなかった理由。`notZip`・`missingDocument`・`subAssemblyCycle`・`subAssemblyDepth` はこの層で見つけたもの、
 * それ以外は `document.json` の読み手(documentJson.ts)の理由をそのまま通したもの。
 */
export type ReadPcadFileErrorCode = ParseErrorCode | 'notZip' | 'archiveExpansionLimit' | 'missingDocument' | 'subAssemblyCycle' | 'subAssemblyDepth';

/** 読み込めなかった理由。`message` はそのまま利用者へ見せる日本語(NFR-UX-5)。 */
export interface ReadPcadFileError {
  readonly code: ReadPcadFileErrorCode;
  readonly message: string;
}

export type ReadPcadFileResult =
  | (SavedResultFields & {
      readonly ok: true;
      readonly document: PartDocument;
      readonly savedAt: string;
      /** 封筒の種別(部品かひな形か)。判断は上の層がする。 */
      readonly kind: PcadDocumentKind;
      /**
       * ひな形が持ち運んでいた表示の長さの単位(FR-814)。**欄が無ければ `undefined`。**
       * 既定(`'mm'`)で埋めるのは model の `openTemplate` の仕事(`documentJson.ts` の注記)。
       */
      readonly lengthUnit?: LengthUnit;
      /** ひな形が持ち運んでいた道具の既定値(FR-814)。`lengthUnit` と同じく、無ければ `undefined`。 */
      readonly toolDefaults?: PcadToolDefaults;
      /**
       * ZIP に入っていた添付。**未参照のものも捨てずに返す。**
       * 版 7 のファイルに、この版の読み手がまだ知らない参照(下絵)が
       * 入っていることがあり、捨てると往復でその添付を失うため。
       */
      readonly attachments: PcadAttachments;
      /** サムネイルが入っていたときだけ付く。 */
      readonly thumbnailPng?: Uint8Array;
    })
  | { readonly ok: false; readonly error: ReadPcadFileError };

const NOT_ZIP_MESSAGE = 'ファイルを開けませんでした。壊れているかもしれません。';
/**
 * 抱き込んだ組の入れ子が成り立たない時の読み取りの断り。理由は model の detectSubAssemblyProblem の kind。
 * 画面の開く流れは、符号(SUB_ASSEMBLY_READ_CODES)から ui の assembly.json の文を出す(ui の file/documentReadError.ts)。
 * ここの日本語は、ほかの読み取りの理由と同じく io の message(文書の比べなど、message をそのまま出す所が読む)。
 */
const SUB_ASSEMBLY_READ_MESSAGES: Readonly<Record<SubAssemblyProblem['kind'], string>> = {
  cycle: 'このアセンブリは自分自身を含んでいます。',
  depth: `組の入れ子が深すぎます(${String(MAX_SUB_ASSEMBLY_DEPTH)} 段まで)。`,
};
/** 抱き込んだ組の入れ子の断りの理由の符号。 */
const SUB_ASSEMBLY_READ_CODES: Readonly<Record<SubAssemblyProblem['kind'], ReadPcadFileErrorCode>> = {
  cycle: 'subAssemblyCycle',
  depth: 'subAssemblyDepth',
};
const MISSING_DOCUMENT_MESSAGE =
  'PointerCAD のファイルではないようです(document.json が入っていません)。';

/**
 * エントリを取り出す。共通入口は Map へ安全な名前だけを入れるので、値の有無だけを見る。
 */
function findEntry(entries: ReadonlyMap<string, Uint8Array>, name: string): Uint8Array | null {
  return entries.get(name) ?? null;
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
  return isAttachmentRef(ref) ? ref : null;
}

function isAttachmentRef(ref: string): boolean {
  return ref.length > 0 && !ref.includes('/');
}

function analysisIdOf(name: string): string | null {
  return attachmentRef(name, PCAD_ANALYSIS_RESULT_ENTRY_PREFIX, PCAD_ANALYSIS_RESULT_ENTRY_SUFFIX);
}

function isResultEntry(name: string): boolean {
  return analysisIdOf(name) !== null || binaryIdOf(name) !== null;
}

function binaryIdOf(name: string): string | null {
  return attachmentRef(name, PCAD_ANALYSIS_RESULT_ENTRY_PREFIX, RESULT_BINARY_SUFFIX);
}

function resultEntryLimit(name: string): number {
  return binaryIdOf(name) === null ? IO_LIMITS.archiveEntryExpandedBytes : SOLID_RESULT_MAX_BYTES;
}

function isAssemblyDocumentEntry(name: string): boolean {
  return name === PCAD_DOCUMENT_ENTRY || attachmentRef(name, PCAD_PART_ENTRY_PREFIX, PCAD_PART_ENTRY_SUFFIX) !== null;
}

function* bindingInputs(entries: ReadonlyMap<string, Uint8Array | ZipStepEntry<SaveEntryBytes>>):
  Generator<readonly [string, Uint8Array | readonly (Uint8Array | undefined)[], boolean]> {
  for (const [name, entry] of entries) {
    const document = isAssemblyDocumentEntry(name);
    if (name === PCAD_THUMBNAIL_ENTRY || isResultEntry(name)) continue;
    if (isPcadArchiveEntry(name) || name.startsWith(PCAD_PART_ENTRY_PREFIX)) {
      const bytes = ArrayBuffer.isView(entry) ? entry : entry[0];
      yield [name, bytes instanceof Uint8Array ? bytes : bytes.pending, document];
    }
  }
}

function appendAnalysisResults(entries: PcadZipEntries<ZipChunkedBytes>, options: ResultWriteOptions & SavedResultFields): void {
  const { analysisResults: results, onAnalysisResultIssue } = options;
  if (results === undefined || results.size === 0) return;
  let binding: string;
  try {
    binding = analysisResultBinding(bindingInputs(entries));
  } catch {
    if (onAnalysisResultIssue) for (const id of results.keys()) onAnalysisResultIssue(id, 'invalidResult');
    return;
  }
  let remaining = IO_LIMITS.archiveTotalExpandedBytes;
  for (const [bytes] of entries.values()) remaining -= bytes.length;
  for (const [id, saved] of sortedEntries(results)) {
    const stem = PCAD_ANALYSIS_RESULT_ENTRY_PREFIX + id;
    const name = stem + PCAD_ANALYSIS_RESULT_ENTRY_SUFFIX;
    if (analysisIdOf(name) !== id || !isSafeZipEntryName(name) || decodeUtf8(strToU8(name)) !== name) {
      onAnalysisResultIssue?.(id, 'invalidResult');
      continue;
    }
    const count = saved.kind === 'oofem-linear-solid-tet4' ? 2 : 1;
    if (entries.size + count > IO_LIMITS.archiveEntryCount || remaining <= 0) {
      onAnalysisResultIssue?.(id, 'resultTooLarge');
      continue;
    }
    const encoded = serializeAnalysisResult(saved, id, binding);
    if (!encoded.ok) {
      onAnalysisResultIssue?.(id, encoded.issue);
      continue;
    }
    const size = encoded.json.length + (encoded.binary?.length ?? 0);
    if (size > remaining) {
      onAnalysisResultIssue?.(id, 'resultTooLarge');
      continue;
    }
    entries.set(name, zipEntry(encoded.json, DOCUMENT_LEVEL));
    if (encoded.binary !== undefined) entries.set(stem + RESULT_BINARY_SUFFIX, zipEntry(encoded.binary, DOCUMENT_LEVEL));
    remaining -= size;
  }
}

function savedResultsOf(entries: ReadonlyMap<string, Uint8Array>, omitted: boolean): SavedResultFields {
  const results = new Map<string, SavedAnalysisResult>();
  let issue: AnalysisResultIssue | undefined = omitted ? 'invalidResult' : undefined;
  let binding: string | undefined;
  for (const [name, bytes] of entries) {
    const id = analysisIdOf(name);
    if (id === null) {
      const orphan = binaryIdOf(name);
      if (orphan !== null && !entries.has(PCAD_ANALYSIS_RESULT_ENTRY_PREFIX + orphan + PCAD_ANALYSIS_RESULT_ENTRY_SUFFIX)) issue ??= 'invalidResult';
      continue;
    }
    try {
      binding ??= analysisResultBinding(bindingInputs(entries));
    } catch {
      // A valid document can contain deeply nested extension data beyond the canonicalizer's stack.
      return { analysisResultIssue: 'invalidResult' };
    }
    const decoded = readAnalysisResult(bytes, id, binding, entries.get(PCAD_ANALYSIS_RESULT_ENTRY_PREFIX + id + RESULT_BINARY_SUFFIX));
    if (decoded.ok) results.set(id, decoded.value);
    else issue ??= decoded.issue;
  }
  return { ...(results.size ? { analysisResults: results } : {}),
    ...(issue === undefined ? {} : { analysisResultIssue: issue }) };
}

function isPcadArchiveEntry(name: string): boolean {
  return (
    name === PCAD_DOCUMENT_ENTRY ||
    name === PCAD_THUMBNAIL_ENTRY || isResultEntry(name) ||
    attachmentRef(name, PCAD_SHAPE_ENTRY_PREFIX, PCAD_SHAPE_ENTRY_SUFFIX) !== null ||
    attachmentRef(name, PCAD_MESH_ENTRY_PREFIX, PCAD_MESH_ENTRY_SUFFIX) !== null ||
    attachmentRef(name, PCAD_CANVAS_ENTRY_PREFIX, PCAD_CANVAS_ENTRY_SUFFIX) !== null
  );
}

function isPcadaArchiveEntry(name: string): boolean {
  return (
    name === PCAD_DOCUMENT_ENTRY ||
    name === PCAD_THUMBNAIL_ENTRY || isResultEntry(name) ||
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
  ownedArchive = false,
): {
  readonly attachments: PcadAttachments;
  readonly brokenMeshEntry: string | null;
  readonly tooLargeMeshEntry: string | null;
  readonly allocatedMeshBytes: number;
} {
  const shapes = new Map<string, Uint8Array>();
  const shapeDigests = new Map<string, string>();
  const meshes = new Map<string, ImportedMeshBytes>();
  const canvases = new Map<string, Uint8Array>();
  let brokenMeshEntry: string | null = null;
  let tooLargeMeshEntry: string | null = null;
  let allocatedMeshBytes = 0;
  for (const [name, bytes] of entries) {
    const shapeRef = attachmentRef(name, PCAD_SHAPE_ENTRY_PREFIX, PCAD_SHAPE_ENTRY_SUFFIX);
    if (shapeRef !== null) {
      shapes.set(shapeRef, bytes);
      shapeDigests.set(shapeRef, importedShapeOf(bytes).shapeDigest);
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
      const mesh = ownedArchive ? decodeOwnedArchiveMesh(bytes) : decodeImportedMeshBytes(bytes);
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
    // どれでもない名前は知らないエントリとして読み飛ばす(以前からの決めごと)。
  }
  return {
    attachments: { shapes, meshes, canvases, shapeDigests },
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
 * 断りは既存の `missingField`
 * (**エラーコードを増やさない**)。
 *
 * **下絵(`canvases`、FR-332)も同じ扱いにする。** 画像が欠けた下絵は
 * 何も描けない枠だけになり、そのまま保存し直すと欄だけが残って**画像を永久に失う**。
 * 読み込みの時点で断れば、利用者は元の `.pcad` を残したまま作り直せる(FR-504)。
 */
function findMissingAttachment(
  document: PartDocument,
  attachments: EmbeddedPartAttachments,
): string | null {
  for (const [kind, ref] of partAttachmentReferences(document)) {
    if (!attachments[kind].has(ref)) return attachmentEntryName(kind, ref);
  }
  return null;
}

/** 組立の履歴へ積む前に、同じ保存名・復号条件で添付が読めることを確かめる。 */
export function canPersistPartAttachments(document: PartDocument, attachments: EmbeddedPartAttachments, partRef: string): boolean {
  if (findMissingAttachment(document, attachments) !== null || !isAttachmentRef(partRef)) return false;
  for (const kind of ['shapes', 'meshes', 'canvases'] as const) {
    for (const ref of attachments[kind].keys()) {
      const name = `${PCAD_PART_ENTRY_PREFIX}${partRef}/${attachmentEntryName(kind, ref)}`;
      if (!isAttachmentRef(ref) || !isSafeZipEntryName(name) || decodeUtf8(strToU8(name)) !== name) return false;
    }
  }
  let remainingMeshBytes = IO_LIMITS.meshAllocationBytes;
  for (const mesh of attachments.meshes.values()) {
    const counts = meshCounts(mesh);
    if (counts === null) return false;
    const bytes = meshAllocationByteLength(counts.vertexCount, counts.triangleCount);
    if (bytes === null || bytes > remainingMeshBytes || !meshValuesValid(mesh, counts.vertexCount)) return false;
    remainingMeshBytes -= bytes;
  }
  return true;
}

/**
 * `.pcad` のバイト列から部品文書と添付を取り出す。
 * 壊れていても例外を投げず、日本語の理由を返す(FR-504、NFR-RE-1)。
 */
/** 比較など複数文書を同時に開く用途の、展開前の資源上限。省略時は通常の上限。 */
export interface ReadPcadFileOptions { readonly limits?: ArchiveReadLimits }

export function readPcadFile(bytes: Uint8Array, options: ReadPcadFileOptions = {}): ReadPcadFileResult {
  const archive = readArchive(bytes, { shouldExtract: isPcadArchiveEntry, optionalEntry: isResultEntry, optionalEntryLimit: resultEntryLimit, limits: options.limits });
  if (!archive.ok) {
    return fail('notZip', archiveFailureMessage(archive.error));
  }
  return readPcadEntriesInternal(archive.entries, true, archive.omittedOptional === true);
}

function archiveFailureCode(error: ArchiveReadError): 'notZip' | 'archiveExpansionLimit' {
  return error.kind === 'compressedInput' ||
    error.kind === 'entryCount' ||
    error.kind === 'entryExpanded' ||
    error.kind === 'totalExpanded'
    ? 'archiveExpansionLimit'
    : 'notZip';
}

/** 全体バイトの読み手は従来のエラーコードと上限の案内を保つ。 */
function archiveFailureMessage(error: ArchiveReadError): string {
  return archiveFailureCode(error) === 'archiveExpansionLimit' ? error.reason : NOT_ZIP_MESSAGE;
}

/**
 * Read document and attachments after bounded readArchive validation.
 * This parses entries only: callers must validate ZIP names, CRC and resource
 * limits with readArchive before calling. The envelope kind is preserved.
 */
export function readPcadEntries(entries: ReadonlyMap<string, Uint8Array>): ReadPcadFileResult {
  return readPcadEntriesInternal(entries, false);
}

function readPcadEntriesInternal(entries: ReadonlyMap<string, Uint8Array>, ownedArchive: boolean, omitted = false): ReadPcadFileResult {
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
  const collected = collectAttachments(entries, IO_LIMITS.meshAllocationBytes, ownedArchive);
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
  return {
    ok: true,
    document: parsed.document,
    savedAt: parsed.savedAt,
    kind: parsed.kind,
    lengthUnit: parsed.lengthUnit,
    toolDefaults: parsed.toolDefaults,
    attachments: collected.attachments,
    ...(parsed.kind === PCAD_TEMPLATE_KIND ? {} : savedResultsOf(entries, omitted)),
    ...(thumbnail === null ? {} : { thumbnailPng: thumbnail }),
  };
}

/**
 * 読んだファイルがひな形(`.pcadt`)か(FR-814)。
 *
 * **拡張子ではなく封筒の種別で判断する**(名前はいくらでも変えられる)。ここに
 * 述語を置いておくと、「どの種別がひな形か」を知っているのが `schema.ts` と
 * この 1 行だけで済み、呼び出し側(ui、model の `openTemplate` へ渡す真偽)が
 * 種別の文字列を写さずに書ける。
 *
 * ひな形でないファイルを断るのは呼び出し側で、**断りのコードは増やさない**
 * ——`.pcad` の種別違いと同じ `file.error.wrongKind` の文言に寄せる
 * (エラーコードを増やさないため)。
 */
export function isTemplateKind(kind: PcadDocumentKind): boolean {
  return kind === PCAD_TEMPLATE_KIND;
}

// ---------------------------------------------------------------------------
// アセンブリ(`.pcada`)の ZIP コンテナ
// ---------------------------------------------------------------------------

export interface WritePcadaFileOptions extends ResultWriteOptions {
  readonly analysisResults?: ReadonlyMap<string, SavedAnalysisResult>;
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
  /** 抱き込んだサブアセンブリ文書。部品と同じ `parts/<ref>.json` 名前空間へ書く。 */
  readonly assemblies?: ReadonlyMap<string, AssemblyDocument>;
  /** 部品ごとの再導出できない添付。鍵は `parts` と同じ `partRef`。 */
  readonly partAttachments?: ReadonlyMap<string, PcadAttachments>;
}

/** 組立封筒の先頭にある通常の保存時刻を、後ろの圧縮率から独立させる。 */
export function assemblyEnvelopeStoredPrefixLength(name: string, bytes: Uint8Array): number | undefined {
  if (!isAssemblyDocumentEntry(name)) return undefined;
  // 文書本体より前の5行を、バイト位置を保ったまま照合する。
  const header = String.fromCharCode(...bytes.subarray(0, 256));
  const prefix = /^(?:[^\n]*\n){4} {2}"savedAt": "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"(?=,\n)/u.exec(header)?.[0];
  return prefix?.length;
}

function assemblyEnvelopeEntry(name: string, text: string): PcadZipEntry {
  const entry = zipEntry(strToU8(text), DOCUMENT_LEVEL);
  const prefixLength = assemblyEnvelopeStoredPrefixLength(name, entry[0]);
  return prefixLength === undefined ? entry : [entry[0], entry[1], prefixLength];
}

/**
 * 抱き込んだ部品文書を ZIP のエントリへ並べる。**名前の順に並べる**(表の並び順は作った側の
 * 都合で変わるので、同じ中身から同じバイト列ができる約束を守るために毎回そろえる)。
 *
 * 1 つ 1 つの中身は**部品の `document.json` とまったく同じ文字列**にする
 * (`serializeDocument`)。こうしておくと読み手が既存の `parseDocument` をそのまま使え、
 * 部品文書の読み書きを 2 か所に持たずに済む。**保存時刻はアセンブリの封筒と
 * 同じ値**を書く——抱き込んだ部品ごとに違う時刻を入れると、同じアセンブリから
 * 書き出したバイト列が呼ぶたびに変わってしまうため(決定性。このファイル冒頭)。
 */
function appendParts(
  entries: PcadZipEntries,
  parts: ReadonlyMap<string, PartDocument>,
  savedAt: string,
): void {
  for (const [ref, document] of sortedEntries(parts)) {
    const text = serializeDocument(document, { savedAt });
    const name = `${PCAD_PART_ENTRY_PREFIX}${ref}${PCAD_PART_ENTRY_SUFFIX}`;
    entries.set(name, assemblyEnvelopeEntry(name, text));
  }
}

/** サブアセンブリも同じ名前空間へ、assembly 封筒のまま決定的に書く。 */
function appendAssemblies(
  entries: PcadZipEntries,
  assemblies: ReadonlyMap<string, AssemblyDocument>,
  savedAt: string,
): void {
  for (const [ref, document] of sortedEntries(assemblies)) {
    const text = writeAssemblyDocument(document, { savedAt, partFiles: [] });
    const name = `${PCAD_PART_ENTRY_PREFIX}${ref}${PCAD_PART_ENTRY_SUFFIX}`;
    entries.set(name, assemblyEnvelopeEntry(name, text));
  }
}

/** 親の保存と同じ名前空間で、ZIP の展開量と復号時のメッシュ確保量を照合する。 */
export async function canPersistAssemblyPartEdit(bundle: AssemblyDocumentBundle): Promise<boolean> {
  const library = partLibraryOfBundle(bundle);
  const savedAt = '1970-01-01T00:00:00.000Z';
  const lengths = new Map<string, number>();
  const documents = pcadaDocumentEntries(bundle.document, { ...library, savedAt });
  for (const [name, [bytes]] of documents) lengths.set(name, bytes.byteLength);
  let meshBytes = 0;
  for (const [ref, document] of library.parts) {
    const attachments = library.attachments.get(ref);
    if (!isAttachmentRef(ref) || library.assemblies?.has(ref) || attachments === undefined
      || findMissingAttachment(document, attachments) !== null) return false;
    for (const table of [attachments.shapes, attachments.meshes, attachments.canvases]) {
      for (const key of table.keys()) if (!isAttachmentRef(key)) return false;
    }
    const prefix = `${PCAD_PART_ENTRY_PREFIX}${ref}/`;
    // The writer emits a digest even for an empty attachment table.
    lengths.set(prefix + PCAD_PART_ATTACHMENTS_DIGEST_ENTRY, 64);
    for (const [key, bytes] of attachments.shapes) lengths.set(prefix + attachmentEntryName('shapes', key), bytes.byteLength);
    for (const [key, bytes] of attachments.canvases) lengths.set(prefix + attachmentEntryName('canvases', key), bytes.byteLength);
    for (const [key, mesh] of attachments.meshes) {
      const counts = meshCounts(mesh);
      if (counts === null) return false;
      const bytes = meshAllocationByteLength(counts.vertexCount, counts.triangleCount);
      if (bytes === null || !meshValuesValid(mesh, counts.vertexCount)) return false;
      meshBytes += bytes;
      if (meshBytes > IO_LIMITS.meshAllocationBytes) return false;
      lengths.set(prefix + attachmentEntryName('meshes', key), MESH_HEADER_BYTES + bytes);
    }
  }
  if (lengths.size > IO_LIMITS.archiveEntryCount) return false;
  let expanded = 0;
  for (const [name, bytes] of lengths) {
    const encoded = strToU8(name);
    if (!isSafeZipEntryName(name) || encoded.byteLength > 65_535 || decodeUtf8(encoded) !== name) return false;
    if (bytes > IO_LIMITS.archiveEntryExpandedBytes) return false;
    expanded += bytes;
    if (expanded > IO_LIMITS.archiveTotalExpandedBytes) return false;
  }
  // savedAt has the same width as the real save timestamp. Its stored block contributes the same bytes
  // to the length and the following compressed payload starts with an independent dictionary.
  await appendPartAttachments(documents, library.attachments, encodeImportedMeshBytes);
  const parts = await zipPcadEntriesPartsAsync(documents);
  return parts.reduce((total, bytes) => total + bytes.byteLength, 0) <= IO_LIMITS.archiveCompressedBytes;
}

/** 部品添付を一時表へ集め、完全なエントリ名の順に本表へ足す。 */
async function appendPartAttachments<Extra extends ZipChunkedBytes>(
  entries: PcadZipEntries<Extra>,
  partAttachments: ReadonlyMap<string, PcadAttachments>,
  encodeMesh: MeshEntryEncoder<Extra>,
  digestAttachments: typeof attachmentsDigestOf = attachmentsDigestOf,
): Promise<void> {
  const staged: PcadZipEntries<Extra> = new Map();
  for (const [ref, attachments] of sortedEntries(partAttachments)) {
    const prefix = `${PCAD_PART_ENTRY_PREFIX}${ref}/`;
    const digest = await digestAttachments(attachments);
    staged.set(
      `${prefix}${PCAD_PART_ATTACHMENTS_DIGEST_ENTRY}`,
      zipEntry(strToU8(digest), DOCUMENT_LEVEL),
    );
    appendAttachments(staged, attachments, encodeMesh, prefix);
  }
  for (const name of [...staged.keys()].sort()) {
    const entry = staged.get(name);
    if (entry !== undefined) {
      entries.set(name, entry);
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
  // 待つのは添付のダイジェストだけにする(以前と同じ待ちの段数で書き終える)。
  const entries = pcadaDocumentEntries(document, options);
  if (options.partAttachments !== undefined) {
    await appendPartAttachments(entries, options.partAttachments, encodeImportedMeshBytes);
  }
  finishAssemblySaveEntries(entries, options);
  return zipPcadEntries(entries);
}

/** `writePcadaFile` の圧縮前の項目(並びと圧縮の指定は `writePcadaFile` の説明のとおり)。 */
async function pcadaEntries<Extra extends ZipChunkedBytes>(
  document: AssemblyDocument,
  options: WritePcadaFileOptions,
  encodeMesh: MeshEntryEncoder<Extra>,
  digestAttachments: typeof attachmentsDigestOf,
): Promise<PcadZipEntries<Extra>> {
  const entries: PcadZipEntries<Extra> = pcadaDocumentEntries(document, options);
  if (options.partAttachments !== undefined) {
    await appendPartAttachments(entries, options.partAttachments, encodeMesh, digestAttachments);
  }
  finishAssemblySaveEntries(entries, options);
  return entries;
}

function finishAssemblySaveEntries(entries: PcadZipEntries<ZipChunkedBytes>, options: WritePcadaFileOptions): void {
  const thumbnail = entries.get(PCAD_THUMBNAIL_ENTRY)?.[0];
  if (thumbnail !== undefined && (entries.size > IO_LIMITS.archiveEntryCount
    || thumbnail.length > IO_LIMITS.archiveEntryExpandedBytes
    || [...entries.values()].reduce((total, [bytes]) => total + bytes.length, 0) > IO_LIMITS.archiveTotalExpandedBytes)) {
    entries.delete(PCAD_THUMBNAIL_ENTRY);
  }
  appendAnalysisResults(entries, options);
}

/** 圧縮後に予算を超えた場合、保存できる原本を残して再導出できる項目を外す。 */
export function dropAssemblySaveExtras(entries: PcadZipEntries<ZipChunkedBytes>, report?: ResultWriteOptions['onAnalysisResultIssue']): boolean {
  let removed = entries.delete(PCAD_THUMBNAIL_ENTRY);
  for (const name of entries.keys()) {
    const id = analysisIdOf(name);
    if (id !== null) report?.(id, 'resultTooLarge');
    if (isResultEntry(name)) removed = entries.delete(name) || removed;
  }
  return removed;
}

/** アセンブリの封筒・サムネイル・抱き込んだ文書の項目(添付の項目の前まで)。 */
function pcadaDocumentEntries(
  document: AssemblyDocument,
  options: WritePcadaFileOptions,
): PcadZipEntries {
  // 封筒と抱き込んだ部品で**同じ保存時刻**を使うため、既定値をここで 1 回だけ決める。
  const savedAt = options.savedAt ?? new Date().toISOString();
  const text = writeAssemblyDocument(document, { savedAt, partFiles: options.partFiles });
  const entries: PcadZipEntries = new Map([
    [PCAD_DOCUMENT_ENTRY, assemblyEnvelopeEntry(PCAD_DOCUMENT_ENTRY, text)],
  ]);
  if (options.thumbnailPng !== undefined) {
    entries.set(PCAD_THUMBNAIL_ENTRY, zipEntry(options.thumbnailPng, THUMBNAIL_LEVEL));
  }
  if (options.parts !== undefined) {
    appendParts(entries, options.parts, savedAt);
  }
  if (options.assemblies !== undefined) {
    appendAssemblies(entries, options.assemblies, savedAt);
  }
  return entries;
}

export type ReadPcadaFileResult =
  | (SavedResultFields & {
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
      /** 抱き込んだサブアセンブリ文書。 */
      readonly assemblies: ReadonlyMap<string, AssemblyDocument>;
      /** 抱き込んだ部品ごとの添付。鍵は `partRef`。 */
      readonly partAttachments: ReadonlyMap<string, PcadAttachments>;
      /** 読み込み時に照合済みの添付 SHA-256。古いファイルでは内容から補う。 */
      readonly partAttachmentDigests: ReadonlyMap<string, string>;
      /** サムネイルが入っていたときだけ付く。 */
      readonly thumbnailPng?: Uint8Array;
    })
  | { readonly ok: false; readonly error: ReadPcadFileError };

/**
 * ZIP のエントリから抱き込んだ部品文書を取り出す。1 つでも読めなければ、そのエントリ名と
 * 中身の理由を添えて断る(**読めない欄が 1 つでもあればファイル全体を断る**。
 * `documentJson.ts` 冒頭の決めごと)。**エラーコードは中身の理由をそのまま通す**
 * (増やさない)。
 */
type CollectPartsResult =
  | {
      readonly ok: true;
      readonly parts: ReadonlyMap<string, PartDocument>;
      readonly assemblies: ReadonlyMap<string, AssemblyDocument>;
    }
  | { readonly ok: false; readonly error: ReadPcadFileError };

function collectParts(entries: ReadonlyMap<string, Uint8Array>): CollectPartsResult {
  const parts = new Map<string, PartDocument>();
  const assemblies = new Map<string, AssemblyDocument>();
  for (const [name, bytes] of entries) {
    const ref = attachmentRef(name, PCAD_PART_ENTRY_PREFIX, PCAD_PART_ENTRY_SUFFIX);
    if (ref === null) {
      // どれでもない名前は知らないエントリとして読み飛ばす(以前からの決めごと)。
      continue;
    }
    const text = decodeUtf8(bytes);
    if (text === null) {
      return { ok: false, error: { code: 'notZip', message: NOT_ZIP_MESSAGE } };
    }
    const parsed = parseDocument(text);
    if (parsed.ok) {
      parts.set(ref, parsed.document);
      continue;
    }
    const parsedAssembly = readAssemblyDocument(text);
    if (parsedAssembly.ok) {
      assemblies.set(ref, parsedAssembly.document);
      continue;
    }
    const reason = parsed.error.code === 'unsupportedKind' ? parsedAssembly.error : parsed.error;
    return {
      ok: false,
      error: {
        code: reason.code,
        message: `抱き込んだ文書を読めませんでした(${name})。${reason.message}`,
      },
    };
  }
  return { ok: true, parts, assemblies };
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
 * アセンブリ文書で、読み手が別(`assemblyJson.ts`)。後者は寸法表から組み立てるので
 * 抱き込む文書がそもそも無い。
 */
function findMissingPart(
  document: AssemblyDocument,
  parts: ReadonlyMap<string, PartDocument>,
  assemblies: ReadonlyMap<string, AssemblyDocument>,
  ancestors: ReadonlySet<string> = new Set(),
): string | null {
  for (const component of document.components) {
    if (component.source.kind === 'part' && !parts.has(component.source.partRef)) {
      return component.source.partRef;
    }
    if (component.source.kind === 'subAssembly') {
      const ref = component.source.assemblyRef;
      const nested = assemblies.get(ref);
      if (nested === undefined) return ref;
      if (!ancestors.has(ref)) {
        const missing = findMissingPart(nested, parts, assemblies, new Set([...ancestors, ref]));
        if (missing !== null) return missing;
      }
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

export function readPcadaFile(
  bytes: Uint8Array,
  options: ReadPcadaFileOptions = {},
): Promise<ReadPcadaFileResult> {
  const archive = readArchive(bytes, {
    shouldExtract: isPcadaArchiveEntry,
    optionalEntry: isResultEntry, optionalEntryLimit: resultEntryLimit,
    limits: options.limits,
  });
  if (!archive.ok) {
    return Promise.resolve(fail('notZip', archiveFailureMessage(archive.error)));
  }
  // 続きの段の約束をそのまま返し、以前(1 つの async 関数)と同じ待ちの段数で終える。
  return readPcadaEntries(archive.entries, archive.omittedOptional === true);
}

/** 取り出し済みの項目からアセンブリ文書と抱き込んだ部品を読む(`readPcadaFile` の ZIP を開いた後の段)。 */
async function readPcadaEntries(
  entries: ReadonlyMap<string, Uint8Array>, omitted = false,
): Promise<ReadPcadaFileResult> {
  const documentEntry = findEntry(entries, PCAD_DOCUMENT_ENTRY);
  if (documentEntry === null) {
    return fail('missingDocument', MISSING_DOCUMENT_MESSAGE);
  }
  const text = decodeUtf8(documentEntry);
  if (text === null) {
    return fail('notZip', NOT_ZIP_MESSAGE);
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
  const subAssemblyProblem = detectSubAssemblyProblem(parsed.document, collected.assemblies);
  if (subAssemblyProblem !== null) {
    return fail(SUB_ASSEMBLY_READ_CODES[subAssemblyProblem.kind], SUB_ASSEMBLY_READ_MESSAGES[subAssemblyProblem.kind]);
  }
  // Cross-level gears and cams point into the embedded subassemblies, so they are checked once all of them are read.
  for (const document of [parsed.document, ...collected.assemblies.values()]) {
    const crossLevel = crossLevelGearTreeFailure(document, collected.assemblies) ?? crossLevelCamTreeFailure(document, collected.assemblies);
    if (crossLevel !== null) {
      return fail('invalidField', `段をまたぐ連動 ${crossLevel.couplingId} の参照が組の中で成り立ちません(${crossLevel.code})。`);
    }
  }
  const missing = findMissingPart(parsed.document, collected.parts, collected.assemblies);
  if (missing !== null) {
    return fail(
      'missingField',
      `部品が見つかりません(${PCAD_PART_ENTRY_PREFIX}${missing}${PCAD_PART_ENTRY_SUFFIX})。`,
    );
  }
  const collectedAttachments = await collectPartAttachments(entries, collected.parts);
  if ('code' in collectedAttachments) {
    return { ok: false, error: collectedAttachments };
  }
  const thumbnail = findEntry(entries, PCAD_THUMBNAIL_ENTRY);
  return {
    ok: true,
    document: parsed.document,
    savedAt: parsed.savedAt,
    partFiles: parsed.partFiles,
    parts: collected.parts,
    assemblies: collected.assemblies,
    partAttachments: collectedAttachments.attachments,
    partAttachmentDigests: collectedAttachments.digests,
    ...(savedResultsOf(entries, omitted)),
    ...(thumbnail === null ? {} : { thumbnailPng: thumbnail }),
  };
}

// ---------------------------------------------------------------------------
// `.pcadd` — 図面文書と参照元モデル
// ---------------------------------------------------------------------------

export interface WritePcaddFileOptions {
  readonly source: DrawingSourceInput;
  readonly savedAt?: string;
  readonly thumbnailPng?: Uint8Array;
}

/**
 * 図面・サムネイル・参照元を、固定時刻と固定順序で ZIP にする。
 * 参照元の封筒にも図面と同じ savedAt を使い、同じ入力から同じバイト列を作る。
 */
export function writePcaddFile(
  document: DrawingDocument,
  options: WritePcaddFileOptions,
): Uint8Array {
  return zipPcadEntries(pcaddEntries(document, options));
}

/** `writePcaddFile` の圧縮前の項目。図面の束が参照元の項目と結合するための口。 */
export function pcaddEntries(
  document: DrawingDocument,
  options: WritePcaddFileOptions,
): PcadZipEntries {
  const savedAt = options.savedAt ?? new Date().toISOString();
  const flat = document.source.flatSheet;
  if (document.source.sourceKind !== options.source.sourceKind
    || canonicalDrawingSourceText(flat) !== canonicalDrawingSourceText(options.source.sourceKind === 'part' ? options.source.flatSheet : undefined))
    throw new Error('Drawing source definition mismatch');
  if (flat !== undefined) {
    if (options.source.sourceKind !== 'part') throw new Error('Only part sources can be unfolded');
    const issue = sheetFlatReferenceIssue(options.source.document, flat); if (issue !== null) throw new Error(issue);
  }
  const sourceText = options.source.sourceKind === 'part'
    ? serializeDocument(options.source.document, { savedAt })
    : writeAssemblyDocument(options.source.document, { savedAt, partFiles: [] });
  const entries: PcadZipEntries = new Map([
    [PCAD_DOCUMENT_ENTRY, zipEntry(strToU8(serializeDrawing(document, { savedAt })), DOCUMENT_LEVEL)],
  ]);
  if (options.thumbnailPng !== undefined) {
    entries.set(PCAD_THUMBNAIL_ENTRY, zipEntry(options.thumbnailPng, THUMBNAIL_LEVEL));
  }
  entries.set(
    `${PCAD_SOURCE_ENTRY_PREFIX}${document.source.sourceRef}${PCAD_SOURCE_ENTRY_SUFFIX}`,
    zipEntry(strToU8(sourceText), DOCUMENT_LEVEL),
  );
  return entries;
}

export type ReadPcaddFileResult =
  | {
      readonly ok: true;
      readonly document: DrawingDocument;
      readonly source: DrawingSourceInput;
      readonly savedAt: string;
      readonly thumbnailPng?: Uint8Array;
    }
  | { readonly ok: false; readonly error: ReadPcadFileError };

/** `.pcadd` の読み手が最初に取り出す項目(図面・サムネイル・参照元の封筒)。 */
export function isPcaddArchiveEntry(name: string): boolean {
  return name === PCAD_DOCUMENT_ENTRY
    || name === PCAD_THUMBNAIL_ENTRY
    || attachmentRef(name, PCAD_SOURCE_ENTRY_PREFIX, PCAD_SOURCE_ENTRY_SUFFIX) !== null;
}

/** `.pcadd` を読み、図面が指す1件の参照元も既存の部品・アセンブリ読み手で検査する。 */
export function readPcaddFile(bytes: Uint8Array, options: ReadPcadFileOptions = {}): ReadPcaddFileResult {
  const archive = readArchive(bytes, { shouldExtract: isPcaddArchiveEntry, limits: options.limits });
  if (!archive.ok) {
    return fail('notZip', archiveFailureMessage(archive.error));
  }
  return readPcaddEntries(archive.entries);
}

/** 已にZIPの検査を終えて取り出した図面の封筒と参照元を読む。 */
export function readPcaddEntries(entries: ReadonlyMap<string, Uint8Array>): ReadPcaddFileResult {
  const documentBytes = findEntry(entries, PCAD_DOCUMENT_ENTRY);
  if (documentBytes === null) {
    return fail('missingDocument', MISSING_DOCUMENT_MESSAGE);
  }
  const documentText = decodeUtf8(documentBytes);
  if (documentText === null) return fail('notZip', NOT_ZIP_MESSAGE);
  const drawing = parseDrawing(documentText);
  if (!drawing.ok) return { ok: false, error: drawing.error };

  const sourceEntry = `${PCAD_SOURCE_ENTRY_PREFIX}${drawing.document.source.sourceRef}${PCAD_SOURCE_ENTRY_SUFFIX}`;
  const sourceBytes = findEntry(entries, sourceEntry);
  if (sourceBytes === null) {
    return fail(
      'missingField',
      `ファイルの中身が壊れています(${sourceEntry} が見つかりません)。`,
    );
  }
  const sourceText = decodeUtf8(sourceBytes);
  if (sourceText === null) return fail('notZip', NOT_ZIP_MESSAGE);
  const source: DrawingSourceInput | null = drawing.document.source.sourceKind === 'part'
    ? (() => {
        const parsed = parseDocument(sourceText);
        if (!parsed.ok) return null;
        const flat = drawing.document.source.flatSheet;
        if (flat !== undefined && sheetFlatReferenceIssue(parsed.document, flat) !== null) return null;
        return { sourceKind: 'part' as const, document: parsed.document, ...(flat === undefined ? {} : { flatSheet: flat }) };
      })()
    : (() => {
        const parsed = readAssemblyDocument(sourceText);
        return parsed.ok ? { sourceKind: 'assembly' as const, document: parsed.document } : null;
      })();
  if (source === null) {
    return fail(
      'invalidField',
      `抱き込んだ文書を読めませんでした(${sourceEntry})。`,
    );
  }
  const thumbnail = findEntry(entries, PCAD_THUMBNAIL_ENTRY);
  return thumbnail === null
    ? { ok: true, document: drawing.document, source, savedAt: drawing.savedAt }
    : {
        ok: true,
        document: drawing.document,
        source,
        savedAt: drawing.savedAt,
        thumbnailPng: thumbnail,
      };
}


export function nativeArchiveFailure(error: ArchiveReadError): { readonly ok: false; readonly error: ReadPcadFileError } {
  const code = archiveFailureCode(error);
  return { ok: false, error: { code, message: code === 'archiveExpansionLimit' ? error.reason : NOT_ZIP_MESSAGE } };
}

export async function readPcadFromSource(source: ArchiveReadSource): Promise<ReadPcadFileResult> {
  const opened = await openArchiveSource(source);
  if (!opened.ok) return nativeArchiveFailure(opened.error);
  const archive = await opened.archive.extract({
    shouldExtract: isPcadArchiveEntry, optionalEntry: isResultEntry, optionalEntryLimit: resultEntryLimit,
  });
  if (!archive.ok) return nativeArchiveFailure(archive.error);
  return readPcadEntriesInternal(archive.entries, true, archive.omittedOptional === true);
}

export async function readAssemblyFromSource(source: ArchiveReadSource): Promise<ReadDocumentBundleResult> {
  const opened = await openArchiveSource(source);
  if (!opened.ok) return nativeArchiveFailure(opened.error);
  const archive = await opened.archive.extract({
    shouldExtract: isPcadaArchiveEntry, optionalEntry: isResultEntry, optionalEntryLimit: resultEntryLimit,
  });
  if (!archive.ok) return nativeArchiveFailure(archive.error);
  const result = await readPcadaEntries(archive.entries, archive.omittedOptional === true);
  if (!result.ok) return result;
  return assemblyBundleOf(result, await partFilesWithDigests(result));
}
