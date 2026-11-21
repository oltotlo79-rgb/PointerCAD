/**
 * 規格部品の選ぶ画面で行を選んだまま置く時の形の検査。登録の表の全部の族の全部の行について、選ぶ画面が作るのと同じ保存の形
 * (createCatalogItemSource。欄は行ごとの既定の値か族の既定の値)が、断られずに形を作る事を確かめる。値の表は持たない(族の一覧から回す)。
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { PRODUCT_CATALOG_REGISTRY } from './registry.js';
import { buildCatalogItemPart, catalogItemRejection, createCatalogItemSource } from './source.js';

beforeAll(async () => {
  await PRODUCT_CATALOG_REGISTRY.ensure(PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id));
});

describe('行を選んだまま置く時の既定の値', () => {
  it('登録の表の全部の族の全部の行は、既定の値の保存の形で断られず、形を作る', () => {
    const refused: string[] = [];
    let rows = 0;
    for (const entry of PRODUCT_CATALOG_REGISTRY.entries) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(entry.id);
      if (family === undefined) throw new Error(`${entry.id} を読み込めない`);
      for (const row of family.rows) {
        rows += 1;
        const source = createCatalogItemSource(family, row);
        const rejection = catalogItemRejection(source);
        if (rejection !== null || buildCatalogItemPart(source) === null) refused.push(`${entry.id} ${row.key} ${JSON.stringify(source.options)}`);
      }
    }
    expect(rows).toBeGreaterThan(0);
    expect(refused).toEqual([]);
  });
});
