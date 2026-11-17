/**
 * 資料 SF-1 の溝つきフレームの 3 族(溝幅 6・8・10)の検査: 行の名乗り(規格の欄・note・出どころの頁)と dims の写し、簡略の形(面ごとの溝・升の格子・
 * 四隅の穴)の面積と押し出しの形、質量が単位質量 × 長さで出る事(族の関数・切断の一覧)、断面の外形、保存の形の作り直し。
 * 製品が使う口(登録口が読む `T_SLOT_CATALOG_FAMILIES` と、族が読む行の表 `T_SLOT_CATALOG_RECORDS`)だけを通して確かめる。
 * 形の種類ごとの代表の行: 4 面溝(20×20)・上をふさいだ 3 面溝(20×20)・四隅の穴つき(30×30 の 3 面溝の基本形)・升の格子(80×80 の 2 面溝の軽量形)・
 * 断面性能の表に行が無く頁の箱の値を持つ行(40×40 の超軽量形)。
 */
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../../createAssemblyDocument.js';
import { buildSteelStockList } from '../../standard/steelStockList.js';
import type { AssemblyComponent } from '../../types.js';
import { createCatalogRegistry } from '../registry.js';
import { catalogItemNominalMass, catalogItemRejection, createCatalogItemSource } from '../source.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { T_SLOT_CATALOG_RECORDS } from './frameCatalogRows.js';
import { T_SLOT_CATALOG_FAMILIES, type TSlotCatalogRecord } from './tSlotFrameCatalog.js';

const FAMILIES = T_SLOT_CATALOG_FAMILIES;
const REPRESENTATIVE = ['s6-20x20', 's6-20x20-blr', 's8-30x30-blr', 's10-80x80-bl-light', 's10-40x40-ultralight'];
const record = (key: string): TSlotCatalogRecord => {
  const found = T_SLOT_CATALOG_RECORDS.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`record ${key} is missing`);
  return found;
};
const RECORDS = REPRESENTATIVE.map(record);
const values = (length: number): Readonly<Record<string, string>> => ({ length: String(length) });

/** 式の面積: W·H − (4 − π)R² − 溝の数·[w·s + (wi − d)·d] − 穴の数·πh²/4 − 四隅の穴。 */
function formulaArea(item: TSlotCatalogRecord): number {
  const nx = item.slotsAcross;
  const ny = (item.height - item.width) / item.slotPitch + nx;
  const slots = [...item.faces].reduce((sum, face) => sum + (face === 't' || face === 'b' ? nx : ny), 0);
  return item.width * item.height - (4 - Math.PI) * item.cornerRadius ** 2
    - slots * (item.slotOpening * item.shoulder + (item.slotInnerWidth - item.slotDepth) * item.slotDepth)
    - nx * ny * Math.PI * item.centerHole ** 2 / 4 - (item.cornerHoleDiameter > 0 ? 4 * Math.PI * item.cornerHoleDiameter ** 2 / 4 : 0);
}

function familyOfRecord(item: TSlotCatalogRecord): CatalogFamily {
  return item.slot === 6 ? FAMILIES.s6 : item.slot === 8 ? FAMILIES.s8 : FAMILIES.s10;
}

function rowOfRecord(item: TSlotCatalogRecord): CatalogItemRow {
  const row = familyOfRecord(item).rows.find((candidate) => candidate.key === item.key);
  if (row === undefined) throw new Error(`row ${item.key} is missing`);
  return row;
}

describe('資料 SF-1 の溝つきフレームの 3 族', () => {
  it('族は溝幅ごとに 3 つで、版・欄・線図を凍結し、行は溝幅で分かれる', () => {
    // 長さの後の 2 つは一括配置の留めの任意の欄(J-01 包み 5。miterOption.test.ts)。
    const MITER_KEYS = [['startMiter', 'none'], ['endMiter', 'none']];
    expect([FAMILIES.s6, FAMILIES.s8, FAMILIES.s10].map((family) => [family.id, family.group, family.kindKey, family.catalogRevision,
      family.generatorRevision, family.stock, family.diagram, family.options.map((spec) => [spec.key, spec.defaultValue])])).toEqual([
      ['t-slot-frame-s6', 'aluminumFrame', 'catalog.frame.kind.tSlotS6', 't-slot-frame-s6-2026-11-r1', 't-slot-2', 'linear', 'tSlotSeries',
        [['length', '1000'], ...MITER_KEYS]],
      ['t-slot-frame-s8', 'aluminumFrame', 'catalog.frame.kind.tSlotS8', 't-slot-frame-s8-2026-11-r1', 't-slot-2', 'linear', 'tSlotSeries',
        [['length', '1000'], ...MITER_KEYS]],
      ['t-slot-frame-s10', 'aluminumFrame', 'catalog.frame.kind.tSlotS10', 't-slot-frame-s10-2026-11-r1', 't-slot-2', 'linear', 'tSlotSeries',
        [['length', '1000'], ...MITER_KEYS]],
    ]);
    for (const [slot, family] of [[6, FAMILIES.s6], [8, FAMILIES.s8], [10, FAMILIES.s10]] as const) {
      expect(family.rows.map((row) => row.key)).toEqual(T_SLOT_CATALOG_RECORDS.filter((item) => item.slot === slot).map((item) => item.key));
    }
  });

  it('行は規格の行を名乗らず、出どころは資料の番号と頁(表か図の箱)だけを持ち、dims は面ごとの溝の有無と表の値を写す', () => {
    const first = rowOfRecord(record('s6-20x20'));
    const closed = rowOfRecord(record('s6-20x20-blr'));
    const box = rowOfRecord(record('s10-40x40-ultralight'));
    for (const row of [first, closed, box]) {
      expect([row.standardLabel, row.materialLabel, row.densityMaterialId, row.verification, row.verified, row.note]).toEqual([
        '製造元の寸法に合わせた物', 'アルミ', 'aluminum', 'manufacturer-catalog', true, '内側の形は簡略。質量は単位質量の値']);
      expect([row.evidence.title, row.evidence.edition, row.evidence.url, row.evidence.sha256, row.evidence.fetchedDate]).toEqual([
        '資料 SF-1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', null, '', '', '']);
    }
    expect(first.evidence.locator).toBe('PDF 42 頁 断面の図(外形・溝・穴・角の丸み)／PDF 384 頁 断面性能の表(断面積・Ix・Iy・Zx・Zy・単位質量)');
    expect(box.evidence.locator).toBe('PDF 174 頁 断面の図(外形・溝・穴・角の丸み)／PDF 174 頁 図の箱(Ix・Iy・Zx・Zy・単位質量。断面性能の表に行が無い)');
    expect([closed.dims.slotTop, closed.dims.slotBottom, closed.dims.slotLeft, closed.dims.slotRight, closed.dims.areaMm2, closed.dims.unitMassKgPerM])
      .toEqual([0, 1, 1, 1, 194, 0.52]);
    expect([box.dims.areaMm2, box.dims.unitMassKgPerM, box.dims.ixCm4]).toEqual([undefined, 1.33, 7.5]);
  });

  it('形は簡略の形の押し出しから穴の押し出しを引いた物で、体積は式の面積 × 長さ(ふさいだ面・升の格子・四隅の穴)', () => {
    for (const item of RECORDS) {
      const family = familyOfRecord(item);
      const row = rowOfRecord(item);
      const nx = item.slotsAcross;
      const ny = (item.height - item.width) / item.slotPitch + nx;
      const holes = nx * ny + (item.cornerHoleDiameter > 0 ? 4 : 0);
      const part = family.build(row, values(750));
      expect(part?.name).toBe(`アルミフレーム ${item.size}×750`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['extrude', ...Array.from({ length: holes }, () => ['extrude', 'boolean']).flat()]);
      expect(family.nominalVolume(row, values(750))).toBeCloseTo(formulaArea(item) * 750, 6);
      expect(family.build(row, values(-1))).toBeNull();
      expect(family.nominalVolume(row, { length: 'abc' })).toBeNull();
    }
  });

  it('質量は単位質量 × 長さ(g)で、断面の外形は原点が中心の W × H', () => {
    for (const item of RECORDS) {
      const family = familyOfRecord(item);
      const row = rowOfRecord(item);
      expect(family.nominalMassG?.(row, values(750))).toBeCloseTo(item.unitMassKgPerM * 750, 9);
      expect(family.nominalMassG?.(row, values(0))).toBeNull();
      expect(family.sectionBounds?.(row, values(750))).toEqual({ minX: -item.width / 2, minY: -item.height / 2, maxX: item.width / 2,
        maxY: item.height / 2 });
    }
  });

  it('保存の形は長さだけを持ち、登録口を通して組め、切断の一覧と 1 個の質量は単位質量 × 長さ', async () => {
    const family = FAMILIES.s6;
    const registry = createCatalogRegistry([{ id: family.id, group: family.group, kindKey: family.kindKey, load: () => Promise.resolve(family) }]);
    await registry.ensure([family.id]);
    const first = rowOfRecord(record('s6-20x20'));
    const closed = rowOfRecord(record('s6-20x20-blr'));
    const source = createCatalogItemSource(family, closed, values(500));
    expect([source.size, source.options, source.catalogRevision, source.generatorRevision]).toEqual(['溝幅 6 20×20 3 面溝',
      { family: 't-slot-frame-s6', item: 's6-20x20-blr', length: '500' }, 't-slot-frame-s6-2026-11-r1', 't-slot-2']);
    expect(catalogItemRejection(source, registry)).toBeNull();
    expect(catalogItemNominalMass(source, registry)).toBeCloseTo(0.52 * 500, 9);
    const placed = (id: string, row: CatalogItemRow, length: number): AssemblyComponent => ({ id, name: id,
      source: createCatalogItemSource(family, row, values(length)), placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true,
      suppressed: false });
    const list = buildSteelStockList({ ...createAssemblyDocument('フレーム'), components: [placed('a', first, 1200), placed('b', first, 1200),
      placed('c', closed, 500)] }, new Map(), new Map(), registry);
    expect(list.catalogRows.map((row) => [row.familyId, row.size, row.lengthMm, row.quantity, row.unitMassKgPerM, row.massEachG]))
      .toEqual([['t-slot-frame-s6', '溝幅 6 20×20', 1200, 2, 0.49, 0.49 * 1200], ['t-slot-frame-s6', '溝幅 6 20×20 3 面溝', 500, 1, 0.52, 0.52 * 500]]);
  });

  it('製品の行(2 回の読みが一致した行)は、全部で形が作れ、鍵と呼びが重ならず、単位質量が正', () => {
    const rows = [FAMILIES.s6, FAMILIES.s8, FAMILIES.s10].flatMap((family) => family.rows.map((row) => ({ family, row })));
    expect(new Set(rows.map(({ row }) => row.key)).size).toBe(rows.length);
    expect(new Set(rows.map(({ row }) => row.size)).size).toBe(rows.length);
    for (const { family, row } of rows) {
      expect(family.build(row, values(1000)), row.key).not.toBeNull();
      expect(row.dims.unitMassKgPerM, row.key).toBeGreaterThan(0);
      expect(row.evidence.locator, row.key).toMatch(/^PDF [0-9]+ 頁 断面の図/u);
    }
  });
});
