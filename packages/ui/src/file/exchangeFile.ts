/**
 * 書き出しと読み込みの手続き(計画書 docs/plans/P6-入出力.md §2.2・§2.4・§2.8・§2.9、
 * §0.a-0.6・0.7・0.12・0.15・0.20・0.22・0.28・0.34、タスク32・53)。
 *
 * 対応要件: FR-802(読み込み)、FR-803(書き出し)、FR-804(名前と色)、FR-811(単位)、
 * FR-813(DXF)、FR-427(選んだ立体だけ)、NFR-UX-4(Enter 連打で意味のある結果)、
 * NFR-UX-5(できないことは押す前に断る)、NFR-RE-1(止めずに警告する)。
 *
 * **ここには画面も store も入らない。** P2 の `partFile.ts` と同じ流儀で、外の世界へ
 * 触れる口(ファイルの出し入れ・幾何カーネル・単位の問い合わせ)を引数で受け、
 * 判断はすべて純関数にしてある。画面(パネル)は下の `exportPanelShape` が返した
 * 見せ方のとおりに欄を並べ、`exportRefusalKey` が返した断りを**押す前に**赤で出す。
 *
 * **store を輸入しない**(`partFile.ts` → store → `partFile.ts` の輪と同じものを作らない。
 * P6 タスク28 の申し送り)。呼び出し側が今の文書・立体・選択を引数で渡す。
 */

import { saveExportFile } from './saveExportFile.js';
import type { ExportHandoff } from './openWith.js';
import {
  dxfFlattenedCurveMessage,
  parseDxfTags,
  readThreeMf,
  readDxf,
  writeDxfDocument,
  type DxfEntity,
  type DxfWriteResult,
  type ImportedMeshBytes,
} from '@pointercad/io';
import {
  appendFeature,
  appendSolid,
  carriesColor,
  dxfToSketch,
  nextSolidId,
  nextSolidName,
  selectExportBodies,
  sketchToDxf,
  usesTriangles,
  type ExportFormat,
  type ExportNoticeKey,
  type ExportRequest,
  type ExportSelection,
  type FileKind,
  type ImportedMeshFeature,
  type ImportedSolidFeature,
  type ImportedSource,
  type ImportedSourceFormat,
  type LengthUnit,
  type PartDocument,
  type SketchDocument,
  type SketchToDxfInput,
  type SolidBody,
  type WorkPlane,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { hasSaveRecoveryCopy } from './saveFailure.js';
import {
  openFileThrough,
  saveFileAsThrough,
  type FileGateway,
  type PickedTypedFile,
} from './fileGateway.js';

// ---------------------------------------------------------------------------
// 形式の対応表(FR-802、FR-803)
// ---------------------------------------------------------------------------

/**
 * 書き出しの画面に並べる 5 形式(FR-803、§0.a-0.20)。**並びは画面に出る順**で、
 * 一覧そのものの正本は model の `EXPORT_FORMATS`(こちらは並べ替えた写しではなく、
 * 画面が「STEP → STL → 3MF → OBJ → glTF」の順で見せるという決めだけを持つ)。
 */
export const EXPORT_FORMAT_ORDER: readonly ExportFormat[] = ['step', 'stl', '3mf', 'obj', 'glb'];

/**
 * 書き出しのパネルで選べる形式(FR-803、FR-813、§0.a-0.34、タスク53)。
 *
 * **立体の 5 形式と DXF は同じ一覧の中にあるが、書き出すものが違う。** 前の 5 つは
 * 文書の中の立体を書き出し、`dxf` は**いま編集しているスケッチの平らな線**を書き出す
 * (立体は 1 つも見ない)。だから依頼の形も流れも別で、model の `ExportFormat` には
 * `dxf` を入れない(あちらは「立体を書き出せる形式」の正本)。
 *
 * 一覧を 1 つにしたのは利用者から見た操作を割らないため(NFR-UX-1)。「書き出す」は
 * 1 つの入口で、そこで何を渡したいかを形式として選ぶ。
 */
export type ExportPanelFormat = ExportFormat | 'dxf';

/** 書き出しの画面に並べる 6 形式。**並びは画面に出る順**で、DXF が 6 つ目。 */
export const EXPORT_PANEL_FORMAT_ORDER: readonly ExportPanelFormat[] = [
  ...EXPORT_FORMAT_ORDER,
  'dxf',
];

/**
 * 読み込みの画面で選べる 6 形式(FR-802、FR-809、FR-813、§0.a-0.26)。
 *
 * **並びが書き出しと違う**のは、読み込みが「よく使う順」で、書き出しが `EXPORT_FORMATS`
 * の順をそのまま使っているため。DXF はどちらも一覧の最後で、読み書きとも平らな
 * スケッチの線として出入りする(立体にはならない。§0.a-0.34)。
 */
/** DWGは変換案内を表示する種類。ネイティブ読込には渡さない。 */
export type ImportFileKind = Exclude<FileKind, 'pcad' | 'pcadt' | 'pcadscript'>;
export const IMPORT_FILE_KINDS: readonly ImportFileKind[] = ['step', 'stl', 'obj', '3mf', 'glb', 'dxf', 'dwg'];
const READABLE_FILE_KINDS = IMPORT_FILE_KINDS.filter(kind => kind !== 'dwg');

/**
 * カーネルへ渡す書き出しの形式(`KernelApi.exportShapes` の `format`)。
 *
 * **3MF だけ `'mesh'` になる**(§0.a-0.19)。3MF の ZIP と XML を組むのは `packages/io` で、
 * カーネルは三角形までを返す。glTF はカーネルの言葉では `'gltf'`(ファイルの種類としては
 * `.glb` なので `FileKind` は `'glb'`)。
 */
export type ExchangeKernelExportFormat = 'step' | 'stl' | 'obj' | 'gltf' | 'mesh';

/** 書き出しの形式 → カーネルの言葉(網羅 `switch`。形式が増えたら型検査が落ちる)。 */
export function kernelExportFormatOf(format: ExportFormat): ExchangeKernelExportFormat {
  switch (format) {
    case 'step':
      return 'step';
    case 'stl':
      return 'stl';
    case 'obj':
      return 'obj';
    case 'glb':
      return 'gltf';
    case '3mf':
      return 'mesh';
  }
}

/**
 * 読み込んだファイルの種類 → 文書に残す形式(`ImportedSource.format`)。
 *
 * 読み込めない種類(`.pcad` / ひな形 / DXF)は `null`。`.pcad` は「開く」の経路、
 * DXF はスケッチになる別の経路で、どちらも読み込んだ形のベースボディにはならない。
 */
export function importedSourceFormatOf(kind: FileKind): ImportedSourceFormat | null {
  switch (kind) {
    case 'step':
      return 'step';
    case 'stl':
      return 'stl';
    case 'obj':
      return 'obj';
    case 'glb':
      return 'gltf';
    case '3mf':
      return '3mf';
    case 'pcad':
    case 'pcadt':
    case 'pcadscript':
    case 'dxf':
    case 'dwg':
      return null;
  }
}

// ---------------------------------------------------------------------------
// 書き出しのパネルの見せ方(§0.a-0.20)
// ---------------------------------------------------------------------------

/**
 * 形式を選んだときに、パネルのどの欄を出すか(§0.a-0.20)。
 *
 * **形式ごとの `if` を画面へ散らさない。** 欄の出し入れを 1 つの純関数にまとめておくと、
 * 検査で「STL のときだけ文字で書く欄が出る」を直接固定でき、形式が増えたときに
 * 直す場所が 1 か所で済む。
 */
export interface ExportPanelShape {
  /** なめらかさの 3 択を出すか(三角形を使う形式だけ。STL / 3MF / OBJ / glTF)。 */
  readonly showsQuality: boolean;
  /** 文字で書く(ASCII)の切替を出すか(**STL だけ**。§0.a-0.14)。 */
  readonly showsAscii: boolean;
  /** 色を書き出すかの切替を出すか(色を持てる形式だけ。STEP / OBJ / glTF / 3MF)。 */
  readonly showsColor: boolean;
  /** 「STL には色が付きません」の 1 行を出すか(§0.a-0.15)。 */
  readonly showsNoColorNotice: boolean;
  /**
   * 立体の「対象」の 2 択(すべての立体 / 選んだ立体)を出すか(FR-427)。
   * **DXF では出さない**——書き出すのは立体ではなくスケッチの線なので、選びようがない。
   */
  readonly showsBodyScope: boolean;
  /**
   * 「対象」に「いま編集しているスケッチ」の 1 行を出すか(§0.a-0.34、タスク53)。
   * 上の 2 択とは**いつも入れ替わり**に出る(「対象」の欄そのものは必ず 1 つある)。
   */
  readonly showsSketchTarget: boolean;
  /** 単位の案内の文言(§0.a-0.7。glTF だけメートル)。 */
  readonly unitNoticeKey: MessageKey;
}

/** その形式を書き出すときの単位の案内(§0.a-0.7)。**glTF だけメートル**で書く。 */
export function unitNoticeKeyOf(format: ExportPanelFormat): MessageKey {
  return format === 'glb' ? 'exchange.unitNoticeMeter' : 'exchange.unitNoticeMillimeter';
}

/**
 * 形式を選んだときのパネルの見せ方(§0.a-0.20、§0.a-0.34)。
 *
 * **DXF は立体の欄をどれも出さない。** なめらかさ(三角形の細かさ)も、文字で書くかも、
 * 色も、DXF に書き出す平らな線には関わらない。「STL には色が付きません」の 1 行も
 * 出さない——あれは**立体の色を渡せない形式**への断りなので、線しか書かない DXF で
 * 出すと、色が付くはずだったものが落ちたように読めてしまう。
 */
export function exportPanelShape(format: ExportPanelFormat): ExportPanelShape {
  if (format === 'dxf') {
    return {
      showsQuality: false,
      showsAscii: false,
      showsColor: false,
      showsNoColorNotice: false,
      showsBodyScope: false,
      showsSketchTarget: true,
      unitNoticeKey: unitNoticeKeyOf(format),
    };
  }
  const triangles = usesTriangles(format);
  const colors = carriesColor(format);
  return {
    showsQuality: triangles,
    showsAscii: format === 'stl',
    showsColor: colors,
    // 色を持てない形式は STL だけなので、この 1 行と上の切替はいつも入れ替わりに出る。
    showsNoColorNotice: !colors,
    showsBodyScope: true,
    showsSketchTarget: false,
    unitNoticeKey: unitNoticeKeyOf(format),
  };
}

/**
 * 書き出しの断りと警告の文言のキー(§2.8 の表)。**`ExportNoticeKey` と 1 対 1**で、
 * model が理由を増やしたら `Record` の網羅で型検査が落ちる。
 */
const EXPORT_NOTICE_KEYS: Readonly<Record<ExportNoticeKey, MessageKey>> = {
  nothingToExport: 'exchangeError.nothingToExport',
  shellNotSupported: 'exchangeError.shellNotSupported',
  meshNotSupported: 'exchangeError.meshNotSupported',
  colorNotSupported: 'exchangeError.colorNotSupported',
  qualityIgnored: 'exchangeError.qualityIgnored',
};

/** 断り・警告のキーを画面の文言のキーへ直す。 */
export function exportNoticeMessageKey(notice: ExportNoticeKey): MessageKey {
  return EXPORT_NOTICE_KEYS[notice];
}

/**
 * **画面に出していない欄についての警告を落とす**(§0.a-0.20、タスク43b。タスク45 の指摘)。
 *
 * model の `selectExportBodies` は依頼の欄をそのまま見て警告を付ける——STEP は三角形を
 * 使わないので必ず `qualityIgnored`、STL は色を持てないので `withColors` が真なら
 * `colorNotSupported` になる。ところが**パネルはその 2 つの欄をその形式では出していない**
 * (`exportPanelShape` の `showsQuality` / `showsColor`)。出していない欄について
 * 「その指定は効きません」と言われても利用者には直しようがなく、**成功のたびに
 * 何かを間違えたように見える**(2026-09-06、タスク45 の担当が実測)。
 *
 * **model の判定と既存の期待値は変えない。** どの欄を出すかは画面の決め事なので、
 * 落とすのもこの層で行う(`exportPanelShape` と同じ 1 か所を見るので、欄を出すように
 * 変えれば警告も自然に戻る)。**弾いた立体の警告(`shellNotSupported` /
 * `meshNotSupported`)は落とさない**——あれは利用者が選んだものについての知らせで、
 * 直しようがある(選び直す)。
 */
export function visibleExportWarnings(
  format: ExportFormat,
  warnings: readonly ExportNoticeKey[],
): readonly ExportNoticeKey[] {
  const shape = exportPanelShape(format);
  return warnings.filter((warning) => {
    if (warning === 'qualityIgnored') {
      return shape.showsQuality;
    }
    if (warning === 'colorNotSupported') {
      return shape.showsColor;
    }
    return true;
  });
}

/**
 * **押す前の断り**(NFR-UX-5)。書き出せないときだけ文言のキーを返し、書き出せるなら `null`。
 *
 * パネルは戻り値が `null` でない間、赤い 1 行を出して「書き出す」を押せなくする。
 * 「面だけの立体を含めて STL」「書き出せる立体が 0 個」の 2 つはここで断る。
 * 判断そのものは model の `selectExportBodies` が持っていて、ここは文言へ直すだけ。
 */
export function exportRefusalKey(
  bodies: readonly SolidBody[],
  request: ExportRequest,
): MessageKey | null {
  const outcome = selectExportBodies(bodies, request);
  return outcome.ok ? null : exportNoticeMessageKey(outcome.reason);
}

/**
 * 書き出せたときに添える警告(効かない指定・弾いた立体)。断りではないので 0 件のこともある。
 *
 * **model が言っている警告をそのまま文言のキーへ直す。** 利用者へ実際に出すのは
 * `runExport` が `visibleExportWarnings` で絞ったほうで、ここはその手前の素の一覧である
 * (「model は何と言っているか」を検査で押さえるための口。絞り込みを混ぜると、
 * どちらを見ているのか分からなくなる)。
 */
export function exportWarningKeys(
  bodies: readonly SolidBody[],
  request: ExportRequest,
): readonly MessageKey[] {
  const outcome = selectExportBodies(bodies, request);
  return outcome.ok ? outcome.selection.warnings.map(exportNoticeMessageKey) : [];
}

/**
 * 「面積が 0 の三角形を n 枚除きました。」の 1 行(§2.4、タスク16 の `droppedTriangleCount`)。
 *
 * **文言そのものは `ja.json` の 1 件**で、ここは数を埋めるだけにする(NFR-MA-5)。
 * 1 枚も落ちていなければ `null`(何も出さない)。
 */
export function droppedTriangleNotice(template: string, droppedTriangleCount: number): string | null {
  return droppedTriangleCount > 0
    ? template.split('{count}').join(String(droppedTriangleCount))
    : null;
}

// ---------------------------------------------------------------------------
// ファイル名
// ---------------------------------------------------------------------------

/**
 * 書き出しのファイル名の基(拡張子なし)。**カーネルが `.obj` と `.mtl` に同じ基を使う**ので、
 * 呼び出し側が 2 つの名前を組み立てずに済む(§0.a-0.16)。
 *
 * 名前が空・拡張子だけのときは `model`(カーネル側の既定と同じ)にする。
 */
export const DEFAULT_EXPORT_BASE_NAME = 'model';

/** ファイル名から拡張子を落とす。拡張子が無ければそのまま。 */
export function exportBaseNameOf(fileName: string | null): string {
  const trimmed = (fileName ?? '').trim();
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return base.length === 0 ? DEFAULT_EXPORT_BASE_NAME : base;
}

// ---------------------------------------------------------------------------
// 幾何カーネルの口(検査では偽物を差し込む)
// ---------------------------------------------------------------------------

/**
 * 三角形の細かさの対(§0.a-0.64)。三角形を使わない形式では `null`。
 *
 * **model の `ExportSelection` の欄をそのまま名前で指す。** 同じ形の型を ui にもう 1 つ
 * 書くと、model が対の欄を増やしたときに片方が古くなる。
 */
export type ExchangeMeshQuality = ExportSelection['meshQuality'];

/** 書き出したファイル 1 つ。名前はカーネルが組んだものを**変えずに**保存する。 */
export interface ExchangeFile {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/** 書き出しの依頼(model の言葉。段のキャッシュの鍵への読み替えは口の実装が行う)。 */
export interface ExchangeExportRequest {
  readonly format: ExchangeKernelExportFormat;
  /** 書き出す立体(`SolidBody.featureId`)。並びは `selectExportBodies` が決めた順。 */
  readonly featureIds: readonly string[];
  /** 三角形の細かさの対(§0.a-0.64)。三角形を使わない形式では `null`。 */
  readonly meshQuality: ExchangeMeshQuality;
  /** 色を書き出すか(§0.a-0.22)。色を持てない形式では見ない。 */
  readonly withColors: boolean;
  /** STL を文字で書くか(§0.a-0.14)。STL 以外では見ない。 */
  readonly ascii: boolean;
  /** ファイル名の基(拡張子なし)。`.obj` と `.mtl` で同じ基を使う。 */
  readonly baseName: string;
}

/**
 * 書き出した立体 1 つぶんの三角形(3MF のときだけ返る。§0.a-0.19)。
 * `packages/io` の `ThreeMfMeshInput` へそのまま渡せる形にしてある。
 */
export interface ExchangeExportMesh {
  readonly name: string | null;
  /** 立体の色(sRGB の 0〜1)。色を書かないときは `null`。 */
  readonly color: readonly [number, number, number] | null;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/** 書き出しの結果。**`files` はそのまま全部保存する**(数えない。§2.4)。 */
export interface ExchangeExportOutcome {
  readonly files: readonly ExchangeFile[];
  /** 面積 0 で落とした三角形の枚数。三角形を使わない形式では 0。 */
  readonly droppedTriangleCount: number;
  /**
   * 3MF のときだけ入る三角形(§0.a-0.19)。カーネルは ZIP と XML を組まないので、
   * ここから `packages/io` の `writeThreeMf` がファイルを作る(`ExchangeDeps.buildThreeMf`)。
   */
  readonly meshes?: readonly ExchangeExportMesh[];
}

/** 読み込んだ立体 1 つ。B-rep を持つ形と三角形だけの形を `bodyKind` で分ける(§0.a-0.23)。 */
export type ExchangeImportedBody =
  | {
      readonly bodyKind: 'solid' | 'shell';
      readonly name: string | null;
      readonly volume: number;
      readonly triangleCount: number;
      /** `.pcad` の `shapes/<id>.brep` へそのまま入れるバイト列。 */
      readonly brepBytes: Uint8Array;
    }
  | {
      readonly bodyKind: 'mesh';
      readonly name: string | null;
      readonly volume: number;
      readonly triangleCount: number;
      /** `.pcad` の `meshes/<id>.bin` へ入れる三角形。 */
      readonly mesh: ImportedMeshBytes;
    };

/** 読み込みの結果。**座標はすでに mm へ換算済み**(NFR-RE-3)。 */
export interface ExchangeImportOutcome {
  readonly bodies: readonly ExchangeImportedBody[];
  /** ファイルが使っていた長さの単位。`'other'` なら利用者へ訊く(§0.a-0.6)。 */
  readonly unit: 'mm' | 'inch' | 'other';
}

/**
 * 幾何カーネルへの口(`KernelApi.exportShapes` / `importShape` の言い換え)。
 *
 * **`packages/ui` は幾何カーネルを直接呼べない**(依存の向きは `ui → model → kernel`)ので、
 * 測定(`PartMeasurer`)と同じく関数の形で差し込む。検査では記憶上の偽物を渡せる。
 *
 * 断りは**日本語の理由の例外**で投げる(カーネルと `packages/io` の流儀。§2.8 の
 * 「文言の正本の層」)。呼び出し側はその文をそのまま画面へ出す。
 */
export interface ExchangeKernel {
  exportShapes(request: ExchangeExportRequest): Promise<ExchangeExportOutcome>;
  importShape(
    format: 'step' | 'stl' | 'obj' | 'gltf',
    fileName: string,
    bytes: Uint8Array,
  ): Promise<ExchangeImportOutcome>;
}

// ---------------------------------------------------------------------------
// 書き出しの流れ(§2.4)
// ---------------------------------------------------------------------------

/** 手続きの結果。**断りも案内も日本語の文**で返し、画面はそのまま帯へ出す(§2.8)。 */
export type ExchangeOutcome =
  | { readonly ok: true; readonly notices: readonly string[]; readonly handoff?: ExportHandoff }
  | { readonly ok: false; readonly message: string }
  /** 利用者が窓を取り消した。何も起きなかったので、断りも出さない。 */
  | { readonly ok: false; readonly cancelled: true };

/** 手続きが外の世界へ触れる口。 */
export interface ExchangeDeps {
  /** ファイルの出し入れ(ストアが持っている口をそのまま渡す)。 */
  readonly gateway: FileGateway;
  /** 幾何カーネル。 */
  readonly kernel: ExchangeKernel;
  /**
   * 読み込んだファイルに単位が書かれていないとき(STL / OBJ)に訊く(§0.a-0.6)。
   * 取り消されたら `null`(読み込みそのものを止める)。
   */
  readonly askImportUnit: () => Promise<LengthUnit | null>;
  /** 3MF の書き出しで、三角形から `.3mf` のバイト列を組む(`packages/io` が持つ)。 */
  readonly buildThreeMf?: (outcome: ExchangeExportOutcome) => ExchangeFile;
  /** 「面積が 0 の三角形を n 枚除きました。」の文言(`{count}` を含む)。 */
  readonly droppedTriangleTemplate: string;
  /** 断りと警告の文言を引く(`ja.json` の `exchangeError.*`)。 */
  readonly messageOf: (key: MessageKey) => string;
  /** 取り込んだ時刻(ISO 8601)。検査では固定した値を渡す。 */
  readonly now?: () => string;
}

/** 例外の中身を利用者へ見せる 1 行にする(理由はカーネル / io が日本語で持っている)。 */
function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 書き出す(FR-803、§2.4)。流れは 4 段:
 *
 * 1. **カーネルを呼ぶ前に**書き出す立体を決める(`selectExportBodies`)。断るならここで断る。
 * 2. カーネルへ頼む(3MF は三角形だけを受け取り、`packages/io` が ZIP と XML を組む)。
 * 3. 返ってきた `files` を**全部**保存する(`.obj` と `.mtl` の 2 つ。名前は変えない)。
 * 4. 警告と「三角形を n 枚除きました」を案内として返す。
 */
export async function runExport(
  deps: ExchangeDeps,
  bodies: readonly SolidBody[],
  request: ExportRequest,
  fileName: string | null,
): Promise<ExchangeOutcome> {
  const selected = selectExportBodies(bodies, request);
  if (!selected.ok) {
    return { ok: false, message: deps.messageOf(exportNoticeMessageKey(selected.reason)) };
  }

  // 画面に出していない欄についての警告は落とす(`visibleExportWarnings` の注釈)。
  const notices = visibleExportWarnings(request.format, selected.selection.warnings).map(
    (warning) => deps.messageOf(exportNoticeMessageKey(warning)),
  );
  const baseName = exportBaseNameOf(fileName);

  let outcome: ExchangeExportOutcome;
  try {
    outcome = await deps.kernel.exportShapes({
      format: kernelExportFormatOf(request.format),
      featureIds: selected.selection.featureIds,
      meshQuality: selected.selection.meshQuality,
      withColors: request.withColors,
      ascii: request.ascii,
      baseName,
    });
  } catch (error) {
    return { ok: false, message: messageOfError(error) };
  }

  // 3MF はカーネルが三角形までしか返さない(§0.a-0.19)ので、ここでファイルへ組む。
  const files =
    request.format === '3mf' && deps.buildThreeMf !== undefined
      ? [deps.buildThreeMf(outcome)]
      : outcome.files;
  if (files.length === 0) {
    return { ok: false, message: deps.messageOf('exchangeError.nothingToExport') };
  }

  /*
   * **全部保存する。** OBJ は `.obj` の中の材質の行が `.mtl` の名前を指しているので、
   * 名前を変えたり片方だけ保存したりすると色が付かない(§2.4)。場所を選べない環境では
   * ダウンロードが 2 回起きる(§0.a-0.13 の暫定。利用者の決定が出たら 1 つにまとめる)。
   */
  let handoff: ExportHandoff | undefined;
  for (const file of files) {
    let saved: boolean;
    try {
      const result = await saveExportFile(deps.gateway, file.fileName, request.format, file.bytes);
      saved = result.saved;
      if (files.length === 1) handoff = result.handoff;
    } catch (error) {
      return { ok: false, message: hasSaveRecoveryCopy(error) ? deps.messageOf('file.saveRecoveryCopyRetained') : messageOfError(error) };
    }
    if (!saved) {
      // 1 つ目で取り消したら 2 つ目も訊かない(訊き続けるほうが煩わしい)。
      return { ok: false, cancelled: true };
    }
  }

  const dropped = droppedTriangleNotice(deps.droppedTriangleTemplate, outcome.droppedTriangleCount);
  return { ok: true, notices: dropped === null ? notices : [...notices, dropped], ...(handoff === undefined ? {} : { handoff }) };
}

// ---------------------------------------------------------------------------
// DXF の書き出し(FR-813、§2.7、§0.a-0.34、タスク53)
// ---------------------------------------------------------------------------

/**
 * 書き出す図形が 1 つも無いとき(NFR-UX-5「できないことは押す前に断る」)。
 *
 * **空のスケッチは model も io も断らない**(`sketchToDxf` は空の実体の列を返し、
 * `writeDxfDocument` は骨だけの正しい DXF を書く)。形式としては正しくても、
 * 利用者にとっては「何も入っていないファイルができた」だけなので、ここで止める。
 */
export const DXF_EXPORT_EMPTY_KEY: MessageKey = 'exchange.dxfNothingToExport';

/**
 * **押す前の断り**(NFR-UX-5)。DXF に書き出せないときだけ**日本語の 1 文**を返す。
 *
 * 立体の側(`exportRefusalKey`)が文言のキーを返すのに対してこちらが文を返すのは、
 * 断りの理由の一方(「この形は平らではないので DXF に書き出せません。」)を
 * **model が文として持っている**ため(§2.8「文言の正本の層」)。キーへ直す表を
 * ここに作ると、同じ文が 2 か所に住むことになる。
 */
export function dxfExportRefusal(
  input: SketchToDxfInput,
  messageOf: (key: MessageKey) => string,
): string | null {
  const converted = sketchToDxf(input);
  if (!converted.ok) {
    return converted.reason;
  }
  return converted.entities.length === 0 ? messageOf(DXF_EXPORT_EMPTY_KEY) : null;
}

/**
 * DXF に書き出す(FR-813、§2.7)。流れは 3 段:
 *
 * 1. スケッチの解決済みの形を DXF の実体へ写す(model の `sketchToDxf`)。断るならここ。
 * 2. R12 のテキストへ書く(io の `writeDxfDocument`)。
 * 3. UTF-8 のバイト列にして `.dxf` を **1 ファイル**保存する。
 *
 * **幾何カーネルを通らない。** DXF に出るのはスケッチの線であって立体ではないので、
 * `ExchangeKernel` は 1 度も呼ばない(`runExport` との一番大きな違い)。
 *
 * R12 に `ELLIPSE` / `SPLINE` が無いため、楕円となめらかな曲線は折れ線へ落ちる。
 * **形がわずかに変わったことは案内として返す**(赤い断りではない。NFR-RE-1)。
 */
export async function runExportDxf(
  deps: ExchangeDeps,
  input: SketchToDxfInput,
  fileName: string | null,
): Promise<ExchangeOutcome> {
  const converted = sketchToDxf(input);
  if (!converted.ok) {
    return { ok: false, message: converted.reason };
  }
  if (converted.entities.length === 0) {
    return { ok: false, message: deps.messageOf(DXF_EXPORT_EMPTY_KEY) };
  }

  let written: DxfWriteResult;
  try {
    written = writeDxfDocument(converted.entities);
  } catch (error) {
    // 書けない値(有限でない座標など)は io が日本語の理由で断る。そのまま見せる。
    return { ok: false, message: messageOfError(error) };
  }

  const bytes = new TextEncoder().encode(written.text);
  let saved: boolean;
  try {
    saved = await saveFileAsThrough(
      deps.gateway,
      `${exportBaseNameOf(fileName)}${DXF_EXTENSION}`,
      'dxf',
      bytes,
    );
  } catch (error) {
    return { ok: false, message: hasSaveRecoveryCopy(error) ? deps.messageOf('file.saveRecoveryCopyRetained') : messageOfError(error) };
  }
  if (!saved) {
    return { ok: false, cancelled: true };
  }

  return {
    ok: true,
    notices:
      written.flattenedCurveCount > 0
        ? [dxfFlattenedCurveMessage(written.flattenedCurveCount)]
        : [],
  };
}

/** 書き出す DXF の拡張子。名前の基は立体の書き出しと同じ `exportBaseNameOf` から取る。 */
const DXF_EXTENSION = '.dxf';

// ---------------------------------------------------------------------------
// 読み込みの流れ(§2.8)
// ---------------------------------------------------------------------------

/** 読み込んだ形を履歴へ積んだ結果。 */
export interface ImportedFeaturesResult {
  readonly document: PartDocument;
  /** `.pcad` の `shapes/<id>.brep` に入れるバイト列(参照 → 中身)。 */
  readonly shapes: ReadonlyMap<string, Uint8Array>;
  /** `.pcad` の `meshes/<id>.bin` に入れる三角形(参照 → 中身)。 */
  readonly meshes: ReadonlyMap<string, ImportedMeshBytes>;
}

/**
 * 読み込んだ立体を履歴のベースボディへ積む(FR-802、§2.8、タスク20)。
 *
 * **参照(`shapeRef` / `meshRef`)はフィーチャーの id をそのまま使う。** 文書の中で
 * 一意であることが `nextSolidId` で保証されていて、`.pcad` の ZIP のエントリ名も
 * それだけで決まる(名前を別に採ると、どちらが正しいかを確かめる場所が増える)。
 *
 * **外観は既定のまま**にする(§0.a-0.28。ファイルの中の色の取り込みは P7 以降)。
 */
export function appendImportedBodies(
  document: PartDocument,
  bodies: readonly ExchangeImportedBody[],
  source: Omit<ImportedSource, 'unit'>,
  unit: LengthUnit,
): ImportedFeaturesResult {
  const shapes = new Map<string, Uint8Array>();
  const meshes = new Map<string, ImportedMeshBytes>();
  let next = document;
  for (const body of bodies) {
    if (body.bodyKind === 'mesh') {
      const id = nextSolidId(next, 'importedMesh');
      const feature: ImportedMeshFeature = {
        id,
        kind: 'importedMesh',
        // ファイルに名前があればそれを使う(FR-804)。無ければ種類ごとの連番。
        name: body.name ?? nextSolidName(next, 'importedMesh'),
        suppressed: false,
        meshRef: id,
        source: { ...source, unit },
        triangleCount: body.triangleCount,
        volume: body.volume,
      };
      meshes.set(id, body.mesh);
      next = appendSolid(next, feature);
      continue;
    }
    const id = nextSolidId(next, 'importedSolid');
    const feature: ImportedSolidFeature = {
      id,
      kind: 'importedSolid',
      name: body.name ?? nextSolidName(next, 'importedSolid'),
      suppressed: false,
      shapeRef: id,
      source: { ...source, unit },
      bodyKind: body.bodyKind,
    };
    shapes.set(id, body.brepBytes);
    next = appendSolid(next, feature);
  }
  return { document: next, shapes, meshes };
}

/** 読み込みの結果(文書の差し替えと添付の追加を、呼び出し側が 1 度に受け取れる形)。 */
export type ImportOutcome =
  | {
      readonly ok: true;
      readonly document: PartDocument;
      readonly shapes: ReadonlyMap<string, Uint8Array>;
      readonly meshes: ReadonlyMap<string, ImportedMeshBytes>;
      readonly notices: readonly string[];
    }
  | { readonly ok: false; readonly message: string }
  | { readonly ok: false; readonly cancelled: true };

/** 取り込んだ形が 1 つも無いとき(§2.8 の表。文言の正本は下の層だが、3MF は空で返る)。 */
export const NO_SHAPE_MESSAGE = 'このファイルには形が入っていません。';

/** DXF を立体の読み込みの経路へ流したとき(呼び分けの取り違えを黙って通さない)。 */
export const DXF_IS_NOT_A_BODY_MESSAGE = 'DXF は図形として取り込みます。';

/** UTF-8 のバイト列を文字へ直す。読めなければ null。 */
function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * ファイルの単位を決める(§0.a-0.6)。`'other'`(STL / OBJ)のときだけ利用者へ訊く。
 * 取り消されたら `null`(読み込みそのものを止める)。
 */
async function resolveImportUnit(
  deps: ExchangeDeps,
  unit: 'mm' | 'inch' | 'other',
): Promise<LengthUnit | null> {
  return unit === 'other' ? deps.askImportUnit() : unit;
}

/**
 * 3MF を読む(FR-809、§0.a-0.26)。**`packages/io` が自前の ZIP / XML の読み手を持つ**ので、
 * カーネルは通らない。座標は `readThreeMf` が mm へ換算済み。
 */
function readThreeMfBodies(bytes: Uint8Array): ExchangeImportOutcome | string {
  const result = readThreeMf(bytes);
  if (!result.ok) {
    return result.reason;
  }
  const bodies: ExchangeImportedBody[] = result.meshes.map((mesh) => ({
    bodyKind: 'mesh',
    name: mesh.name,
    volume: mesh.volume,
    triangleCount: mesh.triangleCount,
    mesh: { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices },
  }));
  // 3MF は単位を属性で持ち、座標は mm へ換算済みなので利用者へ訊かない(§0.a-0.6)。
  return { bodies, unit: 'mm' };
}

/**
 * 立体を読み込む(FR-802、§2.8)。形式は**拡張子で決める**(利用者が窓で選んだ種類の中から)。
 *
 * 断りの文はすべて下の層(カーネル / `packages/io`)が日本語で持っているものをそのまま返す
 * (§2.8「文言の正本の層」)。読めなかったからといって今の文書は変えない(NFR-RE-1)。
 */
export async function runImportBody(
  deps: ExchangeDeps,
  document: PartDocument,
): Promise<ImportOutcome> {
  let picked;
  try {
    picked = await openFileThrough(deps.gateway, READABLE_FILE_KINDS);
  } catch (error) {
    return { ok: false, message: messageOfError(error) };
  }
  if (picked === null) {
    return { ok: false, cancelled: true };
  }
  return importPickedBody(deps, document, picked);
}

/**
 * 選び終わったファイルを立体として取り込む(`runImportBody` の後半)。
 *
 * **窓を開く前に形式が分かっている場合の入口**でもある。「読み込む」の 1 つの窓で
 * 6 形式を選ばせる(`runImport`)ので、選んだ後に DXF とそれ以外へ分かれる。
 */
export async function importPickedBody(
  deps: ExchangeDeps,
  document: PartDocument,
  picked: PickedTypedFile,
): Promise<ImportOutcome> {
  const format = importedSourceFormatOf(picked.kind);
  if (format === null) {
    return { ok: false, message: DXF_IS_NOT_A_BODY_MESSAGE };
  }

  let outcome: ExchangeImportOutcome;
  if (format === '3mf') {
    const read = readThreeMfBodies(picked.bytes);
    if (typeof read === 'string') {
      return { ok: false, message: read };
    }
    outcome = read;
  } else {
    try {
      outcome = await deps.kernel.importShape(format, picked.fileName, picked.bytes);
    } catch (error) {
      return { ok: false, message: messageOfError(error) };
    }
  }
  if (outcome.bodies.length === 0) {
    return { ok: false, message: NO_SHAPE_MESSAGE };
  }

  const unit = await resolveImportUnit(deps, outcome.unit);
  if (unit === null) {
    return { ok: false, cancelled: true };
  }

  const appended = appendImportedBodies(
    document,
    outcome.bodies,
    {
      format,
      fileName: picked.fileName,
      byteLength: picked.bytes.byteLength,
      importedAt: deps.now?.(),
    },
    unit,
  );
  return {
    ok: true,
    document: appended.document,
    shapes: appended.shapes,
    meshes: appended.meshes,
    notices: [],
  };
}

// ---------------------------------------------------------------------------
// DXF の読み込み(FR-813、§2.7)
// ---------------------------------------------------------------------------

/** DXF を読んだ結果(スケッチへ積む)。 */
export type DxfImportOutcome =
  | { readonly ok: true; readonly sketch: SketchDocument; readonly notices: readonly string[] }
  | { readonly ok: false; readonly message: string }
  | { readonly ok: false; readonly cancelled: true };

/** DXF を文字として読めなかったとき(§2.8 の表の「読めませんでした」と同じ扱い)。 */
export const DXF_NOT_TEXT_MESSAGE =
  'このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。';

/**
 * DXF をいま編集しているスケッチへ取り込む(FR-813、§0.a-0.33)。
 *
 * 流れは `parseDxfTags` → `readDxf` → `dxfToSketch` → `appendFeature` の 4 段。
 * **案内(`notices`)は下の層が組んだ文をそのまま並べる**(§2.8)。単位が `'other'`
 * (`$INSUNITS` が無い / 知らない値)のときだけ利用者へ訊く。
 */
export async function runImportDxf(
  deps: ExchangeDeps,
  sketch: SketchDocument,
  plane: WorkPlane,
): Promise<DxfImportOutcome> {
  let picked;
  try {
    picked = await openFileThrough(deps.gateway, ['dxf']);
  } catch (error) {
    return { ok: false, message: messageOfError(error) };
  }
  if (picked === null) {
    return { ok: false, cancelled: true };
  }
  return importPickedDxf(deps, sketch, plane, picked);
}

/** 選び終わった DXF をスケッチへ取り込む(`runImportDxf` の後半)。 */
export async function importPickedDxf(
  deps: ExchangeDeps,
  sketch: SketchDocument,
  plane: WorkPlane,
  picked: PickedTypedFile,
): Promise<DxfImportOutcome> {
  const text = decodeText(picked.bytes);
  if (text === null) {
    return { ok: false, message: DXF_NOT_TEXT_MESSAGE };
  }

  let read;
  try {
    read = readDxf(parseDxfTags(text));
  } catch (error) {
    return { ok: false, message: messageOfError(error) };
  }

  const unit = await resolveImportUnit(deps, read.unit);
  if (unit === null) {
    return { ok: false, cancelled: true };
  }
  const written = dxfToSketch(dxfEntitiesOf(read.entities), plane, {
    unit: read.unit,
    // 単位が分からなかったときだけ、訊いた答えを 1 単位あたりの mm として渡す。
    unitOverrideMm: read.unit === 'other' && unit === 'inch' ? MM_PER_INCH_FOR_DXF : undefined,
    offPlaneCount: read.offPlaneCount,
    skippedEntityCount: read.skippedEntityCount,
    existingFeatures: sketch.features,
  });

  let next = sketch;
  for (const feature of written.features) {
    next = appendFeature(next, feature);
  }
  return { ok: true, sketch: next, notices: written.notices };
}

/** インチの DXF を mm へ直す倍率(国際インチの定義値)。model の `MM_PER_INCH` と同じ値。 */
const MM_PER_INCH_FOR_DXF = 25.4;

/**
 * `packages/io` の実体を model の言葉へ渡す。**欄が 1 対 1 に同じ型**なので詰め替えは
 * 起きない(`model/src/exchange/dxfTypes.ts` の注釈。`model` は `io` を輸入できない)。
 */
function dxfEntitiesOf(entities: readonly DxfEntity[]): readonly DxfEntity[] {
  return entities;
}

// ---------------------------------------------------------------------------
// 「読み込む」の 1 つの入口(§0.a-0.20 の一覧の 1 行)
// ---------------------------------------------------------------------------

/** 「読み込む」の結果。立体になったか、スケッチの図形になったかで枝が分かれる。 */
export type ImportAnyOutcome =
  | {
      readonly ok: true;
      readonly kind: 'body';
      readonly document: PartDocument;
      readonly shapes: ReadonlyMap<string, Uint8Array>;
      readonly meshes: ReadonlyMap<string, ImportedMeshBytes>;
      readonly notices: readonly string[];
    }
  | { readonly ok: true; readonly kind: 'sketch'; readonly sketch: SketchDocument;
      readonly notices: readonly string[] }
  | { readonly ok: false; readonly message: string }
  | { readonly ok: false; readonly cancelled: true };

/**
 * 「読み込む」(FR-802、FR-813)。**窓は 1 つ**で、6 形式のどれを選んでもよい。
 *
 * 選んだ拡張子が `.dxf` ならスケッチの図形として取り込み、それ以外は立体として取り込む
 * (利用者から見れば「読み込む」の 1 つの操作。入口を 2 つに割らない、NFR-UX-1)。
 */
export async function runImport(
  deps: ExchangeDeps,
  document: PartDocument,
  sketch: SketchDocument,
  plane: WorkPlane,
  format?: ImportFileKind,
): Promise<ImportAnyOutcome> {
  if (format === 'dwg') return { ok: false, message: deps.messageOf('exchange.dwgGuide') };
  let picked;
  try {
    picked = await openFileThrough(deps.gateway, format === undefined ? READABLE_FILE_KINDS : [format]);
  } catch (error) {
    return { ok: false, message: messageOfError(error) };
  }
  if (picked === null) {
    return { ok: false, cancelled: true };
  }
  if (picked.kind === 'dxf') {
    const outcome = await importPickedDxf(deps, sketch, plane, picked);
    return outcome.ok ? { ...outcome, kind: 'sketch' } : outcome;
  }
  const outcome = await importPickedBody(deps, document, picked);
  return outcome.ok ? { ...outcome, kind: 'body' } : outcome;
}
