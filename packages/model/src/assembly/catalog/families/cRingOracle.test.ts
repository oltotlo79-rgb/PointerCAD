/**
 * A6 C 形止め輪(JIS B 2804-2010)の軸用・穴用の族の行と、照らす側の読み(cRingOracle.fixture.json)の突合せ、寸法の並びと形の体積の検査。
 * fixture は、2010 年の版の抜粋の表(jis2010。製品の行の出どころ)の値と、互いに独立な 2 つの読み(maker: 製造元の表、jis2001: 2001 年の版の
 * 抜粋。どちらも頁の画像から読んだ)を、印刷の桁のまま持つ。製品の各行は、maker か jis2001 のどちらかと 8 欄の全部で一致する事を確かめる。
 * 資料の番号・URL・発行元は担当の資料の記録だけに置く(製品と検査には持たない)。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { C_RING_BORE_FAMILY, C_RING_SHAFT_FAMILY } from './cRing.js';

type Cells = readonly string[];
interface KindFixture { readonly jis2010: readonly Cells[]; readonly maker: readonly Cells[]; readonly jis2001: readonly Cells[] }

const isCells = (value: unknown): value is Cells => Array.isArray(value) && value.every((cell: unknown) => typeof cell === 'string');
const isTable = (value: unknown): value is readonly Cells[] => Array.isArray(value) && value.every(isCells);
const isKind = (value: unknown): value is KindFixture => typeof value === 'object' && value !== null
  && 'jis2010' in value && 'maker' in value && 'jis2001' in value && isTable(value.jis2010) && isTable(value.maker) && isTable(value.jis2001);

function readFixture(): { readonly shaft: KindFixture; readonly bore: KindFixture } {
  const value: unknown = JSON.parse(readFileSync(new URL('./cRingOracle.fixture.json', import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null || !('shaft' in value) || !('bore' in value) || !isKind(value.shaft) || !isKind(value.bore)) {
    throw new Error('fixture の形が違う');
  }
  return { shaft: value.shaft, bore: value.bore };
}

const FIXTURE = readFixture();
const CASES = [
  { kind: 'shaft', family: C_RING_SHAFT_FAMILY, d3: 'innerDiameter', rows: 39, onlyJis2001: ['10', '11', '12', '14', '15'], onlyMaker: 17 },
  { kind: 'bore', family: C_RING_BORE_FAMILY, d3: 'outerDiameter', rows: 50, onlyJis2001: ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
    onlyMaker: 19 },
] as const;

/** 製品の行の 8 欄 [d3, t, b, a, d5, d1, d2, m](数)。 */
function productCells(family: typeof C_RING_SHAFT_FAMILY, d3: 'innerDiameter' | 'outerDiameter', key: string): readonly number[] {
  const dims = family.rows.find((row) => row.key === key)?.dims ?? {};
  return [dims[d3], dims.thickness, dims.width, dims.lugWidth, dims.fittedDiameter, dims.appliedDiameter, dims.grooveDiameter, dims.grooveWidth]
    .map((value) => value ?? NaN);
}

describe('A6 C 形止め輪 資料の表との突合せ', () => {
  it.each(CASES)('$kind: 製品の行は 2010 年の版の抜粋の行と、呼び・欄・8 欄の全部で同じ', ({ kind, family, d3, rows }) => {
    const table = FIXTURE[kind].jis2010;
    expect(table).toHaveLength(rows);
    expect(family.rows.map((row) => [row.size, row.dims.series, ...productCells(family, d3, row.key)]))
      .toEqual(table.map(([size, series, ...values]) => [size, Number(series), ...values.map(Number)]));
  });

  it.each(CASES)('$kind: 各行は製造元の表か 2001 年の版の抜粋のどちらかと 8 欄の全部で一致する(どちらだけと一致する行の数も決まっている)', (item) => {
    const agree = (source: 'maker' | 'jis2001', key: string): boolean => {
      const found = FIXTURE[item.kind][source].find(([size]) => size === key);
      return found !== undefined && found.slice(1).every((cell, index) => Number(cell) === productCells(item.family, item.d3, key)[index]);
    };
    const keys = item.family.rows.map((row) => row.key);
    expect(keys.filter((key) => !agree('maker', key) && !agree('jis2001', key))).toEqual([]);
    expect(keys.filter((key) => agree('jis2001', key) && !agree('maker', key))).toEqual(item.onlyJis2001);
    expect(keys.filter((key) => agree('maker', key) && !agree('jis2001', key))).toHaveLength(item.onlyMaker);
  });

  it('寸法の並び: 軸用は d3 < d2 < d1 < d5、穴用は d5 < d1 < d2 < d3。溝の幅 m は厚さ t より大きい', () => {
    for (const row of C_RING_SHAFT_FAMILY.rows) {
      const { innerDiameter: d3, grooveDiameter: d2, appliedDiameter: d1, fittedDiameter: d5, grooveWidth: m, thickness: t } = row.dims;
      expect([d3, d2, d1, d5].every((value, index, list) => index === 0 || (list[index - 1] ?? Infinity) < (value ?? -Infinity))).toBe(true);
      expect(m).toBeGreaterThan(t ?? Infinity);
    }
    for (const row of C_RING_BORE_FAMILY.rows) {
      const { outerDiameter: d3, grooveDiameter: d2, appliedDiameter: d1, fittedDiameter: d5, grooveWidth: m, thickness: t } = row.dims;
      expect([d5, d1, d2, d3].every((value, index, list) => index === 0 || (list[index - 1] ?? Infinity) < (value ?? -Infinity))).toBe(true);
      expect(m).toBeGreaterThan(t ?? Infinity);
    }
  });

  it.each(CASES)('$kind: 出どころは JIS の番号と版の年だけを持ち、族の版を凍結し、形は簡略の輪で体積は 輪の面積 × t', ({ kind, family, d3 }) => {
    const evidence = family.rows[0]?.evidence;
    expect(family.rows.every((row) => row.evidence === evidence && row.simplified?.length === 1)).toBe(true);
    expect([evidence?.reference, evidence?.edition]).toEqual(['JIS B 2804:2010', '2010']);
    expect([evidence?.title, evidence?.locator].every((text) => text !== undefined && text.includes('JIS B 2804') && !text.includes('資料'))).toBe(true);
    expect(evidence).not.toHaveProperty('url');
    expect([family.id, family.catalogRevision, family.generatorRevision]).toEqual([`c-ring-${kind}`, `c-ring-${kind}-2026-11-r1`, 'c-ring-1']);
    const label = kind === 'shaft' ? '軸用' : '穴用';
    for (const row of family.rows) {
      const part = family.build(row, {});
      expect(part?.name).toBe(`${label} C 形止め輪 ${row.size}`);
      expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
      const free = (row.dims[d3] ?? NaN) / 2, b = row.dims.width ?? NaN, t = row.dims.thickness ?? NaN;
      const [inner, outer] = kind === 'shaft' ? [free, free + b] : [free - b, free];
      expect(family.nominalVolume(row, {})).toBeCloseTo(Math.PI * (outer ** 2 - inner ** 2) * t, 9);
    }
  });
});
