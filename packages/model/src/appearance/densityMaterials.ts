/**
 * 質量特性(FR-1101)の材料の表(密度、g/cm³)。
 * 計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.4.2、§0.a-0.31、タスク1。
 *
 * 外観の材質プリセット(`materialPresets.ts`)とは**別の表**にする(§0.a-0.31)。
 * 鏡・ガラスの一部の見た目には密度が意味を持たず、質量の材料(鋼 SS400・ステンレス SUS304・
 * アルミ A5052 のような材質記号)には見た目が要らないため、持つものが違う。名前だけ揃え、
 * `materialPresets.ts` の `densityMaterialFor` で対応表を引く。
 *
 * 木材の密度は `materialPresets.ts` の `WOOD_SPECIES` と**共有する**(§0.a-0.31。同じ数値を
 * 2 か所に書かない)。`custom`(自分で決める)は密度が利用者の式そのもの(固定値を持たない)
 * なので、この表には含めない。ui タスク32 の材料の一覧では「自分で決める」を別枠で扱う。
 *
 * 密度は自分で知る出典(機械便覧・JIS の比重表・Wood Handbook 相当の気乾比重の目安)と
 * 2026-09-05 に照合した。鋼 7.85・ステンレス 7.93・銅 8.96・チタン 4.51・アクリル 1.19 など
 * 定番の数値と一致し、A5052 の 2.68 g/cm³ も純アルミ(2.70)よりわずかに軽いという知られた
 * 傾向と一致する。黄銅は組成により 8.4〜8.7 g/cm³ の幅があり、計画書の 8.40 はその範囲の
 * 下限だが範囲内(要検証なら成分を絞って再確認)。木材 6 種は `materialPresets.ts` の注釈を
 * 参照。値はいずれも変えていない(rules/02-禁止事項.md)。
 */

import { WOOD_SPECIES } from './materialPresets.js';

/** 質量の材料 1 件。 */
export interface DensityMaterial {
  readonly id: string;
  /** 密度(g/cm³)。 */
  readonly density: number;
}

/** 木材以外の材料 13 種(§2.4.2 の表の行から `wood-*` と `custom` を除いたもの)。 */
const NON_WOOD_DENSITY_MATERIALS: readonly DensityMaterial[] = [
  { id: 'steel', density: 7.85 },
  { id: 'stainless', density: 7.93 },
  { id: 'aluminum', density: 2.68 },
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
 * 密度を引くので、樹種の密度は 1 か所(`WOOD_SPECIES`)にしかない(§0.a-0.31)。
 */
const WOOD_DENSITY_MATERIALS: readonly DensityMaterial[] = WOOD_SPECIES.map((species) => ({
  id: `wood-${species.id}`,
  density: species.density,
}));

/**
 * 質量の材料の一覧(§2.4.2)。**計画書の表は見た目上「15 行」(木材を `wood-*` の 1 行に
 * まとめ、密度が固定値でない `custom` の行も含めた数)だが、`densityMaterialFor` が返す
 * `wood-<樹種>` を実際に引けるようにするため木材は 6 件へ展開し、固定の密度を持たない
 * `custom` は密度の型(`number`)に合わないためこの配列に含めない。結果は非木材 13 種 +
 * 木材 6 種 = 19 件になる(担当が数えて統括へ報告する差分。手順3・§2.4.2)。**
 */
export const DENSITY_MATERIALS: readonly DensityMaterial[] = [
  ...NON_WOOD_DENSITY_MATERIALS,
  ...WOOD_DENSITY_MATERIALS,
];

/** 既定の質量の材料(§2.4.2「既定は steel(7.85)」)。 */
export const DEFAULT_DENSITY_MATERIAL_ID = 'steel';

/** id から材料を引く。無ければ `undefined`。 */
export function findDensityMaterial(id: string): DensityMaterial | undefined {
  return DENSITY_MATERIALS.find((material) => material.id === id);
}
