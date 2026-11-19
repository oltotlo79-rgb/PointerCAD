/**
 * 溝つきアルミフレームの族の「留め」の任意の欄(J-01 包み 5)の検査:
 * - 欄を使わない部品は、今の行の全部(汎用・系列・資料の 3 族)で、形の台本の結果・台本の体積・質量・保存の形が、欄を足す前の
 *   作り方(押し出しのまま、面積 × 長さ、単位質量 × 長さ、欄の鍵)と同じ。形の台本の版は上げない。
 * - 欄の無い保存(前の文書)は開け、欄を使った保存は、欄を持たない前の版の族が「保存の欄が合わない」で断る。
 * - 欄を使うと、形に切る三角が足され、台本の体積は 1 次のモーメントの式、質量は単位質量 × 中心の長さになる。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { buildProfileSection } from '../standard/profileExtrusion.js';
import { withName } from '../standard/partPrimitives.js';
import { buildSteelStockList } from '../standard/steelStockList.js';
import type { AssemblyComponent } from '../types.js';
import { ALUMINUM_SECTION_FAMILIES } from './families/aluminumSections.js';
import { T_SLOT_OUTLINE_RECORDS } from './families/frameOutlineRows.js';
import { T_SLOT_FRAME_FAMILY } from './families/tSlotFrame.js';
import { T_SLOT_CATALOG_FAMILIES } from './families/tSlotFrameCatalog.js';
import { T_SLOT_FRAME_SERIES_FAMILY } from './families/tSlotFrameSeries.js';
import { MITER_OPTION_SPECS } from './miterOption.js';
import { aluminumSectionProfile, type AluminumSection } from './profiles/aluminumSection.js';
import { slottedOutlineProfile, type SlottedOutline } from './profiles/slottedOutline.js';
import { tSlotProfile, tSlotSectionBounds, type TSlotDimensions } from './profiles/tSlot.js';
import { createCatalogRegistry } from './registry.js';
import { buildCatalogItemPart, catalogItemNominalMass, catalogItemRejection, createCatalogItemSource } from './source.js';
import type { CatalogFamily, CatalogItemRow } from './types.js';

const ROW_FAMILIES: readonly CatalogFamily[] = [T_SLOT_FRAME_SERIES_FAMILY, T_SLOT_CATALOG_FAMILIES.s6, T_SLOT_CATALOG_FAMILIES.s8,
  T_SLOT_CATALOG_FAMILIES.s10];
const SECTION_FAMILIES = Object.values(ALUMINUM_SECTION_FAMILIES);
const ALL_FAMILIES: readonly CatalogFamily[] = [T_SLOT_FRAME_FAMILY, ...ROW_FAMILIES, ...SECTION_FAMILIES];

/** アルミの形材の行の断面(族の id から種類を読む。aluminumSections.ts と同じ読み方)。 */
function aluminumSectionOfRow(familyId: string, row: CatalogItemRow): AluminumSection {
  const value = (key: string): number => row.dims[key] ?? NaN;
  if (familyId === 'aluminum-round-bar') return { kind: 'roundBar', diameter: value('diameter'), holeDiameter: row.dims.holeDiameter ?? 0 };
  if (familyId === 'aluminum-flat-bar') return { kind: 'flatBar', height: value('height'), thickness: value('thickness') };
  const kind = familyId === 'aluminum-channel' ? 'channel' : familyId === 'aluminum-angle' ? 'angle' : 'squarePipe';
  return { kind, height: value('height'), width: value('width'), thickness: value('thickness') };
}

/** 行の寸法を T スロットの寸法にする(系列・資料の族の dims の鍵。面の溝は 1 の時だけ開く)。 */
function rowDimensions(row: CatalogItemRow): TSlotDimensions {
  const dims = row.dims;
  const face = (key: string): boolean => (dims[key] ?? 1) === 1;
  const hasFaces = ['slotTop', 'slotBottom', 'slotLeft', 'slotRight'].some((key) => dims[key] !== undefined);
  return { width: dims.width ?? NaN, height: dims.height ?? NaN, slotPitch: dims.slotPitch ?? NaN, slotsAcross: dims.slotsAcross,
    ...(hasFaces ? { openFaces: { top: face('slotTop'), bottom: face('slotBottom'), left: face('slotLeft'), right: face('slotRight') } } : {}),
    slotOpening: dims.slotOpening ?? NaN, shoulder: dims.shoulder ?? NaN, slotInnerWidth: dims.slotInnerWidth ?? NaN,
    slotDepth: dims.slotDepth ?? NaN, centerHole: dims.centerHole ?? NaN, cornerRadius: dims.cornerRadius ?? NaN,
    cornerHoleDiameter: dims.cornerHoleDiameter ?? 0, cornerHoleInset: dims.cornerHoleInset ?? 0 };
}

/**
 * 資料の族のうち外周の指定を持つ行(1 つの角の大きな丸みなど。frameOutlineRows.ts)の断面の入力。この行の断面は長方形の格子の台本ではなく
 * 溝つきの外周の台本で作るので、「欄を足す前の作り方」は、その外周の断面の押し出しになる。
 */
const OUTLINES = new Map(T_SLOT_OUTLINE_RECORDS.map((record): readonly [string, SlottedOutline] => [record.key, {
  vertices: record.outline?.vertices ?? [], radii: record.outline?.radii ?? [], slots: record.outline?.slots ?? [],
  holes: record.outline?.holes ?? [], slotOpening: record.slotOpening, shoulder: record.shoulder, slotInnerWidth: record.slotInnerWidth,
  slotDepth: record.slotDepth }]));

const registryOf = (family: CatalogFamily) => createCatalogRegistry([{ id: family.id, group: family.group, kindKey: family.kindKey,
  load: () => Promise.resolve(family) }]);

describe('留めの欄を使わない部品は欄を足す前と同じ', () => {
  it('どの族も留めの欄は始点・終点の 2 つの任意の欄で、既定は切らない。形の台本の版は上げない', () => {
    expect(MITER_OPTION_SPECS.map((spec) => [spec.key, spec.kind, spec.defaultValue, spec.optional, spec.choices])).toEqual([
      ['startMiter', 'choice', 'none', true, ['none', 'x+', 'x-', 'y+', 'y-']], ['endMiter', 'choice', 'none', true, ['none', 'x+', 'x-', 'y+', 'y-']]]);
    for (const family of ALL_FAMILIES) expect(family.options.slice(-2)).toEqual(MITER_OPTION_SPECS);
    expect([T_SLOT_FRAME_FAMILY.generatorRevision, T_SLOT_FRAME_SERIES_FAMILY.generatorRevision,
      ...Object.values(T_SLOT_CATALOG_FAMILIES).map((family) => family.generatorRevision)]).toEqual(['t-slot-1', 't-slot-1', 't-slot-2', 't-slot-2', 't-slot-2']);
  });

  it('今の行の全部で、形の台本の結果は押し出しのまま、台本の体積は面積 × 長さ、質量は単位質量 × 長さ、保存の欄は留めの鍵を持たない', () => {
    let rows = 0;
    let outlineRows = 0;
    for (const family of ROW_FAMILIES) {
      for (const row of family.rows) {
        // 外周の指定を持つ行(資料の族だけ)は外周の台本、ほかは長方形の格子の台本の断面。
        const outline = family === T_SLOT_FRAME_SERIES_FAMILY ? undefined : OUTLINES.get(row.key);
        if (outline !== undefined) outlineRows += 1;
        const profile = outline === undefined ? tSlotProfile(rowDimensions(row)) : slottedOutlineProfile(outline);
        if (profile === null) throw new Error(`profile ${row.key}`);
        const source = createCatalogItemSource(family, row, { length: '750' });
        expect(Object.keys(source.options)).toEqual(['family', 'item', 'length']);
        const part = family.build(row, { length: '750' });
        expect(part).toEqual(withName(buildProfileSection(profile, expressionValueFromNumber(750)), family.partName(row, { length: '750' })));
        expect(family.nominalVolume(row, { length: '750' })).toBe(profile.areaMm2 * 750);
        expect(family.nominalMassG?.(row, { length: '750' })).toBe((row.dims.unitMassKgPerM ?? NaN) * 750);
        rows += 1;
      }
    }
    expect(rows).toBe(T_SLOT_FRAME_SERIES_FAMILY.rows.length + Object.values(T_SLOT_CATALOG_FAMILIES)
      .reduce((sum, family) => sum + family.rows.length, 0));
    // 外周の指定を持つ行は、全部が資料の族に入っていて、外周の台本の断面で確かめた。
    expect([outlineRows, OUTLINES.size > 0]).toEqual([T_SLOT_OUTLINE_RECORDS.length, true]);
    // アルミの形材の 5 族(J-01 包み 6 で欄を足した)も、今の行の全部で前と同じ。
    let sectionRows = 0;
    for (const family of SECTION_FAMILIES) {
      for (const row of family.rows) {
        const profile = aluminumSectionProfile(aluminumSectionOfRow(family.id, row));
        if (profile === null) throw new Error(`profile ${row.key}`);
        expect(Object.keys(createCatalogItemSource(family, row, { length: '750' }).options)).toEqual(['family', 'item', 'length']);
        expect(family.build(row, { length: '750' })).toEqual(withName(buildProfileSection(profile, expressionValueFromNumber(750)),
          family.partName(row, { length: '750' })));
        expect(family.nominalVolume(row, { length: '750' })).toBe(profile.areaMm2 * 750);
        expect(family.nominalMassG?.(row, { length: '750' })).toBe((row.dims.unitMassKgPerM ?? NaN) * 750);
        sectionRows += 1;
      }
    }
    expect(sectionRows).toBe(SECTION_FAMILIES.reduce((sum, family) => sum + family.rows.length, 0));
    expect(sectionRows).toBeGreaterThan(0);
    const generic = T_SLOT_FRAME_FAMILY.rows[0];
    if (generic === undefined) throw new Error('generic row');
    const values = Object.fromEntries(T_SLOT_FRAME_FAMILY.options.filter((spec) => spec.optional !== true)
      .map((spec) => [spec.key, spec.defaultValue]));
    expect(Object.keys(createCatalogItemSource(T_SLOT_FRAME_FAMILY, generic).options)).toEqual(['family', 'item', ...Object.keys(values)]);
  });

  it('欄の無い保存(前の文書)は開け、留めの欄を書いた保存は、欄を持たない前の版の族が「保存の欄が合わない」で断る', async () => {
    const family = T_SLOT_FRAME_SERIES_FAMILY;
    const row = family.rows[0];
    if (row === undefined) throw new Error('row');
    const registry = registryOf(family);
    await registry.ensure([family.id]);
    const plain = createCatalogItemSource(family, row, { length: '500' });
    expect(catalogItemRejection(plain, registry)).toBeNull();
    const mitered = createCatalogItemSource(family, row, { length: '500', startMiter: 'x+' });
    expect(mitered.options).toEqual({ family: family.id, item: row.key, length: '500', startMiter: 'x+' });
    expect(catalogItemRejection(mitered, registry)).toBeNull();
    expect(catalogItemRejection({ ...mitered, options: { ...mitered.options, startMiter: 'z+' } }, registry)?.code).toBe('invalid-option-value');
    const previous: CatalogFamily = { ...family, options: family.options.filter((spec) => spec.optional !== true) };
    const old = registryOf(previous);
    await old.ensure([previous.id]);
    expect(catalogItemRejection(plain, old)).toBeNull();
    expect(catalogItemRejection(mitered, old)?.code).toBe('saved-fields-mismatch');
  });
});

describe('留めの欄を使った部品', () => {
  it('形に切る三角柱の引き算が端ごとに足され、台本の体積は 1 次のモーメントの式、質量は単位質量 × 中心の長さ(長い側 − 端ごとの h)', async () => {
    const family = T_SLOT_FRAME_SERIES_FAMILY;
    const row = family.rows.find((candidate) => candidate.key === 's6-20x20');
    if (row === undefined) throw new Error('row');
    const registry = registryOf(family);
    await registry.ensure([family.id]);
    const values = { length: '520', startMiter: 'x+', endMiter: 'x+' };
    const part = buildCatalogItemPart(createCatalogItemSource(family, row, values), registry);
    const plain = family.build(row, { length: '520' });
    expect(part?.solids.map((solid) => solid.kind)).toEqual([...(plain?.solids.map((solid) => solid.kind) ?? []),
      'extrude', 'boolean', 'extrude', 'boolean']);
    // 20×20 の 4 面溝は外形の中心に対して対称なので、端 1 つで 面積 × 10 だけ減る。
    const profile = tSlotProfile(rowDimensions(row));
    if (profile === null) throw new Error('profile');
    expect(family.nominalVolume(row, values)).toBeCloseTo(profile.areaMm2 * (520 - 20), 6);
    expect(catalogItemNominalMass(createCatalogItemSource(family, row, values), registry)).toBeCloseTo((row.dims.unitMassKgPerM ?? NaN) * 500, 9);
    expect(tSlotSectionBounds(rowDimensions(row))).toEqual({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
  });

  it('片側だけ溝の断面(溝幅 8 30×30 1 面溝)の質量は、単位質量 × 留めを引いた後の体積 ÷ 断面積(形の体積の比と合い、中心の長さとは違う)', () => {
    const family = T_SLOT_CATALOG_FAMILIES.s8;
    const row = family.rows.find((candidate) => candidate.key === 's8-30x30-l');
    const profile = row === undefined ? null : tSlotProfile(rowDimensions(row));
    if (row === undefined || profile === null) throw new Error('row');
    const unitMass = row.dims.unitMassKgPerM ?? NaN;
    for (const values of [{ length: '300', startMiter: 'x+', endMiter: 'x+' }, { length: '300', startMiter: 'y-', endMiter: 'x-' }]) {
      const volume = family.nominalVolume(row, values) ?? NaN;
      const mass = family.nominalMassG?.(row, values) ?? NaN;
      expect(mass / unitMass).toBeCloseTo(volume / profile.areaMm2, 9);
      // 外形の中心の長さ(300 − 15 − 15 = 270)とは、切り落とす量の偏りの分だけ違う。
      expect(Math.abs(mass / unitMass - 270)).toBeGreaterThan(1e-3);
    }
    // 留めの無い時は前と同じ(単位質量 × 長さ)。
    expect(family.nominalMassG?.(row, { length: '300' })).toBe(unitMass * 300);
  });

  it('切断の一覧は、同じ長さでも留めの部材を別の行に束ね(長さは長い側、質量は部品表と同じ値)、留めの無い行の鍵は前と同じ', async () => {
    const family = T_SLOT_FRAME_SERIES_FAMILY;
    const row = family.rows.find((candidate) => candidate.key === 's6-20x20');
    if (row === undefined) throw new Error('row');
    const registry = registryOf(family);
    await registry.ensure([family.id]);
    const place = (id: string, values: Readonly<Record<string, string>>): AssemblyComponent => ({ id, name: id,
      source: createCatalogItemSource(family, row, values), placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false });
    const mitered = { length: '520', startMiter: 'x+', endMiter: 'x+' };
    const list = buildSteelStockList({ ...createAssemblyDocument('留め'), components: [place('a', { length: '520' }), place('b', mitered),
      place('c', mitered)] }, new Map(), new Map(), registry);
    expect(list.catalogRows.map((stock) => [stock.lengthMm, stock.quantity, stock.miterEnds])).toEqual([[520, 1, 0], [520, 2, 2]]);
    expect(list.catalogRows[0]?.key).toBe(`${family.id}@${family.catalogRevision}/${family.generatorRevision}:s6-20x20:520`);
    expect(list.catalogRows[1]?.massEachG).toBeCloseTo(catalogItemNominalMass(createCatalogItemSource(family, row, mitered), registry) ?? NaN, 9);
    expect(list.catalogRows[1]?.massEachG).toBeCloseTo((row.dims.unitMassKgPerM ?? NaN) * 500, 6);
  });

  it('アルミの形材の山形・溝形(図心が外形の中心から外れる)も、質量は単位質量 × 留めを引いた体積 ÷ 断面積で、中心の長さとは違う', () => {
    for (const [family, key] of [[ALUMINUM_SECTION_FAMILIES.angle, 'an-15x20x2'], [ALUMINUM_SECTION_FAMILIES.channel, 'ch-40x20x2']] as const) {
      const row = family.rows.find((candidate) => candidate.key === key);
      const profile = row === undefined ? null : aluminumSectionProfile(aluminumSectionOfRow(family.id, row));
      if (row === undefined || profile === null) throw new Error(key);
      const unitMass = row.dims.unitMassKgPerM ?? NaN;
      // 両端とも + の側を短くする(図心の偏りの分が両端で足し合わさる向き)。
      const values = { length: '300', startMiter: 'x+', endMiter: 'y+' };
      const volume = family.nominalVolume(row, values) ?? NaN;
      expect((family.nominalMassG?.(row, values) ?? NaN) / unitMass).toBeCloseTo(volume / profile.areaMm2, 9);
      const bounds = family.sectionBounds?.(row, values);
      if (bounds === null || bounds === undefined) throw new Error('bounds');
      const center = 300 - (bounds.maxX - bounds.minX) / 2 - (bounds.maxY - bounds.minY) / 2;
      expect(Math.abs(volume / profile.areaMm2 - center)).toBeGreaterThan(1e-3);
      expect(family.build(row, values)?.solids.filter((solid) => solid.kind === 'boolean').length)
        .toBe((family.build(row, { length: '300' })?.solids.filter((solid) => solid.kind === 'boolean').length ?? 0) + 2);
    }
  });

  it('短い側の面が残らない長さ(20×20 の両端の留めで 40 以下)は作らない', () => {
    const family = T_SLOT_FRAME_SERIES_FAMILY;
    const row = family.rows.find((candidate) => candidate.key === 's6-20x20');
    if (row === undefined) throw new Error('row');
    expect(family.build(row, { length: '40', startMiter: 'x+', endMiter: 'x-' })).toBeNull();
    expect(family.nominalMassG?.(row, { length: '40', startMiter: 'x+', endMiter: 'x-' })).toBeNull();
    expect(family.build(row, { length: '41', startMiter: 'x+', endMiter: 'x-' })).not.toBeNull();
  });
});
