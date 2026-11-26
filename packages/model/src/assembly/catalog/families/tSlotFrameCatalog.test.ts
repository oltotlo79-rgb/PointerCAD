// 規格資料の出典は規格番号と一般名で照合する。
/**
 * 資料 1 の溝つきフレームの 3 族(溝幅 6・8・10)の検査: 行の名乗り(規格の欄・note・出どころの頁)と dims の写し、簡略の形(面ごとの溝・升の格子・
 * 四隅の穴)の面積と押し出しの形、質量が単位質量 × 長さで出る事(族の関数・切断の一覧)、断面の外形、保存の形の作り直し。
 * 製品が使う口(登録口が読む `T_SLOT_CATALOG_FAMILIES` と、族が読む行の表 `T_SLOT_CATALOG_RECORDS`)だけを通して確かめる。
 * 形の種類ごとの代表の行: 4 面溝(20×20)・上をふさいだ 3 面溝(20×20)・四隅の穴つき(30×30 の 3 面溝の基本形)・升の格子(80×80 の 2 面溝の軽量形)・
 * 断面性能の表に行が無く頁の箱の値を持つ行(40×40 の超軽量形)。
 */
import { describe, expect, it } from 'vitest';

import { frameCapCandidates } from '../../accessories/frameEndCaps.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../../createAssemblyDocument.js';
import { frameSlotLines } from '../../frame/frameSlots.js';
import { buildSteelStockList } from '../../standard/steelStockList.js';
import type { AssemblyComponent } from '../../types.js';
import { createCatalogRegistry, PRODUCT_CATALOG_REGISTRY } from '../registry.js';
import { buildCatalogItemPart, catalogItemNominalMass, catalogItemRejection, createCatalogItemSource } from '../source.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { T_SLOT_CATALOG_RECORDS } from './frameCatalogRows.js';
import { T_SLOT_DIMENSIONED_RECORDS } from './frameDimensionedRows.js';
import { T_SLOT_OUTLINE_RECORDS } from './frameOutlineRows.js';
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

describe('資料 1 の溝つきフレームの 3 族', () => {
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
    // 長方形の格子、外周の指定、寸法を補読した長方形の順で登録する。
    for (const [slot, family] of [[6, FAMILIES.s6], [8, FAMILIES.s8], [10, FAMILIES.s10]] as const) {
      expect(family.rows.map((row) => row.key)).toEqual([...T_SLOT_CATALOG_RECORDS, ...T_SLOT_OUTLINE_RECORDS, ...T_SLOT_DIMENSIONED_RECORDS]
        .filter((item) => item.slot === slot).map((item) => item.key));
    }
  });

  it('行は規格の行を名乗らず、出どころは資料の番号と頁(表か図の箱)だけを持ち、dims は面ごとの溝の有無と表の値を写す', () => {
    const first = rowOfRecord(record('s6-20x20'));
    const closed = rowOfRecord(record('s6-20x20-blr'));
    const box = rowOfRecord(record('s10-40x40-ultralight'));
    for (const row of [first, closed, box]) {
      expect([row.standardLabel, row.materialLabel, row.densityMaterialId, row.verification, row.verified, row.note]).toEqual([
        '製造元の寸法に合わせた物', 'アルミ', 'aluminum', 'manufacturer-catalog', true, '内側の形は簡略。質量は単位質量の値']);
      expect([row.evidence.title, row.evidence.edition, row.evidence.reference]).toEqual([
        '資料 1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', null, '']);
    }
    expect(first.evidence.locator).toBe('PDF 42 頁 断面の図(外形・溝・穴・角の丸み)／PDF 384 頁 断面性能の表(断面積・Ix・Iy・Zx・Zy・単位質量)');
    expect(box.evidence.locator).toBe('PDF 174 頁 断面の図(外形・溝・穴・角の丸み)／PDF 174 頁 図の箱(Ix・Iy・Zx・Zy・単位質量。断面性能の表に行が無い)');
    expect([closed.dims.slotTop, closed.dims.slotBottom, closed.dims.slotLeft, closed.dims.slotRight, closed.dims.areaMm2, closed.dims.unitMassKgPerM])
      .toEqual([0, 1, 1, 1, 194, 0.52]);
    expect([box.dims.areaMm2, box.dims.unitMassKgPerM, box.dims.ixCm4]).toEqual([undefined, 1.33, 7.5]);
  });

  it('表に行があり単位質量だけ頁の箱の値の行は、出どころに表と箱の頁を分けて出し、note にその旨を書く', () => {
    const row = rowOfRecord(record('s10-40x80-tbl'));
    expect(row.evidence.locator)
      .toBe('PDF 176 頁 断面の図(外形・溝・穴・角の丸み)／PDF 385 頁 断面性能の表(断面積・Ix・Iy・Zx・Zy)／PDF 176 頁 図の箱(単位質量)');
    expect(row.note).toBe('内側の形は簡略。質量は単位質量の値(頁の箱の値。断面性能の表の単位質量は断面積と合わないので使わない)');
    expect([row.dims.areaMm2, row.dims.unitMassKgPerM, row.dims.ixCm4, row.dims.zyCm3]).toEqual([1105, 2.98, 70.5, 10.14]);
  });

  it('四隅の穴の位置が参考寸法だけの行は穴を作らず、簡略の印を持つ(印を持たない行は今までどおり印の欄が無い)', () => {
    const row = rowOfRecord(record('s8-30x30'));
    expect([row.dims.cornerHoleDiameter, row.dims.cornerHoleInset, row.simplified]).toEqual([0, 0, ['四隅の小さい穴(位置は参考寸法だけ)']]);
    expect(rowOfRecord(record('s6-20x20')).simplified).toBeUndefined();
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

  it('追加断面は登録した族から寸法・溝の座標を読み、従来のキャップと保存形式を使う', async () => {
    const registry = PRODUCT_CATALOG_REGISTRY;
    await registry.ensure(['t-slot-frame-s8', 't-slot-frame-s10', 't-slot-frame-cap']);
    const cases = [
      { familyId: 't-slot-frame-s8', key: 's8-30x60-tb-light', dimensions: [30, 60, 8, 30, 6.8, 2, 7],
        slotCenters: [['top', [0, 30]], ['bottom', [0, -30]]], holes: 2, mass: 790, cap: ['s8-60x30', 3, 1] },
      { familyId: 't-slot-frame-s10', key: 's10-40x80-tb-light', dimensions: [40, 80, 10, 40, 10.5, 3, 7],
        slotCenters: [['top', [0, 40]], ['bottom', [0, -40]]], holes: 2, mass: 1400, cap: ['s10-80x40-10.9g', 3, 1] },
      { familyId: 't-slot-frame-s10', key: 's10-45x135-light', dimensions: [45, 135, 10, 45, 12.5, 3, 7],
        slotCenters: [['top', [0, 67.5]], ['left', [-22.5, 45]], ['left', [-22.5, 0]], ['left', [-22.5, -45]],
          ['bottom', [0, -67.5]], ['right', [22.5, -45]], ['right', [22.5, 0]], ['right', [22.5, 45]]],
        holes: 3, mass: 2715, cap: null },
      { familyId: 't-slot-frame-s8', key: 's8-30x50-light', dimensions: [30, 50, 8, 20, 6.8, 2, 7],
        slotCenters: [['top', [0, 25]], ['left', [-15, 10]], ['left', [-15, -10]], ['bottom', [0, -25]],
          ['right', [15, -10]], ['right', [15, 10]]], holes: 2, mass: 705, cap: ['s8-50x30', 3, 1] },
      { familyId: 't-slot-frame-s10', key: 's10-40x40-tb-light', dimensions: [40, 40, 10, 40, 10.5, 3, 7],
        slotCenters: [['top', [0, 20]], ['bottom', [0, -20]]], holes: 1, mass: 785, cap: ['s10-40x40-4.7g', 3, 0] },
    ] as const;
    for (const item of cases) {
      const family = registry.loaded(item.familyId);
      const row = family?.rows.find((candidate) => candidate.key === item.key);
      if (family === undefined || row === undefined) throw new Error(`row ${item.key} is missing`);
      const selected = values(500);
      const dimensions = ['width', 'height', 'slotOpening', 'slotPitch', 'centerHole', 'cornerRadius', 'slotDepth'];
      expect(dimensions.map((key) => row.dims[key]), item.key).toEqual(item.dimensions);
      expect(family.sectionSlots?.(row, selected)?.map(({ face, center }) => [face, center]), item.key).toEqual(item.slotCenters);
      const source = createCatalogItemSource(family, row, selected);
      expect(source.options).toEqual({ family: item.familyId, item: item.key, length: '500' });
      const saved: typeof source = { ...source, options: { ...source.options } };
      expect(catalogItemRejection(saved, registry)).toBeNull();
      expect(catalogItemNominalMass(saved, registry)).toBeCloseTo(item.mass, 9);
      expect(buildCatalogItemPart(saved, registry)?.solids.map((feature) => feature.kind)).toEqual(
        ['extrude', ...Array.from({ length: item.holes }, () => ['extrude', 'boolean']).flat()],
      );
      const caps = frameCapCandidates({ family, row, values: selected }, registry);
      if (item.cap === null) {
        expect(caps).toEqual({ ok: false, reason: 'noMatchingCap' });
        continue;
      }
      expect(caps.ok ? caps.value.map((cap) => [cap.itemKey, cap.thicknessMm, cap.quarterTurn]) : caps).toContainEqual(item.cap);
    }

    const legacy = createCatalogItemSource(FAMILIES.s10, rowOfRecord(record('s10-40x40-tb-core')), values(500));
    expect([legacy.catalogRevision, legacy.generatorRevision, legacy.options.item]).toEqual(
      ['t-slot-frame-s10-2026-11-r1', 't-slot-2', 's10-40x40-tb-core'],
    );
    expect(buildCatalogItemPart(legacy, registry)?.solids.map((feature) => feature.kind)).toEqual(['extrude']);
  });

  it.each([
    { key: 's6-20x20-tb', size: [20, 20], faceCenters: [['top', [0, 10]], ['bottom', [0, -10]]],
      holeArcs: [[0, 0, 2.1]], mass: 270 },
    { key: 's6-20x40-tl', size: [20, 40], faceCenters: [['top', [0, 20]], ['left', [-10, 10]], ['left', [-10, -10]]],
      holeArcs: [], mass: 390 },
    { key: 's6-25x25', size: [25, 25], faceCenters: [['top', [0, 12.5]], ['left', [-12.5, 0]], ['bottom', [0, -12.5]],
      // 図の中心間は 18.5 mm。中央の後に四隅を右上から反時計回りに作図する。
      ['right', [12.5, 0]]], holeArcs: [[0, 0, 3.4], [9.25, 9.25, 2.1], [-9.25, 9.25, 2.1], [-9.25, -9.25, 2.1], [9.25, -9.25, 2.1]],
      mass: 390 },
  ] as const)('図面の面・穴・質量を、保存した行から組む断面で区別する($key)', async (item) => {
    const registry = PRODUCT_CATALOG_REGISTRY;
    await registry.ensure(['t-slot-frame-s6']);
    const family = registry.loaded('t-slot-frame-s6');
    const row = family?.rows.find((entry) => entry.key === item.key);
    if (family === undefined || row === undefined) throw new Error(item.key);
    const selected = values(500);
    const [width, height] = item.size;
    expect(family.sectionBounds?.(row, selected)).toEqual({ minX: -width / 2, minY: -height / 2, maxX: width / 2, maxY: height / 2 });
    const slots = family.sectionSlots?.(row, selected);
    expect(slots?.map(({ face, center }) => [face, center])).toEqual(item.faceCenters);
    expect(slots?.map(({ opening, shoulder, slotDepth }) => [opening, shoulder, slotDepth]))
      .toEqual(item.faceCenters.map(() => [6, 2, 4]));
    const source = structuredClone(createCatalogItemSource(family, row, selected));
    expect(source.options).toEqual({ family: 't-slot-frame-s6', item: item.key, length: '500' });
    expect([source.catalogRevision, source.generatorRevision]).toEqual(['t-slot-frame-s6-2026-11-r1', 't-slot-2']);
    expect(catalogItemRejection(source, registry)).toBeNull();
    expect(catalogItemNominalMass(source, registry)).toBeCloseTo(item.mass, 9);
    const part = buildCatalogItemPart(source, registry);
    expect(part?.solids.map((feature) => feature.kind))
      .toEqual(['extrude', ...item.holeArcs.flatMap(() => ['extrude', 'boolean'])]);
    const boreArcs = part?.sketches[0]?.features.flatMap((feature) => feature.kind === 'arc' && feature.center.mode === 'absolute'
      && feature.radius.value > 1 && feature.startAngle.value === 0
      ? [[feature.center.x.value, feature.center.y.value, feature.radius.value]] : []);
    expect(boreArcs).toEqual(item.holeArcs);
  });

  it('20×40 の左溝だけを、部材の向きに合わせ世界座標へ移す', () => {
    const family = FAMILIES.s6;
    const row = family.rows.find((item) => item.key === 's6-20x40-tl');
    if (row === undefined) throw new Error('20×40');
    const selected = values(500);
    const slots = family.sectionSlots?.(row, selected);
    if (slots == null) throw new Error('slots');
    const placement = { position: [100, 200, 300], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } as const;
    const lines = frameSlotLines(slots, placement, 500, null, []);
    expect(lines.map(({ face, start, end, inward }) => [face, start.map(Math.round), end.map(Math.round), inward.map((v) => Math.round(v) + 0)]))
      .toEqual([['top', [80, 200, 300], [80, 200, 800], [1, 0, 0]],
        ['left', [90, 190, 300], [90, 190, 800], [0, 1, 0]], ['left', [110, 190, 300], [110, 190, 800], [0, 1, 0]]]);
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
