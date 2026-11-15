/**
 * 材質別の鋼材の表 r2（角形鋼管・一般構造用炭素鋼鋼管・不等辺山形鋼・I 形鋼）の保存・組み立て・断り・規則・
 * 曲げ・切断の一覧。r1 の行の保存と形は変わらない（r1 の凍結の検査は legacySourceFreeze.test.ts と既存の鋼材の検査）。
 */
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import type { AssemblyComponent } from '../types.js';
import {
  buildStandardPart, buildStandardPartFromSource, createStandardPartSource, standardPartNominalVolume,
  standardPartRejection,
} from './buildStandardPart.js';
import { createSteelBend } from './steelBend.js';
import { planSteelBend, steelBendSection } from './steelBendGeometry.js';
import {
  ALL_STEEL_PRODUCTS, STEEL_CATALOG_REVISION, STEEL_CATALOG_REVISION_R2, STEEL_GENERATOR_REVISION, STEEL_MATERIAL_GRADES,
  STEEL_PRODUCTS, STEEL_R2_MATERIAL_GRADES, steelProductFromSource, steelProductOptions, steelProducts,
  steelSectionCatalogs, type SteelProduct,
} from './steelCatalog.js';
import { steelFinishedLength } from './steelFinishedLength.js';
import { STEEL_R2_GRADE_RULES, STEEL_R2_SECTION_CATALOGS, steelGradeRule } from './steelGradeRules.js';
import { steelCatalogProfile } from './steelProfiles/steelCatalogProfile.js';
import { STEEL_STANDARDS } from './steelStandards.js';
import { buildSteelStockList } from './steelStockList.js';

const REPRESENTATIVES = ['STKR400:rectTube:□ 100×100×3.2', 'STKR400:rectTube:□ 150×100×4.5',
  'STK400:steelPipe:φ48.6×2.3', 'SS400:unequalAngle:L 100×75×7', 'SS400:iBeam:I 200×100×7×10'] as const;
function product(key: string): SteelProduct {
  const row = ALL_STEEL_PRODUCTS.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`Missing r2 representative ${key}`);
  return row;
}
const sourceOf = (row: SteelProduct, length = '1000'): StandardPartSource =>
  createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length });
const component = (id: string, input: StandardPartSource): AssemblyComponent => ({ id, name: id, source: input,
  placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false });

describe('r2 の表は r1 の表を変えずに足す', () => {
  it('r1 の 459 行・3 鋼種はそのままで、r2 の 607 行（2026-11-14 の 273 行と 2026-11-15 の 334 行）がその後に続き、鍵が重ならない', () => {
    expect(STEEL_PRODUCTS).toHaveLength(459);
    expect(STEEL_MATERIAL_GRADES).toEqual(['SS400', 'S45C', 'SGP']);
    expect(STEEL_R2_MATERIAL_GRADES).toEqual(['STKR400', 'STK400', 'SSC400', 'SUS304TP']);
    expect(ALL_STEEL_PRODUCTS.slice(0, 459)).toEqual(STEEL_PRODUCTS);
    const r2 = ALL_STEEL_PRODUCTS.slice(459);
    expect(r2).toHaveLength(607);
    expect(r2.every((row) => row.catalogRevision === STEEL_CATALOG_REVISION_R2)).toBe(true);
    expect(STEEL_PRODUCTS.every((row) => row.catalogRevision === undefined)).toBe(true);
    expect(new Set(ALL_STEEL_PRODUCTS.map((row) => row.key)).size).toBe(1066);
    expect(steelSectionCatalogs('STKR400')).toEqual(['rectTube']);
    expect(steelSectionCatalogs('STK400')).toEqual(['steelPipe']);
    expect(steelSectionCatalogs('SS400').slice(-3)).toEqual(['unequalAngle', 'iBeam', 'ctSection']);
    expect(steelSectionCatalogs('SSC400')).toEqual(['lightChannel', 'lightZ', 'lightAngle', 'lipChannel', 'lipZ', 'hatSection']);
    expect(steelSectionCatalogs('SUS304TP')).toEqual(['steelPipe']);
    expect(steelProducts('SGP')).toHaveLength(48);
    // 2026-11-14 の 273 行は同じ並びのまま先頭に残る（鍵・6 項目・版は変えない）。
    expect(r2.slice(0, 273).map((row) => row.materialGrade + ':' + row.catalog).filter((pair, index, all) =>
      all.indexOf(pair) === index)).toEqual(['STKR400:rectTube', 'STK400:steelPipe', 'SS400:unequalAngle', 'SS400:iBeam']);
  });
});

describe('r2 の行の保存と組み立て', () => {
  it.each(REPRESENTATIVES)('%s: r2 の版で保存し、同じ行に戻り、形と体積が断面の面積 × 長さになる', (key) => {
    const row = product(key);
    const source = sourceOf(row, '1500');
    expect(source).toEqual({ kind: 'standardPart', catalog: row.catalog, size: row.size,
      options: { ...steelProductOptions(row), length: '1500' },
      catalogRevision: STEEL_CATALOG_REVISION_R2, generatorRevision: STEEL_GENERATOR_REVISION });
    expect(steelProductFromSource(source)).toBe(row);
    expect(standardPartRejection(source)).toBeNull();
    const part = buildStandardPartFromSource(source);
    if (part === null) throw new Error(`r2 part did not build: ${key}`);
    expect(part.steelStockSource).toEqual(source);
    expect(part.name).toBe(`${row.materialGrade} ${row.size} 長さ1500`);
    expect(buildStandardPart(row.catalog, row.size, source.options)).toEqual(part);
    const profile = steelCatalogProfile(row.catalog, row.size);
    const area = profile?.areaMm2 ?? Math.PI * ((row.dimensions?.outsideDiameter ?? 0) ** 2
      - ((row.dimensions?.outsideDiameter ?? 0) - 2 * (row.dimensions?.wallThickness ?? 0)) ** 2) / 4;
    expect(standardPartNominalVolume(row.catalog, row.size, source.options)).toBeCloseTo(area * 1500, 6);
    expect(steelFinishedLength(part, source)).toBe(1500);
    const hollow = row.catalog === 'rectTube' || row.catalog === 'steelPipe';
    expect(part.solids.map((feature) => feature.kind)).toEqual(hollow
      ? [row.catalog === 'rectTube' ? 'extrude' : 'primitive', row.catalog === 'rectTube' ? 'extrude' : 'primitive', 'boolean']
      : ['extrude']);
  });

  it('角形鋼管は外の輪と内の輪の 2 つの面を押し出し、内を外から引く', () => {
    const part = buildStandardPartFromSource(sourceOf(product('STKR400:rectTube:□ 100×100×3.2')));
    if (part === null) throw new Error('rect tube did not build');
    const faces = part.sketches[0]?.features.filter((feature) => feature.kind === 'face') ?? [];
    expect(faces).toHaveLength(2);
    const [outer, inner, hollow] = part.solids;
    expect(hollow).toMatchObject({ kind: 'boolean', operation: 'subtract', targetFeatureId: outer.id, toolFeatureId: inner.id });
  });

  it('版の取り違え・r2 の行の古い台本・鍵の改ざんは型付きの理由で断り、組まない', () => {
    const row = product('STKR400:rectTube:□ 100×100×3.2');
    const source = sourceOf(row);
    const cases: readonly [StandardPartSource, string][] = [
      [{ ...source, catalogRevision: STEEL_CATALOG_REVISION }, 'unsupported-catalog-revision'],
      [{ ...source, generatorRevision: '2-steel-1' }, 'unsupported-generator-revision'],
      [{ ...source, catalogRevision: 'jp-steel-future' }, 'unsupported-catalog-revision'],
      [{ ...source, options: { ...source.options, materialGrade: 'SS400', steelProduct: 'forged' } }, 'pipe-outside-scope'],
      [{ ...source, options: { ...source.options, condition: 'hotRolled-heatTreatmentUnspecified' } }, 'saved-fields-mismatch'],
      [{ ...source, options: { ...source.options, length: '12001' } }, 'invalid-steel-length'],
    ];
    for (const [tampered, code] of cases) {
      expect(standardPartRejection(tampered)?.code, code).toBe(code);
      expect(buildStandardPartFromSource(tampered)).toBeNull();
    }
    // r1 の行を r2 の版で保存しても r1 の行には戻らない。
    const r1 = STEEL_PRODUCTS[0];
    const r1Source = createStandardPartSource(r1.catalog, r1.size, steelProductOptions(r1));
    expect(r1Source.catalogRevision).toBe(STEEL_CATALOG_REVISION);
    expect(standardPartRejection({ ...r1Source, catalogRevision: STEEL_CATALOG_REVISION_R2 })?.code)
      .toBe('unsupported-catalog-revision');
    expect(steelProductFromSource({ ...r1Source, catalogRevision: STEEL_CATALOG_REVISION_R2 })).toBeUndefined();
  });
});

describe('r2 の鋼種と断面の規則', () => {
  const r2Pairs = [
    ...(['SS400', 'S45C', 'SGP'] as const).flatMap((grade) => STEEL_R2_SECTION_CATALOGS.map((catalog) => ({ grade, catalog }))),
    ...STEEL_R2_MATERIAL_GRADES.flatMap((grade) => (['flatBar', 'roundBar', 'equalAngle', 'channel', 'hBeam', 'steelPipe',
      ...STEEL_R2_SECTION_CATALOGS] as const).map((catalog) => ({ grade, catalog }))),
  ];

  it('許すのは SS400 の不等辺山形鋼・I 形鋼・CT 形鋼、STKR400 の角形鋼管、STK400 の鋼管、SSC400 の軽量形鋼 6 つ、SUS304TP の鋼管だけで、行の組合せと一致する', () => {
    expect(STEEL_R2_SECTION_CATALOGS).toEqual(['rectTube', 'unequalAngle', 'iBeam',
      'lightChannel', 'lightZ', 'lightAngle', 'lipChannel', 'lipZ', 'hatSection', 'ctSection']);
    expect(Object.entries(STEEL_R2_GRADE_RULES).map(([grade, rules]) => [grade, Object.keys(rules).length]))
      .toEqual([['SS400', 10], ['S45C', 10], ['SGP', 10], ['STKR400', 16], ['STK400', 16], ['SSC400', 16], ['SUS304TP', 16]]);
    const pairs = r2Pairs.map(({ grade, catalog }) => [`${grade}:${catalog}`, steelGradeRule(grade, catalog).allowed] as const);
    expect(pairs).toHaveLength(3 * 10 + 4 * 16);
    const allowedPairs = ['SS400:ctSection', 'SS400:iBeam', 'SS400:unequalAngle', 'SSC400:hatSection', 'SSC400:lightAngle',
      'SSC400:lightChannel', 'SSC400:lightZ', 'SSC400:lipChannel', 'SSC400:lipZ', 'STK400:steelPipe', 'STKR400:rectTube',
      'SUS304TP:steelPipe'];
    expect(pairs.filter(([, allowed]) => allowed).map(([pair]) => pair).sort()).toEqual(allowedPairs);
    const actual = [...new Set(ALL_STEEL_PRODUCTS.slice(459).map((row) => `${row.materialGrade}:${row.catalog}`))].sort();
    expect(actual).toEqual(allowedPairs);
    for (const row of ALL_STEEL_PRODUCTS.slice(459)) {
      const rule = steelGradeRule(row.materialGrade, row.catalog);
      expect(rule.allowed, row.key).toBe(true);
      expect(rule.basis.map((citation) => citation.standardId)).toEqual(expect.arrayContaining([
        row.standardReferences.material, row.standardReferences.dimensions]));
    }
  });

  it.each(r2Pairs.filter(({ grade, catalog }) => !steelGradeRule(grade, catalog).allowed))(
    '$grade / $catalog は鋼種と規格の名前を含む理由で断る', ({ grade, catalog }) => {
      const rule = steelGradeRule(grade, catalog);
      if (rule.allowed) throw new Error('expected a denial');
      expect(rule.reason).toContain(grade);
      for (const citation of rule.basis) {
        expect(rule.reason).toContain(STEEL_STANDARDS[citation.standardId].number);
        expect(citation.locator.trim().length).toBeGreaterThan(0);
      }
    });
});

describe('r2 の断面の曲げと切断の一覧', () => {
  it.each(['STKR400:rectTube:□ 100×100×3.2', 'STK400:steelPipe:φ48.6×2.3', 'SS400:unequalAngle:L 100×75×7'])(
    '%s: 曲げの断面と、図心の道の長さと購入長が等しい曲げ部品を作る', (key) => {
      const row = product(key);
      const section = steelBendSection(row);
      if (section === null) throw new Error('missing bend section');
      const hollow = row.catalog !== 'unequalAngle';
      expect(section.loops).toHaveLength(hollow ? 2 : 1);
      if (row.catalog === 'rectTube') expect(section.centroid.map((value) => value.toFixed(9))).toEqual(['50.000000000', '50.000000000']);
      const dimensions = { radius: 300, radiusConvention: 'inside', angleDegrees: 90, firstLeg: 200, secondLeg: 200,
        legDimension: 'tangent' } as const;
      const plan = planSteelBend(section, dimensions);
      if (!plan.ok) throw new Error(`bend plan failed: ${plan.reason}`);
      const bent = createSteelBend(sourceOf(row, String(plan.geometry.centrelineLengthMm)), dimensions);
      if (!bent.ok) throw new Error(`bend failed: ${bent.reason}`);
      expect(bent.document.solids.filter((feature) => feature.kind === 'sweep')).toHaveLength(hollow ? 2 : 1);
      expect(bent.document.solids.some((feature) => feature.kind === 'boolean')).toBe(hollow);
    });

  it('角形鋼管・STK・I 形鋼を r2 の版の行として数え、r1 の行と分ける', () => {
    const rect = product('STKR400:rectTube:□ 100×100×3.2');
    const pipe = product('STK400:steelPipe:φ48.6×2.3');
    const beam = product('SS400:iBeam:I 200×100×7×10');
    const assembly = { ...createAssemblyDocument('r2 stock'), components: [
      component('rect-a', sourceOf(rect)), component('rect-b', sourceOf(rect)),
      component('pipe', sourceOf(pipe, '2000')), component('beam', sourceOf(beam, '3000')),
      component('sgp', sourceOf(STEEL_PRODUCTS.find((row) => row.key === 'SGP:steelPipe:15A') ?? STEEL_PRODUCTS[0])),
    ] };
    const result = buildSteelStockList(assembly);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => [row.product.key, row.catalogRevision, row.lengthMm, row.quantity])).toEqual([
      [rect.key, STEEL_CATALOG_REVISION_R2, 1000, 2],
      [pipe.key, STEEL_CATALOG_REVISION_R2, 2000, 1],
      [beam.key, STEEL_CATALOG_REVISION_R2, 3000, 1],
      ['SGP:steelPipe:15A', STEEL_CATALOG_REVISION, 1000, 1],
    ]);
  });
});

describe('r2 に 2026-11-15 に足した行（軽量形鋼・CT 形鋼・SUS304TP の鋼管）の保存・組み立て・曲げ・切断の一覧', () => {
  const K3_REPRESENTATIVES = ['SSC400:lightChannel:[ 100×50×50×2.3', 'SSC400:lightZ:Z 75×40×30×2.3',
    'SSC400:lightAngle:L 75×30×3.2', 'SSC400:lipChannel:C 100×50×20×2.3', 'SSC400:lipZ:Z 100×50×20×3.2',
    'SSC400:hatSection:ハット 60×30×25×2.3', 'SS400:ctSection:CT 100×200×8×12', 'SUS304TP:steelPipe:25A×Sch10S',
    'SUS304TP:steelPipe:φ34.0×2.0'] as const;

  it.each(K3_REPRESENTATIVES)('%s: r2 の版で保存し、同じ行に戻り、形と体積が断面の面積 × 長さになる', (key) => {
    const row = product(key);
    const source = sourceOf(row, '1500');
    expect(source).toEqual({ kind: 'standardPart', catalog: row.catalog, size: row.size,
      options: { ...steelProductOptions(row), length: '1500' },
      catalogRevision: STEEL_CATALOG_REVISION_R2, generatorRevision: STEEL_GENERATOR_REVISION });
    expect(steelProductFromSource(source)).toBe(row);
    expect(standardPartRejection(source)).toBeNull();
    const part = buildStandardPartFromSource(source);
    if (part === null) throw new Error(`r2 part did not build: ${key}`);
    expect(part.name).toBe(`${row.materialGrade} ${row.size} 長さ1500`);
    expect(buildStandardPart(row.catalog, row.size, source.options)).toEqual(part);
    const pipe = row.catalog === 'steelPipe';
    const profile = steelCatalogProfile(row.catalog, row.size);
    expect(profile === undefined).toBe(pipe);
    const outside = row.dimensions?.outsideDiameter ?? 0, wall = row.dimensions?.wallThickness ?? 0;
    const area = profile?.areaMm2 ?? Math.PI * (outside ** 2 - (outside - 2 * wall) ** 2) / 4;
    expect(standardPartNominalVolume(row.catalog, row.size, source.options)).toBeCloseTo(area * 1500, 6);
    expect(steelFinishedLength(part, source)).toBe(1500);
    expect(part.solids.map((feature) => feature.kind)).toEqual(pipe ? ['primitive', 'primitive', 'boolean'] : ['extrude']);
  });

  it('新しい鋼種と断面の組合せの取り違えは型付きの理由で断る', () => {
    const lip = product('SSC400:lipChannel:C 100×50×20×2.3');
    const source = sourceOf(lip);
    expect(standardPartRejection({ ...source, options: { ...source.options, materialGrade: 'SS400', steelProduct: 'forged' } })?.code)
      .toBe('section-outside-scope');
    const sus = product('SUS304TP:steelPipe:25A×Sch10S');
    expect(standardPartRejection({ ...sourceOf(sus), catalogRevision: STEEL_CATALOG_REVISION })?.code)
      .toBe('unsupported-catalog-revision');
    expect(standardPartRejection({ ...sourceOf(sus), options: { ...sourceOf(sus).options, condition: 'structuralPipe-plainEnds' } })?.code)
      .toBe('saved-fields-mismatch');
  });

  it.each(['SSC400:lipChannel:C 100×50×20×2.3', 'SS400:ctSection:CT 100×200×8×12', 'SUS304TP:steelPipe:25A×Sch10S'])(
    '%s: 曲げの断面と、図心の道の長さと購入長が等しい曲げ部品を作る', (key) => {
      const row = product(key);
      const section = steelBendSection(row);
      if (section === null) throw new Error('missing bend section');
      const hollow = row.catalog === 'steelPipe';
      expect(section.loops).toHaveLength(hollow ? 2 : 1);
      const dimensions = { radius: 300, radiusConvention: 'inside', angleDegrees: 90, firstLeg: 200, secondLeg: 200,
        legDimension: 'tangent' } as const;
      const plan = planSteelBend(section, dimensions);
      if (!plan.ok) throw new Error(`bend plan failed: ${plan.reason}`);
      const bent = createSteelBend(sourceOf(row, String(plan.geometry.centrelineLengthMm)), dimensions);
      if (!bent.ok) throw new Error(`bend failed: ${bent.reason}`);
      expect(bent.document.solids.filter((feature) => feature.kind === 'sweep')).toHaveLength(hollow ? 2 : 1);
      expect(bent.document.solids.some((feature) => feature.kind === 'boolean')).toBe(hollow);
    });

  it('軽量形鋼・CT 形鋼・SUS304TP の鋼管を r2 の版の行として数える', () => {
    const keys = ['SSC400:lipChannel:C 100×50×20×2.3', 'SS400:ctSection:CT 100×200×8×12', 'SUS304TP:steelPipe:25A×Sch10S'];
    const assembly = { ...createAssemblyDocument('r2 k3 stock'), components: keys.map((key, index) =>
      component(`c${index}`, sourceOf(product(key), String(1000 * (index + 1))))) };
    const result = buildSteelStockList(assembly);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => [row.product.key, row.catalogRevision, row.lengthMm, row.quantity]))
      .toEqual(keys.map((key, index) => [key, STEEL_CATALOG_REVISION_R2, 1000 * (index + 1), 1]));
  });
});
