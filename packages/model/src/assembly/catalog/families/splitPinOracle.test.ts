/**
 * M-12 割りピン(JIS B 1351-1987)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の splitPin)の突合せ、
 * 長さの決まりと形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { SPLIT_PIN_FAMILY } from './splitPin.js';

const ORACLE = CATALOG_ORACLES.splitPin;
const ROWS = SPLIT_PIN_FAMILY.rows;

describe('M-12 割りピン 資料の表との突合せ', () => {
  it('資料の 24 行のうち、JIS に規定が無い呼び径(※)を除く 16 行と製品の 16 行は、呼び径も寸法も一致する', () => {
    expect(ORACLE.rows).toHaveLength(24);
    const kept = ORACLE.rows.filter(([, mark]) => mark !== '※');
    expect(ROWS.map((row) => [row.size, row.dims.diameter, row.dims.headDiameter, row.dims.headLength, row.dims.tipOffset]))
      .toEqual(kept.map(([size, , ...values]) => [size, ...values.map(Number)]));
    for (const row of ROWS) {
      expect(row.dims.diameter).toBeLessThan(Number(row.size));
      expect(row.dims.headDiameter).toBeGreaterThan(row.dims.diameter);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、体積は 頭の円柱 + 脚の円柱、長さは a を超える', () => {
    const evidence = ROWS[0]?.evidence;
    expect(ROWS.every((row) => row.evidence === evidence)).toBe(true);
    expect(evidence?.sha256).toBe(ORACLE.pdfSha256);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.title.startsWith('資料 K5-7 ')).toBe(true);
    expect(evidence?.url).toBe('');
    expect([SPLIT_PIN_FAMILY.id, SPLIT_PIN_FAMILY.catalogRevision, SPLIT_PIN_FAMILY.generatorRevision])
      .toEqual(['split-pin', 'split-pin-2026-11-r1', 'split-pin-1']);
    for (const row of ROWS) {
      const { diameter: d, headDiameter: c, headLength: b, tipOffset: a } = row.dims;
      const part = SPLIT_PIN_FAMILY.build(row, { length: '25' });
      expect(part?.name).toBe(`割りピン ${row.size}×25`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
      expect(SPLIT_PIN_FAMILY.nominalVolume(row, { length: '25' })).toBeCloseTo(Math.PI * (c / 2) ** 2 * b + Math.PI * (d / 2) ** 2 * 25, 6);
      expect(SPLIT_PIN_FAMILY.build(row, { length: String(a) })).toBeNull();
    }
  });
});
