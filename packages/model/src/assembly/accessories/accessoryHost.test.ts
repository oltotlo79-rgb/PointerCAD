/**
 * G2 の段 1: 付属の組の本体を部品の保存の形から引く(accessoryHost.ts)。族の部品・鋼材の部材(鋼管 SGP 25A)・8 分類の部品(六角ボルト)・
 * 作った部品・読み込んでいない族の 5 つ。長さは欄の値(mm)、長さの無い・読めない欄は null。
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { createStandardPartSource } from '../standard/buildStandardPart.js';
import { STEEL_PRODUCTS, steelProductOptions } from '../standard/steelCatalog.js';
import { accessoryHostOf } from './accessoryHost.js';

const REGISTRY = PRODUCT_CATALOG_REGISTRY;
beforeAll(async () => { await REGISTRY.ensure(['t-slot-frame-s6']); });

describe('付属の組の本体', () => {
  it('族の部品は族・行・欄の値と長さ、読み込んでいない族と作った部品は null', () => {
    const family = REGISTRY.loaded('t-slot-frame-s6');
    const row = family?.rows.find((item) => item.key === 's6-20x20');
    if (family === undefined || row === undefined) throw new Error('frame family not loaded');
    const host = accessoryHostOf(createCatalogItemSource(family, row, { length: '1000' }), REGISTRY);
    expect(host?.kind === 'catalogItem' ? [host.family.id, host.row.key, host.values.length, host.lengthMm] : null)
      .toEqual(['t-slot-frame-s6', 's6-20x20', '1000', 1000]);
    const unknown = createStandardPartSource('catalogItem', 'x', { family: 'future-family', item: 'x' });
    expect(accessoryHostOf(unknown, REGISTRY)).toBeNull();
    expect(accessoryHostOf({ kind: 'part', partRef: 'p.pcad' }, REGISTRY)).toBeNull();
  });

  it('鋼材の鋼管は鋼材の行と長さ、六角ボルトは 8 分類の部品のまま', () => {
    const pipe = STEEL_PRODUCTS.find((row) => row.catalog === 'steelPipe' && row.size === '25A' && row.materialGrade === 'SGP');
    if (pipe === undefined) throw new Error('SGP 25A missing');
    const host = accessoryHostOf(createStandardPartSource(pipe.catalog, pipe.size, { ...steelProductOptions(pipe), length: '2000' }), REGISTRY);
    expect(host?.kind === 'steel' ? [host.product.key, host.lengthMm] : null).toEqual([pipe.key, 2000]);
    const bolt = createStandardPartSource('hexBolt', 'M8', { length: '40', dimensionSeries: 'annexJA', threadSeries: 'coarse' });
    expect(accessoryHostOf(bolt, REGISTRY)).toEqual({ kind: 'standard', source: bolt });
  });
});
