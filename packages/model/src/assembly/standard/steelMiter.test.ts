/**
 * 鋼材の留め(J-01 包み 6)の検査: 保存の欄 startMiter・endMiter(値は短くする側)を持つ鋼材の部品が組め、欄の無い部品の形と保存は
 * 前と同じで、値の正しくない欄は「保存の欄が合わない」で断り、切断の一覧は留めの部材を別の行に束ねる事。
 * 形の体積は profileMiterKernel.test.ts が実際の形で確かめる。
 */
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { AssemblyComponent } from '../types.js';
import { buildStandardPartFromSource, createStandardPartSource, standardPartRejection } from './buildStandardPart.js';
import { ALL_STEEL_PRODUCTS, findSteelProduct, steelMiterField, steelProductOptions } from './steelCatalog.js';
import { buildSteelStockList } from './steelStockList.js';

const FLAT = ALL_STEEL_PRODUCTS.find((row) => row.key === 'SS400:flatBar:FB 50×6');

function flatSource(extra: Readonly<Record<string, string>> = {}) {
  if (FLAT === undefined) throw new Error('flat bar row');
  return createStandardPartSource(FLAT.catalog, FLAT.size, { ...steelProductOptions(FLAT), length: '300', ...extra });
}

describe('鋼材の留めの欄', () => {
  it('欄は startMiter・endMiter で、値は短くする側の 4 つだけ', () => {
    expect([steelMiterField('startMiter', 'x+'), steelMiterField('endMiter', 'y-'), steelMiterField('startMiter', 'none'),
      steelMiterField('startMiter', 'z+'), steelMiterField('miter', 'x+')]).toEqual([true, true, false, false, false]);
  });

  it('留めの欄のある保存の行が見つかり、形は端ごとに三角柱の引き算が足される。欄の無い保存の形は前と同じ', () => {
    if (FLAT === undefined) throw new Error('flat bar row');
    expect(findSteelProduct(FLAT.catalog, FLAT.size, flatSource({ startMiter: 'x+', endMiter: 'x-' }).options)).toBe(FLAT);
    const plain = buildStandardPartFromSource(flatSource());
    const mitered = buildStandardPartFromSource(flatSource({ startMiter: 'x+', endMiter: 'x-' }));
    expect(mitered?.solids.map((solid) => solid.kind)).toEqual([...(plain?.solids.map((solid) => solid.kind) ?? []),
      'extrude', 'boolean', 'extrude', 'boolean']);
    expect(standardPartRejection(flatSource({ startMiter: 'x+' }))).toBeNull();
    // 50×6 の両端を幅 50 の向きで切ると短い側は 長さ − 50 − 50。長さ 100 では面が残らないので作らない。
    expect(buildStandardPartFromSource({ ...flatSource({ startMiter: 'x+', endMiter: 'x+' }),
      options: { ...flatSource().options, length: '100', startMiter: 'x+', endMiter: 'x+' } })).toBeNull();
  });

  it('値の正しくない留めの欄は組まず、「保存の欄が合わない」で断る', () => {
    const wrong = flatSource({ startMiter: 'z+' });
    expect(buildStandardPartFromSource(wrong)).toBeNull();
    expect(standardPartRejection(wrong)?.code).toBe('saved-fields-mismatch');
    expect(standardPartRejection(wrong)?.fields).toContain('startMiter');
  });

  it('切断の一覧は、同じ長さでも留めの部材を別の行に束ね、留めの無い行の鍵は前と同じ', () => {
    const place = (id: string, extra: Readonly<Record<string, string>>): AssemblyComponent => ({ id, name: id, source: flatSource(extra),
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false });
    const list = buildSteelStockList({ ...createAssemblyDocument('鋼材の留め'), components: [place('a', {}),
      place('b', { startMiter: 'x+', endMiter: 'x+' }), place('c', { startMiter: 'x+', endMiter: 'x+' })] });
    expect(list.rows.map((row) => [row.lengthMm, row.quantity, row.miterEnds])).toEqual([[300, 1, 0], [300, 2, 2]]);
    expect(list.rows[0]?.key.endsWith(':finished:300')).toBe(true);
    expect(list.rows[1]?.key.endsWith(':miter=x+/x+')).toBe(true);
  });
});
