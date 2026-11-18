// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-25 ソリッド形針状ころ軸受 内輪なし(RNA48・RNA49 系)の表と、資料の 2 回目の独立の読み
 * (catalogOracles.fixture.ts の needleRollerBearing)の突合せ、寸法の整合と形の体積の検査。
 * fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { NEEDLE_ROLLER_BEARING_FAMILY } from './needleRollerBearing.js';

const NEEDLE_ROLLER_BEARING_ORACLE = CATALOG_ORACLES.needleRollerBearing;
const NEEDLE_ROLLER_BEARING_ROWS = NEEDLE_ROLLER_BEARING_FAMILY.rows;
type Row = (typeof NEEDLE_ROLLER_BEARING_ROWS)[number];
const firstEvidence = (rows: readonly Row[]): Row['evidence'] => {
  const evidence = rows[0]?.evidence;
  if (evidence === undefined || rows.some((row) => row.evidence !== evidence)) throw new Error('evidence is not shared by all rows');
  return evidence;
};
const NEEDLE_ROLLER_BEARING_EVIDENCE = firstEvidence(NEEDLE_ROLLER_BEARING_ROWS);

const fromProduct = (row: Row): string => [row.size, row.dims.rollerInscribedDiameter, row.dims.outsideDiameter, row.dims.width,
  row.dims.minimumChamfer].map(String).join('|');

describe('M-25 ソリッド形針状ころ軸受 内輪なし 資料の表との突合せ', () => {
  it('資料の 34 行(RNA48 系 6・RNA49 系 28)と製品の 34 行は、呼び番号の集まりも寸法も一致する', () => {
    const oracle = NEEDLE_ROLLER_BEARING_ORACLE.rows.map((row) => row.join('|'));
    expect(oracle).toHaveLength(34);
    expect(NEEDLE_ROLLER_BEARING_ROWS.map(fromProduct).sort()).toEqual([...oracle].sort());
    expect(NEEDLE_ROLLER_BEARING_ROWS.filter((row) => row.size.startsWith('RNA48'))).toHaveLength(6);
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、行は系列 → Fw の順で、寸法は Fw < D', () => {
    expect(NEEDLE_ROLLER_BEARING_EVIDENCE.reference).toBe(NEEDLE_ROLLER_BEARING_ORACLE.reference);
    const [first, last] = NEEDLE_ROLLER_BEARING_ORACLE.pages;
    expect(NEEDLE_ROLLER_BEARING_EVIDENCE.locator).toContain(`PDF ${first}〜${last} 頁`);
    expect(NEEDLE_ROLLER_BEARING_EVIDENCE.title.startsWith('資料 K4-1 ')).toBe(true);
    expect(NEEDLE_ROLLER_BEARING_EVIDENCE).not.toHaveProperty('url');
    const order = NEEDLE_ROLLER_BEARING_ROWS.map((row) => [row.size.slice(0, 5), row.dims.rollerInscribedDiameter] as const);
    expect(order).toEqual([...order].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]));
    for (const row of NEEDLE_ROLLER_BEARING_ROWS) {
      expect(row.key).toBe(row.size);
      expect(row.size).toMatch(/^RNA4[89]([0-9]{2}|\/[0-9]{2})$/u);
      expect(row.dims.rollerInscribedDiameter).toBeLessThan(row.dims.outsideDiameter);
      expect(NEEDLE_ROLLER_BEARING_FAMILY.partName(row, {})).toBe(`針状ころ軸受 ${row.size}`);
    }
  });

  it('族の版を凍結し、形は内径 Fw・外径 D・幅 C の輪で、体積は π/4 (D² − Fw²) C', () => {
    expect([NEEDLE_ROLLER_BEARING_FAMILY.id, NEEDLE_ROLLER_BEARING_FAMILY.catalogRevision, NEEDLE_ROLLER_BEARING_FAMILY.generatorRevision])
      .toEqual(['needle-roller-bearing-rna', 'needle-roller-bearing-2026-11-r1', 'needle-roller-bearing-1']);
    for (const row of NEEDLE_ROLLER_BEARING_ROWS) {
      const part = NEEDLE_ROLLER_BEARING_FAMILY.build(row, {});
      expect(part?.name).toBe(NEEDLE_ROLLER_BEARING_FAMILY.partName(row, {}));
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
      const { rollerInscribedDiameter: fw, outsideDiameter: D, width: C } = row.dims;
      expect(NEEDLE_ROLLER_BEARING_FAMILY.nominalVolume(row, {})).toBeCloseTo(Math.PI / 4 * (D ** 2 - fw ** 2) * C, 6);
    }
  });
});
