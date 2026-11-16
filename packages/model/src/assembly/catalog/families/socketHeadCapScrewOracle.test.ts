/**
 * M-02 六角穴付きボルト(JIS B 1176-2014)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の socketHeadCapScrew)の突合せ、
 * 今の規格部品の表(M3〜M20)との照合、ねじの表との照合、形の体積の検査。
 * fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { SOCKET_HEAD_CAP_SCREW_TABLE } from '../../standard/fasteners.js';
import { findMetricThread, metricThreadPitch } from '../../../thread/metricThread.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { SOCKET_HEAD_CAP_SCREW_FAMILY } from './socketHeadCapScrew.js';

const SOCKET_HEAD_CAP_SCREW_ORACLE = CATALOG_ORACLES.socketHeadCapScrew;
const SOCKET_HEAD_CAP_SCREW_ROWS = SOCKET_HEAD_CAP_SCREW_FAMILY.rows;
type Row = (typeof SOCKET_HEAD_CAP_SCREW_ROWS)[number];
const firstEvidence = (rows: readonly Row[]): Row['evidence'] => {
  const evidence = rows[0]?.evidence;
  if (evidence === undefined || rows.some((row) => row.evidence !== evidence)) throw new Error('evidence is not shared by all rows');
  return evidence;
};
const SOCKET_HEAD_CAP_SCREW_EVIDENCE = firstEvidence(SOCKET_HEAD_CAP_SCREW_ROWS);
const fromProduct = (row: Row): readonly (string | number | undefined)[] => [row.size, row.dims.pitch, row.dims.threadLength,
  row.dims.headDiameter, row.dims.headHeight, row.dims.socketWidth, row.dims.socketDepth];

describe('M-02 六角穴付きボルト 資料の表との突合せ', () => {
  it('資料の 27 行のうち、M1.6・製造元の参考(▲)・削除された呼び(●)を除く 19 行と製品の 19 行は、呼びも寸法も一致する', () => {
    expect(SOCKET_HEAD_CAP_SCREW_ORACLE.rows).toHaveLength(27);
    expect(findMetricThread('M1.6')).toBeUndefined();
    const kept = SOCKET_HEAD_CAP_SCREW_ORACLE.rows.filter(([size, mark]) => size !== 'M1.6' && mark !== '▲' && mark !== '●');
    expect(SOCKET_HEAD_CAP_SCREW_ROWS.map(fromProduct)).toEqual(kept.map(([size, , ...values]) => [size, ...values.map(Number)]));
    for (const row of SOCKET_HEAD_CAP_SCREW_ROWS) {
      const mark = kept.find(([size]) => size === row.size)?.[1];
      expect(row.note).toBe(mark === '()' ? '資料で括弧付きの呼び(なるべく用いない)' : '');
    }
  });

  it('今の規格部品の表(要確認でない M3〜M20)と頭・六角穴の寸法が同じで、ピッチはねじの表の並目と同じ', () => {
    const legacy = SOCKET_HEAD_CAP_SCREW_TABLE.filter((row) => row.verified);
    expect(legacy.map((row) => row.size)).toEqual(['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20']);
    for (const old of legacy) {
      const row = SOCKET_HEAD_CAP_SCREW_ROWS.find((candidate) => candidate.size === old.size);
      expect([row?.dims.nominalDiameter, row?.dims.pitch, row?.dims.headDiameter, row?.dims.headHeight, row?.dims.socketWidth,
        row?.dims.socketDepth]).toEqual([old.d, old.pitch, old.headDiameter, old.headHeight, old.socketWidth, old.socketDepth]);
    }
    for (const row of SOCKET_HEAD_CAP_SCREW_ROWS) {
      const thread = findMetricThread(row.size);
      expect(thread === undefined ? null : metricThreadPitch(thread, 'coarse')).toBe(row.dims.pitch);
      expect(row.dims.socketDepth).toBeLessThan(row.dims.headHeight);
      expect(row.dims.socketWidth).toBeLessThan(row.dims.headDiameter);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、体積は 頭 + 軸 − 六角穴', () => {
    expect(SOCKET_HEAD_CAP_SCREW_EVIDENCE.sha256).toBe(SOCKET_HEAD_CAP_SCREW_ORACLE.pdfSha256);
    expect(SOCKET_HEAD_CAP_SCREW_EVIDENCE.locator).toContain('PDF 1〜2 頁');
    expect(SOCKET_HEAD_CAP_SCREW_EVIDENCE.title.startsWith('資料 K5-4 ')).toBe(true);
    expect(SOCKET_HEAD_CAP_SCREW_EVIDENCE.url).toBe('');
    expect([SOCKET_HEAD_CAP_SCREW_FAMILY.id, SOCKET_HEAD_CAP_SCREW_FAMILY.catalogRevision, SOCKET_HEAD_CAP_SCREW_FAMILY.generatorRevision])
      .toEqual(['socket-head-cap-screw', 'socket-head-cap-screw-2026-11-r1', 'socket-head-screw-1']);
    for (const row of SOCKET_HEAD_CAP_SCREW_ROWS) {
      const part = SOCKET_HEAD_CAP_SCREW_FAMILY.build(row, { length: '30' });
      expect(part?.name).toBe(`六角穴付きボルト ${row.size}×30`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'threadShaft', 'boolean', 'extrude',
        'boolean']);
      const { nominalDiameter: d, headDiameter: dk, headHeight: k, socketWidth: s, socketDepth: t } = row.dims;
      const expected = Math.PI * (dk / 2) ** 2 * k + Math.PI * (d / 2) ** 2 * 30 - Math.sqrt(3) / 2 * s ** 2 * t;
      expect(SOCKET_HEAD_CAP_SCREW_FAMILY.nominalVolume(row, { length: '30' })).toBeCloseTo(expected, 6);
      expect(SOCKET_HEAD_CAP_SCREW_FAMILY.build(row, { length: '0' })).toBeNull();
    }
  });
});
