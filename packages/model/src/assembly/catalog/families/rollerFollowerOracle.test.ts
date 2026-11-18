// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-29 ローラフォロア(ヨーク形、メートル系)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の rollerFollower)の
 * 突合せ、寸法の整合と形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { ROLLER_FOLLOWER_FAMILY } from './rollerFollower.js';

const ORACLE = CATALOG_ORACLES.rollerFollower;
const ROWS = ROLLER_FOLLOWER_FAMILY.rows;
const fromProduct = (row: (typeof ROWS)[number]): string => [row.dims.boreDiameter, row.dims.outsideDiameter,
  row.dims.outerRingWidth, row.dims.innerRingWidth, row.dims.minimumChamfer].map(String).join('|');

describe('M-29 ローラフォロア 資料の表との突合せ', () => {
  it('資料の 28 行(呼び番号ごと)は内径ごとに寸法が同じで、製品の 14 行と順も値も一致する', () => {
    expect(ORACLE.rows).toHaveLength(28);
    const byBore = new Map<string, Set<string>>();
    for (const row of ORACLE.rows) {
      const set = byBore.get(row[0]) ?? new Set<string>();
      set.add(row.join('|'));
      byBore.set(row[0], set);
    }
    for (const variants of byBore.values()) expect(variants.size).toBe(1);
    expect(ROWS.map(fromProduct)).toEqual([...byBore.values()].map((variants) => [...variants][0]));
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、寸法は 内径 < 外径・外輪の幅 < 内輪の幅', () => {
    const evidence = ROWS[0]?.evidence;
    expect(evidence?.reference).toBe(ORACLE.reference);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.title.startsWith('資料 K4-2 ')).toBe(true);
    expect(evidence).not.toHaveProperty('url');
    for (const row of ROWS) {
      expect(row.evidence).toBe(evidence);
      expect(row.dims.boreDiameter).toBeLessThan(row.dims.outsideDiameter);
      expect(row.dims.outerRingWidth).toBeLessThan(row.dims.innerRingWidth);
      expect(row.key).toBe(`d${row.dims.boreDiameter}`);
      expect(ROLLER_FOLLOWER_FAMILY.partName(row, {})).toMatch(/^ローラフォロア 内径[0-9]+×外径[0-9]+$/u);
    }
  });

  it('族の版を凍結し、形は全幅 B の輪で、体積は π/4 (D² − d²) B', () => {
    expect([ROLLER_FOLLOWER_FAMILY.id, ROLLER_FOLLOWER_FAMILY.catalogRevision, ROLLER_FOLLOWER_FAMILY.generatorRevision])
      .toEqual(['roller-follower-yoke-metric', 'roller-follower-2026-11-r1', 'roller-follower-1']);
    for (const row of ROWS) {
      const part = ROLLER_FOLLOWER_FAMILY.build(row, {});
      expect(part?.name).toBe(ROLLER_FOLLOWER_FAMILY.partName(row, {}));
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
      const { boreDiameter: d, outsideDiameter: D, innerRingWidth: B } = row.dims;
      expect(ROLLER_FOLLOWER_FAMILY.nominalVolume(row, {})).toBeCloseTo(Math.PI / 4 * (D ** 2 - d ** 2) * B, 9);
    }
  });
});
