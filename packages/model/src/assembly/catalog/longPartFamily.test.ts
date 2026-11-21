/**
 * 長物の族の作り(断面の外形を包む長方形 × 長さ。統括の決定 2026-11-19 15:5x の 1)の検査: 族の欄・数え方・既定の長さ、行の名乗りと印と密度の持ち方、
 * 体積と質量(単位質量 × 長さ)、長さの上限を超える長さと寸法の誤りを断る事、切断の一覧に長さと単位質量で出る事、
 * 溝つきのフレームの部材にならない(断面の外形・溝を持たない)事。行は検査の中の仮の行(製品の行の表は読みの後に道具が作る)。
 */
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { buildSteelStockList } from '../standard/steelStockList.js';
import type { AssemblyComponent } from '../types.js';
import { type LongPartRecord, rectangleLongPartFamily } from './longPartFamily.js';
import { createCatalogRegistry } from './registry.js';
import { catalogItemNominalMass, createCatalogItemSource } from './source.js';
import type { CatalogItemRow } from './types.js';

const MARK = '断面の外形を包む形で、溝に入る足と中空は作っていない';
const RECORDS: readonly LongPartRecord[] = [
  { key: 'test-aluminum-12x8', size: '試しの長物 12×8（アルミ）', page: 10, kind: '試しの長物', material: 'aluminum', width: 12, height: 8,
    unitMassKgPerM: 0.2, maxLength: null, simplified: [MARK] },
  { key: 'test-resin-10x4-l2000', size: '試しの長物 10×4（樹脂）', page: 11, kind: '試しの長物', material: 'mixed', materialText: '樹脂', width: 10, height: 4,
    unitMassKgPerM: 0.05, maxLength: 2000, massNote: '質量は資料の定尺 1 本の質量 ÷ 定尺の単位質量 × 長さ', simplified: [MARK] },
  { key: 'test-no-mass-6x6-l500', size: '試しの長物 6×6（鋼）', page: 12, kind: '試しの長物', material: 'steel', width: 6, height: 6,
    unitMassKgPerM: null, maxLength: 500, simplified: [MARK] },
];
const FAMILY = rectangleLongPartFamily({ id: 'test-long-part', kindKey: 'catalog.frame.kind.testLongPart', diagram: 'panelCoverFrame',
  evidenceTitle: '資料 1 試しの資料', defaultLength: 1000 }, RECORDS);
const length = (value: number | string): Readonly<Record<string, string>> => ({ length: String(value) });

function row(key: string): CatalogItemRow {
  const found = FAMILY.rows.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`行 ${key} が無い`);
  return found;
}

describe('長物の族(断面の外形を包む長方形 × 長さ)', () => {
  it('族は数え方が長さ(切断の一覧に出る)で、欄は長さだけ、版は族の id から作り、断面の外形と溝を持たない', () => {
    expect([FAMILY.id, FAMILY.group, FAMILY.kindKey, FAMILY.catalogRevision, FAMILY.generatorRevision, FAMILY.stock, FAMILY.diagram,
      FAMILY.options.map((spec) => [spec.key, spec.defaultValue])]).toEqual(['test-long-part', 'aluminumFrame', 'catalog.frame.kind.testLongPart',
      'test-long-part-2026-11-r1', 'long-part-1', 'linear', 'panelCoverFrame', [['length', '1000']]]);
    expect(['sectionBounds' in FAMILY, 'sectionSlots' in FAMILY]).toEqual([false, false]);
    // 既定の長さは、行の上限と族の既定の短い方。
    const spec = FAMILY.options[0];
    expect(RECORDS.map((record) => spec?.rowDefault?.(row(record.key)))).toEqual(['1000', '1000', '500']);
  });

  it('行は製造元の寸法に合わせた物を名乗り、出どころは族の資料の名前と頁、印の文に単位質量の扱いと長さの上限を書き、金属の行だけ密度を持つ', () => {
    expect(FAMILY.rows.map((item) => [item.key, item.size, item.standardLabel, item.verification, item.verified, item.evidence.title,
      item.evidence.locator, item.simplified, item.materialLabel, item.densityMaterialId, item.dims])).toEqual([
      ['test-aluminum-12x8', '試しの長物 12×8（アルミ）', '製造元の寸法に合わせた物', 'manufacturer-catalog', true, '資料 1 試しの資料',
        'PDF 10 頁 断面の図(外形の寸法)と質量の記入', [MARK], 'アルミ', 'aluminum', { width: 12, height: 8, unitMassKgPerM: 0.2 }],
      ['test-resin-10x4-l2000', '試しの長物 10×4（樹脂）', '製造元の寸法に合わせた物', 'manufacturer-catalog', true, '資料 1 試しの資料',
        'PDF 11 頁 断面の図(外形の寸法)と質量の記入', [MARK], '樹脂', undefined, { width: 10, height: 4, unitMassKgPerM: 0.05, maxLength: 2000 }],
      ['test-no-mass-6x6-l500', '試しの長物 6×6（鋼）', '製造元の寸法に合わせた物', 'manufacturer-catalog', true, '資料 1 試しの資料',
        'PDF 12 頁 断面の図(外形の寸法)と質量の記入', [MARK], '鋼', undefined, { width: 6, height: 6, maxLength: 500 }],
    ]);
    expect(row('test-aluminum-12x8').note).toBe(`形は簡略(${MARK})。質量は資料の単位質量 × 長さ。断面の性質は持たない`);
    expect(row('test-resin-10x4-l2000').note).toBe(`形は簡略(${MARK})。質量は資料の定尺 1 本の質量 ÷ 定尺の単位質量 × 長さ。長さは 2000 mm まで。断面の性質は持たない`);
    expect(row('test-no-mass-6x6-l500').note).toBe(`形は簡略(${MARK})。質量は資料に記入が無いので出さない。長さは 500 mm まで。断面の性質は持たない`);
  });

  it('資料に載らない品(頁なし)は出どころに頁を書かず、値の出どころの種類を行に渡す。持たない行は欄を持たない', () => {
    const screen = rectangleLongPartFamily({ id: 'test-screen-long-part', kindKey: 'catalog.frame.kind.testLongPart', diagram: 'panelCoverFrame',
      evidenceTitle: '資料 1 試しの資料', defaultLength: 1000 }, [{ key: 'test-screen-20x14', size: '試しの長物 20×14（アルミ）', page: null,
      kind: '試しの長物', material: 'aluminum', width: 20, height: 14, unitMassKgPerM: 0.3, maxLength: null, simplified: [MARK],
      valueSource: { kind: 'toolScreen', fields: ['width', 'height', 'unitMassKgPerM'] } }]);
    expect(screen.rows.length).toBe(1);
    const only = screen.rows[0];
    expect([only.evidence.locator, only.valueSource]).toEqual(['資料に載らない品(値は参考にした組立用の道具の画面の値)',
      { kind: 'toolScreen', fields: ['width', 'height', 'unitMassKgPerM'] }]);
    expect(RECORDS.map((record) => 'valueSource' in row(record.key))).toEqual([false, false, false]);
  });

  it('形は断面を長さだけ押し出した物で、体積は横 × 縦 × 長さ、質量は単位質量 × 長さ(単位質量の無い行は出さない)、名前に長さの式', () => {
    expect(FAMILY.nominalVolume(row('test-aluminum-12x8'), length(750))).toBeCloseTo(12 * 8 * 750, 9);
    expect(FAMILY.nominalMassG?.(row('test-aluminum-12x8'), length(750))).toBeCloseTo(0.2 * 750, 9);
    expect(FAMILY.build(row('test-aluminum-12x8'), length('500+250'))?.name).toBe('試しの長物 12×8（アルミ）×500+250');
    expect(FAMILY.partName?.(row('test-resin-10x4-l2000'), length(2000))).toBe('試しの長物 10×4（樹脂）×2000');
    expect(FAMILY.nominalMassG?.(row('test-resin-10x4-l2000'), length(2000))).toBeCloseTo(0.05 * 2000, 9);
    expect(FAMILY.nominalVolume(row('test-no-mass-6x6-l500'), length(500))).toBeCloseTo(6 * 6 * 500, 9);
    expect(FAMILY.nominalMassG?.(row('test-no-mass-6x6-l500'), length(500)) ?? null).toBeNull();
  });

  it('長さの上限を超える長さ・正でない長さ・読めない式・正でない断面は、形も体積も質量も作らない(上限に縮めない)', () => {
    for (const [key, value] of [['test-resin-10x4-l2000', 2000.5], ['test-no-mass-6x6-l500', 501], ['test-aluminum-12x8', 0],
      ['test-aluminum-12x8', -10], ['test-aluminum-12x8', '1+']] as const) {
      expect([FAMILY.build(row(key), length(value)), FAMILY.nominalVolume(row(key), length(value)),
        FAMILY.nominalMassG?.(row(key), length(value)) ?? null], `${key} ${value}`).toEqual([null, null, null]);
    }
    const flat: CatalogItemRow = { ...row('test-aluminum-12x8'), dims: { width: 12, height: 0, unitMassKgPerM: 0.2 } };
    expect([FAMILY.build(flat, length(100)), FAMILY.nominalVolume(flat, length(100))]).toEqual([null, null]);
  });

  it('切断の一覧に長さと単位質量で出て、質量は登録口を通しても同じ', async () => {
    const registry = createCatalogRegistry([{ id: FAMILY.id, group: FAMILY.group, kindKey: FAMILY.kindKey, load: () => Promise.resolve(FAMILY) }]);
    await registry.ensure([FAMILY.id]);
    const source = createCatalogItemSource(FAMILY, row('test-resin-10x4-l2000'), length(1200));
    expect(catalogItemNominalMass(source, registry)).toBeCloseTo(0.05 * 1200, 9);
    const placed: AssemblyComponent = { id: 'a', name: 'a', source, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true,
      suppressed: false };
    const list = buildSteelStockList({ ...createAssemblyDocument('部品'), components: [placed] }, new Map(), new Map(), registry);
    expect(list.catalogRows.map((item) => [item.familyId, item.size, item.lengthMm, item.quantity, item.unitMassKgPerM]))
      .toEqual([['test-long-part', '試しの長物 10×4（樹脂）', 1200, 1, 0.05]]);
  });
});
