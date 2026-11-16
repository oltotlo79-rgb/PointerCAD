/**
 * M-07 平座金 大形(JIS B 1256-2008 部品等級 A)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の largePlainWasher)の
 * 突合せ、並形との大小の照合と形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { PLAIN_WASHER_NORMAL_FAMILY } from './plainWasher.js';
import { PLAIN_WASHER_LARGE_FAMILY } from './plainWasherLarge.js';

const ORACLE = CATALOG_ORACLES.largePlainWasher;
const ROWS = PLAIN_WASHER_LARGE_FAMILY.rows;

describe('M-07 平座金 大形 資料の表との突合せ', () => {
  it('資料の 18 行と製品の 18 行は、呼び径の順も寸法も一致し、第 2 選択の呼び径は行の note に書く', () => {
    expect(ORACLE.rows).toHaveLength(18);
    expect(ROWS.map((row) => [row.size, row.dims.innerDiameter, row.dims.outerDiameter, row.dims.thickness]))
      .toEqual(ORACLE.rows.map(([size, , d1, d2, h]) => [size, Number(d1), Number(d2), Number(h)]));
    for (const row of ROWS) {
      const choice = ORACLE.rows.find(([size]) => size === row.size)?.[1];
      expect(row.note).toBe(choice === '2' ? '資料の第 2 選択の呼び径' : '');
    }
  });

  it('同じ呼び径の並形より外径が大きい(内径は 27 以上を除き同じ)', () => {
    for (const row of ROWS) {
      const normal = PLAIN_WASHER_NORMAL_FAMILY.rows.find((candidate) => candidate.size === row.size);
      expect(row.dims.outerDiameter).toBeGreaterThan(normal?.dims.outerDiameter ?? Infinity);
      if (Number(row.size) < 27) expect(row.dims.innerDiameter).toBe(normal?.dims.innerDiameter);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、形は輪で体積は π/4 (d2² − d1²) h', () => {
    const evidence = ROWS[0]?.evidence;
    expect(ROWS.every((row) => row.evidence === evidence)).toBe(true);
    expect(evidence?.sha256).toBe(ORACLE.pdfSha256);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.title.startsWith('資料 K5-6 ')).toBe(true);
    expect(evidence?.url).toBe('');
    expect([PLAIN_WASHER_LARGE_FAMILY.id, PLAIN_WASHER_LARGE_FAMILY.catalogRevision, PLAIN_WASHER_LARGE_FAMILY.generatorRevision])
      .toEqual(['plain-washer-large', 'plain-washer-large-2026-11-r1', 'washer-1']);
    for (const row of ROWS) {
      const part = PLAIN_WASHER_LARGE_FAMILY.build(row, {});
      expect(part?.name).toBe(`平座金 大形 ${row.size}`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
      const { innerDiameter: d1, outerDiameter: d2, thickness: h } = row.dims;
      expect(PLAIN_WASHER_LARGE_FAMILY.nominalVolume(row, {})).toBeCloseTo(Math.PI / 4 * (d2 ** 2 - d1 ** 2) * h, 6);
    }
  });
});
