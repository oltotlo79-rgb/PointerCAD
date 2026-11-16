/**
 * M-10 テーパピン(JIS B 1352-1988 本体規格)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の taperPin)の突合せ、
 * 長さの決まりと形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { TAPER_PIN_FAMILY } from './taperPin.js';

const ORACLE = CATALOG_ORACLES.taperPin;
const ROWS = TAPER_PIN_FAMILY.rows;

describe('M-10 テーパピン 資料の表との突合せ', () => {
  it('資料の 20 行と製品の 20 行は、呼び径も a(約)も一致する', () => {
    expect(ORACLE.rows).toHaveLength(20);
    expect(ROWS.map((row) => [row.size, row.dims.diameter, row.dims.endLength]))
      .toEqual(ORACLE.rows.map(([d, a]) => [d, Number(d), Number(a)]));
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、形はテーパ比 1/50 の円すい台、長さは 2a を超える', () => {
    const evidence = ROWS[0]?.evidence;
    expect(ROWS.every((row) => row.evidence === evidence)).toBe(true);
    expect(evidence?.sha256).toBe(ORACLE.pdfSha256);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.locator).toContain('テーパ比 1/50');
    expect(evidence?.title.startsWith('資料 K5-7 ')).toBe(true);
    expect(evidence?.url).toBe('');
    expect([TAPER_PIN_FAMILY.id, TAPER_PIN_FAMILY.catalogRevision, TAPER_PIN_FAMILY.generatorRevision])
      .toEqual(['taper-pin', 'taper-pin-2026-11-r1', 'taper-pin-1']);
    for (const row of ROWS) {
      const { diameter: d, endLength: a } = row.dims;
      const part = TAPER_PIN_FAMILY.build(row, { length: '40' });
      expect(part?.name).toBe(`テーパピン ${row.size}×40`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive']);
      const small = d / 2;
      const large = (d + 40 / 50) / 2;
      expect(TAPER_PIN_FAMILY.nominalVolume(row, { length: '40' })).toBeCloseTo(Math.PI * 40 / 3 * (small ** 2 + small * large + large ** 2), 6);
      expect(TAPER_PIN_FAMILY.build(row, { length: String(2 * a) })).toBeNull();
      expect(TAPER_PIN_FAMILY.build(row, { length: String(2 * a + 0.01) })).not.toBeNull();
    }
  });
});
