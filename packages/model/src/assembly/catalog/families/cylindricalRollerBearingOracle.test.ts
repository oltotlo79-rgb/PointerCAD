/**
 * M-27 単列円筒ころ軸受の表と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の cylindricalRollerBearing)の突合せ、
 * 製造元の補助の記号の付いた行が同じ基本番号の記号の無い行と同じ寸法である事の確かめ、寸法の整合と形の体積の検査。
 * fixture は PDF の文字の流れから、製品の表(頁の画像から読んだ 1 回目)を見ずに作った。
 */
import { describe, expect, it } from 'vitest';

import { CYLINDRICAL_ROLLER_BEARING_FAMILIES } from './cylindricalRollerBearing.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';

const CYLINDRICAL_ROLLER_BEARING_ORACLE = CATALOG_ORACLES.cylindricalRollerBearing;
const FAMILIES = Object.entries(CYLINDRICAL_ROLLER_BEARING_FAMILIES);
const ROWS = FAMILIES.flatMap(([, family]) => family.rows.map((row) => ({ family, row })));
const CYLINDRICAL_ROLLER_BEARING_EVIDENCE = ROWS[0]?.row.evidence;
const basicOf = (designation: string): string => designation.replace(/^[A-Z]+/u, '');
const dimsText = (values: readonly (number | string | undefined)[]): string => values.map(String).join('|');

describe('M-27 単列円筒ころ軸受 資料の表との突合せ', () => {
  it('資料の 508 行(形式ごとの呼び番号)は呼び番号ごとに寸法が 1 つで、製品の 409 行と呼び番号の集まりも寸法も一致する', () => {
    expect(CYLINDRICAL_ROLLER_BEARING_ORACLE.rows).toHaveLength(508);
    const byDesignation = new Map<string, Set<string>>();
    for (const [designation, , ...values] of CYLINDRICAL_ROLLER_BEARING_ORACLE.rows) {
      byDesignation.set(designation, new Set([...(byDesignation.get(designation) ?? []), dimsText(values)]));
    }
    expect([...byDesignation.values()].every((set) => set.size === 1)).toBe(true);
    const oracle = [...byDesignation].map(([designation, set]) => `${designation}|${[...set][0]}`).sort();
    const product = ROWS.map(({ row }) => `${row.size}|${dimsText([row.dims.boreDiameter, row.dims.outsideDiameter,
      row.dims.width, row.dims.minimumChamfer, row.dims.minimumChamferR1])}`).sort();
    expect(product).toHaveLength(409);
    expect(product).toEqual(oracle);
  });

  it('補助の記号の付いた行は、同じ基本番号の記号の無い行と主要寸法が同じ(基本番号ごとに寸法が 1 つで、記号の無い行が必ずある)', () => {
    const byBasic = new Map<string, { readonly dims: Set<string>; readonly plain: boolean }>();
    for (const [designation, symbol, ...values] of CYLINDRICAL_ROLLER_BEARING_ORACLE.rows) {
      const basic = basicOf(designation);
      const previous = byBasic.get(basic);
      byBasic.set(basic, { dims: new Set([...(previous?.dims ?? []), dimsText(values)]),
        plain: (previous?.plain ?? false) || symbol === '0' });
    }
    expect(byBasic.size).toBe(129);
    for (const [basic, entry] of byBasic) {
      expect([basic, entry.dims.size, entry.plain]).toEqual([basic, 1, true]);
    }
    const symbols = new Map<string, Set<string>>();
    for (const [designation, symbol] of CYLINDRICAL_ROLLER_BEARING_ORACLE.rows) {
      symbols.set(designation, new Set([...(symbols.get(designation) ?? []), symbol]));
    }
    expect([...symbols.values()].filter((set) => set.size === 2)).toHaveLength(99);
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、形式ごとの族の行は資料にある組だけで、寸法は 内径 < 外径・r1 ≦ r', () => {
    expect(ROWS.every(({ row }) => row.evidence === CYLINDRICAL_ROLLER_BEARING_EVIDENCE)).toBe(true);
    expect(CYLINDRICAL_ROLLER_BEARING_EVIDENCE?.sha256).toBe(CYLINDRICAL_ROLLER_BEARING_ORACLE.pdfSha256);
    const [first, last] = CYLINDRICAL_ROLLER_BEARING_ORACLE.pages;
    expect(CYLINDRICAL_ROLLER_BEARING_EVIDENCE?.locator).toContain(`PDF ${first}〜${last} 頁`);
    expect(CYLINDRICAL_ROLLER_BEARING_EVIDENCE?.title.startsWith('資料 K4-1 ')).toBe(true);
    expect(CYLINDRICAL_ROLLER_BEARING_EVIDENCE?.url).toBe('');
    expect(FAMILIES.map(([type, family]) => [type, family.id, family.kindKey, family.rows.length])).toEqual([
      ['NU', 'cylindrical-roller-bearing-nu', 'catalog.mechanical.kind.cylindricalRollerBearingNU', 129],
      ['NJ', 'cylindrical-roller-bearing-nj', 'catalog.mechanical.kind.cylindricalRollerBearingNJ', 83],
      ['NUP', 'cylindrical-roller-bearing-nup', 'catalog.mechanical.kind.cylindricalRollerBearingNUP', 99],
      ['N', 'cylindrical-roller-bearing-n', 'catalog.mechanical.kind.cylindricalRollerBearingN', 49],
      ['NF', 'cylindrical-roller-bearing-nf', 'catalog.mechanical.kind.cylindricalRollerBearingNF', 49],
    ]);
    for (const [type, family] of FAMILIES) {
      expect(new Set(family.rows.map((row) => row.key)).size).toBe(family.rows.length);
      for (const row of family.rows) {
        expect(row.key).toBe(row.size);
        expect(row.size).toMatch(new RegExp(`^${type}[0-9]{3,4}$`, 'u'));
        expect(row.dims.boreDiameter).toBeLessThan(row.dims.outsideDiameter);
        expect(row.dims.minimumChamferR1).toBeLessThanOrEqual(row.dims.minimumChamfer);
        expect(family.partName(row, {})).toBe(`円筒ころ軸受 ${row.size}`);
      }
    }
  });

  it('族の版を凍結し、形は 3 つの輪で、体積は深溝玉軸受と同じ割合の 3 つの輪の和', () => {
    for (const { family, row } of ROWS) {
      expect([family.catalogRevision, family.generatorRevision]).toEqual(['cylindrical-roller-bearing-2026-11-r1', 'radial-bearing-1']);
      const part = family.build(row, {});
      expect(part?.name).toBe(family.partName(row, {}));
      expect(part?.solids.map((feature) => feature.kind)).toEqual(Array.from({ length: 3 },
        () => ['primitive', 'primitive', 'boolean']).flat());
      const { boreDiameter: d, outsideDiameter: D, width: B } = row.dims;
      const inner = d / 2;
      const outer = D / 2;
      const radial = outer - inner;
      const ring = (a: number, b: number): number => Math.PI * (b ** 2 - a ** 2) * B;
      const expected = ring(inner, inner + 0.22 * radial) + ring(inner + 0.38 * radial, outer - 0.38 * radial)
        + ring(outer - 0.22 * radial, outer);
      expect(family.nominalVolume(row, {})).toBeCloseTo(expected, 6);
    }
  });
});
