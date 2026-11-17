/**
 * 資料 SF-1 のフレームの部品の 4 族(T 溝用ナットの素材・T 溝用ナット・丸ナット・端のキャップ)の検査: 族の版・欄・線図・数え方、
 * 行の名乗り(規格の欄・出どころ・note・簡略の印)、全部の行で形が作れる事、質量が資料の値(素材は単位質量 × 長さ、ほかは 1 個の値)である事、
 * 体積が形の式と合う事、素材の断面の外形、登録口を通した保存の形と切断の一覧。製品が使う口(族の書き出しと行の表)を通して確かめる。
 */
import { describe, expect, it } from 'vitest';

import { withinMagnitude } from '../../../numericTolerance.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../../createAssemblyDocument.js';
import { buildSteelStockList } from '../../standard/steelStockList.js';
import type { AssemblyComponent } from '../../types.js';
import { slotNutVolume } from '../profiles/frameParts.js';
import {
  adjusterVolume, angleBracketCatalogVolume, flatPlateProfile, footBaseProfile, frameCapProfile, roundNutVolume, shapedPlateProfile,
  tSlotNutBarProfile,
} from '../profiles/framePartShapes.js';
import { createCatalogRegistry } from '../registry.js';
import { catalogItemNominalMass, catalogItemRejection, createCatalogItemSource } from '../source.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import {
  ADJUSTER_FAMILY, ANGLE_BRACKET_CATALOG_FAMILY, FLAT_PLATE_FAMILY, FOOT_BASE_FAMILY, FRAME_CAP_FAMILY, ROUND_NUT_FAMILY, SHAPED_PLATE_FAMILY,
  T_SLOT_NUT_BAR_FAMILY, T_SLOT_NUT_FAMILY,
} from './framePartCatalog.js';
import {
  ADJUSTER_RECORDS, ANGLE_BRACKET_RECORDS, FLAT_PLATE_RECORDS, FOOT_BASE_RECORDS, FRAME_CAP_RECORDS, ROUND_NUT_RECORDS, SHAPED_PLATE_RECORDS,
  T_SLOT_NUT_BAR_RECORDS, T_SLOT_NUT_RECORDS,
} from './framePartRows.js';

const FAMILIES = [T_SLOT_NUT_BAR_FAMILY, T_SLOT_NUT_FAMILY, ROUND_NUT_FAMILY, FRAME_CAP_FAMILY, FLAT_PLATE_FAMILY, SHAPED_PLATE_FAMILY,
  ANGLE_BRACKET_CATALOG_FAMILY, FOOT_BASE_FAMILY, ADJUSTER_FAMILY];
const values = (length: number): Readonly<Record<string, string>> => ({ length: String(length) });

function rowOf(family: CatalogFamily, key: string): CatalogItemRow {
  const row = family.rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`${family.id} の行 ${key} が無い`);
  return row;
}

describe('資料 SF-1 のフレームの部品の 9 族', () => {
  it('族の id・群・種類の鍵・版・線図・数え方・欄を凍結し、行は行の表の行を同じ順で持つ', () => {
    expect(FAMILIES.map((family) => [family.id, family.group, family.kindKey, family.catalogRevision, family.generatorRevision, family.diagram,
      family.stock, family.options.map((spec) => [spec.key, spec.defaultValue])])).toEqual([
      ['t-slot-nut-bar', 'aluminumFrame', 'catalog.frame.kind.nutBar', 't-slot-nut-bar-2026-11-r1', 'frame-part-1', 'tSlotNutBar', 'linear',
        [['length', '1000']]],
      ['t-slot-nut', 'aluminumFrame', 'catalog.frame.kind.catalogNut', 't-slot-nut-2026-11-r1', 'frame-part-1', 'tSlotNut', 'count', []],
      ['t-slot-round-nut', 'aluminumFrame', 'catalog.frame.kind.roundNut', 't-slot-round-nut-2026-11-r1', 'frame-part-1', 'roundNut', 'count', []],
      ['t-slot-frame-cap', 'aluminumFrame', 'catalog.frame.kind.cap', 't-slot-frame-cap-2026-11-r1', 'frame-part-1', 'frameCap', 'count', []],
      ['t-slot-flat-plate', 'aluminumFrame', 'catalog.frame.kind.flatPlate', 't-slot-flat-plate-2026-11-r1', 'frame-part-1', 'flatPlate', 'count',
        []],
      ['t-slot-shaped-plate', 'aluminumFrame', 'catalog.frame.kind.shapedPlate', 't-slot-shaped-plate-2026-11-r1', 'frame-part-1', 'shapedPlate',
        'count', []],
      ['t-slot-angle-bracket', 'aluminumFrame', 'catalog.frame.kind.angleBracketCatalog', 't-slot-angle-bracket-2026-11-r1', 'frame-part-1',
        'angleBracketCatalog', 'count', []],
      ['t-slot-foot-base', 'aluminumFrame', 'catalog.frame.kind.footBase', 't-slot-foot-base-2026-11-r1', 'frame-part-1', 'footBase', 'count', []],
      ['t-slot-adjuster', 'aluminumFrame', 'catalog.frame.kind.adjuster', 't-slot-adjuster-2026-11-r1', 'frame-part-1', 'adjuster', 'count', []],
    ]);
    const records = [T_SLOT_NUT_BAR_RECORDS, T_SLOT_NUT_RECORDS, ROUND_NUT_RECORDS, FRAME_CAP_RECORDS, FLAT_PLATE_RECORDS, SHAPED_PLATE_RECORDS,
      ANGLE_BRACKET_RECORDS, FOOT_BASE_RECORDS, ADJUSTER_RECORDS];
    expect(FAMILIES.map((family) => family.rows.map((row) => [row.key, row.size])))
      .toEqual(records.map((list) => list.map((record) => [record.key, record.size])));
    expect(records.map((list) => list.length)).toEqual([12, 50, 4, 51, 11, 15, 42, 14, 4]);
  });

  it('行は規格の行を名乗らず、出どころは資料の番号と頁だけで、note と簡略の印は行の表の印から作る', () => {
    const cases: readonly (readonly [CatalogFamily, string, string, string, readonly string[], string])[] = [
      [T_SLOT_NUT_BAR_FAMILY, 's8-pre-steel', '鋼', 'steel', ['頭の斜面'], '形は簡略(頭の斜面)。質量は単位質量の値'],
      [T_SLOT_NUT_FAMILY, 's10-m8-pre-stainless', 'ステンレス', 'stainless', ['頭の斜面', '首の長さ'], '形は簡略(頭の斜面・首の長さ)。質量は資料の 1 個の値'],
      [ROUND_NUT_FAMILY, 's10-d13-l39', 'ステンレス', 'stainless', ['穴の位置'], '形は簡略(穴の位置)。質量は資料の 1 個の値'],
      [FRAME_CAP_FAMILY, 's6-20x20', '樹脂(ナイロン)', 'nylon', ['取付けの脚と穴', '角の形'], '形は簡略(取付けの脚と穴・角の形)。質量は資料の 1 個の値'],
      [FLAT_PLATE_FAMILY, 's6-50x40x3-h4', 'ステンレス', 'stainless', [], '質量は資料の 1 個の値'],
    ];
    for (const [family, key, materialLabel, density, simplified, note] of cases) {
      const row = rowOf(family, key);
      expect([row.standardLabel, row.materialLabel, row.densityMaterialId, row.verification, row.verified, row.simplified, row.note])
        .toEqual(['製造元の寸法に合わせた物', materialLabel, density, 'manufacturer-catalog', true, simplified, note]);
      expect([row.evidence.title, row.evidence.edition, row.evidence.url, row.evidence.sha256, row.evidence.fetchedDate]).toEqual([
        '資料 SF-1 アルミ構造材の総合カタログ(製造元の寸法に合わせた物)', null, '', '', '']);
      expect(row.evidence.locator).toMatch(/^PDF [0-9]+ 頁 部品の図\(寸法\)と質量の記入$/u);
    }
  });

  it('全部の行で形が作れ、名前は呼び(素材は呼び × 長さ)、鍵と呼びは族の中で重ならない', () => {
    for (const family of FAMILIES) {
      expect(new Set(family.rows.map((row) => row.key)).size).toBe(family.rows.length);
      expect(new Set(family.rows.map((row) => row.size)).size).toBe(family.rows.length);
      for (const row of family.rows) {
        const part = family.build(row, values(250));
        expect(part, `${family.id}/${row.key}`).not.toBeNull();
        expect(part?.name).toBe(family === T_SLOT_NUT_BAR_FAMILY ? `${row.size}×250` : row.size);
      }
    }
    expect(T_SLOT_NUT_BAR_FAMILY.build(rowOf(T_SLOT_NUT_BAR_FAMILY, 's6-pre-steel'), values(0))).toBeNull();
  });

  it('質量は資料の値: 素材は単位質量(kg/m)× 長さ(mm)、ほかは行の 1 個の質量(長さに依らない)', () => {
    for (const record of T_SLOT_NUT_BAR_RECORDS) {
      const row = rowOf(T_SLOT_NUT_BAR_FAMILY, record.key);
      expect(T_SLOT_NUT_BAR_FAMILY.nominalMassG?.(row, values(450))).toBeCloseTo(record.unitMassKgPerM * 450, 9);
      expect(T_SLOT_NUT_BAR_FAMILY.nominalMassG?.(row, values(-1))).toBeNull();
    }
    for (const [family, records] of [[T_SLOT_NUT_FAMILY, T_SLOT_NUT_RECORDS], [ROUND_NUT_FAMILY, ROUND_NUT_RECORDS],
      [FRAME_CAP_FAMILY, FRAME_CAP_RECORDS]] as const) {
      for (const record of records) expect(family.nominalMassG?.(rowOf(family, record.key), {})).toBe(record.massG);
    }
    // 平板は、資料の質量が検算(形の体積 × 密度)と合う行だけ質量を持つ。持たない行は部品表が形 × 密度で出す。
    for (const record of FLAT_PLATE_RECORDS) {
      expect(FLAT_PLATE_FAMILY.nominalMassG?.(rowOf(FLAT_PLATE_FAMILY, record.key), {})).toBe(record.massG);
      if (record.massG !== null) {
        const computed = (flatPlateProfile(record)?.areaMm2 ?? NaN) * record.thickness * 7.93 / 1000;
        expect(withinMagnitude(record.massG - computed, 0.1 * computed), record.key).toBe(true);
      }
    }
  });

  it('体積は形の式(素材は断面積 × 長さ、ナットは今の汎用の形の式、丸ナット・キャップは形の式)と合い、素材の外形は原点が中心', () => {
    for (const record of T_SLOT_NUT_BAR_RECORDS) {
      const row = rowOf(T_SLOT_NUT_BAR_FAMILY, record.key);
      const area = record.headWidth * (record.totalHeight - record.neckHeight) + record.neckWidth * record.neckHeight;
      expect(T_SLOT_NUT_BAR_FAMILY.nominalVolume(row, values(300))).toBeCloseTo(area * 300, 6);
      expect(tSlotNutBarProfile(record)?.areaMm2).toBeCloseTo(area, 9);
      expect(T_SLOT_NUT_BAR_FAMILY.sectionBounds?.(row, values(300))).toEqual({ minX: -record.headWidth / 2, minY: -record.totalHeight / 2,
        maxX: record.headWidth / 2, maxY: record.totalHeight / 2 });
    }
    for (const record of T_SLOT_NUT_RECORDS) {
      expect(T_SLOT_NUT_FAMILY.nominalVolume(rowOf(T_SLOT_NUT_FAMILY, record.key), {})).toBeCloseTo(slotNutVolume({ thread: record.thread,
        flangeWidth: record.headWidth, length: record.length, flangeThickness: record.totalHeight - record.neckHeight, neckWidth: record.neckWidth,
        neckHeight: record.neckHeight }) ?? NaN, 9);
    }
    for (const record of ROUND_NUT_RECORDS) {
      expect(ROUND_NUT_FAMILY.nominalVolume(rowOf(ROUND_NUT_FAMILY, record.key), {})).toBeCloseTo(roundNutVolume(record) ?? NaN, 9);
      // 端から穴までの記入が無い行は、全長の中央に対して対称(簡略の印「穴の位置」)。
      if (record.simplified.includes('穴の位置')) expect(record.holeOffset * 2 + record.holePitch).toBeCloseTo(record.length, 9);
    }
    for (const record of FRAME_CAP_RECORDS) {
      const profile = frameCapProfile({ ...record, armWidth: record.armWidth ?? NaN });
      expect(FRAME_CAP_FAMILY.nominalVolume(rowOf(FRAME_CAP_FAMILY, record.key), {})).toBeCloseTo((profile?.areaMm2 ?? NaN) * record.thickness, 9);
    }
    // 平板: L·W − 2C² − 穴の数·π·d²/4 に厚さを掛けた値。
    for (const record of FLAT_PLATE_RECORDS) {
      const holes = record.holesX.length * record.holesY.length;
      const area = record.length * record.width - 2 * record.chamfer ** 2 - holes * Math.PI * record.holeDiameter ** 2 / 4;
      expect(FLAT_PLATE_FAMILY.nominalVolume(rowOf(FLAT_PLATE_FAMILY, record.key), {})).toBeCloseTo(area * record.thickness, 9);
    }
  });

  it('保存の形は登録口を通して組め、1 個の質量は資料の値。切断の一覧には長さを持つ素材だけが出る', async () => {
    const registry = createCatalogRegistry(FAMILIES.map((family) => ({ id: family.id, group: family.group, kindKey: family.kindKey,
      load: () => Promise.resolve(family) })));
    await registry.ensure(FAMILIES.map((family) => family.id));
    const nut = createCatalogItemSource(T_SLOT_NUT_FAMILY, rowOf(T_SLOT_NUT_FAMILY, 's8-m6-pre-steel'), {});
    const bar = createCatalogItemSource(T_SLOT_NUT_BAR_FAMILY, rowOf(T_SLOT_NUT_BAR_FAMILY, 's8-pre-steel'), values(450));
    expect([nut.size, nut.options, nut.catalogRevision, nut.generatorRevision]).toEqual(['T 溝用ナット 溝幅 8 M6（先入れ・鋼）',
      { family: 't-slot-nut', item: 's8-m6-pre-steel' }, 't-slot-nut-2026-11-r1', 'frame-part-1']);
    expect(catalogItemRejection(nut, registry)).toBeNull();
    expect(catalogItemNominalMass(nut, registry)).toBe(8);
    expect(catalogItemNominalMass(bar, registry)).toBeCloseTo(0.653 * 450, 9);
    const placed = (id: string, source: AssemblyComponent['source']): AssemblyComponent => ({ id, name: id, source,
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false });
    const list = buildSteelStockList({ ...createAssemblyDocument('部品'), components: [placed('a', nut), placed('b', bar)] }, new Map(),
      new Map(), registry);
    expect(list.catalogRows.map((row) => [row.familyId, row.size, row.lengthMm, row.quantity, row.unitMassKgPerM]))
      .toEqual([['t-slot-nut-bar', 'T 溝用ナットの素材 溝幅 8（先入れ・鋼）', 450, 1, 0.653]]);
  });
});

describe('資料 SF-1 の部品の読み直しで足した 4 族(平板の L・T・十字、L 形のブラケット、ベースの板、アジャスター)', () => {
  it('体積は形の関数と同じ式、質量は持つ行だけ資料の値で、簡略の印は族ごとの決まりどおり', () => {
    for (const record of SHAPED_PLATE_RECORDS) {
      const row = rowOf(SHAPED_PLATE_FAMILY, record.key);
      expect(SHAPED_PLATE_FAMILY.nominalVolume(row, {})).toBeCloseTo((shapedPlateProfile(record)?.areaMm2 ?? NaN) * record.thickness, 9);
      expect([SHAPED_PLATE_FAMILY.nominalMassG?.(row, {}) ?? null, row.simplified]).toEqual([record.massG, ['角の形']]);
    }
    for (const record of ANGLE_BRACKET_RECORDS) {
      const row = rowOf(ANGLE_BRACKET_CATALOG_FAMILY, record.key);
      expect(ANGLE_BRACKET_CATALOG_FAMILY.nominalVolume(row, {})).toBeCloseTo(angleBracketCatalogVolume(record) ?? NaN, 9);
      expect([ANGLE_BRACKET_CATALOG_FAMILY.nominalMassG?.(row, {}) ?? null, row.simplified]).toEqual([record.massG,
        record.ribbed ? ['立つ脚の厚さ', 'リブ'] : ['立つ脚の厚さ']]);
      // リブつきの形はリブを省くので、質量は必ず資料の値を持つ。
      if (record.ribbed) expect(record.massG, record.key).not.toBeNull();
    }
    for (const record of FOOT_BASE_RECORDS) {
      const row = rowOf(FOOT_BASE_FAMILY, record.key);
      expect(FOOT_BASE_FAMILY.nominalVolume(row, {})).toBeCloseTo((footBaseProfile(record)?.areaMm2 ?? NaN) * record.thickness, 9);
      expect(FOOT_BASE_FAMILY.nominalMassG?.(row, {}) ?? null).toBe(record.massG);
    }
    for (const record of ADJUSTER_RECORDS) {
      const row = rowOf(ADJUSTER_FAMILY, record.key);
      expect(ADJUSTER_FAMILY.nominalVolume(row, {})).toBeCloseTo(adjusterVolume(record) ?? NaN, 9);
      expect([ADJUSTER_FAMILY.nominalMassG?.(row, {}), row.simplified]).toEqual([record.massG, ['ねじの山']]);
    }
  });

  it('資料の質量が形の体積 × 密度と 10% を超えて合わない、または読みで確かでない行は質量を持たない(持つ行は 10% 以内)', () => {
    const density: Readonly<Record<string, number>> = { steel: 7.85, stainless: 7.93, aluminum: 2.68 };
    const checks: readonly (readonly [number | null, number, string])[] = [
      ...SHAPED_PLATE_RECORDS.map((record): readonly [number | null, number, string] => [record.massG,
        (shapedPlateProfile(record)?.areaMm2 ?? NaN) * record.thickness * (density[record.material] ?? NaN) / 1000, record.key]),
      ...ANGLE_BRACKET_RECORDS.filter((record) => !record.ribbed).map((record): readonly [number | null, number, string] => [record.massG,
        (angleBracketCatalogVolume(record) ?? NaN) * (density[record.material] ?? NaN) / 1000, record.key]),
      ...FOOT_BASE_RECORDS.map((record): readonly [number | null, number, string] => [record.massG,
        (footBaseProfile(record)?.areaMm2 ?? NaN) * record.thickness * (density[record.material] ?? NaN) / 1000, record.key]),
    ];
    for (const [mass, computed, key] of checks) {
      if (mass !== null) expect(withinMagnitude(mass - computed, 0.1 * computed), key).toBe(true);
    }
    expect(checks.filter(([mass]) => mass === null).length).toBe(9);
  });
});
