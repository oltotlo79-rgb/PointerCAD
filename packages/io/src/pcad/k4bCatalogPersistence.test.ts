/**
 * 包み K4b の族(平行ピン・六角ナットの拡張 3 種・圧縮コイルばね)の、長さなどの指定の値(式)が出どころに文字のまま残る事。
 * 全部の行を置いた保存と開き直し(JSON と ZIP)は、登録の表から族ごとに回す catalogRegistryPersistence.test.ts が、
 * 同じ指定の値で見る(P2)。
 */
import { createStandardPartSource, PRODUCT_CATALOG_REGISTRY, type StandardPartSource } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

/** 指定の値を渡す 2 族(包み k4b の全部の族の保存と開き直しは catalogRegistryPersistence.test.ts)。 */
const K4B_FAMILY_IDS = ['parallel-pin', 'compression-spring'] as const;

async function k4bSources(): Promise<readonly StandardPartSource[]> {
  await PRODUCT_CATALOG_REGISTRY.ensure(K4B_FAMILY_IDS);
  return K4B_FAMILY_IDS.flatMap((id) => {
    const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
    if (family === undefined) throw new Error(`family not loaded: ${id}`);
    const values: Readonly<Record<string, string>> = id === 'parallel-pin' ? { length: '12*2' }
      : id === 'compression-spring' ? { wireDiameter: '1.6', meanDiameter: '12', freeLength: '40', totalCoils: '7.5' } : {};
    return family.rows.map((row) => createStandardPartSource('catalogItem', row.size, { family: id, item: row.key, ...values }));
  });
}

describe('K4b の族の部品の保存と開き直し', () => {
  it('指定の値は保存した式の文字のまま残る', async () => {
    const sources = await k4bSources();
    const pin = sources.find((source) => source.options.family === 'parallel-pin');
    const spring = sources.find((source) => source.options.family === 'compression-spring');
    expect(pin?.options).toEqual({ family: 'parallel-pin', item: 'St-d0.6', length: '12*2' });
    expect(spring?.options).toEqual({ family: 'compression-spring', item: 'specified', wireDiameter: '1.6', meanDiameter: '12',
      freeLength: '40', totalCoils: '7.5' });
  });
});
