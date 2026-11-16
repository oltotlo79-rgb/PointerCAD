/**
 * M-06 フランジ付き六角ナット(JIS B 1190-2014)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の flangeNut)の突合せ、
 * ねじの表との照合と形の体積の検査。fixture は PDF の文字の流れ(呼びは語の位置)から、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { findMetricThread, metricThreadPitch, threadMinorDiameter } from '../../../thread/metricThread.js';
import { FLANGE_NUT_FAMILY } from './flangeNut.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';

const ORACLE = CATALOG_ORACLES.flangeNut;
const ROWS = FLANGE_NUT_FAMILY.rows;

describe('M-06 フランジ付き六角ナット 資料の表との突合せ', () => {
  it('資料の 8 行(M5〜M20)と製品の 8 行は、呼びも寸法も一致し、括弧付きの呼びは行の note に書く', () => {
    expect(ORACLE.rows).toHaveLength(8);
    expect(ROWS.map((row) => [row.size, row.dims.pitch, row.dims.flangeThickness, row.dims.flangeDiameter, row.dims.heightMax,
      row.dims.acrossFlats])).toEqual(ORACLE.rows.map(([size, , ...values]) => [size, ...values.map(Number)]));
    for (const row of ROWS) {
      const mark = ORACLE.rows.find(([size]) => size === row.size)?.[1];
      expect(row.note).toBe(mark === '()' ? '資料で括弧付きの呼び(なるべく用いない)' : '');
      const thread = findMetricThread(row.size);
      expect(thread === undefined ? null : metricThreadPitch(thread, 'coarse')).toBe(row.dims.pitch);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、体積は 六角柱 + フランジの外の部分 − 下穴', () => {
    const evidence = ROWS[0]?.evidence;
    expect(ROWS.every((row) => row.evidence === evidence)).toBe(true);
    expect(evidence?.sha256).toBe(ORACLE.pdfSha256);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.title.startsWith('資料 K5-8 ')).toBe(true);
    expect(evidence?.url).toBe('');
    expect([FLANGE_NUT_FAMILY.id, FLANGE_NUT_FAMILY.catalogRevision, FLANGE_NUT_FAMILY.generatorRevision])
      .toEqual(['flange-nut', 'flange-nut-2026-11-r1', 'flange-nut-1']);
    for (const row of ROWS) {
      const part = FLANGE_NUT_FAMILY.build(row, {});
      expect(part?.name).toBe(`フランジ付き六角ナット ${row.size}`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['extrude', 'primitive', 'boolean', 'threadHole']);
      const { nominalDiameter: d, pitch: p, acrossFlats: s, heightMax: m, flangeDiameter: dc, flangeThickness: c } = row.dims;
      const hexagon = Math.sqrt(3) / 2 * s ** 2;
      const expected = hexagon * m + (Math.PI * (dc / 2) ** 2 - hexagon) * c - Math.PI * (threadMinorDiameter(d, p) / 2) ** 2 * m;
      expect(FLANGE_NUT_FAMILY.nominalVolume(row, {})).toBeCloseTo(expected, 6);
    }
  });
});
