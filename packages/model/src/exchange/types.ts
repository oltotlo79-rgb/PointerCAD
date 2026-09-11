/**
 * 書き出し・読み込みの型(要件 FR-803・FR-804・FR-802・FR-427、計画書
 * docs/plans/P6-入出力.md §2.1・§2.8、タスク2)。
 *
 * ここに置くのは**型と定数だけ**で、判断(どの立体を書き出せるか)は `exportPart.ts` の
 * 純関数が持つ。カーネルも `packages/ui` の画面もこの 1 か所を見るので、形式の一覧・
 * 品質の 3 択・既定値を写して 2 か所に持つことはしない。
 *
 * **断りと警告は文字列のキーで持ち、日本語の文言は持たない**(NFR-MA-5)。文言は
 * `packages/ui` の `ja.json` が持ち、画面がキーで引く(計画書 §2.8 の表)。エラーコードの
 * 体系(`ParseErrorCode` など)は増やさない(`docs/報告記録.md` 2026-09-04 01:40 の③)。
 */

/**
 * このアプリの種類一覧に載るファイル(計画書 §2.2・§2.10)。DWGは変換案内だけ。
 *
 * `'pcad'` は部品の文書、`'pcadt'` はそのひな形(§0.a-0.35。中身は同じで拡張子と封筒の
 * `kind` だけが違う)。`'pcadscript'`は自動作図の処理ファイル。残りは他の CAD・スライサーとやり取りする形式で、`'glb'` は
 * glTF のバイナリ 1 ファイル版(§0.a-0.16)である。
 *
 * **「書き出せる形式」「読み込める形式」はこれの部分集合**で、下の `ExportFormat` /
 * `ImportFormat` が正本になる。
 */
export type FileKind = 'pcad' | 'pcadt' | 'pcadscript' | 'step' | 'stl' | 'obj' | 'glb' | '3mf' | 'dxf' | 'dwg';

/** ファイルの種類の実行時の一覧(`LENGTH_UNITS` と同じ流儀。同じ並びを 2 か所に書かない)。 */
export const FILE_KINDS: readonly FileKind[] = [
  'pcad', 'pcadt', 'pcadscript', 'step', 'stl', 'obj', 'glb', '3mf', 'dxf', 'dwg',
];

/**
 * 立体を書き出せる形式(FR-803)。**`packages/io` の `ExportFormat` の正本**で、あちらは
 * この型と `EXPORT_FORMATS` を再輸出するだけにしてある(P2 が io に置いた定義を、P6 で
 * model へ寄せた。二重定義にしない)。
 *
 * **DXF はここに入らない。** DXF に書き出すのは平らなスケッチの線であって立体ではない
 * (§0.a-0.30・§0.a-0.34)ので、依頼の形(`ExportRequest`)も別になる。DXF の書き出しの
 * 依頼はタスク26 以降の担当が別に作る。ただし**品質(なめらかさ)の扱いだけは形式ごとの
 * 性質**なので、`exportPart.ts` の `usesTriangles` は `FileKind` で受けて DXF も答える。
 */
export type ExportFormat = 'step' | 'stl' | '3mf' | 'obj' | 'glb';

/** 書き出せる形式の一覧(FR-803)。`packages/io/src/schemaVersion.test.ts` がこの並びを固定する。 */
export const EXPORT_FORMATS: readonly ExportFormat[] = ['step', 'stl', '3mf', 'obj', 'glb'];

/**
 * 読み込める形式(FR-802 の Must の 3 つ)。3MF と glTF の読み込みは Could(FR-809、
 * §0.a-0.26・§0.a-0.56)、DXF の読み込みはスケッチになる別の口(FR-813)なので、
 * どちらもここには入れない。**増やすときは `canRoundTrip` の意味も見直すこと。**
 */
export type ImportFormat = 'step' | 'stl' | 'obj';

/** 読み込める形式の一覧(FR-802)。 */
export const IMPORT_FORMATS: readonly ImportFormat[] = ['step', 'stl', 'obj'];

/**
 * 書き出す立体の選び方(FR-427、§0.a-0.12)。`'all'` は文書の中のすべての立体、
 * `'selected'` は画面で選んである立体だけ。
 */
export type ExportScope = 'all' | 'selected';

/**
 * 三角形のなめらかさの 3 択(§0.a-0.20)。利用者には「粗い / 標準 / 細かい」として見せ、
 * 内部の逸脱(mm)は見せない(NFR-UX-4。数値の式にしない)。
 */
export type ExportQuality = 'coarse' | 'normal' | 'fine';

/** 品質の一覧(画面が並べる順。粗いほうから)。 */
export const EXPORT_QUALITIES: readonly ExportQuality[] = ['coarse', 'normal', 'fine'];

/**
 * 三角形の細かさの指定(§0.a-0.64)。**長さと角度の「対」**で持つ。
 *
 * カーネルの `ShapeExportMeshQuality`(`packages/kernel/src/types.ts`)と欄が 1 対 1 に
 * 同じで、そのまま渡せる形にしてある(**model は kernel の型を輸入しない**——依存の向きは
 * `model → kernel` だが、書き出しの依頼を組み立てるのは `packages/ui` で、あちらは
 * kernel を輸入できないため、渡す形の正本をここに置く)。
 */
export interface ExportMeshQuality {
  /** 弦の最大ずれ(mm)。小さいほど細かい。 */
  readonly deviationMm: number;
  /** 法線の向きの最大ずれ(ラジアン)。小さいほど丸い面が細かくなる。 */
  readonly angularDeflectionRad: number;
}

/**
 * 品質 → 三角形分割の細かさの対の表(§0.a-0.64)。**この表はここ 1 か所だけ**にある。
 *
 * **長さだけでは足りない**(2026-09-06 の実測、タスク11・17)。角度の偏差には既定の
 * 0.5 ラジアンがあり、丸い面ではそちらが先に効くので、長さを 0.1mm に絞っても
 * 半径 10 の球は 978 枚・体積の不足 1.43% にとどまる(§2.4 の「偏差 0.1 で 1% 以内」が
 * 成り立たない)。角度も一緒に 0.2 ラジアンへ絞って初めて 2,022 枚・0.72% になり、
 * FR-803 の精度が成り立つ。だから 3 択の裏は数 1 つではなく**対**で持つ。
 *
 * `0.1` は画面表示の既定と同じ細かさで、`0.02` は 3D プリントの積層(0.1〜0.2mm)より
 * 十分細かい。`0.5` は大きな形の下見用。
 */
export const EXPORT_MESH_QUALITY: Readonly<Record<ExportQuality, ExportMeshQuality>> = {
  coarse: { deviationMm: 0.5, angularDeflectionRad: 0.5 },
  normal: { deviationMm: 0.1, angularDeflectionRad: 0.2 },
  fine: { deviationMm: 0.02, angularDeflectionRad: 0.1 },
};

/**
 * 品質 → 三角形分割の逸脱(mm)の表(§0.a-0.20)。
 *
 * **数を書き写さず、対の表(`EXPORT_MESH_QUALITY`)から長さの欄だけを取り出す。**
 * 同じ 3 つの数を 2 か所に書くと、片方だけ直したときに気づけない。
 */
export const EXPORT_DEVIATION_MM: Readonly<Record<ExportQuality, number>> = {
  coarse: EXPORT_MESH_QUALITY.coarse.deviationMm,
  normal: EXPORT_MESH_QUALITY.normal.deviationMm,
  fine: EXPORT_MESH_QUALITY.fine.deviationMm,
};

/**
 * 書き出しの断りと警告のキー(計画書 §2.8 の表)。**文言は持たない**(ui の `ja.json`)。
 *
 * - `nothingToExport`: 書き出せる立体が 1 つも無い(断りだけ)。
 * - `shellNotSupported`: 面だけの立体を、閉じた立体しか持てない形式(STL・3MF)へ出そうとした。
 * - `meshNotSupported`: 読み込んだ三角形の形を、B-rep しか持てない形式(STEP)へ出そうとした。
 * - `colorNotSupported`: 色を出す指定だが形式に色が無い(STL。§0.a-0.15。警告だけ)。
 * - `qualityIgnored`: なめらかさの指定が効かない形式(三角形を使わない。警告だけ)。
 *
 * `shellNotSupported` / `meshNotSupported` は**断りにも警告にもなる**。弾いた残りが 1 つでも
 * あれば警告として添えて書き出しを続け、全部弾いて 0 個になったらその理由で断る
 * (「3 つのうち 1 つが面だけ」のときに全部を止めないため。NFR-UX-5 は「実行前に知らせる」)。
 */
export type ExportNoticeKey =
  | 'nothingToExport'
  | 'shellNotSupported'
  | 'meshNotSupported'
  | 'colorNotSupported'
  | 'qualityIgnored';

/**
 * 書き出しの依頼(FR-803・FR-427)。画面(§0.a-0.20 のパネル)が組み立て、
 * `selectExportBodies` が受ける。
 */
export interface ExportRequest {
  readonly format: ExportFormat;
  /** すべての立体か、選んだ立体か(FR-427)。 */
  readonly scope: ExportScope;
  /**
   * `scope === 'selected'` のときに書き出す立体の id(`SolidBody.featureId`)。
   * `scope === 'all'` のときは見ない(空でよい)。
   */
  readonly selectedFeatureIds: readonly string[];
  /** 三角形のなめらかさ。三角形を使わない形式(STEP)では無視される。 */
  readonly quality: ExportQuality;
  /** 色を書き出すか(§0.a-0.22。既定は `true`)。色を持てない形式(STL)では警告になる。 */
  readonly withColors: boolean;
  /** STL を文字で書くか(§0.a-0.14)。STL 以外では意味を持たない。既定はバイナリ(`false`)。 */
  readonly ascii: boolean;
}

/** 書き出す立体を選び分けた結果(FR-427)。ここまでが model の担当で、実際に書くのは kernel / io。 */
export interface ExportSelection {
  /** 書き出す立体。並びは渡された順のまま。 */
  readonly featureIds: readonly string[];
  /**
   * 三角形分割の逸脱(mm)。三角形を使わない形式では `null`(品質は使われない)。
   * カーネルはこの値をそのまま `BRepMesh_IncrementalMesh` の線形逸脱に渡す。
   */
  readonly deviationMm: number | null;
  /**
   * 三角形分割の細かさの対(§0.a-0.64)。三角形を使わない形式では `null`。
   *
   * **`deviationMm` を残したまま欄を足してある。** あちらは長さだけを見る古い呼び出し
   * (P6 の途中で書かれた配線)がそのまま動くようにするための同じ値の写しで、
   * カーネルへ渡すのはこちらの対のほう(角度を落とすと丸い面が粗いままになる)。
   */
  readonly meshQuality: ExportMeshQuality | null;
  /** 弾いた立体・効かない指定の知らせ。**同じキーは 1 度だけ**入る。 */
  readonly warnings: readonly ExportNoticeKey[];
}

/**
 * 書き出せるかどうかの答え(FR-803)。断るときは**理由のキーを 1 つだけ**返す
 * (画面は 1 行で断る。NFR-UX-5)。
 */
export type ExportOutcome =
  | { readonly ok: true; readonly selection: ExportSelection }
  | { readonly ok: false; readonly reason: ExportNoticeKey };

/** 書き出しの対象の既定(§0.a-0.12「既定は全て」)。 */
export const DEFAULT_EXPORT_SCOPE: ExportScope = 'all';

/** なめらかさの既定。画面表示と同じ細かさ(0.1mm)で、たいていの用途に足りる。 */
export const DEFAULT_EXPORT_QUALITY: ExportQuality = 'normal';

/** 色を書き出すかの既定(§0.a-0.22。「既定は書き出す」)。 */
export const DEFAULT_EXPORT_WITH_COLORS = true;

/** STL を文字で書くかの既定(§0.a-0.14。小さいバイナリを既定にする)。 */
export const DEFAULT_EXPORT_ASCII = false;

/** `createExportRequest` に渡す上書き。省いた欄は既定になる。 */
export interface ExportRequestOptions {
  readonly scope?: ExportScope;
  readonly selectedFeatureIds?: readonly string[];
  readonly quality?: ExportQuality;
  readonly withColors?: boolean;
  readonly ascii?: boolean;
}

/**
 * 既定値を埋めた書き出しの依頼を作る。**既定値を画面側に写さない**ための口で、
 * 画面は利用者が触った欄だけを渡す。
 */
export function createExportRequest(
  format: ExportFormat,
  options: ExportRequestOptions = {},
): ExportRequest {
  return {
    format,
    scope: options.scope ?? DEFAULT_EXPORT_SCOPE,
    selectedFeatureIds: options.selectedFeatureIds ?? [],
    quality: options.quality ?? DEFAULT_EXPORT_QUALITY,
    withColors: options.withColors ?? DEFAULT_EXPORT_WITH_COLORS,
    ascii: options.ascii ?? DEFAULT_EXPORT_ASCII,
  };
}
