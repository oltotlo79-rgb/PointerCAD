/**
 * S-02 一般構造用炭素鋼鋼管（JIS G 3444 表6、STK400）の独立の転記との突合せと質量の検算。
 *
 * fixture（steelStructuralPipeOracle.fixture.ts）は PDF の文字の流れから読んだ 2 回目の転記で、製品の表
 * （steelRows/g3444Rows.ts、語の座標から読んだ 1 回目）を見ずに作った。ここで 2 つを 1 行ずつ照らす。
 */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { standardPartNominalVolume } from './buildStandardPart.js';
import { ALL_STEEL_PRODUCTS, STEEL_CATALOG_REVISION_R2, STEEL_EVIDENCE, steelProductOptions, steelProducts } from './steelCatalog.js';
import { G3444_STRUCTURAL_PIPE_ROWS } from './steelRows/g3444Rows.js';
import { STRUCTURAL_PIPE_ORACLE } from './steelStructuralPipeOracle.fixture.js';

/** 10 進の偶数丸め（JIS Z 8401 の規則A）。1 未満の値（例 0.972）は桁の位置を負にして数える。 */
function significant(numerator: bigint, denominator: bigint, digits: number): string {
  let exponent = 0;
  while (numerator >= denominator * 10n ** BigInt(exponent + 1)) exponent++;
  while (exponent <= 0 && exponent > -12 && numerator * 10n ** BigInt(-exponent) < denominator) exponent--;
  const places = digits - 1 - exponent;
  const top = places >= 0 ? numerator * 10n ** BigInt(places) : numerator;
  const bottom = places >= 0 ? denominator : denominator * 10n ** BigInt(-places);
  const quotient = top / bottom, remainder = top % bottom;
  const rounded = quotient + (2n * remainder > bottom || (2n * remainder === bottom && quotient % 2n === 1n) ? 1n : 0n);
  return (Number(rounded) * 10 ** -places).toFixed(Math.max(0, places));
}
const tenths = (text: string): bigint => BigInt(Math.round(Number(text) * 10));

describe('S-02 一般構造用炭素鋼鋼管 JIS G 3444 表6 の独立の転記との突合せ', () => {
  it('表6 の 128 行がそろい、製品の STK400 の鋼管も 128 行で鍵が重ならない', () => {
    expect(STRUCTURAL_PIPE_ORACLE.rows).toHaveLength(128);
    expect(G3444_STRUCTURAL_PIPE_ROWS).toHaveLength(128);
    const products = steelProducts('STK400', 'steelPipe');
    expect(products).toHaveLength(128);
    expect(steelProducts('STK400')).toEqual(products);
    expect(new Set(products.map((row) => row.key)).size).toBe(128);
    expect(new Set(STRUCTURAL_PIPE_ORACLE.rows.map(([d]) => d)).size).toBe(29);
  });

  it('製品の表（1 回目）と fixture（2 回目）が 128 行の全ての値・頁で一致し、fixture はアプリを読まない', () => {
    expect(G3444_STRUCTURAL_PIPE_ROWS.map((row) => [...row])).toEqual(STRUCTURAL_PIPE_ORACLE.rows.map((row) => [...row]));
    const text = readFileSync(new URL('./steelStructuralPipeOracle.fixture.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(file.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))).toEqual([]);
    expect(STEEL_EVIDENCE.stkDraft.sha256).toBe(STRUCTURAL_PIPE_ORACLE.pdfSha256);
  });

  it.each(STRUCTURAL_PIPE_ORACLE.rows)('φ%s×%s: 単位質量は式(1)、断面積は注a の式に一致し、行の値と頁を持つ', (d, t, w, a, page) => {
    // 式(1) W = 0.024 66 t (D − t)、有効数字 3 桁。D・t は 0.1 mm 単位。
    const d10 = tenths(d), t10 = tenths(t);
    expect(significant(2466n * t10 * (d10 - t10), 10n ** 7n, 3)).toBe(w);
    // 注a A = π(D² − d²)/400、d = D − 2t、有効数字 4 桁。
    const dn = Number(d), tn = Number(t);
    const area = Math.PI * (dn ** 2 - (dn - 2 * tn) ** 2) / 400;
    expect(Number(area.toPrecision(4))).toBe(Number(a));
    const size = `φ${d}×${t}`;
    const product = ALL_STEEL_PRODUCTS.find((row) => row.key === `STK400:steelPipe:${size}`);
    if (product === undefined) throw new Error(`Missing STK pipe ${size}`);
    expect(product).toMatchObject({ catalog: 'steelPipe', size, materialGrade: 'STK400', materialStandard: 'JIS G 3444',
      productStandard: 'JIS G 3444', condition: 'structuralPipe-plainEnds', evidence: 'stkDraft',
      catalogRevision: STEEL_CATALOG_REVISION_R2, geometry: 'nominal', standardLengthsMm: [],
      dimensions: { outsideDiameter: dn, wallThickness: tn },
      standardReferences: { material: 'jis-g-3444-2025', dimensions: 'jis-g-3444-2025' } });
    expect(product.note).toContain(`表6 PDF p${page}`);
    const volume = standardPartNominalVolume('steelPipe', size, { ...steelProductOptions(product), length: '1000' });
    expect(volume).not.toBeNull();
    expect(Math.abs((volume ?? 0) / 100000 - area)).toBeLessThan(1e-9 * area);
  });
});
