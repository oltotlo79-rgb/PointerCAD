/**
 * M-31 O リング(JIS B 2401 P 系列・G 系列)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の oRing)の突合せ、
 * 寸法の整合と形の体積の検査。fixture は語の位置と太さの欄の区切りの線から、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogFamily } from '../types.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { O_RING_FAMILIES } from './oRing.js';

const ORACLE = CATALOG_ORACLES.oRing;
const SERIES: readonly (readonly ['P' | 'G', CatalogFamily, number])[] = [['P', O_RING_FAMILIES.P, 122], ['G', O_RING_FAMILIES.G, 46]];

describe('M-31 O リング 資料の表との突合せ', () => {
  it('P 122 行・G 46 行は、資料の行と呼び番号の順も内径・太さも一致する', () => {
    for (const [series, family, count] of SERIES) {
      expect(ORACLE[series]).toHaveLength(count);
      expect(family.rows.map((row) => [row.key, row.size, row.dims.innerDiameter, row.dims.crossSection]))
        .toEqual(ORACLE[series].map(([name, inner, section]) => [name, name, Number(inner), Number(section)]));
    }
  });

  it('呼び番号は系列の文字で始まり重ならず、内径は呼び番号の数より小さく、太さは系列ごとに決まった値だけ', () => {
    const sections = { P: [1.9, 2.4, 3.5, 5.7, 8.4], G: [3.1, 5.7] };
    for (const [series, family] of SERIES) {
      const keys = family.rows.map((row) => row.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const row of family.rows) {
        expect(row.key.startsWith(series)).toBe(true);
        expect(row.dims.innerDiameter).toBeLessThan(Number.parseFloat(row.key.slice(1)));
        expect(sections[series]).toContain(row.dims.crossSection);
      }
      const ordered = family.rows.map((row) => row.dims.crossSection ?? NaN);
      expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、形はトーラスで体積は 2π² R r²', () => {
    const evidence = O_RING_FAMILIES.P.rows[0]?.evidence;
    expect(SERIES.every(([, family]) => family.rows.every((row) => row.evidence === evidence))).toBe(true);
    expect(evidence?.sha256).toBe(ORACLE.pdfSha256);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.pages[0]}〜${ORACLE.pages[1]} 頁`);
    expect(evidence?.title.startsWith('資料 K5-9 ')).toBe(true);
    expect(evidence?.url).toBe('');
    expect(SERIES.map(([, family]) => [family.id, family.kindKey, family.catalogRevision, family.generatorRevision, family.options]))
      .toEqual([['o-ring-p', 'catalog.mechanical.kind.oRingP', 'o-ring-2026-11-r1', 'o-ring-1', []],
        ['o-ring-g', 'catalog.mechanical.kind.oRingG', 'o-ring-2026-11-r1', 'o-ring-1', []]]);
    for (const [, family] of SERIES) {
      for (const row of family.rows) {
        const part = family.build(row, {});
        expect(part?.name).toBe(`O リング ${row.size}`);
        expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive']);
        const { innerDiameter: d1, crossSection: d2 } = row.dims;
        const expected = 2 * Math.PI ** 2 * (((d1 ?? NaN) + (d2 ?? NaN)) / 2) * ((d2 ?? NaN) / 2) ** 2;
        expect(family.nominalVolume(row, {})).toBeCloseTo(expected, 6);
      }
    }
  });
});
