// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-26 単式スラスト玉軸受(平面座形)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の thrustBallBearing)の突合せ、
 * 寸法の整合と形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { THRUST_BALL_BEARING_FAMILY } from './thrustBallBearing.js';

const THRUST_BALL_BEARING_ORACLE = CATALOG_ORACLES.thrustBallBearing;
const THRUST_BALL_BEARING_ROWS = THRUST_BALL_BEARING_FAMILY.rows;
type Row = (typeof THRUST_BALL_BEARING_ROWS)[number];
const firstEvidence = (rows: readonly Row[]): Row['evidence'] => {
  const evidence = rows[0]?.evidence;
  if (evidence === undefined || rows.some((row) => row.evidence !== evidence)) throw new Error('evidence is not shared by all rows');
  return evidence;
};
const THRUST_BALL_BEARING_EVIDENCE = firstEvidence(THRUST_BALL_BEARING_ROWS);

const fromProduct = (row: Row): string => [row.size, row.dims.boreDiameter, row.dims.outsideDiameter, row.dims.height,
  row.dims.minimumChamfer, row.dims.shaftWasherOutsideDiameter, row.dims.housingWasherBoreDiameter].map(String).join('|');

describe('M-26 単式スラスト玉軸受 資料の表との突合せ', () => {
  it('資料の 40 行(511・512 系、内径 10〜100)と製品の 40 行は、呼び番号の集まりも寸法も一致する', () => {
    const oracle = THRUST_BALL_BEARING_ORACLE.rows.map((row) => row.join('|'));
    expect(oracle).toHaveLength(40);
    expect(THRUST_BALL_BEARING_ROWS.map(fromProduct).sort()).toEqual([...oracle].sort());
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、行は系列 → 内径の順で、寸法は d < D1・d < d1 ≦ D・D1 < D', () => {
    expect(THRUST_BALL_BEARING_EVIDENCE.reference).toBe(THRUST_BALL_BEARING_ORACLE.reference);
    const [first, last] = THRUST_BALL_BEARING_ORACLE.pages;
    expect(THRUST_BALL_BEARING_EVIDENCE.locator).toContain(`PDF ${first}〜${last} 頁`);
    expect(THRUST_BALL_BEARING_EVIDENCE.title.startsWith('資料 K4-1 ')).toBe(true);
    expect(THRUST_BALL_BEARING_EVIDENCE).not.toHaveProperty('url');
    const order = THRUST_BALL_BEARING_ROWS.map((row) => [row.size.slice(0, 3), row.dims.boreDiameter] as const);
    expect(order).toEqual([...order].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]));
    for (const row of THRUST_BALL_BEARING_ROWS) {
      const { boreDiameter: d, outsideDiameter: D, shaftWasherOutsideDiameter: d1, housingWasherBoreDiameter: D1 } = row.dims;
      expect(row.key).toBe(row.size);
      expect(d).toBeLessThan(D1);
      expect(d).toBeLessThan(d1);
      expect(d1).toBeLessThanOrEqual(D);
      expect(D1).toBeLessThan(D);
      expect(THRUST_BALL_BEARING_FAMILY.partName(row, {})).toBe(`スラスト玉軸受 ${row.size}`);
    }
  });

  it('族の版を凍結し、形は 3 つの輪で、体積は 軸軌道盤 + 玉の帯 + ハウジング軌道盤(全高の 0.3・0.4・0.3)', () => {
    expect([THRUST_BALL_BEARING_FAMILY.id, THRUST_BALL_BEARING_FAMILY.catalogRevision, THRUST_BALL_BEARING_FAMILY.generatorRevision])
      .toEqual(['thrust-ball-bearing-flat-seat', 'thrust-ball-bearing-2026-11-r1', 'thrust-bearing-1']);
    for (const row of THRUST_BALL_BEARING_ROWS) {
      const part = THRUST_BALL_BEARING_FAMILY.build(row, {});
      expect(part?.name).toBe(THRUST_BALL_BEARING_FAMILY.partName(row, {}));
      expect(part?.solids.map((feature) => feature.kind)).toEqual(Array.from({ length: 3 },
        () => ['primitive', 'primitive', 'boolean']).flat());
      const { boreDiameter: d, outsideDiameter: D, height: T, shaftWasherOutsideDiameter: d1, housingWasherBoreDiameter: D1 } = row.dims;
      const radial = (D - d) / 2;
      const band = [d / 2 + 0.38 * radial, D / 2 - 0.38 * radial];
      const expected = Math.PI * (((d1 / 2) ** 2 - (d / 2) ** 2) * 0.3 * T + (band[1] ** 2 - band[0] ** 2) * 0.4 * T
        + ((D / 2) ** 2 - (D1 / 2) ** 2) * 0.3 * T);
      expect(THRUST_BALL_BEARING_FAMILY.nominalVolume(row, {})).toBeCloseTo(expected, 6);
    }
  });
});
