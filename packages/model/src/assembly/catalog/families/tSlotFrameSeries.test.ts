/**
 * 製造元の寸法に合わせたフレームの系列(仮の id t-slot-frame-series)の検査: 行の値が読み取りの表(この検査の中の独立の写し)と同じ事、
 * 行の名乗り(規格の欄・note・出どころの欄)、簡略形状の面積(式と輪)、簡略形状の質量と単位質量の差(差がある事の記録。合わせ込まない)、
 * 質量が単位質量 × 長さで出る事(族の関数・部品表・切断の一覧・アセンブリの質量)、読み取りの T ナットの寸法が溝の寸法に入る事。
 */
import { describe, expect, it } from 'vitest';

import { findDensityMaterial } from '../../../appearance/densityMaterials.js';
import { massFromVolume } from '../../../measure/massProperties.js';
import { buildBom } from '../../bom.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../../createAssemblyDocument.js';
import { assemblyMassProperties } from '../../massProperties.js';
import { IDENTITY_PLACEMENT } from '../../placementMath.js';
import { partKeyOf } from '../../resolveAssembly.js';
import { buildSteelStockList } from '../../standard/steelStockList.js';
import type { AssemblyComponent } from '../../types.js';
import { PRODUCT_CATALOG_REGISTRY } from '../registry.js';
import { createCatalogItemSource } from '../source.js';
import type { CatalogItemRow } from '../types.js';
import { T_SLOT_FRAME_FAMILY } from './tSlotFrame.js';
import { T_SLOT_FRAME_SERIES_FAMILY } from './tSlotFrameSeries.js';

/** 読み取りの表の写し: [呼び, W, H, 溝の口, 中の幅, 肩, 中の深さ, 中心の穴, 角 R, 列の間隔, 四隅の穴の径, 四隅の穴の位置, 単位質量 kg/m]。 */
const READINGS: readonly (readonly [string, number, number, number, number, number, number, number, number, number, number, number,
  number])[] = [
  ['溝幅 6 20×20', 20, 20, 6, 12, 2, 4, 4.2, 1, 20, 0, 0, 0.49],
  ['溝幅 6 20×40', 20, 40, 6, 12, 2, 4, 4.2, 1, 20, 0, 0, 0.87],
  ['溝幅 8 30×30', 30, 30, 8, 16.5, 2, 7, 6.8, 2, 30, 4.2, 3.4, 0.9],
  ['溝幅 8 30×60', 30, 60, 8, 16.5, 2, 7, 6.8, 2, 30, 4.2, 3.4, 1.6],
  ['溝幅 10 40×40', 40, 40, 10, 20, 5.5, 7, 10.5, 3, 40, 0, 0, 1.74],
  ['溝幅 10 40×80', 40, 80, 10, 20, 5.5, 7, 10.5, 3, 40, 0, 0, 3.01],
];

/** 読み取りの T ナットの寸法(溝幅ごとの [首の幅, つばの幅])。溝の口と中の幅に入るかを照らす。 */
const READ_SLOT_NUTS: Readonly<Record<string, readonly [number, number]>> = { 6: [5.8, 10], 8: [7.8, 15], 10: [9.8, 17] };

const ROWS = T_SLOT_FRAME_SERIES_FAMILY.rows;
const values = (length: number): Readonly<Record<string, string>> => ({ length: String(length) });

/** 簡略形状の面積の式: W·H − (4 − π)R² − (2 + 2k)·[w·s + (wi − d)·d] − k·π h²/4 − 4·π dc²/4(k は長い辺の溝の数)。 */
function formulaArea(reading: (typeof READINGS)[number]): number {
  const [, w, h, opening, inner, shoulder, depth, hole, r, pitch, cornerHole] = reading;
  const k = (h - w) / pitch + 1;
  return w * h - (4 - Math.PI) * r ** 2 - (2 + 2 * k) * (opening * shoulder + (inner - depth) * depth) - k * Math.PI * hole ** 2 / 4
    - 4 * Math.PI * cornerHole ** 2 / 4;
}

function placed(id: string, row: CatalogItemRow, length: number): AssemblyComponent {
  return { id, name: id, source: createCatalogItemSource(T_SLOT_FRAME_SERIES_FAMILY, row, values(length)),
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false };
}

describe('製造元の寸法に合わせたフレームの系列', () => {
  it('6 行の寸法と単位質量は読み取りの表と同じで、行は規格の行を名乗らず、出どころの欄は値の種類だけ', () => {
    expect(ROWS.map((row) => [row.size, row.dims.width, row.dims.height, row.dims.slotOpening, row.dims.slotInnerWidth, row.dims.shoulder,
      row.dims.slotDepth, row.dims.centerHole, row.dims.cornerRadius, row.dims.slotPitch, row.dims.cornerHoleDiameter,
      row.dims.cornerHoleInset, row.dims.unitMassKgPerM])).toEqual(READINGS.map((reading) => [...reading]));
    for (const row of ROWS) {
      expect([row.standardLabel, row.note, row.materialLabel, row.densityMaterialId, row.verification])
        .toEqual(['製造元の寸法に合わせた物', '内側の形は簡略。質量は単位質量の値（解析の自重は簡略の形の値）', 'アルミ', 'aluminum',
          'manufacturer-catalog']);
      expect(row.evidence).toEqual({ title: '販売店の公開の頁の数値(製造元の寸法に合わせた物)', edition: null, url: '', locator: '',
        sha256: '', fetchedDate: '' });
      expect(row.key).toMatch(/^s(6|8|10)-[0-9]+x[0-9]+$/u);
    }
    expect([T_SLOT_FRAME_SERIES_FAMILY.id, T_SLOT_FRAME_SERIES_FAMILY.group, T_SLOT_FRAME_SERIES_FAMILY.stock,
      T_SLOT_FRAME_SERIES_FAMILY.diagram, T_SLOT_FRAME_SERIES_FAMILY.catalogRevision, T_SLOT_FRAME_SERIES_FAMILY.options.map((spec) => spec.key)])
      .toEqual(['t-slot-frame-series', 'aluminumFrame', 'linear', 'tSlotSeries', 't-slot-frame-series-2026-11-r1', ['length']]);
  });

  it('簡略形状の面積は式と合い、面積 × 2.68 の質量は単位質量と違う(差を記録するだけで合わせ込まない)', () => {
    const aluminum = findDensityMaterial('aluminum')?.density ?? NaN;
    for (const [index, row] of ROWS.entries()) {
      const reading = READINGS[index];
      if (reading === undefined) throw new Error(`reading ${index} is missing`);
      const volume = T_SLOT_FRAME_SERIES_FAMILY.nominalVolume(row, values(1000));
      expect(volume).toBeCloseTo(formulaArea(reading) * 1000, 6);
      const simplifiedKgPerM = massFromVolume(volume ?? NaN, aluminum) / 1000;
      const ratio = simplifiedKgPerM / reading[12];
      // 簡略形状は中空・切り欠き・仕切りを作らないので、実物より重い(差がある事の記録)。
      expect(ratio).toBeGreaterThan(1.05);
      const part = T_SLOT_FRAME_SERIES_FAMILY.build(row, values(1000));
      const holes = (reading[2] - reading[1]) / reading[9] + 1 + (reading[10] > 0 ? 4 : 0);
      expect(part?.solids).toHaveLength(1 + 2 * holes);
      expect(part?.name).toBe(`アルミフレーム ${row.size}×1000`);
    }
  });

  it('質量は単位質量 × 長さ: 族の関数、部品表(単位質量を持たない汎用の族は体積 × 密度のまま)、切断の一覧、アセンブリの質量', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure([T_SLOT_FRAME_SERIES_FAMILY.id, T_SLOT_FRAME_FAMILY.id]);
    const [small, , , , , large] = ROWS;
    const generic = T_SLOT_FRAME_FAMILY.rows[0];
    if (small === undefined || large === undefined || generic === undefined) throw new Error('rows are missing');
    expect(T_SLOT_FRAME_SERIES_FAMILY.nominalMassG?.(small, values(500))).toBeCloseTo(0.49 * 500, 9);
    const genericSource = createCatalogItemSource(T_SLOT_FRAME_FAMILY, generic, { length: '500' });
    const components: AssemblyComponent[] = [placed('a', small, 500), placed('b', small, 500), placed('c', large, 1200),
      { ...placed('d', small, 500), source: genericSource }];
    const assembly = { ...createAssemblyDocument('フレームの質量'), components };
    const partKeys = new Map(components.map((component) => [component.id, partKeyOf(component.source)]));
    // 形の台本どおりの体積(カーネルを使わない)。汎用の族の部品は体積 × 密度で質量を出す。
    // 汎用の族の欄の値は、保存の形が持つ全ての欄(初めの値で埋めた物)を渡す。
    const genericVolume = T_SLOT_FRAME_FAMILY.nominalVolume(generic, genericSource.options) ?? NaN;
    expect(genericVolume).toBeGreaterThan(0);
    const volumes: Readonly<Record<string, number>> = { a: T_SLOT_FRAME_SERIES_FAMILY.nominalVolume(small, values(500)) ?? NaN,
      c: T_SLOT_FRAME_SERIES_FAMILY.nominalVolume(large, values(1200)) ?? NaN, d: genericVolume };
    const bodies = new Map(components.map((component) => [partKeyOf(component.source),
      [{ volume: volumes[component.id === 'b' ? 'a' : component.id] ?? NaN, centroid: [0, 0, 250] as const }]]));
    const rows = buildBom(assembly, { partKeys, bodies });
    // 部品表の材質は部品の材質(ここでは付けていないので既定の鋼)。単位質量を持つ行は材質によらず単位質量 × 長さ。
    expect(rows.map((row) => [row.quantity, row.massEach])).toEqual([[2, 0.49 * 500], [1, 3.01 * 1200],
      [1, massFromVolume(genericVolume, findDensityMaterial('steel')?.density ?? NaN)]]);
    // 切断の一覧の質量は行の材質(アルミ)の密度。単位質量を持つ行は単位質量 × 長さ。
    const genericStockMass = massFromVolume(genericVolume, findDensityMaterial('aluminum')?.density ?? NaN);
    const stock = buildSteelStockList(assembly);
    expect(stock.catalogRows.map((row) => [row.size, row.quantity, row.unitMassKgPerM, row.massEachG, row.massTotalG])).toEqual([
      ['溝幅 6 20×20', 2, 0.49, 0.49 * 500, 0.49 * 500 * 2], ['溝幅 10 40×80', 1, 3.01, 3.01 * 1200, 3.01 * 1200],
      ['寸法指定', 1, null, genericStockMass, genericStockMass]]);
    const placements = new Map(components.map((component) => [component.id, IDENTITY_PLACEMENT]));
    const masses = assemblyMassProperties({ ...assembly, components: components.slice(0, 1) },
      { partKeys, bodies }, placements);
    expect(masses.mass).toBeCloseTo(0.49 * 500, 9);
    expect(masses.centroid?.[2]).toBeCloseTo(250, 9);
  });

  it('断面の外形は原点が中心の W × H(線に沿って並べる時に使う)', () => {
    expect(ROWS.map((row) => T_SLOT_FRAME_SERIES_FAMILY.sectionBounds?.(row, values(1000))))
      .toEqual(READINGS.map(([, w, h]) => ({ minX: -w / 2, minY: -h / 2, maxX: w / 2, maxY: h / 2 })));
  });

  it('読み取りの T ナットの首の幅とつばの幅は、同じ溝幅の行の溝の口と中の幅に入る(首の幅 < 口 < つばの幅 < 中の幅)', () => {
    for (const row of ROWS) {
      const nut = READ_SLOT_NUTS[String(row.dims.slotOpening)];
      if (nut === undefined) throw new Error(`no nut for ${row.size}`);
      const [neck, flange] = nut;
      expect(neck).toBeLessThan(row.dims.slotOpening ?? NaN);
      expect(row.dims.slotOpening).toBeLessThan(flange);
      expect(flange).toBeLessThan(row.dims.slotInnerWidth ?? NaN);
    }
  });
});
