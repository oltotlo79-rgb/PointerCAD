// 規格資料の出典は規格番号と一般名で照合する。
/**
 * M-05 六角ナットの拡張(JIS B 1181:2014 本体)の 3 つの族と、資料の 2 回目の独立の読み(catalogOracles.fixture.ts の hexNut)の突合せ、
 * 今の六角ナットの表との重なりが無い事、形と体積の検査。
 */
import { describe, expect, it } from 'vitest';

import { HEX_NUT_TABLE } from '../../standard/fasteners.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { CATALOG_ORACLES } from './catalogOracles.fixture.js';
import * as hexNutExtended from './hexNutExtended.js';

const firstEvidence = (rows: readonly CatalogItemRow[]): CatalogItemRow['evidence'] => {
  const evidence = rows[0]?.evidence;
  if (evidence === undefined || rows.some((row) => row.evidence !== evidence)) throw new Error('evidence is not shared by all rows');
  return evidence;
};
const HEX_NUT_ORACLE = CATALOG_ORACLES.hexNut;
const { HEX_NUT_STYLE1_FAMILY, HEX_NUT_STYLE2_FAMILY, HEX_NUT_THIN_FAMILY } = hexNutExtended;
const FAMILIES = Object.values(hexNutExtended)
  .filter((value: unknown): value is CatalogFamily => typeof value === 'object' && value !== null
    && 'id' in value && typeof value.id === 'string' && 'rows' in value && Array.isArray(value.rows))
  .sort((left, right) => left.id.localeCompare(right.id));
const HEX_NUT_STYLE1_ROWS = HEX_NUT_STYLE1_FAMILY.rows;
const HEX_NUT_STYLE2_ROWS = HEX_NUT_STYLE2_FAMILY.rows;
const HEX_NUT_THIN_ROWS = HEX_NUT_THIN_FAMILY.rows;
const ROWS = FAMILIES.flatMap((family) => family.rows);
const HEX_NUT_EXTENDED_EVIDENCE = firstEvidence(ROWS);

const ORACLE = new Map<string, readonly string[]>(HEX_NUT_ORACLE.rows.map((row) => [row[0], row]));
/** fixture の列の位置(make_nut_oracle.py の COLUMNS の順 + 呼びの 1 列)。 */
const COLUMN = { style1Max: 1, style1Min: 2, style2Max: 3, style2Min: 4, thinBasic: 7, thinMin: 8, sBasic: 10 } as const;
const cell = (size: string, column: keyof typeof COLUMN): number => Number(ORACLE.get(size)?.[COLUMN[column]] ?? NaN);

describe('M-05 六角ナットの拡張 資料の表との突合せ', () => {
  it('スタイル1 の族は今の表(本体 M3〜M20)に無い 17 の呼びで、m(最大・最小)と対辺が資料と一致する', () => {
    const current = new Set<string>(HEX_NUT_TABLE.filter((row) => row.dimensionSeries === 'main').map((row) => row.size));
    expect(HEX_NUT_STYLE1_ROWS.map((row) => row.size)).toEqual(['M2', 'M2.5', 'M3.5', 'M22', 'M24', 'M27', 'M30', 'M33', 'M36',
      'M39', 'M42', 'M45', 'M48', 'M52', 'M56', 'M60', 'M64']);
    for (const row of HEX_NUT_STYLE1_ROWS) {
      expect(current.has(row.size)).toBe(false);
      expect([row.dims.heightMax, row.dims.heightMin, row.dims.acrossFlats])
        .toEqual([cell(row.size, 'style1Max'), cell(row.size, 'style1Min'), cell(row.size, 'sBasic')]);
    }
    // 今の表の本体の行は、資料と同じ値(重ねて持たないが、同じ資料と食い違わない事を確かめる)。
    for (const row of HEX_NUT_TABLE.filter((candidate) => candidate.dimensionSeries === 'main')) {
      expect([row.mMax, row.mMin, row.s]).toEqual([cell(row.size, 'style1Max'), cell(row.size, 'style1Min'), cell(row.size, 'sBasic')]);
    }
  });

  it('スタイル2 の族は資料に値のある M5〜M36 の 15 行、六角低ナットの族は M2〜M64 の 28 行で、資料と一致する', () => {
    expect(HEX_NUT_STYLE2_ROWS.map((row) => row.size)).toEqual(HEX_NUT_ORACLE.rows.filter((row) => row[3] !== '−').map((row) => row[0]));
    for (const row of HEX_NUT_STYLE2_ROWS) {
      expect([row.dims.heightMax, row.dims.heightMin, row.dims.acrossFlats])
        .toEqual([cell(row.size, 'style2Max'), cell(row.size, 'style2Min'), cell(row.size, 'sBasic')]);
    }
    // M1.6 はねじの表(M2〜M64)に無いので入れない。
    expect(HEX_NUT_THIN_ROWS.map((row) => row.size)).toEqual(HEX_NUT_ORACLE.rows.slice(1).map((row) => row[0]));
    for (const row of HEX_NUT_THIN_ROWS) {
      expect([row.dims.heightMax, row.dims.heightMin, row.dims.acrossFlats])
        .toEqual([cell(row.size, 'thinBasic'), cell(row.size, 'thinMin'), cell(row.size, 'sBasic')]);
    }
  });

  it('出どころは資料の番号・SHA・頁だけを持ち、行の鍵は種類の記号とねじの呼びで重ならない', () => {
    expect(HEX_NUT_EXTENDED_EVIDENCE.reference).toBe(HEX_NUT_ORACLE.reference);
    expect(HEX_NUT_EXTENDED_EVIDENCE.title.startsWith('資料 K4-5 ')).toBe(true);
    expect(HEX_NUT_EXTENDED_EVIDENCE).not.toHaveProperty('url');
    const keys = ROWS.map((row) => row.key);
    expect(new Set(keys).size).toBe(60);
    for (const key of keys) expect(key).toMatch(/^(S1|S2|T)-M[0-9.]+$/u);
  });

  it('族の版を凍結し、形は今の六角ナットと同じ作りで、体積は (√3/2 S² − π(下穴/2)²) m', () => {
    expect(FAMILIES.map((family) => [family.id, family.catalogRevision, family.generatorRevision, family.options.length]))
      .toEqual([['hex-nut-style1-extended', 'hex-nut-2026-11-r1', 'hex-nut-1', 0], ['hex-nut-style2', 'hex-nut-2026-11-r1', 'hex-nut-1', 0],
        ['hex-nut-thin', 'hex-nut-2026-11-r1', 'hex-nut-1', 0]]);
    for (const family of FAMILIES) {
      for (const row of family.rows) {
        const part = family.build(row, {});
        expect(part?.name).toBe(family.partName(row, {}));
        expect(part?.solids.map((feature) => feature.kind)).toEqual(['extrude', 'threadHole']);
        expect(family.nominalVolume(row, {})).toBeGreaterThan(0);
      }
    }
    expect(HEX_NUT_STYLE2_FAMILY.partName(HEX_NUT_STYLE2_ROWS[2], {})).toBe('六角ナット M8（スタイル2）');
    expect(HEX_NUT_THIN_FAMILY.partName(HEX_NUT_THIN_ROWS[0], {})).toBe('六角低ナット M2');
  });
});
