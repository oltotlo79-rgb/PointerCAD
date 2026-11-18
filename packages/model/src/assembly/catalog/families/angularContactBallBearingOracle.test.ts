// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-23 単列アンギュラ玉軸受の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の angularContactBallBearing)の突合せ、
 * 同じ寸法系列の深溝玉軸受との照合、寸法の整合と形の体積の検査。fixture は PDF の文字の流れから、
 * 製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { ALL_DEEP_GROOVE_BALL_BEARINGS } from '../../standard/bearings.js';
import { ANGULAR_CONTACT_BALL_BEARING_FAMILY } from './angularContactBallBearing.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';

const ANGULAR_CONTACT_BALL_BEARING_ORACLE = CATALOG_ORACLES.angularContactBallBearing;
const ANGULAR_CONTACT_BALL_BEARING_ROWS = ANGULAR_CONTACT_BALL_BEARING_FAMILY.rows;
type Row = (typeof ANGULAR_CONTACT_BALL_BEARING_ROWS)[number];
const firstEvidence = (rows: readonly Row[]): Row['evidence'] => {
  const evidence = rows[0]?.evidence;
  if (evidence === undefined || rows.some((row) => row.evidence !== evidence)) throw new Error('evidence is not shared by all rows');
  return evidence;
};
const ANGULAR_CONTACT_BALL_BEARING_EVIDENCE = firstEvidence(ANGULAR_CONTACT_BALL_BEARING_ROWS);

const fromProduct = (row: Row): string => [row.size, row.dims.boreDiameter, row.dims.outsideDiameter, row.dims.width,
  row.dims.minimumChamfer, row.dims.minimumChamferR1].map(String).join('|');
const baseOf = (designation: string): string => designation.replace(/[BC]$/u, '');
const seriesOf = (designation: string): string => designation.slice(0, 2);

describe('M-23 単列アンギュラ玉軸受 資料の表との突合せ', () => {
  it('資料の 183 行(呼び番号ごと)と製品の 183 行は、呼び番号の集まりも寸法も一致する', () => {
    const oracle = ANGULAR_CONTACT_BALL_BEARING_ORACLE.rows.map((row) => row.join('|'));
    expect(oracle).toHaveLength(183);
    expect(new Set(oracle).size).toBe(183);
    expect(ANGULAR_CONTACT_BALL_BEARING_ROWS.map(fromProduct).sort()).toEqual([...oracle].sort());
  });

  it('接触角の記号 無表示・B・C は主要寸法が同じで、呼び接触角は資料の表の注 2) のとおり、記号つきの無い呼び番号は 7300〜7302 だけ', () => {
    expect(ANGULAR_CONTACT_BALL_BEARING_ORACLE.contactAngles).toEqual([['', '30'], ['B', '40'], ['C', '15']]);
    const angleOf = new Map<string, number>(ANGULAR_CONTACT_BALL_BEARING_ORACLE.contactAngles
      .map(([symbol, angle]) => [symbol, Number(angle)] as const));
    const byBase = new Map<string, Row[]>();
    for (const row of ANGULAR_CONTACT_BALL_BEARING_ROWS) byBase.set(baseOf(row.size), [...(byBase.get(baseOf(row.size)) ?? []), row]);
    expect(byBase.size).toBe(63);
    for (const [base, rows] of byBase) {
      expect(new Set(rows.map((row) => fromProduct(row).split('|').slice(1).join('|'))).size).toBe(1);
      expect(rows.map((row) => row.size)).toEqual(['7300', '7301', '7302'].includes(base) ? [base] : [base, `${base}B`, `${base}C`]);
      for (const row of rows) {
        const angle = angleOf.get(row.size.slice(base.length));
        expect(row.dims.contactAngle).toBe(angle);
        expect(row.note).toContain(`呼び接触角 ${String(angle)}°`);
        expect(row.note).toContain(`PDF ${ANGULAR_CONTACT_BALL_BEARING_ORACLE.pages.join('〜')} 頁の表の注 2)`);
      }
    }
  });

  it('同じ寸法系列の深溝玉軸受(60↔70・62↔72・63↔73)がある 57 の呼び番号は、外径・幅・r(最小)が同じ', () => {
    const deepGroove = new Map(ALL_DEEP_GROOVE_BALL_BEARINGS.map((row) => [row.size, row]));
    const matched = ANGULAR_CONTACT_BALL_BEARING_ROWS.filter((row) => row.size === baseOf(row.size))
      .flatMap((row) => {
        const counterpart = deepGroove.get(`6${row.size.slice(1)}`);
        return counterpart === undefined ? [] : [[row, counterpart] as const];
      });
    expect(matched).toHaveLength(57);
    for (const [row, counterpart] of matched) {
      expect([row.dims.boreDiameter, row.dims.outsideDiameter, row.dims.width, row.dims.minimumChamfer])
        .toEqual([counterpart.boreDiameter, counterpart.outsideDiameter, counterpart.width, counterpart.minimumChamfer]);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、行は系列 → 内径 → 記号の順で、寸法は 内径 < 外径・r1 ≦ r', () => {
    expect(ANGULAR_CONTACT_BALL_BEARING_EVIDENCE.reference).toBe(ANGULAR_CONTACT_BALL_BEARING_ORACLE.reference);
    const [first, last] = ANGULAR_CONTACT_BALL_BEARING_ORACLE.pages;
    expect(ANGULAR_CONTACT_BALL_BEARING_EVIDENCE.locator).toContain(`PDF ${first}〜${last} 頁`);
    expect(ANGULAR_CONTACT_BALL_BEARING_EVIDENCE.title.startsWith('資料 K4-1 ')).toBe(true);
    expect(ANGULAR_CONTACT_BALL_BEARING_EVIDENCE).not.toHaveProperty('url');
    const order = ANGULAR_CONTACT_BALL_BEARING_ROWS.map((row) => [seriesOf(row.size), row.dims.boreDiameter, row.size] as const);
    expect(order).toEqual([...order].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2].localeCompare(b[2])));
    for (const row of ANGULAR_CONTACT_BALL_BEARING_ROWS) {
      expect(row.key).toBe(row.size);
      expect(row.dims.boreDiameter).toBeLessThan(row.dims.outsideDiameter);
      expect(row.dims.minimumChamferR1).toBeLessThanOrEqual(row.dims.minimumChamfer);
      expect(ANGULAR_CONTACT_BALL_BEARING_FAMILY.partName(row, {})).toBe(`アンギュラ玉軸受 ${row.size}`);
    }
  });

  it('族の版を凍結し、形は 3 つの輪で、体積は深溝玉軸受と同じ割合の 3 つの輪の和', () => {
    expect([ANGULAR_CONTACT_BALL_BEARING_FAMILY.id, ANGULAR_CONTACT_BALL_BEARING_FAMILY.catalogRevision,
      ANGULAR_CONTACT_BALL_BEARING_FAMILY.generatorRevision])
      .toEqual(['angular-contact-ball-bearing', 'angular-contact-ball-bearing-2026-11-r1', 'radial-bearing-1']);
    for (const row of ANGULAR_CONTACT_BALL_BEARING_ROWS) {
      const part = ANGULAR_CONTACT_BALL_BEARING_FAMILY.build(row, {});
      expect(part?.name).toBe(ANGULAR_CONTACT_BALL_BEARING_FAMILY.partName(row, {}));
      expect(part?.solids.map((feature) => feature.kind)).toEqual(Array.from({ length: 3 },
        () => ['primitive', 'primitive', 'boolean']).flat());
      const { boreDiameter: d, outsideDiameter: D, width: B } = row.dims;
      const inner = d / 2;
      const outer = D / 2;
      const radial = outer - inner;
      const ring = (a: number, b: number): number => Math.PI * (b ** 2 - a ** 2) * B;
      const expected = ring(inner, inner + 0.22 * radial) + ring(inner + 0.38 * radial, outer - 0.38 * radial)
        + ring(outer - 0.22 * radial, outer);
      expect(ANGULAR_CONTACT_BALL_BEARING_FAMILY.nominalVolume(row, {})).toBeCloseTo(expected, 6);
    }
  });
});
