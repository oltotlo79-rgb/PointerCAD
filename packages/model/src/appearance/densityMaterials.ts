/**
 * 質量特性(FR-1101)の材料の表。
 * (密度、g/cm³)。
 *
 * 外観の材質プリセット(`materialPresets.ts`)とは**別の表**にする。
 * 鏡・ガラスの一部の見た目には密度が意味を持たず、質量の材料(鋼 SS400・ステンレス SUS304・
 * アルミ A5052 のような材質記号)には見た目が要らないため、持つものが違う。名前だけ揃え、
 * `materialPresets.ts` の `densityMaterialFor` で対応表を引く。
 *
 * 木材の密度は `materialPresets.ts` の `WOOD_SPECIES` と**共有する**(同じ数値を
 * 2 か所に書かない)。`custom`(自分で決める)は密度が利用者の式そのもの(固定値を持たない)
 * なので、この表には含めない。ui の材料の一覧では「自分で決める」を別枠で扱う。
 *
 * 密度は自分で知る出典(機械便覧・JIS の比重表・Wood Handbook 相当の気乾比重の目安)と
 * 2026-09-05 に照合した。鋼 7.85・ステンレス 7.93・銅 8.96・チタン 4.51・アクリル 1.19 など
 * 定番の数値と一致し、A5052 の 2.68 g/cm³ も純アルミ(2.70)よりわずかに軽いという知られた
 * 傾向と一致する。黄銅は組成により 8.4〜8.7 g/cm³ の幅があり、当初の案の 8.40 はその範囲の
 * 下限だが範囲内(要検証なら成分を絞って再確認)。木材 6 種は `materialPresets.ts` の注釈を
 * 参照。値はいずれも変えていない(rules/02-禁止事項.md)。
 *
 * 一次資料への紐付け(2026-11-09): steel・stainless・aluminum の 3 行だけ、掲載元の値・条件が
 * 表の値と一致する資料を各行の `source` に直接結ぶ。どれも取引の質量計算に
 * 使う基本質量や代表の比重であり、SS400・S45C などの各ロットの実測値ではない。残りの 16 行は
 * 一次資料を確かめていないので `source` を持たない(未確認の出典を作らない)。
 */

import { WOOD_SPECIES } from './materialPresets.js';

/** 質量の材料 1 件。 */
export interface DensityMaterial {
  readonly id: string;
  /** 密度(g/cm³)。 */
  readonly density: number;
  /** 一次資料で値と条件を確かめた行だけ持つ。無い行は出典未確認。 */
  readonly source?: DensitySource;
}

/**
 * 密度の掲載元 1 件。掲載元の数値と単位をそのまま持ち、表の値(g/cm³)との一致は試験で確かめる。
 * `condition` は値の種類(質量計算の基本質量か比重か)と対象の材質・調質。
 */
interface DensitySource {
  readonly url: string;
  readonly publisher: string;
  readonly locator: string;
  readonly condition: string;
  readonly statedValue: number;
  /** `kg/(cm2*m)` は断面積 1 cm²・長さ 1 m の質量(10 倍で g/cm³)。`specific-gravity` は水を 1 g/cm³ として読む比重。 */
  readonly statedUnit: 'g/cm3' | 'kg/(cm2*m)' | 'specific-gravity';
  readonly checkedDate: string;
  /** 資料の全文を取得して指紋を取ったものではなく、検索の抜粋で値・位置・条件を確かめたもの。 */
  readonly evidence: 'search-excerpt';
}

/** 一次資料で値と条件を確かめた密度の掲載元(steel・stainless・aluminum の 3 行だけ)。 */
const STEEL_DENSITY_SOURCE: DensitySource = {
  url: 'https://www.niscs.nipponsteel.com/products/ac/forming/data/forming_15.pdf',
  publisher: '日本製鉄グループ(niscs.nipponsteel.com)',
  locator: '軽量形鋼の重量計算方法の表、計算順序の最初の行(基本質量)',
  condition: 'JIS G 3350 に準じた軽量形鋼の計算質量の基本質量。鋼の密度の目安で、SS400・S45C の各ロットの実測値ではない',
  statedValue: 0.785, statedUnit: 'kg/(cm2*m)', checkedDate: '2026-11-09', evidence: 'search-excerpt',
};

const STAINLESS_DENSITY_SOURCE: DensitySource = {
  url: 'https://www.jfe-steel.co.jp/products/stainless/catalog/g1j-001.pdf',
  publisher: 'JFEスチール',
  locator: 'JFEのステンレス薄鋼板、物理的性質の表の SUS304 の行と表の注記',
  condition: 'SUS304。表の注記により SUS 規格の密度は JIS で規定された基本質量(取引の質量計算は JIS G 4304・G 4305)で、実測値ではない',
  statedValue: 7.93, statedUnit: 'g/cm3', checkedDate: '2026-11-09', evidence: 'search-excerpt',
};

const ALUMINUM_DENSITY_SOURCE: DensitySource = {
  url: 'https://www.aluminum.or.jp/fields/kenchiku/kenzai/guide/a/',
  publisher: '日本アルミニウム協会',
  locator: '建材ガイド「1.特長」、A5052P-H34 の物理的・機械的性質の表、比重の行',
  condition: 'A5052P-H34 の比重(代表値)。他の調質や他の掲載元の値には結ばず、各ロットの実測値ではない',
  statedValue: 2.68, statedUnit: 'specific-gravity', checkedDate: '2026-11-09', evidence: 'search-excerpt',
};

/** 木材以外の材料 13 種(材料の表の行から `wood-*` と `custom` を除いたもの)。 */
const NON_WOOD_DENSITY_MATERIALS: readonly DensityMaterial[] = [
  { id: 'steel', density: 7.85, source: STEEL_DENSITY_SOURCE },
  { id: 'stainless', density: 7.93, source: STAINLESS_DENSITY_SOURCE },
  { id: 'aluminum', density: 2.68, source: ALUMINUM_DENSITY_SOURCE },
  { id: 'brass', density: 8.4 },
  { id: 'copper', density: 8.96 },
  { id: 'titanium', density: 4.51 },
  { id: 'abs', density: 1.05 },
  { id: 'pc', density: 1.2 },
  { id: 'nylon', density: 1.14 },
  { id: 'acrylic', density: 1.19 },
  { id: 'pla', density: 1.24 },
  { id: 'glass', density: 2.5 },
  { id: 'rubber', density: 1.2 },
];

/**
 * 木材 6 樹種を `wood-<樹種>` の id で展開する。`materialPresets.ts` の `WOOD_SPECIES` から
 * 密度を引くので、樹種の密度は 1 か所(`WOOD_SPECIES`)にしかない。
 */
const WOOD_DENSITY_MATERIALS: readonly DensityMaterial[] = WOOD_SPECIES.map((species) => ({
  id: `wood-${species.id}`,
  density: species.density,
}));

/**
 * 質量の材料の一覧。**当初の表は見た目上「15 行」(木材を `wood-*` の 1 行に
 * まとめ、密度が固定値でない `custom` の行も含めた数)だが、`densityMaterialFor` が返す
 * `wood-<樹種>` を実際に引けるようにするため木材は 6 件へ展開し、固定の密度を持たない
 * `custom` は密度の型(`number`)に合わないためこの配列に含めない。結果は非木材 13 種 +
 * 木材 6 種 = 19 件になる。**
 */
export const DENSITY_MATERIALS: readonly DensityMaterial[] = [
  ...NON_WOOD_DENSITY_MATERIALS,
  ...WOOD_DENSITY_MATERIALS,
];

/** 既定の質量の材料(「既定は steel(7.85)」)。 */
export const DEFAULT_DENSITY_MATERIAL_ID = 'steel';

/** id から材料を引く。無ければ `undefined`。 */
export function findDensityMaterial(id: string): DensityMaterial | undefined {
  return DENSITY_MATERIALS.find((material) => material.id === id);
}

/** g/cm³ → kg/m³: 1 g = 1e-3 kg and 1 cm³ = 1e-6 m³. Analysis readers validate positivity/finite range. */
export function densityGPerCm3ToKgM3(densityGPerCm3: number): number {
  return densityGPerCm3 * 1000;
}
