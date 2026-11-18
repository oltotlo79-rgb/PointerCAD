/**
 * 資料 SF-1 のジョイントバー・スタッド・ローレットナットの 3 族の検査: 族の版と欄、行の名乗りと出どころ、形(包む形・段の並び)と体積、
 * 質量は資料の 1 個の値で包む形 × 密度より軽い事、簡略の印。製品が使う口(族の定数と行の表)だけを通して確かめる。
 */
import { describe, expect, it } from 'vitest';

import { findMetricThread, metricThreadPitch, threadMinorDiameter } from '../../../thread/metricThread.js';
import { buildJointBarPart, jointBarVolume } from '../profiles/frameParts.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { JOINT_BAR_FAMILY, KNURLED_NUT_FAMILY, STUD_FAMILY } from './tSlotFittingCatalog.js';
import { JOINT_BAR_RECORDS, KNURLED_NUT_RECORDS, STUD_RECORDS } from './tSlotFittingRows.js';

const FAMILIES: readonly CatalogFamily[] = [JOINT_BAR_FAMILY, STUD_FAMILY, KNURLED_NUT_FAMILY];
const DENSITY: Readonly<Record<string, number>> = { steel: 7.85, stainless: 7.93, brass: 8.4 };

function minorOf(thread: string): number {
  const size = findMetricThread(thread);
  return size === undefined ? NaN : threadMinorDiameter(size.diameter, metricThreadPitch(size, 'coarse'));
}

function rowOf(family: CatalogFamily, key: string): CatalogItemRow {
  const row = family.rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`row ${key} is missing`);
  return row;
}

describe('資料 SF-1 のジョイントバー・スタッド・ローレットナット', () => {
  it('族は 3 つで、版・欄・線図・数え方を凍結し、行の数は 6・2・1、行は規格の行を名乗らず、密度は行の材料', () => {
    expect(FAMILIES.map((family) => [family.id, family.group, family.kindKey, family.catalogRevision, family.generatorRevision, family.stock,
      family.diagram, family.options.length, family.rows.length])).toEqual([
      ['t-slot-joint-bar', 'aluminumFrame', 'catalog.frame.kind.jointBar', 't-slot-joint-bar-2026-11-r1', 't-slot-fitting-1', 'count', 'jointBar', 0, 6],
      ['t-slot-stud', 'aluminumFrame', 'catalog.frame.kind.tSlotStud', 't-slot-stud-2026-11-r1', 't-slot-fitting-1', 'count', 'tSlotStud', 0, 2],
      ['t-slot-knurled-nut', 'aluminumFrame', 'catalog.frame.kind.knurledNut', 't-slot-knurled-nut-2026-11-r1', 't-slot-fitting-1', 'count',
        'knurledNut', 0, 1],
    ]);
    for (const family of FAMILIES) {
      expect(new Set(family.rows.map((row) => row.size)).size).toBe(family.rows.length);
      for (const row of family.rows) {
        expect([row.standardLabel, row.verification, row.verified, row.evidence.sha256, row.evidence.url], row.key)
          .toEqual(['製造元の寸法に合わせた物', 'manufacturer-catalog', true, '', '']);
        expect(row.size + row.key, row.key).not.toMatch(/[A-Z]{2,}-?[0-9]/u);
        expect(row.simplified?.length ?? 0, row.key).toBeGreaterThan(0);
      }
    }
    const records = [...JOINT_BAR_RECORDS, ...STUD_RECORDS, ...KNURLED_NUT_RECORDS];
    for (const family of FAMILIES) {
      for (const row of family.rows) expect(row.densityMaterialId, row.key).toBe(records.find((record) => record.key === row.key)?.material);
    }
  });

  it('ジョイントバーは頭の幅 × 全厚 × 長さの箱で包み、めねじを並べ、体積は箱 − めねじの数 × 谷の径の円 × 全厚。印は首の段', () => {
    for (const record of JOINT_BAR_RECORDS) {
      const row = rowOf(JOINT_BAR_FAMILY, record.key);
      const part = JOINT_BAR_FAMILY.build(row, {});
      expect(part?.name, record.key).toBe(record.size);
      expect(part?.solids.map((feature) => feature.kind), record.key).toEqual(['primitive', 'threadHole']);
      const volume = record.length * record.width * record.thickness - record.holeOffsets.length * Math.PI * (minorOf(record.thread) / 2) ** 2 * record.thickness;
      expect(JOINT_BAR_FAMILY.nominalVolume(row, {}), record.key).toBeCloseTo(volume, 9);
      expect(record.simplified, record.key).toContain('首の段(記入が無いので作らず包んだ)');
      // めねじは長さの端の面からの位置で、長さの内に、小さい順に並ぶ。
      expect([...record.holeOffsets].sort((a, b) => a - b), record.key).toEqual(record.holeOffsets);
      expect(record.holeOffsets.every((offset) => offset > 0 && offset < record.length), record.key).toBe(true);
    }
  });

  it('スタッドは板とおねじの円柱、ローレットナットは太い段の径の円柱と通しのめねじ。体積は段の式と合う', () => {
    for (const record of STUD_RECORDS) {
      const row = rowOf(STUD_FAMILY, record.key);
      expect(STUD_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      const thread = findMetricThread(record.thread);
      const rod = thread === undefined ? NaN : Math.PI * (thread.diameter / 2) ** 2 * record.threadLength;
      expect(STUD_FAMILY.nominalVolume(row, {}), record.key).toBeCloseTo(record.width * record.depth * record.plateThickness + rod, 9);
      expect(record.simplified, record.key).toContain('中央の張り出し(幅の記入が無いので作っていない)');
    }
    for (const record of KNURLED_NUT_RECORDS) {
      const row = rowOf(KNURLED_NUT_FAMILY, record.key);
      expect(KNURLED_NUT_FAMILY.build(row, {})?.name, record.key).toBe(record.size);
      expect(KNURLED_NUT_FAMILY.nominalVolume(row, {}), record.key)
        .toBeCloseTo((Math.PI * (record.diameter / 2) ** 2 - Math.PI * (minorOf(record.thread) / 2) ** 2) * record.height, 9);
      expect(record.flangeDiameter, record.key).toBeLessThan(record.diameter);
    }
  });

  it('ジョイントバーの形の関数は、めねじが長さの内に収まり、隣と重ならず、谷の径が幅より小さい時だけ形を作る(汎用の寸法で確かめる)', () => {
    const base = { length: 100, width: 10, thickness: 4, thread: 'M5', holeOffsets: [10, 50, 90] };
    expect(buildJointBarPart(base)).not.toBeNull();
    expect(jointBarVolume(base)).toBeCloseTo(100 * 10 * 4 - 3 * Math.PI * (minorOf('M5') / 2) ** 2 * 4, 9);
    for (const bad of [{ ...base, holeOffsets: [1, 50] }, { ...base, holeOffsets: [10, 99] }, { ...base, holeOffsets: [10, 12] },
      { ...base, holeOffsets: [] }, { ...base, thread: 'M12' }, { ...base, thread: 'M0' }, { ...base, thickness: 0 }]) {
      expect([buildJointBarPart(bad), jointBarVolume(bad)], JSON.stringify(bad)).toEqual([null, null]);
    }
  });

  it('質量は資料の 1 個の値で、包む形 × 密度より軽い(作っていない所の分だけ形が重い。質量の決まり)', () => {
    for (const family of FAMILIES) {
      for (const row of family.rows) {
        const mass = family.nominalMassG?.(row, {});
        const shape = (family.nominalVolume(row, {}) ?? NaN) * (DENSITY[row.densityMaterialId ?? ''] ?? NaN) / 1000;
        expect(mass, row.key).toBe(row.dims.massG);
        if (family === JOINT_BAR_FAMILY || family === KNURLED_NUT_FAMILY) expect(mass ?? NaN, row.key).toBeLessThan(shape);
      }
    }
  });
});
