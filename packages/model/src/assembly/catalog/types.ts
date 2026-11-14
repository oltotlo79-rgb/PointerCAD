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
import type { SteelEvidence } from '../standard/steelCatalog.js';

/** 選ぶ画面の分類(鋼材・アルミフレーム・機械要素)。 */
type CatalogGroup = 'steel' | 'aluminumFrame' | 'mechanical';

/** 版の確かさ。鋼材の台帳(`steelStandards.ts`)の確認の程度と同じ考え方。 */
type CatalogVerification = 'draft' | 'final-standard' | 'manufacturer-catalog' | 'unverified';

/** 寸法を添えて描く簡単な線図の種類。製造元の図・画像は使わない。 */
type DimensionDiagramId = 'rectTube' | 'angle' | 'iBeam' | 'channel' | 'lipChannel' | 'pipe'
  | 'pin' | 'nut' | 'bolt' | 'washer' | 'bearing' | 'camFollower' | 'bush' | 'compressionSpring' | 'tSlotFrame';

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
  /** 新しく置く時の既定の値。保存の時は必ず書き出す。 */
  readonly defaultValue: string;
}

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
  /** 質量に使う密度の材質 id(`appearance/densityMaterials.ts` の steel・stainless・aluminum ほか)。 */
  readonly densityMaterialId: string;
  readonly dims: Readonly<Record<string, number>>;
  /** 寸法の出どころ。形は鋼材と同じ(題名・版・URL・頁・SHA-256・取得日)。 */
  readonly evidence: SteelEvidence;
  readonly verification: CatalogVerification;
  /** false の行は画面で「要確認」と知らせる。 */
  readonly verified: boolean;
  /** 未確認または欠測の理由。確認済みなら空文字。 */
  readonly note: string;
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
}

/**
 * 登録口の 1 行。**族の表は必要な時だけ読む**(選ぶ画面を開いた時、文書に族の部品が見つかった時)ので、
 * ここには表を持たず、読む入口 `load` だけを置く(起動の時の読み込みを増やさない)。
 */
export interface CatalogFamilyEntry {
  readonly id: string;
  readonly group: CatalogGroup;
  readonly kindKey: string;
  readonly load: () => Promise<CatalogFamily>;
}
