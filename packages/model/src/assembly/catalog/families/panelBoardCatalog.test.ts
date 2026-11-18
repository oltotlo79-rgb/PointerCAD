/**
 * 板の族(パネルボード・ベースプレート)の検査: 形(箱)と体積、注文の寸法の上限(向きを入れ替えてよい)、質量の出し方(面積あたりの質量・比重・
 * どちらも無い行は null)、行の名乗り、部品の名前。汎用の寸法の行で、族の作り方(createPanelBoardFamilies)を確かめる。
 */
import { describe, expect, it } from 'vitest';

import { buildPanelBoardPart, fitsPanelMax, panelBoardProfile } from '../profiles/panelBoard.js';
import type { CatalogItemRow } from '../types.js';
import { createPanelBoardFamilies, type PanelBoardRecord } from './panelBoardCatalog.js';

const BASE: PanelBoardRecord = { key: 'g-3', size: '樹脂の板 3 mm', page: 1, materialLabel: '樹脂', thickness: 3, massKgPerM2: 3.6,
  specificGravity: null, fixedSize: null, maxSize: [1000, 2000], simplified: [] };
const RECORDS: readonly PanelBoardRecord[] = [
  BASE,
  { ...BASE, key: 'g-5-sg', size: '樹脂の板 5 mm', thickness: 5, massKgPerM2: null, specificGravity: 1.2 },
  { ...BASE, key: 'm-2', size: '金属の板 2 mm', materialLabel: 'アルミ', densityMaterialId: 'aluminum', thickness: 2, massKgPerM2: null,
    specificGravity: null, fixedSize: [900, 1800], maxSize: null, simplified: ['網目'] },
];
const FAMILIES = createPanelBoardFamilies(RECORDS);

function rowOf(rows: readonly CatalogItemRow[], key: string): CatalogItemRow {
  const row = rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`row ${key} is missing`);
  return row;
}

describe('板の族の形', () => {
  it('板は幅 × 高さの長方形を板厚だけ押し出した箱で、寸法が正でない時は作らない', () => {
    expect(panelBoardProfile({ width: 600, height: 400, thickness: 3 })?.areaMm2).toBe(240000);
    expect(buildPanelBoardPart({ width: 600, height: 400, thickness: 3 })).not.toBeNull();
    for (const bad of [{ width: 0, height: 400, thickness: 3 }, { width: 600, height: -1, thickness: 3 }, { width: 600, height: 400, thickness: NaN }]) {
      expect([panelBoardProfile(bad), buildPanelBoardPart(bad)], JSON.stringify(bad)).toEqual([null, null]);
    }
  });

  it('注文の寸法は上限に収まる時だけ(向きを入れ替えて収まってもよい。上限の無い行は常に収まる)', () => {
    expect([fitsPanelMax(1000, 2000, [1000, 2000]), fitsPanelMax(2000, 1000, [1000, 2000]), fitsPanelMax(1001, 2000, [1000, 2000]),
      fitsPanelMax(1500, 1500, [1000, 2000]), fitsPanelMax(5000, 5000, null)]).toEqual([true, true, false, false, true]);
  });
});

describe('板の族(定尺と注文の寸法)', () => {
  it('定尺の行は欄の無い族、注文の寸法の行は幅と高さの欄の族に分かれ、行は規格の行を名乗らない', () => {
    expect([FAMILIES.fixed.rows.map((row) => row.key), FAMILIES.order.rows.map((row) => row.key)]).toEqual([['m-2'], ['g-3', 'g-5-sg']]);
    expect([FAMILIES.fixed.options.map((spec) => spec.key), FAMILIES.order.options.map((spec) => spec.key)]).toEqual([[], ['width', 'height']]);
    expect([FAMILIES.fixed.stock, FAMILIES.order.stock, FAMILIES.fixed.catalogRevision, FAMILIES.order.catalogRevision])
      .toEqual(['count', 'count', 'panel-board-fixed-2026-11-r1', 'panel-board-order-2026-11-r1']);
    for (const row of [...FAMILIES.fixed.rows, ...FAMILIES.order.rows]) {
      expect([row.standardLabel, row.verification, row.verified], row.key).toEqual(['製造元の寸法に合わせた物', 'manufacturer-catalog', true]);
    }
    expect(rowOf(FAMILIES.fixed.rows, 'm-2').note).toBe('形は簡略(網目)。質量は形の体積 × 材質の密度');
  });

  it('注文の寸法の板は、欄の幅 × 高さの箱で、上限を越える寸法・読めない寸法は作らない。部品の名前に入れた寸法', () => {
    const row = rowOf(FAMILIES.order.rows, 'g-3');
    const ok = { width: '600', height: '400' };
    expect(FAMILIES.order.build(row, ok)?.name).toBe('樹脂の板 3 mm 600×400');
    expect(FAMILIES.order.partName(row, ok)).toBe('樹脂の板 3 mm 600×400');
    expect(FAMILIES.order.nominalVolume(row, ok)).toBeCloseTo(600 * 400 * 3, 9);
    for (const bad of [{ width: '1200', height: '2100' }, { width: 'x', height: '400' }, { width: '0', height: '400' }]) {
      expect([FAMILIES.order.build(row, bad), FAMILIES.order.nominalVolume(row, bad), FAMILIES.order.nominalMassG?.(row, bad)], JSON.stringify(bad))
        .toEqual([null, null, null]);
    }
  });

  it('質量は、面積あたりの質量の行は面積 × その値、比重の行は体積 × 比重、どちらも無い行は null(部品表が形 × 密度)', () => {
    const values = { width: '600', height: '400' };
    expect(FAMILIES.order.nominalMassG?.(rowOf(FAMILIES.order.rows, 'g-3'), values)).toBeCloseTo(0.24 * 3.6 * 1000, 9);
    expect(FAMILIES.order.nominalMassG?.(rowOf(FAMILIES.order.rows, 'g-5-sg'), values)).toBeCloseTo(600 * 400 * 5 / 1000 * 1.2, 9);
    const fixed = rowOf(FAMILIES.fixed.rows, 'm-2');
    expect([FAMILIES.fixed.nominalMassG?.(fixed, {}), fixed.densityMaterialId, FAMILIES.fixed.build(fixed, {})?.name]).toEqual([null, 'aluminum', '金属の板 2 mm']);
    expect(FAMILIES.fixed.nominalVolume(fixed, {})).toBeCloseTo(900 * 1800 * 2, 9);
  });
});
