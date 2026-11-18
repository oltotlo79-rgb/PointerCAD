// 規格資料の出典は規格番号と一般名で照合する。
/**
 * S-06 CT 形鋼（JIS G 3192 表17、SS400）の独立の転記との突合せと、質量の検算・断面の形（重心の位置）の検査。
 *
 * fixture（steelCtOracle.fixture.ts）は資料の PDF の文字の流れから読んだ 2 回目の転記で、製品の表
 * （steelRows/g3192CtRows.ts、語の座標から読んだ 1 回目）を見ずに作った。ここで 2 つを 1 行ずつ照らす。
 */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { ALL_STEEL_PRODUCTS, STEEL_CATALOG_REVISION_R2, STEEL_EVIDENCE, steelProducts } from './steelCatalog.js';
import { CT_ORACLE } from './steelCtOracle.fixture.js';
import { steelCatalogProfile } from './steelProfiles/steelCatalogProfile.js';
import { G3192_CT_ROWS } from './steelRows/g3192CtRows.js';
import type { SteelProfilePoint, SteelProfileSegment } from './steelSectionProfiles.js';

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

const tenths = (text: string): bigint => BigInt(Math.round(Number(text) * 10));
const sizeOf = (hb: string, t1: string, t2: string): string => `CT ${hb}×${t1}×${t2}`;

/** 輪の点の列（円弧は細かい弦で近似）。重心の位置の検査だけに使う。 */
function polyline(segments: readonly SteelProfileSegment[]): readonly SteelProfilePoint[] {
  return segments.flatMap((segment): SteelProfilePoint[] => {
    if (segment.kind === 'line') return [segment.from];
    const steps = 512;
    return Array.from({ length: steps }, (_, index): SteelProfilePoint => {
      const angle = segment.startAngle + (segment.endAngle - segment.startAngle) * index / steps;
      return [segment.center[0] + segment.radius * Math.cos(angle), segment.center[1] + segment.radius * Math.sin(angle)];
    });
  });
}
function centroidY(points: readonly SteelProfilePoint[]): number {
  let area = 0, moment = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    const cross = point[0] * next[1] - next[0] * point[1];
    area += cross / 2;
    moment += cross * (point[1] + next[1]) / 6;
  });
  return moment / area;
}

describe('S-06 CT 形鋼 JIS G 3192 表17 の独立の転記との突合せ', () => {
  it('表17 の 53 行がそろい、製品の行も 53 行で鍵が重ならない', () => {
    expect(CT_ORACLE.rows).toHaveLength(53);
    expect(G3192_CT_ROWS).toHaveLength(53);
    const products = steelProducts('SS400', 'ctSection');
    expect(products).toHaveLength(53);
    expect(new Set(products.map((row) => row.key)).size).toBe(53);
    expect(ALL_STEEL_PRODUCTS.filter((row) => row.catalog === 'ctSection')).toEqual(products);
  });

  it('製品の表（1 回目）と fixture（2 回目）が 53 行の全ての値・頁で一致する', () => {
    expect(G3192_CT_ROWS.map(([h, b, ...rest]) => [`${h}×${b}`, ...rest]))
      .toEqual(CT_ORACLE.rows.map((row) => [...row]));
  });

  it('fixture はアプリのモジュールを読まない', () => {
    const text = readFileSync(new URL('./steelCtOracle.fixture.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(file.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))).toEqual([]);
    expect(STEEL_EVIDENCE.ssCtDraft.reference).toBe(CT_ORACLE.reference);
  });

  it.each(CT_ORACLE.rows)('CT %s×%s×%s: 表6 の式の断面積・単位質量と、形の面積・重心の位置が印刷の値に一致する',
    (hb, t1, t2, r, area, mass, cx, page) => {
      const [h, b] = hb.split('×');
      // 断面積 = t1(H − t2) + B t2 + 0.429 r²（mm²）を 1/100 して有効数字 4 桁（規則A）。寸法は 0.1 mm 単位。
      const raw = tenths(t1) * (tenths(h) - tenths(t2)) * 1000n + tenths(b) * tenths(t2) * 1000n
        + 429n * tenths(r) * tenths(r);
      expect(significant(raw, 100n * 1000n * 100n, 4)).toBe(area);
      const areaHundredths = BigInt(Math.round(Number(area) * 1000));
      expect(significant(785n * areaHundredths, 1000n * 1000n, 3)).toBe(mass);
      const size = sizeOf(hb, t1, t2);
      const product = ALL_STEEL_PRODUCTS.find((row) => row.key === `SS400:ctSection:${size}`);
      if (product === undefined) throw new Error(`Missing CT ${size}`);
      expect(product).toMatchObject({ catalog: 'ctSection', size, materialGrade: 'SS400',
        materialStandard: 'JIS G 3101', productStandard: 'JIS G 3192', condition: 'hotRolled-heatTreatmentUnspecified',
        evidence: 'ssCtDraft', materialEvidence: 'ss400GradeDraft', catalogRevision: STEEL_CATALOG_REVISION_R2,
        geometry: 'profileSection', standardLengthsMm: [6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000],
        standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' } });
      expect(product.note).toContain(`表17 PDF p${page}`);
      expect(product.note).toContain(`断面積 ${area} cm²・単位質量 ${mass} kg/m`);
      expect(product.profileEvidence).toEqual(STEEL_EVIDENCE.ssCtDraft);
      const profile = steelCatalogProfile('ctSection', size);
      if (profile === undefined) throw new Error(`Missing CT profile ${size}`);
      const [hn, bn, t1n, t2n, rn] = [h, b, t1, t2, r].map(Number);
      const exact = t1n * (hn - t2n) + bn * t2n + (2 - Math.PI / 2) * rn * rn;
      expect(Math.abs(profile.areaMm2 - exact)).toBeLessThan(1e-9 * exact);
      expect(Math.abs(profile.areaMm2 / 100 - Number(area)) / Number(area)).toBeLessThan(5e-4);
      expect(profile).toMatchObject({ width: bn, height: hn, rootRadius: rn, tipRadius: 0, taperDegrees: 0 });
      expect(profile.holes).toEqual([]);
      // 表17 の図: フランジの外面が上、Cx はフランジの外面から重心まで（cm、有効数字 3 桁）。印刷の桁の半分以内。
      const fromFlange = (hn - centroidY(polyline(profile.segments))) / 10;
      const unit = 10 ** (Math.floor(Math.log10(Number(cx))) - 2);
      expect(Math.abs(fromFlange - Number(cx))).toBeLessThanOrEqual(unit / 2 + 1e-6);
    });
});

describe('S-06 CT 形鋼の断面の形（H 形鋼の半分: フランジは一定の厚さ、根元の 2 つの丸み r、ほかの角は丸めない）', () => {
  it.each(CT_ORACLE.rows)('CT %s×%s×%s: 閉じた 1 つの輪で、円弧は根元の半径 r の 2 つだけ', (hb, t1, t2, r) => {
    const profile = steelCatalogProfile('ctSection', sizeOf(hb, t1, t2));
    if (profile === undefined) throw new Error('Missing CT profile');
    const arcs = profile.segments.filter((segment) => segment.kind === 'arc');
    expect(arcs.map((arc) => arc.kind === 'arc' ? arc.radius : 0)).toEqual([Number(r), Number(r)]);
    for (let index = 0; index < profile.segments.length; index++) {
      const current = profile.segments[index], next = profile.segments[(index + 1) % profile.segments.length];
      expect(current.to[0]).toBeCloseTo(next.from[0], 10);
      expect(current.to[1]).toBeCloseTo(next.from[1], 10);
    }
    const [hn, bn, t1n, t2n] = [...hb.split('×'), t1, t2].map(Number);
    const points = profile.segments.flatMap((segment) => [segment.from, segment.to]);
    // ウェブは幅の中央、下の端は y = 0、フランジの下の面は y = H − t2。
    const bottom = [...new Set(points.filter((point) => Math.abs(point[1]) < 1e-12).map((point) => point[0].toFixed(9)))];
    expect(bottom.sort()).toEqual([((bn - t1n) / 2).toFixed(9), ((bn + t1n) / 2).toFixed(9)].sort());
    expect(Math.min(...points.map((point) => point[0]))).toBeCloseTo(0, 12);
    expect(Math.max(...points.map((point) => point[0]))).toBeCloseTo(bn, 12);
    expect(Math.max(...points.map((point) => point[1]))).toBeCloseTo(hn, 12);
    expect(points.some((point) => Math.abs(point[0]) < 1e-12 && Math.abs(point[1] - (hn - t2n)) < 1e-12)).toBe(true);
  });
});
