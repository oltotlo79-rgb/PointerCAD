/**
 * M-03 十字穴付き小ねじ(JIS B 1111-2017 本体規格のなべ・皿・チーズ)の表と、資料の 2 回目の独立の読み
 * (catalogOracles.fixture.ts の crossRecessedScrew)の突合せ、ねじの表との照合、長さの決まりと形の体積の検査。
 * fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { findMetricThread, metricThreadPitch } from '../../../thread/metricThread.js';
import type { CatalogFamily } from '../types.js';
import {
  CROSS_RECESSED_CHEESE_HEAD_SCREW_FAMILY, CROSS_RECESSED_COUNTERSUNK_SCREW_FAMILY, CROSS_RECESSED_PAN_HEAD_SCREW_FAMILY,
} from './crossRecessedScrew.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';

const CROSS_RECESSED_SCREW_ORACLE = CATALOG_ORACLES.crossRecessedScrew;
const CROSS_RECESSED_SCREW_EVIDENCE = CROSS_RECESSED_PAN_HEAD_SCREW_FAMILY.rows[0]?.evidence;

type OracleRow = readonly [string, number, number, number, number];
const toRows = (rows: readonly (readonly string[])[]): readonly OracleRow[] => rows.map(([size = '', ...values]) => {
  const [pitch, b, dk, k] = values.map(Number);
  return [size, pitch ?? NaN, b ?? NaN, dk ?? NaN, k ?? NaN];
});

/** [頭の形, 族, 資料の行, 族に入れない呼び]。チーズは資料の注のとおり十字穴付きに M1.6・M2・M10 が無い。 */
const FAMILIES: readonly (readonly ['pan' | 'countersunk' | 'cheese', CatalogFamily, readonly OracleRow[], readonly string[]])[] = [
  ['pan', CROSS_RECESSED_PAN_HEAD_SCREW_FAMILY, toRows(CROSS_RECESSED_SCREW_ORACLE.pan), ['M1.6']],
  ['countersunk', CROSS_RECESSED_COUNTERSUNK_SCREW_FAMILY, toRows(CROSS_RECESSED_SCREW_ORACLE.countersunk), ['M1.6']],
  ['cheese', CROSS_RECESSED_CHEESE_HEAD_SCREW_FAMILY, toRows(CROSS_RECESSED_SCREW_ORACLE.cheese), ['M1.6', 'M2', 'M10']],
];

describe('M-03 十字穴付き小ねじ 資料の表との突合せ', () => {
  it('資料の 10 行(M1.6〜M10)のうち、ねじの表に無い M1.6(チーズは M2・M10 も)を除く行と製品の行は、呼びも寸法も一致する', () => {
    expect(findMetricThread('M1.6')).toBeUndefined();
    for (const [, family, oracle, excluded] of FAMILIES) {
      expect(oracle).toHaveLength(10);
      expect(family.rows.map((row) => [row.size, row.dims.pitch, row.dims.threadLengthMin, row.dims.headDiameter,
        row.dims.headHeight])).toEqual(oracle.filter(([size]) => !excluded.includes(size)));
    }
  });

  it('丸皿は資料の表で dk・k が皿と同じ(丸み f を入れない簡略形状では皿と同じ形なので族にしない)', () => {
    const raised = toRows(CROSS_RECESSED_SCREW_ORACLE.raisedCountersunk);
    const countersunk = toRows(CROSS_RECESSED_SCREW_ORACLE.countersunk);
    expect(raised.map(([size, , , dk, k]) => [size, dk, k])).toEqual(countersunk.map(([size, , , dk, k]) => [size, dk, k]));
  });

  it('ピッチはねじの表の並目と同じで、呼び径は呼びの数、頭の径は呼び径より大きい', () => {
    for (const [, family] of FAMILIES) {
      for (const row of family.rows) {
        const thread = findMetricThread(row.size);
        expect(thread === undefined ? null : metricThreadPitch(thread, 'coarse')).toBe(row.dims.pitch);
        expect(row.dims.nominalDiameter).toBe(Number(row.size.slice(1)));
        expect(row.dims.headDiameter).toBeGreaterThan(row.dims.nominalDiameter);
        expect(row.note).toBe(row.size === 'M3.5' ? '資料の表で括弧付きの呼び' : '');
      }
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版と長さの指定を凍結する', () => {
    expect(FAMILIES.every(([, family]) => family.rows.every((row) => row.evidence === CROSS_RECESSED_SCREW_EVIDENCE))).toBe(true);
    expect(CROSS_RECESSED_SCREW_EVIDENCE?.sha256).toBe(CROSS_RECESSED_SCREW_ORACLE.pdfSha256);
    expect(CROSS_RECESSED_SCREW_EVIDENCE?.locator).toContain(`PDF ${CROSS_RECESSED_SCREW_ORACLE.pages.pan} 頁`);
    expect(CROSS_RECESSED_SCREW_EVIDENCE?.locator).toContain(`PDF ${CROSS_RECESSED_SCREW_ORACLE.pages.countersunk} 頁`);
    expect(CROSS_RECESSED_SCREW_EVIDENCE?.title.startsWith('資料 K5-1 ')).toBe(true);
    expect(CROSS_RECESSED_SCREW_EVIDENCE?.url).toBe('');
    expect(FAMILIES.map(([, family]) => [family.id, family.kindKey, family.catalogRevision, family.generatorRevision])).toEqual([
      ['cross-recessed-pan-head-screw', 'catalog.mechanical.kind.panHeadScrew', 'cross-recessed-screw-2026-11-r1', 'screw-1'],
      ['cross-recessed-countersunk-screw', 'catalog.mechanical.kind.countersunkScrew', 'cross-recessed-screw-2026-11-r1', 'screw-1'],
      ['cross-recessed-cheese-head-screw', 'catalog.mechanical.kind.cheeseHeadScrew', 'cross-recessed-screw-2026-11-r1', 'screw-1'],
    ]);
    for (const [, family] of FAMILIES) {
      expect(family.options).toEqual([{ key: 'length', kind: 'lengthExpression', labelKey: 'catalog.mechanical.length',
        defaultValue: '10' }]);
    }
  });

  it('なべ・チーズは頭の円柱 + 軸、皿は頭の円すい台 + 軸(呼び長さは頭を含み、k 以下は作らない)で、体積は台本どおり', () => {
    const names = { pan: '十字穴付きなべ小ねじ', cheese: '十字穴付きチーズ小ねじ', countersunk: '十字穴付き皿小ねじ' } as const;
    for (const [head, family] of FAMILIES) {
      for (const row of family.rows) {
        const { nominalDiameter: d, headDiameter: dk, headHeight: k } = row.dims;
        const part = family.build(row, { length: '10*2' });
        expect(part?.name).toBe(`${names[head]} ${row.size}×10*2（本体規格）`);
        expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'threadShaft', 'boolean']);
        const big = dk / 2;
        const small = d / 2;
        const expected = head !== 'countersunk' ? Math.PI * big ** 2 * k + Math.PI * small ** 2 * 20
          : Math.PI * k / 3 * (big ** 2 + big * small + small ** 2) + Math.PI * small ** 2 * (20 - k);
        expect(family.nominalVolume(row, { length: '20' })).toBeCloseTo(expected, 6);
        expect(family.build(row, { length: String(k) }) === null).toBe(head === 'countersunk');
        expect(family.nominalVolume(row, { length: String(k) }) === null).toBe(head === 'countersunk');
        expect(family.build(row, { length: '0' })).toBeNull();
      }
    }
  });
});
