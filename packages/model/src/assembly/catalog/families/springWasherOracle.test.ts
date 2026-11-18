// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-08 ばね座金(JIS B 1251-2018 2 号・3 号、メートルねじ用)の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の springWasher)の
 * 突合せ、寸法の整合と形の体積の検査。fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogFamily } from '../types.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import { SPRING_WASHER_NUMBER2_FAMILY, SPRING_WASHER_NUMBER3_FAMILY } from './springWasher.js';

const SPRING_WASHER_ORACLE = CATALOG_ORACLES.springWasher;
const SPRING_WASHER_EVIDENCE = SPRING_WASHER_NUMBER2_FAMILY.rows[0]?.evidence;

type OracleRow = readonly [string, number, number, number, number];
const toRow = (size: string, values: readonly string[]): OracleRow => {
  const [d, D, b, t] = values.map(Number);
  return [size, d ?? NaN, D ?? NaN, b ?? NaN, t ?? NaN];
};

const FAMILIES: readonly (readonly [string, CatalogFamily, readonly OracleRow[]])[] = [
  ['2 号', SPRING_WASHER_NUMBER2_FAMILY, SPRING_WASHER_ORACLE.number2.map(([size, , ...values]) => toRow(size, values))],
  ['3 号', SPRING_WASHER_NUMBER3_FAMILY, SPRING_WASHER_ORACLE.number3.map(([size, ...values]) => toRow(size, values))],
];

describe('M-08 ばね座金 資料の表との突合せ', () => {
  it('2 号 23 行(呼び 2〜39)・3 号 12 行(呼び 6〜27)は、資料の行と呼びの順も寸法も一致する', () => {
    expect([SPRING_WASHER_ORACLE.number2.length, SPRING_WASHER_ORACLE.number3.length]).toEqual([23, 12]);
    for (const [, family, oracle] of FAMILIES) {
      expect(family.rows.map((row) => [row.size, row.dims.innerDiameter, row.dims.outerDiameter, row.dims.width,
        row.dims.thickness])).toEqual(oracle);
    }
  });

  it('資料で括弧付きの呼びは行の note に書き、内径 < 外径、3 号は同じ呼びの 2 号より外径・幅・厚さが小さくない', () => {
    const avoided = new Set<string>(SPRING_WASHER_ORACLE.number2.filter(([, mark]) => mark === '1').map(([size]) => size));
    expect(avoided.size).toBe(9);
    for (const [, family] of FAMILIES) {
      for (const row of family.rows) {
        expect(row.note).toBe(avoided.has(row.size) ? '資料で括弧付きの呼び(なるべく用いない)' : '');
        expect(row.dims.innerDiameter).toBeLessThan(row.dims.outerDiameter);
      }
    }
    for (const row of SPRING_WASHER_NUMBER3_FAMILY.rows) {
      const light = SPRING_WASHER_NUMBER2_FAMILY.rows.find((candidate) => candidate.size === row.size);
      expect(light?.dims.innerDiameter).toBe(row.dims.innerDiameter);
      expect(row.dims.outerDiameter).toBeGreaterThanOrEqual(light?.dims.outerDiameter ?? Infinity);
      expect(row.dims.width).toBeGreaterThanOrEqual(light?.dims.width ?? Infinity);
      expect(row.dims.thickness).toBeGreaterThan(light?.dims.thickness ?? Infinity);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、族の版を凍結し、形は輪で体積は π/4 (D² − d²) t', () => {
    expect(FAMILIES.every(([, family]) => family.rows.every((row) => row.evidence === SPRING_WASHER_EVIDENCE))).toBe(true);
    expect(SPRING_WASHER_EVIDENCE?.reference).toBe(SPRING_WASHER_ORACLE.reference);
    expect(SPRING_WASHER_EVIDENCE?.locator).toContain(`PDF ${SPRING_WASHER_ORACLE.page} 頁`);
    expect(SPRING_WASHER_EVIDENCE?.title.startsWith('資料 K5-3 ')).toBe(true);
    expect(SPRING_WASHER_EVIDENCE).not.toHaveProperty('url');
    expect(FAMILIES.map(([, family]) => [family.id, family.kindKey, family.catalogRevision, family.generatorRevision])).toEqual([
      ['spring-washer-number2', 'catalog.mechanical.kind.springWasherNumber2', 'spring-washer-2026-11-r1', 'washer-1'],
      ['spring-washer-number3', 'catalog.mechanical.kind.springWasherNumber3', 'spring-washer-2026-11-r1', 'washer-1'],
    ]);
    for (const [duty, family] of FAMILIES) {
      for (const row of family.rows) {
        const part = family.build(row, {});
        expect(part?.name).toBe(`ばね座金 ${duty} ${row.size}`);
        expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
        const { innerDiameter: d, outerDiameter: D, thickness: t } = row.dims;
        expect(family.nominalVolume(row, {})).toBeCloseTo(Math.PI / 4 * (D ** 2 - d ** 2) * t, 6);
      }
    }
  });
});
