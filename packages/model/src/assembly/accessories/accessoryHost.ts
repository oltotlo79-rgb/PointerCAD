/**
 * 付属の組の本体(G2。設計 wip/k28-bundle3-g2-design.md §1)。部品の保存の形から、組が使う本体の事実を引く純関数。
 *
 * - 族の部品(catalogItem): 族・行・欄の値と、長さの欄の値(mm。長さを持たない・読めない時は null)。族が読み込まれていない・行が無い時は本体にしない。
 * - 鋼材の部材(鋼管・丸棒・角パイプ・形鋼): 鋼材の行(`steelProductFromSource`)と長さの欄の値。置き方は族のフレームと同じ約束
 *   (局所の +Z が長さの向き、z = 0 が始点の端)なので、端に付く組は族と同じ計算で扱える(段 2 で使う)。
 * - 8 分類の部品(六角ボルト・深溝玉軸受ほか): 保存の形のまま。
 * 本体の種類は記録に持たない(記録の hostComponentId の部品の保存の形から毎回引く)。
 */
import { evaluateExpression } from '@pointercad/expression';

import type { CatalogRegistry } from '../catalog/registry.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { steelProductFromSource, type SteelProduct } from '../standard/steelCatalog.js';
import type { ComponentSource } from '../types.js';

const FAMILY_KEY = 'family', ITEM_KEY = 'item';

/** 族の部品の本体。 */
export interface CatalogItemHost {
  readonly kind: 'catalogItem';
  readonly source: StandardPartSource;
  readonly family: CatalogFamily;
  readonly row: CatalogItemRow;
  readonly values: Readonly<Record<string, string>>;
  readonly lengthMm: number | null;
}

export type AccessoryHost = CatalogItemHost
  | { readonly kind: 'steel'; readonly source: StandardPartSource; readonly product: SteelProduct; readonly lengthMm: number | null }
  | { readonly kind: 'standard'; readonly source: StandardPartSource };

/** 欄の値の長さ(mm)。欄が無い・式が読めない・0 以下は null。 */
function lengthOf(values: Readonly<Record<string, string>>): number | null {
  const length = Object.hasOwn(values, 'length') ? evaluateExpression(values.length ?? '') : null;
  return length !== null && length.ok && length.value.value > 0 ? length.value.value : null;
}

/** 族と行と欄の値から作る族の部品の本体(置く前の選ぶ窓の本体にも使う)。 */
export function catalogItemHost(source: StandardPartSource, family: CatalogFamily, row: CatalogItemRow,
  values: Readonly<Record<string, string>>): CatalogItemHost {
  return { kind: 'catalogItem', source, family, row, values, lengthMm: lengthOf(values) };
}

/** 部品の保存の形の本体。規格部品でない(作った部品)・族が読み込まれていない・行が無い時は null。 */
export function accessoryHostOf(source: ComponentSource, registry: CatalogRegistry): AccessoryHost | null {
  if (source.kind !== 'standardPart') return null;
  if (source.catalog === 'catalogItem') {
    const family = registry.loaded(source.options[FAMILY_KEY] ?? '');
    const row = family?.rows.find((candidate) => candidate.key === source.options[ITEM_KEY]);
    if (family === undefined || row === undefined) return null;
    const values = Object.fromEntries(Object.entries(source.options).filter(([key]) => key !== FAMILY_KEY && key !== ITEM_KEY));
    return catalogItemHost(source, family, row, values);
  }
  const product = steelProductFromSource(source);
  return product === undefined ? { kind: 'standard', source } : { kind: 'steel', source, product, lengthMm: lengthOf(source.options) };
}
