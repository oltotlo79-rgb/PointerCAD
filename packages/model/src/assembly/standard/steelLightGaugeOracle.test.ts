/**
 * S-10・S-11 軽量形鋼（JIS G 3350 表5〜表10、SSC400）の独立の転記との突合せと、質量の検算・断面の形の検査。
 *
 * fixture（steelLightGaugeOracle.fixture.ts）は資料の PDF の文字の流れから読んだ 2 回目の転記で、製品の表
 * （steelRows/g3350Rows.ts、語の座標から読んだ 1 回目）を見ずに作った。ここで 2 つを 1 行ずつ照らす。
 */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ALL_STEEL_PRODUCTS, STEEL_CATALOG_REVISION_R2, STEEL_EVIDENCE, steelProducts, type SteelSectionCatalog,
} from './steelCatalog.js';
import { LIGHT_GAUGE_ORACLE } from './steelLightGaugeOracle.fixture.js';
import { steelCatalogProfile } from './steelProfiles/steelCatalogProfile.js';
import {
  G3350_HAT_ROWS, G3350_LIGHT_ANGLE_ROWS, G3350_LIGHT_CHANNEL_ROWS, G3350_LIGHT_Z_ROWS, G3350_LIP_CHANNEL_ROWS,
  G3350_LIP_Z_ROWS,
} from './steelRows/g3350Rows.js';
import type { SteelProfileSegment } from './steelSectionProfiles.js';

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

/** 小数の文字列を 1000 倍の整数に（寸法と厚さは小数 1 桁、係数は小数 3 桁）。 */
const milli = (text: string): bigint => BigInt(Math.round(Number(text) * 1000));

/**
 * 表12 の断面積の式（t は厚さ、寸法は表の記号）。[直線の長さの和の係数, 厚さの係数（1000 倍）]。
 * 軽溝・軽Z: t(H+A+B−3.287t)、軽山形: t(A+B−1.644t)、リップ溝・リップZ: t(H+2A+2C−6.574t)、ハット: t(2H+A+2C−4.575t)。
 */
const FORMULAS = {
  表5: { weights: [1n, 1n, 1n], k: 3287n, exact: 8 - 1.5 * Math.PI },
  表6: { weights: [1n, 1n, 1n], k: 3287n, exact: 8 - 1.5 * Math.PI },
  表7: { weights: [1n, 1n], k: 1644n, exact: 4 - 0.75 * Math.PI },
  表8: { weights: [1n, 2n, 2n], k: 6574n, exact: 16 - 3 * Math.PI },
  表9: { weights: [1n, 2n, 2n], k: 6574n, exact: 16 - 3 * Math.PI },
  表10: { weights: [2n, 1n, 2n], k: 4575n, exact: 14 - 3 * Math.PI },
} as const;
type Table = keyof typeof FORMULAS;

const CATALOG: Readonly<Record<Table, { readonly catalog: SteelSectionCatalog; readonly prefix: string }>> = {
  表5: { catalog: 'lightChannel', prefix: '[' },
  表6: { catalog: 'lightZ', prefix: 'Z' },
  表7: { catalog: 'lightAngle', prefix: 'L' },
  表8: { catalog: 'lipChannel', prefix: 'C' },
  表9: { catalog: 'lipZ', prefix: 'Z' },
  表10: { catalog: 'hatSection', prefix: 'ハット' },
};

/** 表8 の呼び名 4367（125×50×20×4.5）だけは、印刷の単位質量 8.32 が丸めた断面積 10.59 からの値（8.31）と違う。 */
const PRINTED_MASS_EXCEPTIONS: Readonly<Record<string, { readonly fromRoundedArea: string }>> = {
  '表8:4367': { fromRoundedArea: '8.31' },
};

const loopArea = (segments: readonly SteelProfileSegment[]): number => segments.reduce((area, segment) => area
  + (segment.kind === 'line'
    ? (segment.from[0] * segment.to[1] - segment.from[1] * segment.to[0]) / 2
    : (segment.center[0] * (segment.to[1] - segment.from[1]) - segment.center[1] * (segment.to[0] - segment.from[0])
      + segment.radius ** 2 * (segment.endAngle - segment.startAngle)) / 2), 0);

const PRODUCT_ROWS = [
  ...G3350_LIGHT_CHANNEL_ROWS.map(([code, h, a, b, t, area, mass, page]) => ['表5', code, `${h}×${a}×${b}`, t, area, mass, page]),
  ...G3350_LIGHT_Z_ROWS.map(([code, h, a, b, t, area, mass, page]) => ['表6', code, `${h}×${a}×${b}`, t, area, mass, page]),
  ...G3350_LIGHT_ANGLE_ROWS.map(([code, a, b, t, area, mass, page]) => ['表7', code, `${a}×${b}`, t, area, mass, page]),
  ...G3350_LIP_CHANNEL_ROWS.map(([code, h, a, c, t, area, mass, page]) => ['表8', code, `${h}×${a}×${c}`, t, area, mass, page]),
  ...G3350_LIP_Z_ROWS.map(([code, h, a, c, t, area, mass, page]) => ['表9', code, `${h}×${a}×${c}`, t, area, mass, page]),
  ...G3350_HAT_ROWS.map(([code, h, a, c, t, area, mass, page]) => ['表10', code, `${h}×${a}×${c}`, t, area, mass, page]),
];

const sizeOf = (table: Table, dims: string, t: string): string => `${CATALOG[table].prefix} ${dims}×${t}`;

describe('S-10・S-11 軽量形鋼 JIS G 3350 表5〜表10 の独立の転記との突合せ', () => {
  it('6 つの表の 91 行がそろい、製品の行も 91 行で鍵が重ならない', () => {
    const counts = Object.fromEntries(Object.keys(FORMULAS).map((table) =>
      [table, LIGHT_GAUGE_ORACLE.rows.filter((row) => row[0] === table).length]));
    expect(counts).toEqual({ 表5: 31, 表6: 7, 表7: 6, 表8: 37, 表9: 2, 表10: 8 });
    expect(PRODUCT_ROWS).toHaveLength(91);
    const products = steelProducts('SSC400');
    expect(products).toHaveLength(91);
    expect(new Set(products.map((row) => row.key)).size).toBe(91);
    expect([...new Set(products.map((row) => row.catalog))])
      .toEqual(['lightChannel', 'lightZ', 'lightAngle', 'lipChannel', 'lipZ', 'hatSection']);
    for (const { catalog } of Object.values(CATALOG)) {
      expect(ALL_STEEL_PRODUCTS.filter((row) => row.catalog === catalog)).toEqual(steelProducts('SSC400', catalog));
    }
  });

  it('製品の表（1 回目）と fixture（2 回目）が 91 行の全ての値・頁・表で一致する', () => {
    expect(PRODUCT_ROWS).toEqual(LIGHT_GAUGE_ORACLE.rows.map((row) => [...row]));
  });

  it('fixture はアプリのモジュールを読まない', () => {
    const text = readFileSync(new URL('./steelLightGaugeOracle.fixture.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(file.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))).toEqual([]);
    expect(STEEL_EVIDENCE.sscDraft.sha256).toBe(LIGHT_GAUGE_ORACLE.pdfSha256);
  });

  it.each(LIGHT_GAUGE_ORACLE.rows)('%s %s %s×%s: 表12 の式の断面積・単位質量と、呼び名の末尾の厚さの記号が一致する',
    (table, code, dims, t, area, mass) => {
      const formula = FORMULAS[table];
      const lengths = dims.split('×').map(milli);
      expect(lengths).toHaveLength(formula.weights.length);
      const t1000 = milli(t);
      // 断面積 = t(Σ − k t) / 100、有効数字 4 桁（規則A）。値は 1000 倍の整数で厳密に計算する。
      const sum = lengths.reduce((total, length, index) => total + formula.weights[index] * length, 0n);
      const raw = t1000 * (sum * 1000n - formula.k * t1000);
      expect(significant(raw, 1000n * 1000n * 1000n * 100n, 4)).toBe(area);
      // 単位質量 = 0.785 × 断面積、有効数字 3 桁。
      const fromRounded = significant(785n * milli(area), 1000n * 1000n, 3);
      const exception = PRINTED_MASS_EXCEPTIONS[`${table}:${code}`];
      if (exception === undefined) {
        expect(fromRounded).toBe(mass);
      } else {
        expect(fromRounded).toBe(exception.fromRoundedArea);
        // 印刷の値は丸める前の断面積からの値と一致する（原案の印刷の値をそのまま持つ）。
        expect(significant(785n * raw, 1000n * 1000n * 1000n * 100n * 1000n, 3)).toBe(mass);
      }
      const digit = { 8: '6.0', 7: '4.5', 6: '4.0', 5: '3.2', 3: '2.3', 2: '2.0', 1: '1.6' } as const;
      expect(digit[Number(code.slice(-1)) as keyof typeof digit]).toBe(t);
    });

  it('式の検算と印刷の値が食い違う行は表8 の 4367 の 1 行だけ', () => {
    expect(Object.keys(PRINTED_MASS_EXCEPTIONS)).toEqual(['表8:4367']);
    expect(LIGHT_GAUGE_ORACLE.rows.filter(([table, code]) => `${table}:${code}` === '表8:4367'))
      .toEqual([['表8', '4367', '125×50×20', '4.5', '10.59', '8.32', 8]]);
  });

  it.each(LIGHT_GAUGE_ORACLE.rows)('%s %s %s×%s: 製品の行・保存の文字列・形の面積が資料と一致する',
    (table, code, dims, t, area, mass, page) => {
      const { catalog } = CATALOG[table];
      const size = sizeOf(table, dims, t);
      const product = ALL_STEEL_PRODUCTS.find((row) => row.key === `SSC400:${catalog}:${size}`);
      if (product === undefined) throw new Error(`Missing light gauge ${size}`);
      expect(product).toMatchObject({ catalog, size, materialGrade: 'SSC400',
        materialStandard: 'JIS G 3350', productStandard: 'JIS G 3350', condition: 'lightGauge-coldFormed',
        evidence: 'sscDraft', catalogRevision: STEEL_CATALOG_REVISION_R2, geometry: 'profileSection',
        standardLengthsMm: [6000, 7000, 8000, 9000, 10000, 11000, 12000],
        standardReferences: { material: 'jis-g-3350-2021', dimensions: 'jis-g-3350-2021' } });
      expect(product.note).toContain(`${table} PDF p${page}`);
      expect(product.note).toContain(`呼び名 ${code}`);
      expect(product.note).toContain(`断面積 ${area} cm²・単位質量 ${mass} kg/m`);
      expect(product.profileEvidence).toEqual(STEEL_EVIDENCE.sscDraft);
      const profile = steelCatalogProfile(catalog, size);
      if (profile === undefined) throw new Error(`Missing light gauge profile ${size}`);
      // 形の面積は角の円弧を厳密に数えた値で、式の係数（3.287 ほか）の代わりに π を使った値と一致する。
      const tn = Number(t);
      const weights = FORMULAS[table].weights.map(Number);
      const lengths = dims.split('×').map(Number);
      const exact = tn * (lengths.reduce((total, length, index) => total + weights[index] * length, 0) - FORMULAS[table].exact * tn);
      expect(Math.abs(profile.areaMm2 - exact)).toBeLessThan(1e-9 * exact);
      expect(Math.abs(profile.areaMm2 / 100 - Number(area)) / Number(area)).toBeLessThan(5e-4);
      expect(profile).toMatchObject({ rootRadius: tn, tipRadius: 2 * tn, taperDegrees: 0 });
      expect(profile.holes).toEqual([]);
    });
});

describe('S-10・S-11 軽量形鋼の断面の形（角部の曲率半径は厚さの中心線で 1.5t＝外 2t・内 t、8.1）', () => {
  it.each(LIGHT_GAUGE_ORACLE.rows)('%s %s %s×%s: 閉じた 1 つの輪で、曲げの角は外 2t・内 t の同じ中心の円弧になる',
    (table, _code, dims, t) => {
      const { catalog } = CATALOG[table];
      const profile = steelCatalogProfile(catalog, sizeOf(table, dims, t));
      if (profile === undefined) throw new Error('Missing light gauge profile');
      const tn = Number(t);
      const bends = { 表5: 2, 表6: 2, 表7: 1, 表8: 4, 表9: 4, 表10: 4 }[table];
      const arcs = profile.segments.filter((segment) => segment.kind === 'arc');
      expect(arcs.map((arc) => arc.kind === 'arc' ? arc.radius : 0).sort((a, b) => a - b))
        .toEqual([...Array<number>(bends).fill(tn), ...Array<number>(bends).fill(2 * tn)]);
      const centers = (radius: number) => arcs.filter((arc) => arc.kind === 'arc' && arc.radius === radius)
        .map((arc) => arc.kind === 'arc' ? `${arc.center[0].toFixed(9)},${arc.center[1].toFixed(9)}` : '').sort();
      expect(centers(tn)).toEqual(centers(2 * tn));
      for (let index = 0; index < profile.segments.length; index++) {
        const current = profile.segments[index], next = profile.segments[(index + 1) % profile.segments.length];
        expect(current.to[0]).toBeCloseTo(next.from[0], 10);
        expect(current.to[1]).toBeCloseTo(next.from[1], 10);
      }
      expect(loopArea(profile.segments)).toBeGreaterThan(0);
      expect(profile.areaMm2).toBeCloseTo(loopArea(profile.segments), 9);
      const points = profile.segments.flatMap((segment) => [segment.from, segment.to]);
      const [d1, d2, d3] = dims.split('×').map(Number);
      // 表の図の向き: 高さ（H・軽山形の A）は y、幅は x。軽Z・リップZ はフランジが左右に出る。
      const width = { 表5: Math.max(d2, d3), 表6: d2 + d3 - tn, 表7: d2, 表8: d2, 表9: 2 * d2 - tn, 表10: d2 + 2 * d3 }[table];
      expect(Math.min(...points.map((point) => point[0]))).toBeCloseTo(0, 12);
      expect(Math.min(...points.map((point) => point[1]))).toBeCloseTo(0, 12);
      expect(Math.max(...points.map((point) => point[0]))).toBeCloseTo(width, 9);
      expect(Math.max(...points.map((point) => point[1]))).toBeCloseTo(d1, 9);
      expect(profile).toMatchObject({ width, height: d1 });
    });
});
