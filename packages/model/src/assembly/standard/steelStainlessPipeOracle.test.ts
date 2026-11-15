/**
 * S-16 配管用ステンレス鋼鋼管（JIS G 3459 表7・表8、SUS304TP）の独立の転記との突合せと、質量の検算。
 *
 * fixture（steelStainlessPipeOracle.fixture.ts）は資料の PDF の文字の流れから読んだ 2 回目の転記で、製品の表
 * （steelRows/g3459Rows.ts、語の座標から読んだ 1 回目）を見ずに作った。ここで 2 つを 1 行ずつ照らす。
 */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { ALL_STEEL_PRODUCTS, STEEL_CATALOG_REVISION_R2, STEEL_EVIDENCE, steelProducts } from './steelCatalog.js';
import { G3459_TABLE7_ROWS, G3459_TABLE8_ROWS } from './steelRows/g3459Rows.js';
import { STAINLESS_PIPE_ORACLE } from './steelStainlessPipeOracle.fixture.js';

/** 10 進の偶数丸め（JIS Z 8401 の規則A）。value = numerator / denominator（正）。 */
function significant(numerator: bigint, denominator: bigint, digits: number): string {
  let exponent = 0;
  while (numerator >= denominator * 10n ** BigInt(exponent + 1)) exponent++;
  // 1 未満の値（例 0.237）は指数を負へ下げる。value < 10^e ⟺ numerator·10^(−e) < denominator（e ≤ 0）。
  while (exponent <= 0 && numerator * 10n ** BigInt(-exponent) < denominator) exponent--;
  const places = digits - 1 - exponent;
  const top = places >= 0 ? numerator * 10n ** BigInt(places) : numerator;
  const bottom = places >= 0 ? denominator : denominator * 10n ** BigInt(-places);
  const quotient = top / bottom, remainder = top % bottom;
  const rounded = quotient + (2n * remainder > bottom || (2n * remainder === bottom && quotient % 2n === 1n) ? 1n : 0n);
  return (Number(rounded) * 10 ** -places).toFixed(Math.max(0, places));
}

const hundredths = (text: string): bigint => BigInt(Math.round(Number(text) * 100));
const unbracket = (text: string): string => text.replace(/^\((.*)\)$/u, '$1');
/** 表9: SUS304TP の単位質量 W = 0.024 91 t (D − t) を有効数字 3 桁（規則A）。 */
const mass304 = (d: string, t: string): string =>
  significant(2491n * hundredths(t) * (hundredths(d) - hundredths(t)), 100000n * 100n * 100n, 3);

/** 表7 の行の呼び方（呼び径×呼び厚さ、箇条15 の例「50A×Sch10S」）。 */
const table7Size = (a: string, sch: string): string => `${a}×${sch}`;
/** 表8 の行の呼び方（外径×厚さ、表8 の注a）。 */
const table8Size = (d: string, t: string): string => `φ${d}×${t}`;

const TABLE8_NEW = STAINLESS_PIPE_ORACLE.table8.filter(([, , d, , t]) => t.startsWith('(')
  && !STAINLESS_PIPE_ORACLE.table7.some(([, , d7, , t7]) => d7 === d && t7 === unbracket(t)));

describe('S-16 配管用ステンレス鋼鋼管 JIS G 3459 表7・表8 の独立の転記との突合せ', () => {
  it('表7 の 139 組・表8 の 90 組がそろい、製品の行は表7 の 139 行と表8 の新しい外径×厚さの 51 行', () => {
    expect(STAINLESS_PIPE_ORACLE.table7).toHaveLength(139);
    expect(STAINLESS_PIPE_ORACLE.table8).toHaveLength(90);
    expect(G3459_TABLE7_ROWS).toHaveLength(139);
    expect(G3459_TABLE8_ROWS).toHaveLength(90);
    expect(TABLE8_NEW).toHaveLength(51);
    const products = steelProducts('SUS304TP');
    expect(products).toHaveLength(190);
    expect(new Set(products.map((row) => row.key)).size).toBe(190);
    expect(steelProducts('SUS304TP', 'steelPipe')).toEqual(products);
    const counts = Object.fromEntries(['Sch5S', 'Sch10S', 'Sch20S', 'Sch40', 'Sch80', 'Sch120', 'Sch160'].map((sch) =>
      [sch, STAINLESS_PIPE_ORACLE.table7.filter((row) => row[3] === sch).length]));
    expect(counts).toEqual({ Sch5S: 18, Sch10S: 18, Sch20S: 18, Sch40: 25, Sch80: 25, Sch120: 13, Sch160: 22 });
  });

  it('製品の表（1 回目）と fixture（2 回目）が全ての組の値・頁で一致する', () => {
    expect(G3459_TABLE7_ROWS.map(([a, b, d, sch, t, w, page]) => [`${a}A`, b, d, `Sch${sch}`, t, w, page]))
      .toEqual(STAINLESS_PIPE_ORACLE.table7.map((row) => [...row]));
    expect(G3459_TABLE8_ROWS.map(([a, b, d, sch, t, w, page, bracketed]) =>
      [`${a}A`, b, d, `Sch${sch}`, bracketed ? `(${t})` : t, w, page]))
      .toEqual(STAINLESS_PIPE_ORACLE.table8.map((row) => [...row]));
  });

  it('fixture はアプリのモジュールを読まない', () => {
    const text = readFileSync(new URL('./steelStainlessPipeOracle.fixture.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(file.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))).toEqual([]);
    expect(STEEL_EVIDENCE.susPipeDraft.sha256).toBe(STAINLESS_PIPE_ORACLE.pdfSha256);
  });

  it('表8 の括弧の無い厚さは表7 の同じ呼び径・Sch と同じ厚さ・単位質量で、括弧の厚さは表7 と違う', () => {
    for (const [a, , d, sch, t, w] of STAINLESS_PIPE_ORACLE.table8) {
      const seven = STAINLESS_PIPE_ORACLE.table7.find((row) => row[0] === a && row[2] === d && row[3] === sch);
      if (t.startsWith('(')) {
        expect(seven?.[4], `${a} ${sch}`).not.toBe(unbracket(t));
      } else {
        expect([seven?.[4], seven?.[5]], `${a} ${sch}`).toEqual([t, w]);
      }
    }
    // 括弧の厚さのうち 3 組は、表7 の同じ外径の別の Sch と同じ寸法（製品の行は表7 の 1 行だけ）。
    expect(STAINLESS_PIPE_ORACLE.table8.filter(([, , d, , t]) => t.startsWith('(') && STAINLESS_PIPE_ORACLE.table7
      .some(([, , d7, , t7]) => d7 === d && t7 === unbracket(t))).map(([a, , , sch, t]) => `${a} ${sch} ${t}`))
      .toEqual(['10A Sch10S (2.0)', '32A Sch10S (3.0)', '40A Sch10S (3.0)']);
  });

  it.each([...STAINLESS_PIPE_ORACLE.table7, ...STAINLESS_PIPE_ORACLE.table8])(
    '%s %s %s: 表9 の式（SUS304TP）の単位質量が印刷の値に一致する', (_a, _b, d, _sch, t, w) => {
      expect(mass304(d, unbracket(t))).toBe(w);
    });

  it.each(STAINLESS_PIPE_ORACLE.table7)('%s（%s）%s %s: 表7 の行は呼び径×Sch の呼び方で、外径と厚さの鋼管になる',
    (a, b, d, sch, t, w, page) => {
      const size = table7Size(a, sch);
      const product = ALL_STEEL_PRODUCTS.find((row) => row.key === `SUS304TP:steelPipe:${size}`);
      if (product === undefined) throw new Error(`Missing stainless pipe ${size}`);
      expect(product).toMatchObject({ catalog: 'steelPipe', size, materialGrade: 'SUS304TP',
        materialStandard: 'JIS G 3459', productStandard: 'JIS G 3459', condition: 'stainlessPipe-solutionTreated-plainEnds',
        evidence: 'susPipeDraft', catalogRevision: STEEL_CATALOG_REVISION_R2, geometry: 'nominal', standardLengthsMm: [],
        dimensions: { outsideDiameter: Number(d), wallThickness: Number(t) },
        standardReferences: { material: 'jis-g-3459-2021', dimensions: 'jis-g-3459-2021' } });
      expect(product.note).toContain(`表7 PDF p${page}`);
      expect(product.note).toContain(`呼び径 ${a}（${b}B）・${sch}`);
      expect(product.note).toContain(`外径 ${d} mm・厚さ ${t} mm・単位質量 ${w} kg/m`);
    });

  it.each(TABLE8_NEW)('%s（%s）%s %s: 表8 の括弧の厚さは外径×厚さの呼び方の溶接鋼管の行になる',
    (a, b, d, sch, t, w, page) => {
      const size = table8Size(d, unbracket(t));
      const product = ALL_STEEL_PRODUCTS.find((row) => row.key === `SUS304TP:steelPipe:${size}`);
      if (product === undefined) throw new Error(`Missing welded stainless pipe ${size}`);
      expect(product).toMatchObject({ catalog: 'steelPipe', size, materialGrade: 'SUS304TP',
        condition: 'stainlessPipe-solutionTreated-plainEnds', evidence: 'susPipeDraft',
        catalogRevision: STEEL_CATALOG_REVISION_R2, geometry: 'nominal',
        dimensions: { outsideDiameter: Number(d), wallThickness: Number(unbracket(t)) } });
      expect(product.note).toContain(`表8 PDF p${page}`);
      expect(product.note).toContain(`溶接鋼管`);
      expect(product.note).toContain(`呼び径 ${a}（${b}B）・${sch}`);
      expect(product.note).toContain(`単位質量 ${w} kg/m`);
    });

  it('製品の行は外径×厚さが重ならず、表7・表8 の順に並ぶ', () => {
    const products = steelProducts('SUS304TP');
    const pairs = products.map((row) => `${row.dimensions?.outsideDiameter}×${row.dimensions?.wallThickness}`);
    expect(new Set(pairs).size).toBe(190);
    expect(products.slice(0, 139).map((row) => row.size))
      .toEqual(STAINLESS_PIPE_ORACLE.table7.map(([a, , , sch]) => table7Size(a, sch)));
    expect(products.slice(139).map((row) => row.size))
      .toEqual(TABLE8_NEW.map(([, , d, , t]) => table8Size(d, unbracket(t))));
  });
});
