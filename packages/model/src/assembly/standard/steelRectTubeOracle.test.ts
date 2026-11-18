// 規格資料の出典は規格番号と一般名で照合する。
/**
 * S-01 角形鋼管（JIS G 3466 表5・表6、STKR400）の独立の転記との突合せと、質量の検算・断面の形の検査。
 *
 * fixture（steelRectTubeOracle.fixture.ts）は資料の PDF の文字の流れから読んだ 2 回目の転記で、製品の表
 * （steelRows/g3466Rows.ts、語の座標から読んだ 1 回目）を見ずに作った。ここで 2 つを 1 行ずつ照らす。
 */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ALL_STEEL_PRODUCTS, STEEL_CATALOG_REVISION_R2, STEEL_EVIDENCE, steelProducts,
} from './steelCatalog.js';
import { steelCatalogProfile } from './steelProfiles/steelCatalogProfile.js';
import { RECT_TUBE_ORACLE } from './steelRectTubeOracle.fixture.js';
import { G3466_RECT_TUBE_ROWS } from './steelRows/g3466Rows.js';
import type { SteelProfileSegment } from './steelSectionProfiles.js';

/** 10 進の偶数丸め（JIS Z 8401 の規則A）。2 進の浮動小数の丸めに頼らない。 */
function significant(numerator: bigint, denominator: bigint, digits: number): string {
  let exponent = 0;
  while (numerator >= denominator * 10n ** BigInt(exponent + 1)) exponent++;
  const places = digits - 1 - exponent;
  const top = places >= 0 ? numerator * 10n ** BigInt(places) : numerator;
  const bottom = places >= 0 ? denominator : denominator * 10n ** BigInt(-places);
  const quotient = top / bottom, remainder = top % bottom;
  const rounded = quotient + (2n * remainder > bottom || (2n * remainder === bottom && quotient % 2n === 1n) ? 1n : 0n);
  return (Number(rounded) * 10 ** -places).toFixed(Math.max(0, places));
}

const tenths = (text: string): bigint => BigInt(Math.round(Number(text) * 10));
const sizeOf = (a: string, b: string, t: string): string => `□ ${a}×${b}×${t}`;
const loopArea = (segments: readonly SteelProfileSegment[]): number => segments.reduce((area, segment) => area
  + (segment.kind === 'line'
    ? (segment.from[0] * segment.to[1] - segment.from[1] * segment.to[0]) / 2
    : (segment.center[0] * (segment.to[1] - segment.from[1]) - segment.center[1] * (segment.to[0] - segment.from[0])
      + segment.radius ** 2 * (segment.endAngle - segment.startAngle)) / 2), 0);

describe('S-01 角形鋼管 JIS G 3466 表5・表6 の独立の転記との突合せ', () => {
  it('表5 の 53 行と表6 の 59 行がそろい、製品の行も 112 行で鍵が重ならない', () => {
    expect(RECT_TUBE_ORACLE.rows.filter((row) => row[6] === '表5')).toHaveLength(53);
    expect(RECT_TUBE_ORACLE.rows.filter((row) => row[6] === '表6')).toHaveLength(59);
    expect(G3466_RECT_TUBE_ROWS).toHaveLength(112);
    const products = steelProducts('STKR400', 'rectTube');
    expect(products).toHaveLength(112);
    expect(new Set(products.map((row) => row.key)).size).toBe(112);
    expect(steelProducts('STKR400')).toEqual(products);
    expect(ALL_STEEL_PRODUCTS.filter((row) => row.catalog === 'rectTube')).toEqual(products);
  });

  it('製品の表（1 回目）と fixture（2 回目）が 112 行の全ての値・頁・表で一致する', () => {
    expect(G3466_RECT_TUBE_ROWS.map((row) => [...row]))
      .toEqual(RECT_TUBE_ORACLE.rows.map(([a, b, t, w, s, page, table]) => [a, b, t, w, s, page, table.slice(1)]));
  });

  it('fixture はアプリのモジュールを読まない', () => {
    const text = readFileSync(new URL('./steelRectTubeOracle.fixture.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(file.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))).toEqual([]);
    expect(STEEL_EVIDENCE.stkrDraft.reference).toBe(RECT_TUBE_ORACLE.reference);
  });

  it.each(RECT_TUBE_ORACLE.rows)('%s×%s×%s: 単位質量は式(1)、断面積は注a の式と形の面積が印刷の値に一致する',
    (a, b, t, w, s, page, table) => {
      // 式(1) W = 0.015 7 t (A + B − 3.287 t) を有効数字 3 桁（規則A）。t は 0.1 mm 単位。
      const t10 = tenths(t), sum = BigInt(Number(a) + Number(b));
      expect(significant(157n * t10 * (10000n * sum - 3287n * t10), 10n ** 9n, 3)).toBe(w);
      const tn = Number(t), an = Number(a), bn = Number(b);
      const jisArea = (2 * tn * (an - 4 * tn) + 2 * tn * (bn - 4 * tn) + 3 * Math.PI * tn ** 2) / 100;
      expect(Number(jisArea.toPrecision(4))).toBe(Number(s));
      const product = ALL_STEEL_PRODUCTS.find((row) => row.key === `STKR400:rectTube:${sizeOf(a, b, t)}`);
      if (product === undefined) throw new Error(`Missing rect tube ${a}×${b}×${t}`);
      expect(product).toMatchObject({ catalog: 'rectTube', size: sizeOf(a, b, t), materialGrade: 'STKR400',
        materialStandard: 'JIS G 3466', productStandard: 'JIS G 3466', condition: 'rectTube-asManufactured',
        evidence: 'stkrDraft', catalogRevision: STEEL_CATALOG_REVISION_R2, geometry: 'profileSection',
        standardLengthsMm: [6000, 8000, 10000, 12000],
        standardReferences: { material: 'jis-g-3466-2025', dimensions: 'jis-g-3466-2025' } });
      expect(product.note).toContain(`${table} PDF p${page}`);
      expect(product.profileEvidence).toEqual(STEEL_EVIDENCE.stkrDraft);
      const profile = steelCatalogProfile(product.catalog, product.size);
      if (profile === undefined) throw new Error(`Missing rect tube profile ${product.size}`);
      expect(Math.abs(profile.areaMm2 / 100 - jisArea)).toBeLessThan(1e-9 * jisArea);
      // 注a の IXA = 2t(A−4t)³/12: 辺 A は y の向き（高さ）、辺 B は x の向き（幅）。
      expect(profile).toMatchObject({ width: bn, height: an, rootRadius: tn, tipRadius: 2 * tn, taperDegrees: 0 });
    });
});

describe('S-01 角形鋼管の断面の形（角部の外側の半径 2t・内側の半径 t、表5・表6 の注a）', () => {
  it.each(RECT_TUBE_ORACLE.rows)('%s×%s×%s: 外と内の閉じた輪で、角は同じ中心の円弧になる', (a, b, t) => {
    const profile = steelCatalogProfile('rectTube', sizeOf(a, b, t));
    if (profile === undefined) throw new Error('Missing rect tube profile');
    const tn = Number(t), an = Number(a), bn = Number(b);
    expect(profile.holes).toHaveLength(1);
    const outerArcs = profile.segments.filter((segment) => segment.kind === 'arc');
    const innerArcs = profile.holes[0].filter((segment) => segment.kind === 'arc');
    expect(outerArcs.map((arc) => arc.kind === 'arc' ? arc.radius : 0)).toEqual([2 * tn, 2 * tn, 2 * tn, 2 * tn]);
    expect(innerArcs.map((arc) => arc.kind === 'arc' ? arc.radius : 0)).toEqual([tn, tn, tn, tn]);
    const centers = (arcs: readonly SteelProfileSegment[]) => arcs.map((arc) => arc.kind === 'arc' ? arc.center : [0, 0])
      .map(([x, y]) => `${x.toFixed(9)},${y.toFixed(9)}`).sort();
    expect(centers(innerArcs)).toEqual(centers(outerArcs));
    for (const loop of [profile.segments, profile.holes[0]]) {
      for (let index = 0; index < loop.length; index++) {
        const current = loop[index], next = loop[(index + 1) % loop.length];
        expect(current.to[0]).toBeCloseTo(next.from[0], 10);
        expect(current.to[1]).toBeCloseTo(next.from[1], 10);
      }
      expect(loopArea(loop)).toBeGreaterThan(0);
    }
    expect(profile.areaMm2).toBeCloseTo(loopArea(profile.segments) - loopArea(profile.holes[0]), 9);
    const points = profile.segments.flatMap((segment) => [segment.from, segment.to]);
    expect(Math.min(...points.map((point) => point[0]))).toBeCloseTo(0, 12);
    expect(Math.max(...points.map((point) => point[0]))).toBeCloseTo(bn, 12);
    expect(Math.max(...points.map((point) => point[1]))).toBeCloseTo(an, 12);
    const inner = profile.holes[0].flatMap((segment) => [segment.from, segment.to]);
    expect(Math.min(...inner.map((point) => point[0]))).toBeCloseTo(tn, 12);
    expect(Math.max(...inner.map((point) => point[1]))).toBeCloseTo(an - tn, 12);
  });
});
