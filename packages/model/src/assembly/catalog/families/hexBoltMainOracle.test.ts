// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-01 六角ボルト(JIS B 1180-2014 本体規格の呼び径六角ボルト)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の
 * hexBoltMain)の突合せ、今の規格部品の本体規格の表との照合、ねじ長さの区分と形の体積の検査。
 * fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { HEX_BOLT_TABLE } from '../../standard/fasteners.js';
import { findMetricThread, metricThreadPitch } from '../../../thread/metricThread.js';
import { HEX_BOLT_MAIN_FAMILY } from './hexBoltMain.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';

const ORACLE = CATALOG_ORACLES.hexBoltMain;
const ROWS = HEX_BOLT_MAIN_FAMILY.rows;
const value = (text: string): number | undefined => (text === '―' ? undefined : Number(text.replace(/[()]/gu, '')));

describe('M-01 六角ボルト 本体規格 資料の表との突合せ', () => {
  it('資料の 29 行のうち、ねじの表に無い M1.6 を除く 28 行と製品の 28 行は、呼びも寸法も一致する(b の「―」は値を持たない)', () => {
    expect(ORACLE.rows).toHaveLength(29);
    expect(findMetricThread('M1.6')).toBeUndefined();
    const kept = ORACLE.rows.filter(([size]) => size !== 'M1.6');
    expect(ROWS.map((row) => [row.size, row.dims.pitch, row.dims.threadLengthShort, row.dims.threadLengthMiddle,
      row.dims.threadLengthLong, row.dims.headHeight, row.dims.acrossFlats]))
      .toEqual(kept.map(([size, , pitch, b1, b2, b3, k, s]) => [size, value(pitch), value(b1), value(b2), value(b3), value(k), value(s)]));
    for (const row of ROWS) {
      const choice = kept.find(([size]) => size === row.size)?.[1];
      expect(row.note).toBe(choice === '2' ? '資料の第 2 選択の呼び' : '');
      const thread = findMetricThread(row.size);
      expect(thread === undefined ? null : metricThreadPitch(thread, 'coarse')).toBe(row.dims.pitch);
    }
  });

  it('今の規格部品の本体規格の六角ボルト(要確認でない行)と、二面幅・頭の高さ・ℓ≦125 のねじ長さが同じ', () => {
    const legacy = HEX_BOLT_TABLE.filter((row) => row.dimensionSeries === 'main' && row.verified);
    expect(legacy.length).toBeGreaterThan(0);
    for (const old of legacy) {
      const row = ROWS.find((candidate) => candidate.size === old.size);
      expect([old.size, row?.dims.acrossFlats, row?.dims.headHeight, row?.dims.threadLengthShort])
        .toEqual([old.size, old.s, old.k, old.b1]);
    }
  });

  it('ねじ長さは呼び長さの区分の b で、b の無い区分の長さは作らない。体積は 六角柱 + 軸', () => {
    const evidence = ROWS[0]?.evidence;
    expect(ROWS.every((row) => row.evidence === evidence)).toBe(true);
    expect(evidence?.reference).toBe(ORACLE.reference);
    expect(evidence?.locator).toContain(`PDF ${ORACLE.page} 頁`);
    expect(evidence?.title.startsWith('資料 K5-5 ')).toBe(true);
    expect(evidence).not.toHaveProperty('url');
    expect([HEX_BOLT_MAIN_FAMILY.id, HEX_BOLT_MAIN_FAMILY.catalogRevision, HEX_BOLT_MAIN_FAMILY.generatorRevision])
      .toEqual(['hex-bolt-main', 'hex-bolt-main-2026-11-r1', 'hex-bolt-main-1']);
    for (const row of ROWS) {
      for (const [length, key] of [[100, 'threadLengthShort'], [150, 'threadLengthMiddle'], [250, 'threadLengthLong']] as const) {
        const b = row.dims[key];
        const part = HEX_BOLT_MAIN_FAMILY.build(row, { length: String(length) });
        expect(part === null).toBe(b === undefined);
        if (part === null) continue;
        expect(part.name).toBe(`六角ボルト ${row.size}×${length}（本体規格）`);
        expect(part.solids.map((feature) => feature.kind)).toEqual(['extrude', 'primitive', 'threadShaft', 'boolean']);
        const thread = part.solids.find((feature) => feature.kind === 'threadShaft');
        expect(thread?.kind === 'threadShaft' ? thread.length.value : NaN).toBe(Math.min(length, b ?? NaN));
        const { nominalDiameter: d, acrossFlats: s, headHeight: k } = row.dims;
        expect(HEX_BOLT_MAIN_FAMILY.nominalVolume(row, { length: String(length) }))
          .toBeCloseTo(Math.sqrt(3) / 2 * s ** 2 * k + Math.PI * (d / 2) ** 2 * length, 6);
      }
    }
  });
});
