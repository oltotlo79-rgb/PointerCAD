// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-35 六角穴付きボタンボルト(JIS B 1174-2017)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の buttonHeadScrew)の
 * 突合せ、ねじの表との照合、形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { findMetricThread, metricThreadPitch } from '../../../thread/metricThread.js';
import { BUTTON_HEAD_SCREW_FAMILY } from './buttonHeadScrew.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';

const ORACLE = CATALOG_ORACLES.buttonHeadScrew;
const ROWS = BUTTON_HEAD_SCREW_FAMILY.rows;

describe('M-35 六角穴付きボタンボルト 資料の表との突合せ', () => {
  it('資料の 8 行(M3〜M16)と製品の 8 行は、呼びも寸法も一致し、ピッチはねじの表の並目と同じ', () => {
    expect(ORACLE.rows).toHaveLength(8);
    expect(ROWS.map((row) => [row.size, row.dims.pitch, row.dims.threadLength, row.dims.headDiameter, row.dims.headHeight,
      row.dims.socketWidth, row.dims.socketDepth])).toEqual(ORACLE.rows.map(([size, ...values]) => [size, ...values.map(Number)]));
    for (const row of ROWS) {
      const thread = findMetricThread(row.size);
      expect(thread === undefined ? null : metricThreadPitch(thread, 'coarse')).toBe(row.dims.pitch);
      expect(row.dims.socketDepth).toBeLessThan(row.dims.headHeight);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、体積は 頭 + 軸 − 六角穴', () => {
    const evidence = ROWS[0]?.evidence;
    expect(ROWS.every((row) => row.evidence === evidence)).toBe(true);
    expect(evidence?.reference).toBe(ORACLE.reference);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.title.startsWith('資料 K5-4 ')).toBe(true);
    expect(evidence).not.toHaveProperty('url');
    expect([BUTTON_HEAD_SCREW_FAMILY.id, BUTTON_HEAD_SCREW_FAMILY.catalogRevision, BUTTON_HEAD_SCREW_FAMILY.generatorRevision])
      .toEqual(['button-head-socket-screw', 'button-head-socket-screw-2026-11-r1', 'socket-head-screw-1']);
    for (const row of ROWS) {
      const part = BUTTON_HEAD_SCREW_FAMILY.build(row, { length: '12' });
      expect(part?.name).toBe(`六角穴付きボタンボルト ${row.size}×12`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'threadShaft', 'boolean', 'extrude',
        'boolean']);
      const { nominalDiameter: d, headDiameter: dk, headHeight: k, socketWidth: s, socketDepth: t } = row.dims;
      const expected = Math.PI * (dk / 2) ** 2 * k + Math.PI * (d / 2) ** 2 * 12 - Math.sqrt(3) / 2 * s ** 2 * t;
      expect(BUTTON_HEAD_SCREW_FAMILY.nominalVolume(row, { length: '12' })).toBeCloseTo(expected, 6);
    }
  });
});
