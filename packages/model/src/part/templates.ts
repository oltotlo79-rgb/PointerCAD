/**
 * ひな形(テンプレート)から新しい部品を始める / いまの部品をひな形にする
 * (要件 FR-814、計画書 docs/plans/P6-入出力.md §2.10・§0.a-0.35・§0.a-0.36、タスク27)。
 *
 * **ひな形は「中身の入っていない部品」**である。形も欄も部品とまったく同じで、
 * 保存の中身(ZIP + JSON)も 1 行も分けない。分かれるのは封筒の種別
 * (`packages/io` の `PCAD_TEMPLATE_KIND`)と拡張子(`.pcadt`)だけ(§0.a-0.35)。
 *
 * ここに置くのは**文書だけを見る純関数**で、ファイルの読み書き(`packages/io`)にも
 * 画面(`packages/ui`)にも触れない。断りと知らせは**コード**だけを返し、利用者へ見せる
 * 文言は ui が持つ(NFR-MA-5。`.pcad` の `file.error.wrongKind` と同じ流儀)。
 *
 * **`lengthUnit` と `toolDefaults` を文書ではなく封筒に持つ理由**(§0.a-0.1):
 * どちらも**利用者の設定**であって部品の形の一部ではない。文書に単位を持たせると
 * 「`10` は 10mm か 10inch か」が保存の版と設定の両方に依存してしまう(内部は mm 固定、
 * NFR-RE-3)。設定はひな形の封筒に写して持ち運び、新規作成のときに端末の設定へ配る。
 * `rules/04`「導出できるものは保存しない」には触れない——利用者が決めた値であって、
 * 文書から計算し直せるものではないため。
 */

import { createEmptySketchDocument, nextSerialId } from '../sketch/createSketchDocument.js';
import type { LengthUnit } from '../units/length.js';

import {
  createEmptyPartDocument,
  DEFAULT_CHAMFER_DISTANCE_MM,
  DEFAULT_FILLET_RADIUS_MM,
  DEFAULT_HOLE_DIAMETER_MM,
  PART_SCHEMA_VERSION,
} from './createPartDocument.js';
import type { PartDocument } from './types.js';

/**
 * 部品文書の id の接頭辞(`createEmptyPartDocument` の `'part-1'` と同じ連番方式、§0.a-0.19)。
 * ひな形から新規作成するときに**ひな形の id と重ならない id** を採るために使う。
 */
const PART_ID_PREFIX = 'part-';

/**
 * 押し出しの距離の既定(mm)。`packages/ui` の `DEFAULT_EXTRUDE_DISTANCE`(P2 からの 10mm)と
 * 同じ値である。**ひな形は道具の既定値を持ち運ぶ**(§2.10)ので、値の正本を model 側の
 * ここへ置いた。ui の定数をこちらへ寄せる(同じ数を 2 か所に置かない)のはタスク33 の担当。
 */
export const DEFAULT_EXTRUDE_DISTANCE_MM = 10;

/**
 * スケッチの円の半径の既定(mm)。`packages/ui` の数値入力の表(`numericInput.ts` の
 * 円の `defaultSource`)と同じ値。ui を寄せるのがタスク33 なのは押し出しの距離と同じ。
 */
export const DEFAULT_CIRCLE_RADIUS_MM = 10;

/**
 * ひな形が持ち運ぶ道具の既定値(FR-814、§2.10)。**P6 ではこの 5 つに絞る**
 * (増やすのは P12 の環境設定、FR-1104)。
 *
 * 値は**式の文字列**で持つ(FR-202)。評価値ではなく式のまま持つのは、パラメータ表を
 * 参照する既定値(`板厚 * 2`)を将来書けるようにするためで、`.pcad` の他の数値欄と同じ
 * 約束である。評価は使う側(ui の数値入力)が `evaluateExpression` で行う。
 */
export interface ToolDefaults {
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
 * `ToolDefaults` の欄を漏れなく 1 つずつ持つ表。**欄を足し忘れると
 * `satisfies Record<keyof ToolDefaults, true>` が型検査で落ちる**(余分な鍵を書いても同様)。
 * `createPartDocument.ts` の `SOLID_FEATURE_KIND_TABLE` と同じ流儀。
 */
const TOOL_DEFAULT_KEY_TABLE = {
  extrudeDistance: true,
  holeDiameter: true,
  filletRadius: true,
  chamferDistance: true,
  circleRadius: true,
} satisfies Record<keyof ToolDefaults, true>;

/**
 * 道具の既定値の欄の名前(5 つ)。`packages/io` の妥当性検査と ui の設定画面が
 * この一覧を見る(同じ一覧を 2 か所に書かない。`PARAMETER_UNITS` と同じ流儀)。
 *
 * `Object.keys` はいつも `string[]` を返すので、`as` ではなく型ガードで絞り直す。
 */
export const TOOL_DEFAULT_KEYS: readonly (keyof ToolDefaults)[] = Object.keys(
  TOOL_DEFAULT_KEY_TABLE,
).filter((key): key is keyof ToolDefaults => key in TOOL_DEFAULT_KEY_TABLE);

/**
 * 道具の既定値の既定(ひな形が `toolDefaults` を持たないときの値。§2.10「無ければ既定」)。
 *
 * 数はそれぞれの定数から作る(同じ数を 2 か所に書かない)。`String` を通すだけなので
 * `'6'` のように整数の字面になり、プロパティ欄にそのまま出せる。
 */
export const DEFAULT_TOOL_DEFAULTS: ToolDefaults = {
  extrudeDistance: String(DEFAULT_EXTRUDE_DISTANCE_MM),
  holeDiameter: String(DEFAULT_HOLE_DIAMETER_MM),
  filletRadius: String(DEFAULT_FILLET_RADIUS_MM),
  chamferDistance: String(DEFAULT_CHAMFER_DISTANCE_MM),
  circleRadius: String(DEFAULT_CIRCLE_RADIUS_MM),
};

/**
 * ひな形が単位を持たないときの表示の単位(§2.10「`lengthUnit` が無いひな形は `'mm'`」)。
 * 内部の計算は単位に関係なく mm のまま(NFR-RE-3)。
 */
export const DEFAULT_TEMPLATE_LENGTH_UNIT: LengthUnit = 'mm';

/**
 * ひな形 1 つ(FR-814、§2.10)。部品文書そのものに、封筒が持つ 2 つの設定を添えた形。
 *
 * `packages/io` の封筒(`PcadEnvelope`)では `lengthUnit` / `toolDefaults` が**任意の欄**
 * (版 7 のファイルでも持たないものがある)だが、こちらは読み終えた後の形なので
 * **必ず埋まっている**(欠けていた分は `openTemplate` が既定で埋める)。読む側が毎回
 * `undefined` を確かめずに済むようにするためで、`PcadAttachments` が空の表を持つのと同じ考え方。
 */
export interface PartTemplate {
  /** ひな形の中身。**履歴(基準ジオメトリ・ソリッド・スケッチ)は空**(§2.10)。 */
  readonly document: PartDocument;
  /** 表示の長さの単位(FR-811、FR-814)。新規作成のときに端末の設定へ反映する。 */
  readonly lengthUnit: LengthUnit;
  /** 各道具の既定値(FR-814)。新規作成のときにストアへ反映する。 */
  readonly toolDefaults: ToolDefaults;
}

/**
 * 空の履歴(スケッチ 1 本・基準ジオメトリ無し・ソリッド無し)と、履歴に結び付いた札を作る。
 *
 * **選択セット(FR-112)と下絵(FR-332)もここで空にする**(P6 タスク37・38)。どちらも
 * パラメータ表・外観と違って**履歴を指している**ためである。選択セットの要素は立体の
 * ボディ id と部分形状の指紋で、下絵の `imageId` は `.pcad` の ZIP のエントリを指すので、
 * 履歴を空にしたひな形へ持ち越すと、どちらも指す先の無い参照になる(下絵は画像の添付ごと
 * 失われ、読み込みが `missingField` で断る)。
 */
function emptyHistory(): Pick<
  PartDocument,
  'sketches' | 'activeSketchId' | 'references' | 'solids' | 'sheetUnfolds' | 'selectionSets' | 'canvases'
> {
  // スケッチは 0 本にできない(`activeSketchId` が `sketches` のいずれかを指す約束、
  // §0.a-0.4)。起動直後の部品と同じく、空のスケッチを 1 本だけ持たせる。
  const sketch = createEmptySketchDocument();
  return {
    sketches: [sketch],
    activeSketchId: sketch.id,
    references: [],
    solids: [],
    sheetUnfolds: [],
    selectionSets: [],
    canvases: [],
  };
}

export interface DocumentFromTemplateOptions {
  /** 新しい部品の名前。省略するとひな形の名前が初期値になる(§2.10 の表)。 */
  readonly name?: string;
}

/**
 * ひな形から新しい部品を始める(FR-814、§2.10)。
 *
 * - **新しい id を採る。** ひな形の id と重ならない連番(`part-1` → `part-2`)にする。
 *   同じ id のまま開くと、ひな形と新しい部品が同じものとして扱われる場面
 *   (最近使ったファイル・自動保存の鍵)で取り違えが起きる。
 * - **履歴は空にする**(計画書タスク27 の実装内容、統括の指示 2026-09-06)。ひな形に形が
 *   入っていた場合は `openTemplate` が知らせ(`templateHasHistory`)を返しているので、
 *   利用者は黙って落とされたとは受け取らない。**ひな形のファイルそのものは変わらない。**
 * - **パラメータ表・外観はそのままコピーする**(§2.10 の表)。どちらも不変の値なので
 *   参照をそのまま渡す(写しを作っても中身は変わらない)。
 * - 単位と道具の既定値は文書の欄ではないので、ここでは触らない(`template` から
 *   呼び出し側が端末の設定・ストアへ配る。§0.a-0.1)。
 */
export function documentFromTemplate(
  template: PartTemplate,
  options: DocumentFromTemplateOptions = {},
): PartDocument {
  return {
    id: nextSerialId([template.document.id], PART_ID_PREFIX),
    name: options.name ?? template.document.name,
    schemaVersion: PART_SCHEMA_VERSION,
    ...emptyHistory(),
    parameters: template.document.parameters,
    appearance: template.document.appearance,
    namedViews: template.document.namedViews,
    configurations: template.document.configurations,
    activeConfigurationId: template.document.activeConfigurationId,
  };
}

export interface TemplateFromDocumentOptions {
  /** いまの表示の単位(端末の設定、§0.a-0.1)。ひな形の封筒へ書く。 */
  readonly lengthUnit: LengthUnit;
  /** いまの道具の既定値。ひな形の封筒へ書く。 */
  readonly toolDefaults: ToolDefaults;
  /** ひな形の名前。省略すると元の部品の名前をそのまま使う。 */
  readonly name?: string;
}

/**
 * いまの部品をひな形にする(FR-814、§2.10。「ひな形として保存」の中身)。
 *
 * **履歴を空にして書く**(§0.a-0.35「フィーチャー履歴は空」)。持ち越すのは名前・
 * パラメータ表・外観と、封筒の 2 つの設定だけ。元の部品の文書は変えない(不変)。
 *
 * id はそのまま持ち越す。ひな形の id は「そのひな形から作られた部品」の id を採るときの
 * もと(`documentFromTemplate`)にしかならないので、ここで採り直す意味が無いためである。
 */
export function templateFromDocument(
  document: PartDocument,
  options: TemplateFromDocumentOptions,
): PartTemplate {
  return {
    document: {
      ...document,
      name: options.name ?? document.name,
      ...emptyHistory(),
    },
    lengthUnit: options.lengthUnit,
    toolDefaults: options.toolDefaults,
  };
}

/**
 * ひな形を開いたときの知らせ(§2.10)。**断りではない**(そのまま開く)。
 * 文言(「このひな形には形が入っています。そのまま開きます。」)は ui が持つ。
 */
export type TemplateNotice = 'templateHasHistory';

/**
 * ひな形として開けない理由(§2.8 の断りの表)。文言(「このファイルはひな形では
 * ありません。」)は ui が持ち、`.pcad` の `file.error.wrongKind` と同じ扱いにする
 * ——**エラーコードを増やさない**(`docs/報告記録.md` 2026-09-04 01:40 の③)。
 */
export type TemplateRefusal = 'notTemplate';

/**
 * `.pcadt` を読んだ結果のうち、ひな形の判断に要るものだけ(`packages/io` の
 * `readPcadFile` が返す値から詰め替える)。
 *
 * **封筒の種別そのものではなく真偽で受け取る。** 種別の文字列の正本は
 * `packages/io` の `PCAD_TEMPLATE_KIND` で、`model` は `io` に依存できない
 * (依存の向きは io → model。`rules/04`)ため、判定だけを呼び出し側から渡してもらう。
 */
export interface TemplateFileContents {
  /** 封筒の種別がひな形か(io の `isTemplateKind(result.kind)`)。 */
  readonly isTemplate: boolean;
  /** 読み込んだ部品文書。 */
  readonly document: PartDocument;
  /** 封筒の `lengthUnit`。無ければ `'mm'` とみなす(§2.10)。 */
  readonly lengthUnit?: LengthUnit;
  /** 封筒の `toolDefaults`。無ければ既定を使う(§2.10)。 */
  readonly toolDefaults?: ToolDefaults;
}

export type OpenTemplateResult =
  | {
      readonly ok: true;
      readonly template: PartTemplate;
      /** 知らせることがあれば入る。無ければ `null`(黙って開く)。 */
      readonly notice: TemplateNotice | null;
    }
  | { readonly ok: false; readonly reason: TemplateRefusal };

/**
 * その文書に形(履歴)が入っているか(§2.10 の「フィーチャー履歴」の行)。
 *
 * ソリッドと基準ジオメトリだけでなく**スケッチの中身**も見る。利用者から見れば
 * 線が引いてあるひな形も「形が入っている」ものだからで、`documentFromTemplate` が
 * 空にするもの(`emptyHistory`)とちょうど同じ範囲を見ていることになる。
 */
function hasHistory(document: PartDocument): boolean {
  if (document.solids.length > 0 || document.references.length > 0) {
    return true;
  }
  return document.sketches.some((sketch) => sketch.features.length > 0);
}

/**
 * 読み込んだファイルをひな形として受け取る(FR-814、§2.10)。
 *
 * - **ひな形でないファイル(`.pcad`)は断る。** 拡張子だけでは分からない(名前は
 *   いくらでも変えられる)ので、封筒の種別で判断する(§0.a-0.35)。
 * - **形が入っているひな形は断らない。** 知らせを 1 行返して、そのまま開く(§2.10)。
 * - 欠けている任意の欄は既定で埋める(`lengthUnit` 無し → `'mm'`、
 *   `toolDefaults` 無し → `DEFAULT_TOOL_DEFAULTS`)。版 7 のひな形でも
 *   この 2 欄を持たないものがあるため(タスク27 の手順2「任意の欄にする」)。
 */
export function openTemplate(contents: TemplateFileContents): OpenTemplateResult {
  if (!contents.isTemplate) {
    return { ok: false, reason: 'notTemplate' };
  }
  return {
    ok: true,
    template: {
      document: contents.document,
      lengthUnit: contents.lengthUnit ?? DEFAULT_TEMPLATE_LENGTH_UNIT,
      toolDefaults: contents.toolDefaults ?? DEFAULT_TOOL_DEFAULTS,
    },
    notice: hasHistory(contents.document) ? 'templateHasHistory' : null,
  };
}

/**
 * 何も入っていないひな形(起動直後の部品と同じ中身に、既定の設定を添えたもの)。
 * ひな形が 1 つも無い環境で「ひな形から新規」を選んだときの土台にできる。
 *
 * 中身は `createEmptyPartDocument` をそのまま使う(起動直後の部品の作り方を写さない)。
 */
export function createEmptyPartTemplate(): PartTemplate {
  return {
    document: createEmptyPartDocument(),
    lengthUnit: DEFAULT_TEMPLATE_LENGTH_UNIT,
    toolDefaults: DEFAULT_TOOL_DEFAULTS,
  };
}
