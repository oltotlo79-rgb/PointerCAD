/**
 * 規格部品の「族」の型（設計 案 C。鋼材・アルミフレーム・機械要素を同じ選び方で置くための共通の土台）。
 *
 * **保存されるのは、族の id・行の鍵・族の options の値と、族の 2 つの版の文字列だけ**
 * (`ComponentSource{ kind: 'standardPart', catalog: 'catalogItem', size, options: { family, item, … },
 * catalogRevision, generatorRevision }`)。形・寸法・出どころ・材質は保存せず、開くたびに族の表から組み直す
 * (rules/04「導出できるものは保存しない」)。
 *
 * 既存の 3 系統(従来の JIS の部品・材質別の鋼材・溶接のビード)はこの型を使わず、今までの保存の形と道のままにする。
 * 新しい族は `catalog/families/<族>.ts` に 1 族 1 ファイルで書き、`catalog/registry/<包み>.ts` の一覧へ
 * 必要な時だけ読む入口(`load`)を足す。
 */
import type { PartDocument } from '../../part/types.js';
import type { FrameSectionBounds } from '../frame/frameMembers.js';
import type { FrameSectionSlot } from '../frame/frameSlots.js';
import type { SteelEvidence } from '../standard/steelCatalog.js';

/** 選ぶ画面の分類(鋼材・アルミフレーム・機械要素)。 */
type CatalogGroup = 'steel' | 'aluminumFrame' | 'mechanical' | 'piping';

/** 版の確かさ。鋼材の台帳(`steelStandards.ts`)の確認の程度と同じ考え方。 */
type CatalogVerification = 'draft' | 'final-standard' | 'manufacturer-catalog' | 'unverified';

/** 寸法を添えて描く簡単な線図の種類。製造元の図・画像は使わない。 */
type DimensionDiagramId = 'rectTube' | 'angle' | 'iBeam' | 'channel' | 'lipChannel' | 'pipe'
  | 'pin' | 'nut' | 'bolt' | 'washer' | 'bearing' | 'camFollower' | 'bush' | 'compressionSpring' | 'tSlotFrame' | 'key' | 'sealRing' | 'oRing'
  | 'angleBracket' | 'joinPlate' | 'slotNut' | 'tSlotSeries' | 'flatBar' | 'roundBar' | 'tSlotNutBar' | 'tSlotNut' | 'roundNut' | 'frameCap'
  | 'flatPlate' | 'shapedPlate' | 'angleBracketCatalog' | 'footBase' | 'adjuster' | 'pipeFrame' | 'pipeFrameSlotted' | 'pipeFrameTwin'
  | 'smallFrame' | 'smallFrameCap' | 'bracketStock' | 'pipeFrameCap' | 'pipeFrameFoot' | 'pipeLongPart'
  | 'jointBar' | 'tSlotStud' | 'knurledNut' | 'panelBoardFixed' | 'panelBoardOrder' | 'panelPartBox' | 'panelCoverFrame' | 'connectorBox' | 'capFootBox' | 'caster'
  | 'movableBox' | 'accessoryBox' | 'pipeElbow' | 'pipeTee' | 'pipeSocket' | 'pipeCap' | 'pipePlug' | 'pipeNipple' | 'pipeBushing' | 'pipeFlange' | 'blockBracket'
  | 'sliderBox' | 'capAccessoryBox' | 'footPartBox' | 'slotLongPart'
  | 'doorPartBox'
  | 'drawerPartBox';

/**
 * 族の options の 1 つの鍵の指定。**鍵の名前は保存されるので、版の中で変えない。**
 * `family`・`item` は保存の形が使う鍵なので、族の指定には使えない(登録口が断る)。
 */
export interface CatalogOptionSpec {
  /** 例 `length`。 */
  readonly key: string;
  /** `lengthExpression` は正の長さの式、`numberExpression` は数の式、`choice` は `choices` のどれか。 */
  readonly kind: 'lengthExpression' | 'choice' | 'numberExpression';
  /** 画面の欄の名前の i18n の鍵。 */
  readonly labelKey: string;
  /** `choice` の選択肢(出どころのある物だけ)。 */
  readonly choices?: readonly string[];
  /** 式の値の下限・上限(両端を含む。アプリの範囲で、規格や供給の約束ではない)。 */
  readonly min?: number;
  readonly max?: number;
  /** 新しく置く時の既定の値。保存の時は必ず書き出す(`optional` の欄だけは、既定の値の時に書き出さない)。 */
  readonly defaultValue: string;
  /** 行ごとに作れる範囲が違う族(呼びごとに長さの範囲がある止めねじなど)の、その行の既定の値。無い時は `defaultValue`。 */
  readonly rowDefault?: (row: CatalogItemRow) => string;
  /**
   * 後から足した任意の欄(フレームの留め。J-01 包み 5)。保存に無ければ既定の値として読み、既定の値の時は書き出さないので、
   * 欄を使わない部品の保存の形は欄を足す前と同じ(前の版でも開ける)。欄を使った部品は前の版が「保存の欄が合わない」で断る。
   * 選ぶ画面の欄には出さず、置く道(一括配置の留めの角)だけが書く。
   */
  readonly optional?: boolean;
}

/**
 * 簡略の印の種類の鍵(判定に使う。表示は行の `simplified` の文)。`slotPositionSymmetric`: 溝と穴の横の位置を、資料の図に記入が
 * 無いので幅の中央に対して対称に置いた(フレームの溝への締結は、予告に溝の位置の簡略の知らせを出す)。種類を増やす時はここに足す。
 */
export type CatalogSimplifiedKind = 'slotPositionSymmetric';

/** 族の 1 行。保存されるのは `key` と `size` だけで、ほかは導出と表示に使う。 */
export interface CatalogItemRow {
  /** 版の中で凍結する行の鍵(保存される)。 */
  readonly key: string;
  /** 呼び(保存される)。 */
  readonly size: string;
  /** 例 `JIS B 1354`。 */
  readonly standardLabel: string;
  /** 部品表の材質の表示。 */
  readonly materialLabel?: string;
  /**
   * 質量に使う密度の材質 id(`appearance/densityMaterials.ts` の steel・stainless・aluminum ほか)。
   * 密度の表に無い材料(LDPE・導電 PP・PU・NBR・部位ごとに材料の違う物)の行は持たない。持たない行は、質量を行の値(資料の 1 個の値)だけで出し、
   * 置いた部品に材質を付けない(統括の決定 2026-11-17 19:5x の (1))。
   */
  readonly densityMaterialId?: string;
  readonly dims: Readonly<Record<string, number>>;
  /** 寸法の出どころ。形は鋼材と同じ(題名・版・URL・頁・SHA-256・取得日)。 */
  readonly evidence: SteelEvidence;
  readonly verification: CatalogVerification;
  /** false の行は画面で「要確認」と知らせる。 */
  readonly verified: boolean;
  /** 未確認または欠測の理由。確認済みなら空文字。 */
  readonly note: string;
  /**
   * 形のうち、資料の寸法で作らず簡略にした所(例「穴の位置」「取付けの脚と穴」)。選ぶ画面の行と切断の一覧に簡略の印として出す。
   * 資料の寸法どおりに作る行・印を持たない今までの族は持たない。
   */
  readonly simplified?: readonly string[];
  /**
   * 簡略の印の種類の鍵(判定だけに使う。印の文 `simplified` と同じ並びで持つ。行の表の道具が、印の文と鍵を対で書く)。
   * 鍵を持たない行・族は持たない(保存しない導出の欄なので、足しても保存の形と catalogRevision は変わらない)。
   */
  readonly simplifiedKinds?: readonly CatalogSimplifiedKind[];
  /**
   * 端のキャップなどの行が合うフレームの行の鍵(同じ資料のフレームの族の行。例: 小さい溝つきフレームの端のキャップ)。
   * 外形だけでは決まらない(外形が同じで溝の違うフレームがある)ので、行の表の道具が資料の記入から書く。持たない行・族は持たない
   * (保存しない導出の欄なので、足しても保存の形と catalogRevision は変わらない)。
   */
  readonly fitsFrameKeys?: readonly string[];
  /**
   * 資料と頁でない値の出どころ(持たない行は資料と頁。`evidence` の題名と頁)。資料に記入が無く、参考にした組立用の道具の画面の値で入れた行だけが
   * 持ち、画面の値の寸法の鍵(`dims` の鍵)を `fields` に並べる(利用者の回答 2026-11-21 16:0x: 印つきで入れる)。
   * 画面に出す文は ui の i18n が持つ。保存しない導出の欄なので、足しても保存の形と catalogRevision は変わらない。
   */
  readonly valueSource?: CatalogValueSource;
}

/** 資料と頁でない値の出どころ(今は参考にした組立用の道具の画面の値だけ。資料と頁の行は `valueSource` を持たない)。 */
export interface CatalogValueSource {
  readonly kind: 'toolScreen';
  readonly fields: readonly string[];
}

/**
 * 族 1 つ。`build`・`nominalVolume`・`partName` に渡す `values` は、族の options の指定の鍵だけを持つ
 * (保存の形の `family`・`item` は含まない)。値は登録口が範囲と形を確かめた後のものである。
 */
export interface CatalogFamily<Row extends CatalogItemRow = CatalogItemRow> {
  /** 例 `jis-b-1354-parallel-pin`(保存される)。 */
  readonly id: string;
  readonly group: CatalogGroup;
  /** 画面の「種類」の i18n の鍵。 */
  readonly kindKey: string;
  /** 表の版(保存される)。表を直す時は版を増やし、古い版の行を残す。 */
  readonly catalogRevision: string;
  /** 形の台本の版(保存される)。 */
  readonly generatorRevision: string;
  readonly options: readonly CatalogOptionSpec[];
  /** `linear` は長さを持ち切断の一覧に出す物、`count` は個数で数える物。 */
  readonly stock: 'linear' | 'count';
  readonly diagram: DimensionDiagramId;
  readonly rows: readonly Row[];
  build(row: Row, values: Readonly<Record<string, string>>): PartDocument | null;
  nominalVolume(row: Row, values: Readonly<Record<string, string>>): number | null;
  partName(row: Row, values: Readonly<Record<string, string>>): string;
  /**
   * 1 個の質量(g)を形の体積から計算せずに持つ族だけが持つ(製造元の寸法に合わせたフレームの系列は、単位質量 × 長さ)。
   * 部品表・切断の一覧の質量はこれを先に使い、無い族は体積 × 行の材質の密度。形を簡略にした族の質量を実物に近づけるため。
   */
  nominalMassG?(row: Row, values: Readonly<Record<string, string>>): number | null;
  /**
   * 長さを持つ族の断面の外形(部品の XY 面、mm)。線に沿って並べる時に外形の中心を線に乗せる(J-01)。
   * 欄の値で形が作れない時は null。持たない族は線に沿って並べられない。
   */
  sectionBounds?(row: Row, values: Readonly<Record<string, string>>): FrameSectionBounds | null;
  /**
   * 溝つきのフレームの族の断面の溝(部品の XY 面、J-02 P6a)。フレームの締結で溝の中心線を出す。位置は行の欄だけから出す。
   * 欄の値で形が作れない時は null。持たない族は溝の締結の相手にならない。
   */
  sectionSlots?(row: Row, values: Readonly<Record<string, string>>): readonly FrameSectionSlot[] | null;
}

/**
 * 登録口の 1 行。**族の表は必要な時だけ読む**(選ぶ画面を開いた時、文書に族の部品が見つかった時)ので、
 * ここには表を持たず、読む入口 `load` だけを置く(起動の時の読み込みを増やさない)。
 */
export interface CatalogFamilyEntry {
  readonly id: string;
  readonly group: CatalogGroup;
  readonly kindKey: string;
  /**
   * 選ぶ画面の指定の欄の説明の 1 行の i18n の鍵と、呼びの一覧の行の文字の形(説明を族ごとに持つ族だけ)。
   * `specified` は寸法を指定して作る族(行の文字は「寸法を指定して作る」)、`simplified` は資料の寸法に合わせて形を簡略にした族
   * (簡略の印を持つ行は、呼びに印を添える)。族を足す時は、この行だけを書けばよい(ui に族ごとの表を持たない)。
   */
  readonly hint?: { readonly key: string; readonly rowLabel: 'specified' | 'simplified' };
  readonly load: () => Promise<CatalogFamily>;
}
