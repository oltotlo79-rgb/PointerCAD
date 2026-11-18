// 規格資料の出典は規格番号と一般名で照合する。
/**
 * S-03 不等辺山形鋼（JIS G 3192 表9）と S-05 I 形鋼（表11）の独立の転記との突合せ、質量の検算、断面の形の検査。
 *
 * fixture（steelG3192ExtraOracle.fixture.ts）は PDF の文字の流れから読んだ 2 回目の転記で、製品の表
 * （steelRows/g3192ExtraRows.ts、語の座標から読んだ 1 回目）を見ずに作った。
 */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { ALL_STEEL_PRODUCTS, STEEL_CATALOG_REVISION_R2, STEEL_EVIDENCE, steelProducts } from './steelCatalog.js';
import { G3192_EXTRA_ORACLE } from './steelG3192ExtraOracle.fixture.js';
import { steelCatalogProfile } from './steelProfiles/steelCatalogProfile.js';
import { G3192_I_BEAM_ROWS, G3192_UNEQUAL_ANGLE_ROWS } from './steelRows/g3192ExtraRows.js';
import type { SteelProfileSegment } from './steelSectionProfiles.js';

/** 10 進の偶数丸め（JIS Z 8401 の規則A）。 */
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
/** 表6: 単位質量 = 基本質量 0.785 × 断面積（印刷の値）、有効数字 3 桁。 */
function massFromArea(area: string): string {
  return significant(BigInt(area.replace('.', '')) * 785n, 10n ** BigInt(area.split('.')[1]?.length ?? 0) * 1000n, 3);
}
const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / expected;

function expectClosedTangentLoop(segments: readonly SteelProfileSegment[]): void {
  for (let index = 0; index < segments.length; index++) {
    const current = segments[index], next = segments[(index + 1) % segments.length];
    expect(current.to[0]).toBeCloseTo(next.from[0], 10);
    expect(current.to[1]).toBeCloseTo(next.from[1], 10);
    if (current.kind === 'arc') {
      for (const point of [current.from, current.to]) {
        expect(Math.hypot(point[0] - current.center[0], point[1] - current.center[1])).toBeCloseTo(current.radius, 10);
      }
    }
  }
}

describe('JIS G 3192 表9・表11 の独立の転記との突合せ', () => {
  it('表9 の 13 行と表11 の 20 行がそろい、製品の行が一致し、fixture はアプリを読まない', () => {
    expect(G3192_EXTRA_ORACLE.unequalAngle).toHaveLength(13);
    expect(G3192_EXTRA_ORACLE.iBeam).toHaveLength(20);
    expect(G3192_UNEQUAL_ANGLE_ROWS.map((row) => [...row])).toEqual(G3192_EXTRA_ORACLE.unequalAngle.map((row) => [...row]));
    expect(G3192_I_BEAM_ROWS.map((row) => [...row])).toEqual(G3192_EXTRA_ORACLE.iBeam.map((row) => [...row]));
    expect(steelProducts('SS400', 'unequalAngle')).toHaveLength(13);
    expect(steelProducts('SS400', 'iBeam')).toHaveLength(20);
    const text = readFileSync(new URL('./steelG3192ExtraOracle.fixture.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(file.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))).toEqual([]);
    expect(STEEL_EVIDENCE.ssUnequalAngleDraft.reference).toBe(G3192_EXTRA_ORACLE.reference);
    expect(STEEL_EVIDENCE.ssIBeamDraft.reference).toBe(G3192_EXTRA_ORACLE.reference);
  });
});

describe('S-03 不等辺山形鋼 JIS G 3192 表9', () => {
  it.each(G3192_EXTRA_ORACLE.unequalAngle)('L %s×%s×%s: 表6 の式の断面積・単位質量と形の面積が印刷の値に一致する',
    (a, b, t, r1, r2, area, mass, page) => {
      // 表6: t(A+B−t) + 0.215(r1² − 2r2²)、cm² で有効数字 4 桁。寸法は 0.1 mm 単位。
      const [a10, b10, t10, r110, r210] = [a, b, t, r1, r2].map(tenths);
      expect(significant(1000n * t10 * (a10 + b10 - t10) + 215n * (r110 ** 2n - 2n * r210 ** 2n), 10n ** 7n, 4)).toBe(area);
      expect(massFromArea(area)).toBe(mass);
      const size = `L ${a}×${b}×${t}`;
      const product = ALL_STEEL_PRODUCTS.find((row) => row.key === `SS400:unequalAngle:${size}`);
      if (product === undefined) throw new Error(`Missing unequal angle ${size}`);
      expect(product).toMatchObject({ catalog: 'unequalAngle', size, materialGrade: 'SS400', materialStandard: 'JIS G 3101',
        productStandard: 'JIS G 3192', condition: 'hotRolled-heatTreatmentUnspecified', evidence: 'ssUnequalAngleDraft',
        materialEvidence: 'ss400GradeDraft', catalogRevision: STEEL_CATALOG_REVISION_R2, geometry: 'profileSection',
        standardLengthsMm: [6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000],
        standardReferences: { material: 'jis-g-3101-2024', dimensions: 'jis-g-3192-2024' } });
      expect(product.note).toContain(`表9 PDF p${page}`);
      expect(product.profileEvidence).toEqual(STEEL_EVIDENCE.ssUnequalAngleDraft);
      const profile = steelCatalogProfile('unequalAngle', size);
      if (profile === undefined) throw new Error('Missing unequal angle profile');
      // 表9 の図: 長い脚 A は縦（高さ）、脚 B は横（幅）。
      expect(profile).toMatchObject({ width: Number(b), height: Number(a), rootRadius: Number(r1), tipRadius: Number(r2),
        taperDegrees: 0, holes: [] });
      expect(relative(profile.areaMm2 / 100, Number(area))).toBeLessThanOrEqual(5e-4);
      expect(profile.segments.filter((segment) => segment.kind === 'arc')).toHaveLength(3);
      expectClosedTangentLoop(profile.segments);
    });
});

describe('S-05 I 形鋼 JIS G 3192 表11（内面の角度 98°、t2 は (B−t1)/4 の位置）', () => {
  it.each(G3192_EXTRA_ORACLE.iBeam)('I %s×%s×%s×%s: 表6 の式の断面積・単位質量と形の面積が印刷の値に一致する',
    (h, b, t1, t2, r1, r2, area, mass, page) => {
      // 表6: Ht1 + 2t2(B−t1) + 0.615(r1² − r2²)、cm² で有効数字 4 桁。
      const [h10, b10, t110, t210, r110, r210] = [h, b, t1, t2, r1, r2].map(tenths);
      expect(significant(1000n * (h10 * t110 + 2n * t210 * (b10 - t110)) + 615n * (r110 ** 2n - r210 ** 2n), 10n ** 7n, 4))
        .toBe(area);
      expect(massFromArea(area)).toBe(mass);
      const size = `I ${h}×${b}×${t1}×${t2}`;
      const product = ALL_STEEL_PRODUCTS.find((row) => row.key === `SS400:iBeam:${size}`);
      if (product === undefined) throw new Error(`Missing I beam ${size}`);
      expect(product).toMatchObject({ catalog: 'iBeam', size, materialGrade: 'SS400', evidence: 'ssIBeamDraft',
        catalogRevision: STEEL_CATALOG_REVISION_R2, geometry: 'profileSection' });
      expect(product.note).toContain(`表11 PDF p${page}`);
      const profile = steelCatalogProfile('iBeam', size);
      if (profile === undefined) throw new Error('Missing I beam profile');
      expect(profile).toMatchObject({ width: Number(b), height: Number(h), rootRadius: Number(r1), tipRadius: Number(r2),
        taperDegrees: 8, holes: [] });
      expect(relative(profile.areaMm2 / 100, Number(area))).toBeLessThanOrEqual(5e-4);
      const arcs = profile.segments.filter((segment) => segment.kind === 'arc');
      expect(arcs).toHaveLength(8);
      // 98° の角の円弧は 82° を回る。凹の内面の角(r1)と凸のフランジの先(r2)で回る向きが逆。
      for (const arc of arcs) {
        if (arc.kind !== 'arc') continue;
        expect(Math.abs(arc.endAngle - arc.startAngle)).toBeCloseTo(82 * Math.PI / 180, 10);
        expect(arc.endAngle < arc.startAngle).toBe(arc.radius === Number(r1));
      }
      expectClosedTangentLoop(profile.segments);
    });
});
