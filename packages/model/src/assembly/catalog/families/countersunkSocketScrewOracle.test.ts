// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-34 六角穴付き皿ボルト(JIS B 1194-2006)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の
 * countersunkSocketScrew)の突合せ、皿の角度・ねじの表との照合、長さの決まりと形の体積の検査。
 * fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { findMetricThread, metricThreadPitch } from '../../../thread/metricThread.js';
import { COUNTERSUNK_SOCKET_SCREW_FAMILY } from './countersunkSocketScrew.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';

const ORACLE = CATALOG_ORACLES.countersunkSocketScrew;
const ROWS = COUNTERSUNK_SOCKET_SCREW_FAMILY.rows;

describe('M-34 六角穴付き皿ボルト 資料の表との突合せ', () => {
  it('資料の 10 行(M3〜M20)と製品の 10 行は、呼びも寸法も一致する', () => {
    expect(ORACLE.rows).toHaveLength(10);
    expect(ROWS.map((row) => [row.size, row.dims.pitch, row.dims.threadLength, row.dims.headDiameter, row.dims.headHeight,
      row.dims.socketWidth, row.dims.socketDepth])).toEqual(ORACLE.rows.map(([size, ...values]) => [size, ...values.map(Number)]));
  });

  it('dk(理論)と k は皿の角度 90° の関係(k = (dk − d) / 2)で、ピッチはねじの表の並目と同じ、六角穴は頭の中に収まる', () => {
    for (const row of ROWS) {
      const { nominalDiameter: d, headDiameter: dk, headHeight: k, socketWidth: s, socketDepth: t } = row.dims;
      expect(k).toBeCloseTo((dk - d) / 2, 9);
      const thread = findMetricThread(row.size);
      expect(thread === undefined ? null : metricThreadPitch(thread, 'coarse')).toBe(row.dims.pitch);
      expect(s / Math.sqrt(3)).toBeLessThan(dk / 2 - (dk / 2 - d / 2) * t / k);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版と長さの指定を凍結し、体積は 円すい台 + 軸 − 六角穴(ℓ は頭を含む)', () => {
    const evidence = ROWS[0]?.evidence;
    expect(ROWS.every((row) => row.evidence === evidence)).toBe(true);
    expect(evidence?.reference).toBe(ORACLE.reference);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.title.startsWith('資料 K5-4 ')).toBe(true);
    expect(evidence).not.toHaveProperty('url');
    expect([COUNTERSUNK_SOCKET_SCREW_FAMILY.id, COUNTERSUNK_SOCKET_SCREW_FAMILY.catalogRevision,
      COUNTERSUNK_SOCKET_SCREW_FAMILY.generatorRevision])
      .toEqual(['countersunk-socket-screw', 'countersunk-socket-screw-2026-11-r1', 'countersunk-socket-screw-1']);
    for (const row of ROWS) {
      const part = COUNTERSUNK_SOCKET_SCREW_FAMILY.build(row, { length: '40' });
      expect(part?.name).toBe(`六角穴付き皿ボルト ${row.size}×40`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'threadShaft', 'boolean', 'extrude',
        'boolean']);
      const { nominalDiameter: d, headDiameter: dk, headHeight: k, socketWidth: s, socketDepth: t } = row.dims;
      const big = dk / 2;
      const small = d / 2;
      const expected = Math.PI * k / 3 * (big ** 2 + big * small + small ** 2) + Math.PI * small ** 2 * (40 - k)
        - Math.sqrt(3) / 2 * s ** 2 * t;
      expect(COUNTERSUNK_SOCKET_SCREW_FAMILY.nominalVolume(row, { length: '40' })).toBeCloseTo(expected, 6);
      expect(COUNTERSUNK_SOCKET_SCREW_FAMILY.build(row, { length: String(k) })).toBeNull();
      expect(COUNTERSUNK_SOCKET_SCREW_FAMILY.nominalVolume(row, { length: String(k) })).toBeNull();
    }
  });
});
