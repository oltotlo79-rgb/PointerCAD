// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-07 平座金(JIS B 1256-2008 並形・小形 部品等級 A)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の plainWasher)の
 * 突合せ、寸法の整合と形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogFamily } from '../types.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { PLAIN_WASHER_NORMAL_FAMILY, PLAIN_WASHER_SMALL_FAMILY } from './plainWasher.js';

const PLAIN_WASHER_ORACLE = CATALOG_ORACLES.plainWasher;
const PLAIN_WASHER_EVIDENCE = PLAIN_WASHER_NORMAL_FAMILY.rows[0]?.evidence;

type OracleRow = readonly [string, number, number, number];
const toRow = (size: string, d1: string, d2: string, h: string): OracleRow => [size, Number(d1), Number(d2), Number(h)];

const FAMILIES: readonly (readonly [string, CatalogFamily, readonly OracleRow[]])[] = [
  ['並形', PLAIN_WASHER_NORMAL_FAMILY, PLAIN_WASHER_ORACLE.normal.map(([size, , d1, d2, h]) => toRow(size, d1, d2, h))],
  ['小形', PLAIN_WASHER_SMALL_FAMILY, PLAIN_WASHER_ORACLE.small.map(([size, d1, d2, h]) => toRow(size, d1, d2, h))],
];

describe('M-07 平座金 資料の表との突合せ', () => {
  it('並形 29 行・小形 21 行は、資料の行と呼び径の順も寸法も一致する', () => {
    expect([PLAIN_WASHER_ORACLE.normal.length, PLAIN_WASHER_ORACLE.small.length]).toEqual([29, 21]);
    for (const [, family, oracle] of FAMILIES) {
      expect(family.rows.map((row) => [row.size, row.dims.innerDiameter, row.dims.outerDiameter, row.dims.thickness]))
        .toEqual(oracle);
    }
  });

  it('資料の第 2 選択の呼び径は行の note に書き、内径 < 外径', () => {
    const second = new Set<string>(PLAIN_WASHER_ORACLE.normal.filter(([, choice]) => choice === '2').map(([size]) => size));
    expect(second.size).toBe(10);
    for (const [, family] of FAMILIES) {
      for (const row of family.rows) {
        expect(row.note).toBe(second.has(row.size) ? '資料の第 2 選択の呼び径' : '');
        expect(row.dims.innerDiameter).toBeLessThan(row.dims.outerDiameter);
        expect(row.key).toBe(row.size);
      }
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、形は輪で体積は π/4 (d2² − d1²) h', () => {
    expect(FAMILIES.every(([, family]) => family.rows.every((row) => row.evidence === PLAIN_WASHER_EVIDENCE))).toBe(true);
    expect(PLAIN_WASHER_EVIDENCE?.reference).toBe(PLAIN_WASHER_ORACLE.reference);
    expect(PLAIN_WASHER_EVIDENCE?.locator).toContain(`PDF ${PLAIN_WASHER_ORACLE.page} 頁`);
    expect(PLAIN_WASHER_EVIDENCE?.title.startsWith('資料 K5-2 ')).toBe(true);
    expect(PLAIN_WASHER_EVIDENCE).not.toHaveProperty('url');
    expect(FAMILIES.map(([, family]) => [family.id, family.kindKey, family.catalogRevision, family.generatorRevision])).toEqual([
      ['plain-washer-normal', 'catalog.mechanical.kind.plainWasherNormal', 'plain-washer-2026-11-r1', 'washer-1'],
      ['plain-washer-small', 'catalog.mechanical.kind.plainWasherSmall', 'plain-washer-2026-11-r1', 'washer-1'],
    ]);
    for (const [form, family] of FAMILIES) {
      for (const row of family.rows) {
        const part = family.build(row, {});
        expect(part?.name).toBe(`平座金 ${form} ${row.size}`);
        expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
        const { innerDiameter: d1, outerDiameter: d2, thickness: h } = row.dims;
        expect(family.nominalVolume(row, {})).toBeCloseTo(Math.PI / 4 * (d2 ** 2 - d1 ** 2) * h, 6);
      }
    }
  });
});
