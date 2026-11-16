/**
 * M-22 深溝玉軸受 60・62・63 系(内径 10〜100、57 行)の表と、寸法表の PDF の 2 回目の独立の読み
 * (deepGrooveBallBearingOracle.fixture.ts、PDF の文字の流れから道具で作った)の突合せと、寸法の整合・保存の形・組み立ての検査。
 * 今の 15 行(DEEP_GROOVE_BALL_BEARINGS)の保存は legacySourceFreeze.test.ts が固定している。
 */
import { describe, expect, it } from 'vitest';

import {
  ADDED_DEEP_GROOVE_BALL_BEARINGS, ALL_DEEP_GROOVE_BALL_BEARINGS, bearingBoreFromDesignation, DEEP_GROOVE_BALL_BEARING_EVIDENCE,
  DEEP_GROOVE_BALL_BEARINGS, findDeepGrooveBallBearing,
} from './bearings.js';
import { buildStandardPart, createStandardPartSource, standardPartNominalVolume } from './buildStandardPart.js';
import { DEEP_GROOVE_BALL_BEARING_ORACLE } from './deepGrooveBallBearingOracle.fixture.js';

describe('M-22 深溝玉軸受 寸法表との突合せ', () => {
  it('寸法表の 57 行が、探す口の 57 行と d・D・B・r(最小)で全て一致する', () => {
    expect(DEEP_GROOVE_BALL_BEARING_ORACLE.rows).toHaveLength(57);
    expect(ALL_DEEP_GROOVE_BALL_BEARINGS).toHaveLength(57);
    for (const [size, d, D, B, r] of DEEP_GROOVE_BALL_BEARING_ORACLE.rows) {
      const row = findDeepGrooveBallBearing(size);
      expect(row, size).toBeDefined();
      expect([row?.boreDiameter, row?.outsideDiameter, row?.width, row?.minimumChamfer], size)
        .toEqual([Number(d), Number(D), Number(B), Number(r)]);
    }
    expect(ALL_DEEP_GROOVE_BALL_BEARINGS.map((row) => row.size))
      .toEqual(DEEP_GROOVE_BALL_BEARING_ORACLE.rows.map((row) => row[0]));
  });

  it('今の 15 行は残り、足した 42 行と重ならず、合わせた一覧は系列ごとに内径の順', () => {
    expect(DEEP_GROOVE_BALL_BEARINGS).toHaveLength(15);
    expect(ADDED_DEEP_GROOVE_BALL_BEARINGS).toHaveLength(42);
    const sizes = new Set<string>(DEEP_GROOVE_BALL_BEARINGS.map((row) => row.size));
    expect(ADDED_DEEP_GROOVE_BALL_BEARINGS.some((row) => sizes.has(row.size))).toBe(false);
    for (const row of DEEP_GROOVE_BALL_BEARINGS) expect(ALL_DEEP_GROOVE_BALL_BEARINGS).toContain(row);
    const keys = ALL_DEEP_GROOVE_BALL_BEARINGS.map((row) => row.key);
    expect(new Set(keys).size).toBe(57);
    for (const series of ['6000', '6200', '6300'] as const) {
      const bores = ALL_DEEP_GROOVE_BALL_BEARINGS.filter((row) => row.series === series).map((row) => row.boreDiameter);
      expect(bores).toEqual([10, 12, 15, 17, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100]);
    }
  });

  it('呼び番号(JIS B 1513)から読める系列と内径が、行の系列と内径に一致し、外径 > 内径', () => {
    for (const row of ALL_DEEP_GROOVE_BALL_BEARINGS) {
      expect(row.key).toBe(`JIS-B-1521:2012:${row.size}`);
      expect(row.series).toBe(`${row.size.slice(0, 2)}00`);
      expect(bearingBoreFromDesignation(row.size)).toBe(row.boreDiameter);
      expect(row.outsideDiameter).toBeGreaterThan(row.boreDiameter);
      expect(row.verified && row.note === '').toBe(true);
    }
  });

  it('出どころは寸法表の PDF の SHA-256 と頁を持つ', () => {
    expect(DEEP_GROOVE_BALL_BEARING_EVIDENCE.sha256).toBe(DEEP_GROOVE_BALL_BEARING_ORACLE.pdfSha256);
    expect(DEEP_GROOVE_BALL_BEARING_EVIDENCE.locator).toContain('PDF 5〜8 頁');
    // 出どころの欄は資料の番号・SHA・頁だけ(URL と発行元は製品に書かない)。
    expect(DEEP_GROOVE_BALL_BEARING_EVIDENCE.title.startsWith('資料 K4-1 ')).toBe(true);
    expect(DEEP_GROOVE_BALL_BEARING_EVIDENCE.url).toBe('');
    expect(new Set(DEEP_GROOVE_BALL_BEARING_ORACLE.rows.map((row) => row[5]))).toEqual(new Set([5, 6, 7, 8]));
  });

  it('足した行も今の行と同じ保存の形(従来の版のまま)で、組めて、体積が出る', () => {
    const legacy = createStandardPartSource('deepGrooveBallBearing', '6000', {});
    for (const row of ADDED_DEEP_GROOVE_BALL_BEARINGS) {
      const source = createStandardPartSource('deepGrooveBallBearing', row.size, {});
      expect(source).toEqual({ ...legacy, size: row.size });
      expect(buildStandardPart('deepGrooveBallBearing', row.size)?.name).toBe(`深溝玉軸受 ${row.size}`);
      expect(standardPartNominalVolume('deepGrooveBallBearing', row.size)).toBeGreaterThan(0);
    }
    expect(JSON.stringify(createStandardPartSource('deepGrooveBallBearing', '6205', {}))).toBe(
      JSON.stringify({ ...legacy, size: '6205' }));
  });
});
