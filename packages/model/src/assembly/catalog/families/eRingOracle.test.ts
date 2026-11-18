// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-14 E 形止め輪(JIS B 2804-2010)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の eRing)の突合せ、
 * 寸法の整合と形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { E_RING_FAMILY } from './eRing.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';

const ORACLE = CATALOG_ORACLES.eRing;
const ROWS = E_RING_FAMILY.rows;

describe('M-14 E 形止め輪 資料の表との突合せ', () => {
  it('資料の 18 行のうち、JIS 規格外(※)の 2.3 を除く 17 行と製品の 17 行は、呼びも寸法も一致する', () => {
    expect(ORACLE.rows).toHaveLength(18);
    const kept = ORACLE.rows.filter(([, mark]) => mark !== '※');
    expect(kept.map(([size]) => size)).not.toContain('2.3');
    expect(ROWS.map((row) => [row.size, row.dims.innerDiameter, row.dims.outerDiameter, row.dims.openingWidth, row.dims.thickness,
      row.dims.width, row.dims.shaftOver, row.dims.shaftUpTo, row.dims.grooveDiameter, row.dims.grooveWidth]))
      .toEqual(kept.map(([size, , ...values]) => [size, ...values.map(Number)]));
  });

  it('寸法は 切口幅 < 内径 < 溝底径 ≦ 適用する軸径の下限 < 外径', () => {
    for (const row of ROWS) {
      const { innerDiameter: d, outerDiameter: D, openingWidth: H, grooveDiameter: d2, shaftOver } = row.dims;
      expect(H).toBeLessThan(d);
      expect(d).toBeLessThan(d2);
      expect(d2).toBeLessThanOrEqual(shaftOver);
      expect(shaftOver).toBeLessThan(D);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、体積は 輪 − 切口の帯', () => {
    const evidence = ROWS[0]?.evidence;
    expect(ROWS.every((row) => row.evidence === evidence)).toBe(true);
    expect(evidence?.reference).toBe(ORACLE.reference);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.title.startsWith('資料 K5-6 ')).toBe(true);
    expect(evidence).not.toHaveProperty('url');
    expect([E_RING_FAMILY.id, E_RING_FAMILY.catalogRevision, E_RING_FAMILY.generatorRevision])
      .toEqual(['e-ring', 'e-ring-2026-11-r1', 'retaining-ring-1']);
    for (const row of ROWS) {
      const part = E_RING_FAMILY.build(row, {});
      expect(part?.name).toBe(`E 形止め輪 ${row.size}`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean', 'primitive', 'boolean']);
      const { innerDiameter: d, outerDiameter: D, openingWidth: H, thickness: t } = row.dims;
      const strip = (radius: number): number => H / 2 * Math.sqrt(radius ** 2 - (H / 2) ** 2) + radius ** 2 * Math.asin(H / 2 / radius);
      const expected = t * (Math.PI * ((D / 2) ** 2 - (d / 2) ** 2) - (strip(D / 2) - strip(d / 2)));
      expect(E_RING_FAMILY.nominalVolume(row, {})).toBeCloseTo(expected, 9);
      expect(expected).toBeGreaterThan(0);
    }
  });
});
