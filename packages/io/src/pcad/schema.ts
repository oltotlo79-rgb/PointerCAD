/**
 * .pcad の `document.json` の封筒と書式の版(要件§8、計画書 docs/plans/P2-ソリッド基礎.md §2.8、§0.a-0.3)。
 *
 * 封筒は「どの版の、どのアプリが、いつ書いたか」だけを持ち、中身は部品文書そのものを入れる。
 * 版の正本は部品文書の `schemaVersion`(統括の決定④、docs/報告記録.md 2026-09-03 07:35)で、
 * 封筒の `schema` には同じ値を書く。読み手は封筒の `schema` を先に検査してから中身を読む
 * (中身の形は版によって変わり得るため、版の判定を中身の解釈より先に済ませる)。
 */

import type { PartDocument } from '@pointercad/model';

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
 */
export const PCAD_SCHEMA_VERSION = 5;

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

/** `document.json` の中身(封筒)。ここに書いたものだけを保存し、それ以外は保存しない。 */
export interface PcadEnvelope {
  /** 書式の版。部品文書の `schemaVersion` と同じ値。 */
  readonly schema: number;
  /** 中身の種別。部品ファイルは常に `PCAD_DOCUMENT_KIND`。 */
  readonly kind: typeof PCAD_DOCUMENT_KIND;
  /** 常に `PCAD_APP_NAME`。 */
  readonly app: string;
  /** 保存した時刻(ISO 8601、UTC)。 */
  readonly savedAt: string;
  /** 部品文書そのもの。導出できるもの(解決済みの座標・メッシュ・鍵)は入れない。 */
  readonly document: PartDocument;
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
};
