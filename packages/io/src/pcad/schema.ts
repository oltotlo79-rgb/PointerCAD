/**
 * .pcad の `document.json` の封筒と書式の版(要件§8、計画書 docs/plans/P2-ソリッド基礎.md §2.8、§0.a-0.3)。
 *
 * 封筒は「どの版の、どのアプリが、いつ書いたか」だけを持ち、中身は部品文書そのものを入れる。
 * 版の正本は部品文書の `schemaVersion`(統括の決定④、docs/報告記録.md 2026-09-03 07:35)で、
 * 封筒の `schema` には同じ値を書く。読み手は封筒の `schema` を先に検査してから中身を読む
 * (中身の形は版によって変わり得るため、版の判定を中身の解釈より先に済ませる)。
 */

import {
  DEFAULT_BOM_SETTINGS,
  createDefaultNamedViews,
  createDefaultConfigurationsFromSources,
  type AssemblyDocument,
  type DrawingDocument,
  type LengthUnit,
  type PartDocument,
} from '@pointercad/model';

import { isRecord } from './guards.js';

/**
 * .pcad の書式の版(§0.a-0.3)。P3 で 3 になり(P3 計画書 §0.a-0.22、§2.10)、
 * P4 タスク31(§0.a-0.24)で 4 になり、P4b タスク21(§0.a-0.17、案 A)で 5 になった。
 * 版 1 で保存されたファイルはこの世に 1 つも無い(P0 には保存機能が無かった)ので、
 * 版 1 は「対応していない古い版」として断る。
 * この値は部品文書の `PART_SCHEMA_VERSION` と必ず同じにする(documentJson.test.ts が検査する)。
 *
 * **版 3 → 版 4(P4 タスク31、§0.a-0.24):** P4 が足したのは新しいスケッチの種類
 * (矩形・正多角形・長穴・楕円・スプライン・オフセット・複製・投影/交差)と基準ジオメトリ・
 * 任意平面・3D スケッチ・構築線フラグである。これらの実装過程(タスク6・9)で、版 3 のままの
 * 段階的な追加として「欄が無ければ寛容に読む」扱いにしていたものが3つある
 * (`construction` 無し→false、点列の `base`/`azimuth`/`spacing`/`count` が `layout` を
 * 挟まないフラットな形→`layout: { kind: 'linear', ... }`、`references` 無し→空配列)。
 * 版を4へ上げたことで、この寛容さを「版3以前からの移行」として `SCHEMA_MIGRATIONS[3]` へ
 * 明示的に切り出し、版4の読み手(`documentJson.ts` の各 read 関数)はこれらの欄が
 * 無ければ `missingField` で断る(寛容な読みを版3以前だけに限定し、版4以降に持ち越さない)。
 * `freeOrientation`(3D スケッチの円弧の向き、タスク10)は版に関係なく恒常的に省略可能な欄
 * (作図面上の円弧はそもそも持たない)なので、この移行の対象にしない。
 *
 * **版 4 → 版 5(P4b タスク21、§0.a-0.17):** P4b が足したのはパラメータ表
 * (`PartDocument.parameters`、FR-207)とスケッチの拘束(`SketchDocument.constraints`、
 * FR-313)である。`parameters` は部品文書の必須の欄になるので、版4以前のファイル
 * (この欄を持たない)は `SCHEMA_MIGRATIONS[4]` が空配列で補う(`references` と同じ扱い)。
 * `constraints` は型自体が恒常的に省略可能なまま(`SketchDocument.constraints?`)なので、
 * `freeOrientation` と同じく版に関係なく「無ければ触らない」まま読み込む
 * (`documentJson.ts` の `readSketch`。移行の対象にしない)。拘束の**解**(座標の上書き)は
 * 保存しない(式と目標値だけを保存し、解決のたびに解き直す。rules/04「導出できるものは
 * 保存しない」)。
 *
 * **版 5 → 版 6(P5 タスク5、§0.a-0.15):** P5 が足したのは外観の割り当て
 * (`PartDocument.appearance`、FR-1106〜1110)である。計画書は「版 5」と書いているが、
 * P4b タスク21が先に版 5 を使ったため、統括の決定により P5 のこの節はすべて版 6 に
 * 読み替える。`appearance` は部品文書の必須の欄になるので、版5以前のファイル(この欄を
 * 持たない)は `SCHEMA_MIGRATIONS[5]` が空の表で補う(`parameters` と同じ扱い)。
 *
 * **版 6 → 版 7(P6 タスク21、§0.a-0.55):** P6 が足したのは
 * ①読み込んだ形のベースボディ 2 種(`importedSolid` / `importedMesh`、FR-802、タスク20)、
 * ②選択セット(`selectionSets`、FR-112、§0.a-0.44)、③下絵の画像(`canvases`、FR-332、
 * §0.a-0.45)、④**ZIP の中の新しいエントリ**(`shapes/*.brep` / `meshes/*.bin` /
 * `canvases/*.png`、`pcadFile.ts`)である。**版は 1 回しか上げない**(統括の承認、§0.a-0.55)
 * ので、②③がまだ部品文書の欄になっていない段階でも、版 7 の移行にまとめて含める。
 *
 * ①はフィーチャーの種類が増えるだけ(版 2 → 版 3 と同じ)なので移行では何もしない。
 * ②③は部品文書の必須の欄になる予定なので、版6以前のファイル(この欄を持たない)は
 * `SCHEMA_MIGRATIONS[6]` が空配列で補う(`parameters`(版 5)・`appearance`(版 6)と
 * まったく同じ形)。④は `document.json` の中身ではないので移行の対象にならない
 * (添付が 1 つも無い版7のファイルは、版6のファイルと同じく `document.json` だけを持つ)。
 *
 * **版 7 のまま足した欄(P6 タスク27、FR-814、§0.a-0.35):** ひな形の封筒の
 * `lengthUnit` / `toolDefaults` は**任意の欄**にしたので版は上げない。欄を持たない
 * 版 7 のファイル(部品の `.pcad` は今までどおり書かない)はそのまま読め、読み手が
 * 既定で埋める。**任意の欄を足すたびに版を上げると、古いアプリで開けないファイルが
 * 増えるだけで得るものが無い**(要件§8 の前方互換)。
 *
 * **版 7 → 版 8(P7 タスク3、P7 §0.a-0.2):** P7 が足したのは**封筒の新しい種別**
 * `assembly`(アセンブリ文書、FR-601、FR-801)と、その ZIP の `parts/<ref>.json` の
 * エントリである(`assemblyJson.ts` / `pcadFile.ts`)。**部品文書の欄は 1 つも増えていない**
 * ので、`SCHEMA_MIGRATIONS[7]` は部品文書のためには `schemaVersion` を書き換えるだけで
 * 何もしない(版 2 → 版 3 と同じ)。
 *
 * **それでも版を上げるのは、部品とアセンブリで版の系列を分けないためである**(P7 §0.a-0.2)。
 * 封筒の `schema` は 1 本で、種別によらず同じ数を書く。こうしておくと「このファイルは
 * 新しすぎる/古すぎる」の判定が種別ごとに分かれず 1 か所で済む。版 7 以前の
 * アセンブリファイルはこの世に 1 つも存在しない(種別そのものが版 8 で生まれた)。
 */
export const PCAD_SCHEMA_VERSION = 10;

/** 封筒に書くアプリ名。他のアプリの JSON を取り違えて読まないための目印。 */
export const PCAD_APP_NAME = 'PointerCAD';

/**
 * 封筒に書く種別(要件§8 の「種別(part / assembly / drawing)」、統括の決定
 * docs/報告記録.md 2026-09-03 07:58 の⑤)。
 *
 * このアプリが書き出すのは部品(part)だけなので、書き出しでは常にこの値を書く。
 * 読み手は `part` 以外を理由つきで断る。将来アセンブリや図面を足すときは、
 * この定数ではなく読み手の受け入れる一覧を広げる(書き出す側は種類ごとに決まった値を書く)。
 */
export const PCAD_DOCUMENT_KIND = 'part';

/**
 * ひな形(テンプレート)の封筒に書く種別(FR-814、§0.a-0.35。P6 タスク21 で足した)。
 *
 * ひな形は「中身の入っていない部品」で、**形も欄も部品とまったく同じ**なので、
 * 読み書きの実装は 1 行も分けず、封筒のこの欄と拡張子(`.pcadt`)だけで分ける。
 * 「そのひな形に履歴が入っていたらどうするか」の判断はここではせず、
 * 読み手(`parseDocument` が返す `kind`)を見た上の層(タスク27)が決める。
 */
export const PCAD_TEMPLATE_KIND = 'partTemplate';

/**
 * **部品の**読み手(`documentJson.ts` の `parseDocument`)が受け入れる封筒の種別
 * (§0.a-0.35)。**この一覧に無い種別**(`drawing`)は、既存の `unsupportedKind` で断る
 * (**エラーコードを増やさない**。`docs/報告記録.md` 2026-09-04 01:40 の③)。
 *
 * **アセンブリ(P7 タスク3、`PCAD_ASSEMBLY_KIND`)はここに入れない。** 中身が
 * `PartDocument` とはまったく別の型(`AssemblyDocument`)で、読み手も別
 * (`assemblyJson.ts` の `readAssemblyDocument`)だからである。ここへ足してしまうと、
 * 部品の読み手がアセンブリの封筒を受け取って中身を部品として読み始め、
 * 「document.sketches が見つかりません」という**取り違えた理由**で断ることになる。
 * 種別ごとに「その読み手が受け入れる一覧」を持ち、一覧に無い種別は入口で断る。
 */
export type PcadDocumentKind = typeof PCAD_DOCUMENT_KIND | typeof PCAD_TEMPLATE_KIND;

/** 同上の実体。`readLiteral` に渡して封筒の `kind` を絞るために配列で持つ。 */
export const PCAD_DOCUMENT_KINDS: readonly PcadDocumentKind[] = [
  PCAD_DOCUMENT_KIND,
  PCAD_TEMPLATE_KIND,
];

/**
 * 封筒に書くアセンブリの種別(要件§8 の「種別(part / assembly / drawing)」、
 * P7 §0.a-0.1、タスク3)。拡張子は `.pcada`。
 *
 * **中身は部品(`PartDocument`)とはまったく別の型**(`AssemblyDocument`)で、
 * ZIP の作り(`document.json` / `thumbnail.png`)と決定性の約束だけを部品と共有する。
 * 拡張子と種別を分けるのは、部品を開くつもりでアセンブリを開く取り違えを防ぐため
 * (§0.a-0.1。P6 のひな形 `.pcadt` と同じ判断)。
 */
export const PCAD_ASSEMBLY_KIND = 'assembly';

/** 同上の型。アセンブリの封筒はこの 1 値しか取らない。 */
export type PcadAssemblyKind = typeof PCAD_ASSEMBLY_KIND;

/**
 * **アセンブリの**読み手(`assemblyJson.ts` の `readAssemblyDocument`)が受け入れる種別。
 * 部品・ひな形・図面はこの一覧に無いので `unsupportedKind` で断る。
 */
export const PCAD_ASSEMBLY_KINDS: readonly PcadAssemblyKind[] = [PCAD_ASSEMBLY_KIND];

/** 図面と図面ひな形の封筒種別(P8 タスク3・58)。 */
export const PCAD_DRAWING_KIND = 'drawing';
export const PCAD_DRAWING_TEMPLATE_KIND = 'drawingTemplate';

export type PcadDrawingKind =
  | typeof PCAD_DRAWING_KIND
  | typeof PCAD_DRAWING_TEMPLATE_KIND;

/** 図面の読み手だけが受け入れる種別。部品・アセンブリの読み手とは混ぜない。 */
export const PCAD_DRAWING_KINDS: readonly PcadDrawingKind[] = [
  PCAD_DRAWING_KIND,
  PCAD_DRAWING_TEMPLATE_KIND,
];

/**
 * ひな形が持ち運ぶ道具の既定値(FR-814、§2.10、P6 タスク27)。**P6 ではこの 5 つに絞る**
 * (増やすのは P12 の環境設定、FR-1104)。値は**式の文字列**で持つ(FR-202。
 * 評価は使う側が `evaluateExpression` で行う)。
 *
 * **正本は `@pointercad/model` の `part/templates.ts` の `ToolDefaults`** で、ここに同じ形を
 * 置いているのは、`packages/model` の輸出の入口(`src/index.ts`)がタスク27 の時点で
 * 別の作業のコミット待ちに入っており触れないためである。**タスク33 でこの 2 つ
 * (`PcadToolDefaults` / `PCAD_TOOL_DEFAULT_KEYS`)を model からの輸入へ置き換える。**
 * 2 つは構造が同じなので、置き換えるまでの間も値はそのまま行き来できる。
 */
export interface PcadToolDefaults {
  /** 押し出しの距離(mm、FR-415)。 */
  readonly extrudeDistance: string;
  /** 穴の径(mm、FR-403)。 */
  readonly holeDiameter: string;
  /** R 面取りの半径(mm、FR-407)。 */
  readonly filletRadius: string;
  /** C 面取りの距離(mm、FR-406)。 */
  readonly chamferDistance: string;
  /** スケッチの円の半径(mm、FR-302)。 */
  readonly circleRadius: string;
}

/**
 * 道具の既定値の欄の名前(5 つ)。読み手はこの一覧の欄だけを読み、書き手はこの順に書く
 * (**同じ中身から同じバイト列**の約束。`pcadFile.ts` 冒頭)。
 *
 * `keyof PcadToolDefaults` を要素の型にしてあるので、**欄を足して一覧に書き忘れると
 * 読み手が黙って落とす**のではなく、この一覧を使う側(`documentJson.ts`)が全欄を
 * 読めなくなる形で気づける。上の注記のとおり、正本は model 側にある。
 */
export const PCAD_TOOL_DEFAULT_KEYS: readonly (keyof PcadToolDefaults)[] = [
  'extrudeDistance',
  'holeDiameter',
  'filletRadius',
  'chamferDistance',
  'circleRadius',
];

/** `document.json` の中身(封筒)。ここに書いたものだけを保存し、それ以外は保存しない。 */
export interface PcadEnvelope {
  /** 書式の版。部品文書の `schemaVersion` と同じ値。 */
  readonly schema: number;
  /** 中身の種別。部品ファイルは `PCAD_DOCUMENT_KIND`、ひな形は `PCAD_TEMPLATE_KIND`。 */
  readonly kind: PcadDocumentKind;
  /** 常に `PCAD_APP_NAME`。 */
  readonly app: string;
  /** 保存した時刻(ISO 8601、UTC)。 */
  readonly savedAt: string;
  /**
   * 表示の長さの単位(FR-811、FR-814、§2.10。P6 タスク27 で足した**任意の欄**)。
   *
   * **版は上げない。** 版 7 のファイルでも持たないものがある(部品の `.pcad` は書かない)
   * ので、欄そのものを省略できる形にした。読み手は無ければ `'mm'` とみなす
   * (既定値の正本は model の `DEFAULT_TEMPLATE_LENGTH_UNIT`)。
   *
   * **文書ではなく封筒に持つ**のは、単位が利用者の設定であって部品の形の一部ではない
   * ためである(§0.a-0.1。内部の計算は mm 固定、NFR-RE-3)。
   */
  readonly lengthUnit?: LengthUnit;
  /**
   * 各道具の既定値(FR-814、§2.10。`lengthUnit` と同じく任意の欄)。
   * 読み手は無ければ既定(model の `DEFAULT_TOOL_DEFAULTS`)を使う。
   */
  readonly toolDefaults?: PcadToolDefaults;
  /** 部品文書そのもの。導出できるもの(解決済みの座標・メッシュ・鍵)は入れない。 */
  readonly document: PartDocument;
}

/**
 * アセンブリが抱き込んだ部品 1 つの素性(要件§8「参照部品はアセンブリファイルに
 * 相対パス+内容ハッシュで記録(欠損時は警告)」、P7 §2.2、§0.a-0.3)。
 *
 * **文書そのものは ZIP の別エントリ**(`parts/<ref>.json`)にあり、ここに入るのは
 * 「どのファイルから、いつ、どの中身を取り込んだか」だけである。元のファイルを
 * 追いかける判断(更新されている/見つからない)は上の層(P7 タスク4)がこの 3 欄
 * (`path` / `contentHash` / `importedAt`)を見て決める。**読み込みは止めない**
 * ——抱き込んだ文書だけで開けるのがこの設計の要点(§2.3)。
 */
export interface PcadPartFile {
  /** ZIP の中の名前。`parts/<ref>.json` の `<ref>` で、`ComponentSource` が指す。 */
  readonly ref: string;
  /** 取り込んだときのファイル名(利用者へ見せる)。 */
  readonly fileName: string;
  /** アセンブリのファイルから見た相対パス(要件§8)。 */
  readonly path: string;
  /** 抱き込んだ文書の内容ハッシュ(P7 タスク4 が作り方を決める)。 */
  readonly contentHash: string;
  /** 取り込んだ時刻(ISO 8601、UTC)。 */
  readonly importedAt: string;
}

/**
 * アセンブリの `document.json` の中身(封筒。P7 §2.2、タスク3)。
 *
 * 部品の封筒(`PcadEnvelope`)と**欄の並びをそろえてある**(`schema` → `kind` → `app` →
 * `savedAt` → `document`)。違うのは中身の型(`AssemblyDocument`)と、抱き込んだ部品の
 * 素性 `partFiles` を最後に持つことだけ。ひな形の 2 欄(`lengthUnit` / `toolDefaults`)は
 * 持たない——ひな形は部品の話であり、アセンブリのひな形は要件に無いため。
 */
export interface PcadAssemblyEnvelope {
  /** 書式の版。アセンブリ文書の `schemaVersion` と同じ値(部品と同じ系列。§0.a-0.2)。 */
  readonly schema: number;
  /** 中身の種別。常に `PCAD_ASSEMBLY_KIND`。 */
  readonly kind: PcadAssemblyKind;
  /** 常に `PCAD_APP_NAME`。 */
  readonly app: string;
  /** 保存した時刻(ISO 8601、UTC)。 */
  readonly savedAt: string;
  /** アセンブリ文書そのもの。部品の形も合致の解も入れない(§0.a-0.4、§0.a-0.6)。 */
  readonly document: AssemblyDocument;
  /** 抱き込んだ部品の素性。**空でも欄ごと書く**(読み手が毎回 `undefined` を見ずに済む)。 */
  readonly partFiles: readonly PcadPartFile[];
}

/** `.pcadd` の `document.json` に入る図面用の封筒。 */
export interface PcadDrawingEnvelope {
  readonly schema: number;
  readonly kind: PcadDrawingKind;
  readonly app: string;
  readonly savedAt: string;
  readonly document: DrawingDocument;
}

/**
 * 版を1つ上げる変換。封筒ごと受け取り、封筒ごと返す
 * (将来は封筒の欄が増減し得るので、中身だけを渡す形にしない)。
 */
export type SchemaMigration = (raw: unknown) => unknown;

/**
 * 版を上げたときの変換表。鍵は「変換元の版」で、`SCHEMA_MIGRATIONS[2]` は版 2 を版 3 へ直す。
 * 読み手は古い版のファイルをこの表で今の版まで順に持ち上げてから読む(要件§8 の前方互換)。
 *
 * **版2 → 版3(P3、§0.a-0.22):** P3 が足すのは新しいフィーチャーの種類だけで、版 2 に
 * 出てくる欄は 1 つも変えていないので、封筒の `schema` と、その中の `document.schemaVersion`
 * を 3 へ書き換えるだけでよい(読み手が両方を検査して `versionMismatch` で断るため、
 * 片方だけの書き換えでは足りない)。中身が `isRecord` で絞れないほど壊れているときは
 * そのまま返し、呼び出し側(`documentJson.ts` の `migrateToCurrentSchema`)の
 * `isRecord` の検査に断らせる(変換そのものは例外を投げない)。
 */
/**
 * 版3以前で `construction` を省略できたスケッチフィーチャーの種類
 * (`documentJson.ts` の `readConstructionFlag` が版4から必須にする対象と同じ一覧)。
 * `point`・`pointArray`・`face` はもともと `construction` を持たない種類なので含めない。
 */
const CONSTRUCTION_FEATURE_KINDS: ReadonlySet<string> = new Set([
  'line',
  'arc',
  'rectangle',
  'polygon',
  'slot',
  'ellipse',
  'spline',
  'offset',
  'copy',
  'projectedCurve',
  'planeSection',
]);

/**
 * 版3以前のスケッチフィーチャー1件を版4の形へ補う(構築線フラグ・点列の layout)。
 * 型を検査せずベストエフォートで補うだけで、欄の妥当性そのものは
 * 呼び出し側(`documentJson.ts` の版4の読み手)が厳密に検査する。
 */
function migrateSketchFeatureToV4(feature: unknown): unknown {
  if (!isRecord(feature)) {
    return feature;
  }
  let migrated: Record<string, unknown> = feature;
  const kind = migrated['kind'];
  if (
    typeof kind === 'string' &&
    CONSTRUCTION_FEATURE_KINDS.has(kind) &&
    !('construction' in migrated)
  ) {
    migrated = { ...migrated, construction: false };
  }
  if (kind === 'pointArray' && !('layout' in migrated)) {
    // 版3以前は base/azimuth/spacing/count を直下に持つ(タスク6の統括の差し戻し)。
    // 直線状(linear)の layout へ包み直し、フラットだった4欄は取り除く。
    const { base, azimuth, spacing, count, ...rest } = migrated;
    migrated = { ...rest, layout: { kind: 'linear', base, azimuth, spacing, count } };
  }
  return migrated;
}

/** 版3以前のスケッチ1本を版4の形へ補う(features の各要素へ上の変換をかける)。 */
function migrateSketchToV4(sketch: unknown): unknown {
  if (!isRecord(sketch)) {
    return sketch;
  }
  const features = sketch['features'];
  if (!Array.isArray(features)) {
    return sketch;
  }
  return { ...sketch, features: features.map(migrateSketchFeatureToV4) };
}

/**
 * 版3以前の部品文書を版4の形へ補う。`schemaVersion` の書き換え、各スケッチの
 * `construction`/`layout` の補完、`references`(基準ジオメトリの履歴、タスク9)が
 * 無ければ空配列で補う(§0.a-0.24)。
 */
function migrateDocumentToV4(document: Record<string, unknown>): Record<string, unknown> {
  let migrated: Record<string, unknown> = { ...document, schemaVersion: 4 };
  const sketches = migrated['sketches'];
  if (Array.isArray(sketches)) {
    migrated = { ...migrated, sketches: sketches.map(migrateSketchToV4) };
  }
  if (!('references' in migrated)) {
    migrated = { ...migrated, references: [] };
  }
  return migrated;
}

/**
 * 版4以前の部品文書を版5の形へ補う(P4b タスク21、§0.a-0.17)。`schemaVersion` の書き換えと、
 * `parameters`(パラメータ表、FR-207)が無ければ空配列で補う。
 *
 * スケッチの `constraints`(FR-313)はここで補わない。**型自体が恒常的に省略可能**
 * (`SketchDocument.constraints?`)なので、`references` のように「版4以前だけの寛容さ」を
 * 「版5の必須欄」へ切り出す対象にしない(`documentJson.ts` の `readSketch` が版に関係なく
 * 「無ければ触らない」まま読む。`freeOrientation` と同じ扱い)。
 */
function migrateDocumentToV5(document: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...document, schemaVersion: 5 };
  if ('parameters' in migrated) {
    return migrated;
  }
  return { ...migrated, parameters: [] };
}

/**
 * 版5以前の部品文書を版6の形へ補う(P5 タスク5、§0.a-0.15)。`schemaVersion` の書き換えと、
 * `appearance`(外観の割り当て、FR-1106〜1110)が無ければ空の表で補う
 * (`migrateDocumentToV5` の `parameters` と同じ扱い)。
 */
function migrateDocumentToV6(document: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...document, schemaVersion: 6 };
  if ('appearance' in migrated) {
    return migrated;
  }
  return { ...migrated, appearance: { entries: [] } };
}

/**
 * 版6以前の部品文書を版7の形へ補う(P6 タスク21、§0.a-0.55)。`schemaVersion` の書き換えと、
 * `selectionSets`(選択セット、FR-112、§0.a-0.44)・`canvases`(下絵の画像、FR-332、
 * §0.a-0.45)が無ければ空配列で補う(`migrateDocumentToV5` の `parameters`・
 * `migrateDocumentToV6` の `appearance` と同じ扱い)。
 *
 * **この 2 欄はまだ `PartDocument` の欄になっていない**(タスク37・38 で足す)。
 * それでもここで補うのは、版を 2 回上げない(統括の承認、§0.a-0.55)と決めたためで、
 * 補った欄は読み手が知らないうちは黙って捨てられる(欄が増えたときに移行を書き足さずに済む)。
 *
 * 読み込んだ形のベースボディ 2 種(`importedSolid` / `importedMesh`、タスク20)は
 * **フィーチャーの種類が増えただけ**なので、ここでは何もしない(版 2 → 版 3 と同じ)。
 */
function migrateDocumentToV7(document: Record<string, unknown>): Record<string, unknown> {
  let migrated: Record<string, unknown> = { ...document, schemaVersion: 7 };
  if (!('selectionSets' in migrated)) {
    migrated = { ...migrated, selectionSets: [] };
  }
  if (!('canvases' in migrated)) {
    migrated = { ...migrated, canvases: [] };
  }
  return migrated;
}

/**
 * 版7以前のアセンブリ文書を版8の形へ補う(P7 タスク3、§0.a-0.2)。`schemaVersion` の
 * 書き換えと、`bom`(部品表の並びと列、FR-611)が無ければ既定で補う
 * (`migrateDocumentToV5` の `parameters`・`migrateDocumentToV6` の `appearance` と同じ扱い)。
 *
 * **版 7 以前のアセンブリファイルはこの世に 1 つも存在しない**(種別 `assembly` そのものが
 * 版 8 で生まれた)が、補う側を書いておく。`bom` は必須の欄で、読み手は欠けたら
 * `missingField` で断るため、**版を持ち上げてきた文書がこの欄を持たないときに
 * 既定で埋める口**をここに 1 か所だけ置いておく(既定の正本は model 側の
 * `DEFAULT_BOM_SETTINGS`。同じ既定を io にも書かない)。
 */
function migrateAssemblyDocumentToV8(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...document, schemaVersion: 8 };
  if ('bom' in migrated) {
    return migrated;
  }
  return { ...migrated, bom: DEFAULT_BOM_SETTINGS };
}

export const SCHEMA_MIGRATIONS: Readonly<Record<number, SchemaMigration | undefined>> = {
  2: (raw) => {
    if (!isRecord(raw)) {
      return raw;
    }
    const document = raw['document'];
    if (!isRecord(document)) {
      return raw;
    }
    return { ...raw, schema: 3, document: { ...document, schemaVersion: 3 } };
  },
  /**
   * 版3 → 版4(P4 タスク31、§0.a-0.24): 版3のままの段階的な追加(タスク6・9)で
   * 「欄が無ければ寛容に読む」扱いにしていた3つ(`construction`・点列の `layout`・
   * `references`)を、ここで明示的に「移行」として補う。中身が `isRecord` で
   * 絞れないほど壊れているときはそのまま返し、呼び出し側の `isRecord` の検査に
   * 断らせる(`SCHEMA_MIGRATIONS[2]` と同じ決めごと)。
   */
  3: (raw) => {
    if (!isRecord(raw)) {
      return raw;
    }
    const document = raw['document'];
    if (!isRecord(document)) {
      return raw;
    }
    return { ...raw, schema: 4, document: migrateDocumentToV4(document) };
  },
  /**
   * 版4 → 版5(P4b タスク21、§0.a-0.17): パラメータ表(`parameters`、FR-207)が無ければ
   * 空配列で補う。スケッチの `constraints`(FR-313)は型が恒常的に省略可能なので、
   * ここでは補わない(`migrateDocumentToV5` のコメント参照)。
   */
  4: (raw) => {
    if (!isRecord(raw)) {
      return raw;
    }
    const document = raw['document'];
    if (!isRecord(document)) {
      return raw;
    }
    return { ...raw, schema: 5, document: migrateDocumentToV5(document) };
  },
  /**
   * 版5 → 版6(P5 タスク5、§0.a-0.15): 外観の割り当て(`appearance`、FR-1106〜1110)が
   * 無ければ空の表で補う。
   */
  5: (raw) => {
    if (!isRecord(raw)) {
      return raw;
    }
    const document = raw['document'];
    if (!isRecord(document)) {
      return raw;
    }
    return { ...raw, schema: 6, document: migrateDocumentToV6(document) };
  },
  /**
   * 版6 → 版7(P6 タスク21、§0.a-0.55): 選択セット(`selectionSets`、FR-112)と
   * 下絵の画像(`canvases`、FR-332)が無ければ空配列で補う。ZIP の新しいエントリ
   * (`shapes/*.brep` / `meshes/*.bin` / `canvases/*.png`)は `document.json` の外なので
   * ここでは触らない(添付を 1 つも持たない版7のファイルは版6と同じ中身になる)。
   */
  6: (raw) => {
    if (!isRecord(raw)) {
      return raw;
    }
    const document = raw['document'];
    if (!isRecord(document)) {
      return raw;
    }
    return { ...raw, schema: 7, document: migrateDocumentToV7(document) };
  },
  /**
   * 版7 → 版8(P7 タスク3、§0.a-0.2): 足したのは**封筒の新しい種別 `assembly`** だけで、
   * 部品文書の欄は 1 つも増えていない。したがって部品(とひな形)の文書に対しては
   * `schemaVersion` を書き換えるだけで何もしない(版 2 → 版 3 と同じ)。
   * アセンブリの文書だけは `bom` の省略を既定で補う(`migrateAssemblyDocumentToV8`)。
   *
   * 種別で分けるのは、**同じ版の中に中身の型が 2 つある**からである(`document` が
   * `PartDocument` か `AssemblyDocument` か)。封筒の `kind` は移行の前から読める欄なので、
   * ここで見て分けられる。
   */
  7: (raw) => {
    if (!isRecord(raw)) {
      return raw;
    }
    const document = raw['document'];
    if (!isRecord(document)) {
      return raw;
    }
    return {
      ...raw,
      schema: 8,
      document:
        raw['kind'] === PCAD_ASSEMBLY_KIND
          ? migrateAssemblyDocumentToV8(document)
          : { ...document, schemaVersion: 8 },
    };
  },
  /**
   * 版8 → 版9(P8 タスク3): 新しい封筒種別 `drawing` / `drawingTemplate` を足す。
   * 既存文書の欄は変えないので、封筒と文書の版だけを同時に持ち上げる。
   */
  8: (raw) => {
    if (!isRecord(raw)) {
      return raw;
    }
    const document = raw['document'];
    if (!isRecord(document)) {
      return raw;
    }
    return { ...raw, schema: 9, document: { ...document, schemaVersion: 9 } };
  },
  /** 版9 → 版10: 名前付き視点と、パラメータの式だけを持つ構成を追加する。 */
  9: (raw) => {
    if (!isRecord(raw)) return raw;
    const document = raw['document'];
    if (!isRecord(document)) return raw;
    let migrated: Record<string, unknown> = { ...document, schemaVersion: 10 };
    if (raw['kind'] === PCAD_DOCUMENT_KIND || raw['kind'] === PCAD_TEMPLATE_KIND) {
      const values: [string, string][] = [];
      const parameters = document['parameters'];
      if (Array.isArray(parameters)) {
        for (const parameter of parameters) {
          if (!isRecord(parameter) || typeof parameter['name'] !== 'string') continue;
          const value = parameter['value'];
          if (isRecord(value) && typeof value['source'] === 'string') values.push([parameter['name'], value['source']]);
        }
      }
      migrated = { ...migrated,
        namedViews: 'namedViews' in document ? document['namedViews'] : createDefaultNamedViews(),
        configurations: 'configurations' in document ? document['configurations']
          : createDefaultConfigurationsFromSources(Object.fromEntries(values)),
        activeConfigurationId: 'activeConfigurationId' in document ? document['activeConfigurationId'] : 'configuration-1',
      };
    } else if (raw['kind'] === PCAD_ASSEMBLY_KIND) {
      migrated = { ...migrated, namedViews: 'namedViews' in document ? document['namedViews'] : createDefaultNamedViews() };
    }
    return { ...raw, schema: 10, document: migrated };
  },
};
