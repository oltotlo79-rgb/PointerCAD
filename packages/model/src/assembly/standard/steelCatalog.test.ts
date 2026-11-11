import { H_BEAM_ADDITION_EDITION_ORACLE } from './steelHBeamOracle.fixture.js';
import { SECTION_ADDITION_EDITION_ORACLE } from './steelAngleChannelOracle.fixture.js';
import { SS400_EXPANSION_EDITION_ORACLE } from './steelCatalogOracle.fixture.js';
import { STEEL_STANDARDS } from './steelStandards.js';
import { STEEL_GRADE_RULES } from './steelGradeRules.js';
import type { SteelProduct } from './steelCatalog.js';
import { describe, expect, it } from 'vitest';

import { liveBodyIds } from '../../part/createPartDocument.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { partKeyOf } from '../resolveAssembly.js';
import {
  buildStandardPart, buildStandardPartFromSource, changeStandardSize, createStandardPartSource,
  standardPartNominalVolume,
} from './buildStandardPart.js';
import {
  findSteelProduct, STEEL_CATALOG_REVISION, STEEL_EVIDENCE, STEEL_GENERATOR_REVISION,
  STEEL_PRODUCTS, steelLength, steelProductOptions, steelProductFromSource, steelProducts, steelSectionCatalogs,
} from './steelCatalog.js';
import { buildSteelStockList } from './steelStockList.js';
import { STANDARD_CATALOG_REVISION, STANDARD_PART_GENERATOR_REVISION } from './types.js';

function product(grade: 'SS400' | 'S45C' | 'SGP', catalog: 'flatBar' | 'roundBar' | 'steelPipe') {
  const row = steelProducts(grade, catalog)[0];
  if (row === undefined) throw new Error('Missing steel fixture');
  return row;
}

describe('material-compatible steel catalog', () => {
  it('keeps black and white SGP source identities separate while generating the same nominal shape', () => {
    const black = steelProducts('SGP').find((row) => row.key === 'SGP:steelPipe:100A');
    const white = steelProducts('SGP').find((row) => row.key === 'SGP:steelPipe:100A:whitePipe-zincCoated');
    if (black === undefined || white === undefined) throw new Error('Missing black/white SGP pair');
    const sources = [black, white].map((row) => createStandardPartSource(row.catalog, row.size,
      { ...steelProductOptions(row), length: '100' }));
    expect(partKeyOf(sources[0])).not.toBe(partKeyOf(sources[1]));
    expect(standardPartNominalVolume(black.catalog, black.size, sources[0].options))
      .toBe(standardPartNominalVolume(white.catalog, white.size, sources[1].options));
    for (const row of [black, white]) {
      expect(findSteelProduct(row.catalog, row.size, { ...steelProductOptions(row),
        condition: row === black ? white.condition : black.condition })).toBeUndefined();
      const source = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '100' });
      const make = { id: 'pipe', name: 'pipe', source, placement: DEFAULT_COMPONENT_PLACEMENT,
        fixed: false, visible: true, suppressed: false };
      const replacement = changeStandardSize({ ...createAssemblyDocument('SGP'), components: [make] },
        'pipe', '500A', { bodies: [] });
      expect(replacement?.nextSource).toMatchObject({ size: '500A', options: { condition: row.condition, length: '100' } });
    }
  });
  it('offers an explicit producer-backed matrix rather than every grade/shape combination', () => {
    expect(STEEL_PRODUCTS).toHaveLength(459);
    expect(new Set(STEEL_PRODUCTS.map((row) => row.key)).size).toBe(459);
    expect(steelSectionCatalogs('SS400')).toEqual(['flatBar', 'roundBar', 'equalAngle', 'channel', 'hBeam']);
    expect(steelSectionCatalogs('S45C')).toEqual(['roundBar', 'flatBar']);
    expect(steelSectionCatalogs('SGP')).toEqual(['steelPipe']);
    expect(steelProducts('S45C', 'hBeam')).toEqual([]);
    expect(steelProducts('SS400', 'steelPipe')).toEqual([]);
    for (const row of STEEL_PRODUCTS) {
      expect(STEEL_EVIDENCE[row.evidence].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(findSteelProduct(row.catalog, row.size, steelProductOptions(row))).toBe(row);
    }
  });

  it('ties each stated product standard to a pinned source without persisting it or claiming final JIS verification', () => {
    // Independent expectations: which producer page states which standard (task240/241 reconciled evidence).
    const expected = new Map<string, readonly [string, string]>([
      ['JIS G 3194:flatBar', ['PDF p6 JIS G 3194', '07cca88a466a190142c87b74eb6c53c3c72e0c66433d3e120e2af497512b7dea']],
      ['JIS G 3192:equalAngle', ['PDF p26（冊子p24）', '031d35df73d5681c7ad7cb721eea4838e80624c9ca7092a69c8e83641c5d65de']],
      ['JIS G 3192:channel', ['PDF p26（冊子p24）', '031d35df73d5681c7ad7cb721eea4838e80624c9ca7092a69c8e83641c5d65de']],
      ['JIS G 3192:hBeam', ['PDF p9 ', '69774143c7a64e457b72f06cc4180f2b3a2bb3cc82aadebb347f3543fa8d6a22']],
      ['JIS G 3123:roundBar', ['公差表（JIS G 3123）', '63430ac1b24c555dbe09796a706cdfd75b77e12c727fe064e5d4db63917480eb']],
      ['JIS G 3123:flatBar', ['公差表（JIS G 3123）', '63430ac1b24c555dbe09796a706cdfd75b77e12c727fe064e5d4db63917480eb']],
    ]);
    for (const row of STEEL_PRODUCTS) {
      const target = expected.get(`${row.productStandard}:${row.catalog}`);
      if (target === undefined) {
        // The dimensional source itself states these product/dimension standards (SS400 flat/round, SGP).
        expect(row.productStandardEvidence, row.key).toBeUndefined();
        continue;
      }
      expect(row.productStandardEvidence?.locator, row.key).toContain(target[0]);
      expect(row.productStandardEvidence?.locator, row.key).toContain(row.productStandard);
      expect(row.productStandardEvidence?.sha256, row.key).toBe(target[1]);
      // Producer editions or a draft with no final edition claim.
      expect([null, '2025.12'], row.key).toContain(row.productStandardEvidence?.edition);
      // Saved options and lookups are unchanged, so existing saved parts keep resolving.
      expect(Object.keys(steelProductOptions(row)), row.key)
        .toEqual(['steelProduct', 'materialGrade', 'materialStandard', 'productStandard', 'condition', 'evidence']);
    }
    expect(STEEL_PRODUCTS.filter((row) => row.productStandardEvidence !== undefined)).toHaveLength(326);
  });

  it.each(['0', '-1', '0.999', '12000.001', '1/', '1e999'])('rejects out-of-range/nonfinite length %s', (value) => {
    expect(steelLength(value)).toBeNull();
  });
  it.each(['1', '12000', '500*2'])('accepts bounded length expressions %s', (value) => {
    expect(steelLength(value)?.source).toBe(value);
  });

  it.each(STEEL_PRODUCTS)('$key creates a deterministic, single live body with the requested length', (row) => {
    const options = { ...steelProductOptions(row), length: '500*2' };
    const source = createStandardPartSource(row.catalog, row.size, options);
    expect(source).toMatchObject({ catalogRevision: STEEL_CATALOG_REVISION,
      generatorRevision: STEEL_GENERATOR_REVISION, options });
    const document = buildStandardPartFromSource(source);
    expect(document).not.toBeNull();
    expect(document).toEqual(buildStandardPartFromSource(source));
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
    for (const feature of document?.solids ?? []) {
      if (feature.kind === 'extrude') expect(feature.distance).toMatchObject({ source: '500*2', value: 1000 });
      if (feature.kind === 'primitive' && feature.shape.kind === 'cylinder') {
        expect(feature.shape.height).toMatchObject({ source: '500*2', value: 1000 });
      }
    }
    expect(standardPartNominalVolume(row.catalog, row.size, options)).toBeGreaterThan(0);
  });

  it('creates a hollow SGP pipe with independent outside/inside diameters and subtract', () => {
    const row = product('SGP', 'steelPipe');
    const options = { ...steelProductOptions(row), length: '100' };
    const document = buildStandardPart(row.catalog, row.size, options);
    expect(document?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
    expect(document?.solids[0]).toMatchObject({ shape: { kind: 'cylinder', radius: { value: 10.85 } } });
    expect(document?.solids[1]).toMatchObject({ shape: { kind: 'cylinder', radius: { value: 8.05 } } });
    expect(document?.solids[2]).toMatchObject({ operation: 'subtract' });
    expect(standardPartNominalVolume(row.catalog, row.size, options))
      .toBeCloseTo(Math.PI * (10.85 ** 2 - 8.05 ** 2) * 100, 8);
  });

  it('creates the producer nominal flat and round cross-sections without inferred strength', () => {
    const flat = product('SS400', 'flatBar');
    expect(standardPartNominalVolume(flat.catalog, flat.size,
      { ...steelProductOptions(flat), length: '100' })).toBe(50 * 6 * 100);
    const round = product('S45C', 'roundBar');
    expect(createStandardPartSource(round.catalog, round.size, steelProductOptions(round)).options.length).toBe('1000');
    expect(buildStandardPart(round.catalog, round.size, steelProductOptions(round))?.solids[0])
      .toMatchObject({ shape: { kind: 'cylinder', radius: { value: 10 }, height: { value: 1000 } } });
    expect(standardPartNominalVolume(round.catalog, round.size,
      { ...steelProductOptions(round), length: '100' })).toBeCloseTo(Math.PI * 10 ** 2 * 100, 8);
  });

  it.each(['materialGrade', 'materialStandard', 'productStandard', 'condition', 'evidence', 'steelProduct'])(
    'rejects a changed persisted %s rather than silently regenerating a different product', (field) => {
      const row = product('S45C', 'roundBar');
      const options = { ...steelProductOptions(row), [field]: 'SS400' };
      expect(buildStandardPart(row.catalog, row.size, options)).toBeNull();
      expect(standardPartNominalVolume(row.catalog, row.size, options)).toBeNull();
    });

  it('rejects missing metadata, unsupported options, versions, size and grade/shape mismatches', () => {
    const row = product('SGP', 'steelPipe');
    const source = createStandardPartSource(row.catalog, row.size, steelProductOptions(row));
    expect(buildStandardPart('steelPipe', '15A')).toBeNull();
    expect(buildStandardPartFromSource({ ...source, size: '999A' })).toBeNull();
    expect(buildStandardPartFromSource({ ...source, generatorRevision: 'unknown' })).toBeNull();
    expect(buildStandardPartFromSource({ ...source, catalogRevision: STANDARD_CATALOG_REVISION,
      generatorRevision: STANDARD_PART_GENERATOR_REVISION })).toBeNull();
    expect(buildStandardPartFromSource({ ...source, options: { ...source.options, heatTreatment: 'quenched' } })).toBeNull();
    expect(buildStandardPart('hBeam', 'H 150×150×7×10', steelProductOptions(product('S45C', 'roundBar')))).toBeNull();
    expect(buildStandardPartFromSource(createStandardPartSource('hexBolt', 'M8',
      steelProductOptions(product('S45C', 'roundBar'))))).toBeNull();
  });

  it('retains old revisions, dimensions, names and positive lengths without assigning a grade', () => {
    const source = createStandardPartSource('equalAngle', 'L 50×50×6', { length: '0.5' });
    expect(source.catalogRevision).toBe(STANDARD_CATALOG_REVISION);
    expect(source.generatorRevision).toBe(STANDARD_PART_GENERATOR_REVISION);
    expect(source.options).toEqual({ length: '0.5' });
    expect(buildStandardPartFromSource(source)).toEqual(buildStandardPart('equalAngle', 'L 50×50×6', { length: '0.5' }));
    expect(buildStandardPartFromSource(source)?.name).toBe('L 50×50×6 長さ0.5');
    // r1 did not interpret these arbitrary options as a grade or manufacturing certificate.
    expect(buildStandardPartFromSource({ ...source, options: { ...source.options,
      condition: 'old-custom-metadata', materialGrade: 'old-user-note' } }))
      .toEqual(buildStandardPartFromSource(source));
    expect(standardPartNominalVolume('equalAngle', source.size, { length: '1000' })).toBe(564000);
  });

  it('distinguishes SS400 and S45C round bars at the same nominal diameter in assembly source keys', () => {
    const ss = steelProducts('SS400', 'roundBar').find((row) => row.size === 'φ25');
    const carbon = steelProducts('S45C', 'roundBar').find((row) => row.size === 'φ25');
    if (ss === undefined || carbon === undefined) throw new Error('Missing shared diameter');
    expect(partKeyOf(createStandardPartSource(ss.catalog, ss.size, steelProductOptions(ss))))
      .not.toBe(partKeyOf(createStandardPartSource(carbon.catalog, carbon.size, steelProductOptions(carbon))));
  });

  it('changes only to a confirmed size of the same material/condition and retains the length expression', () => {
    const row = product('S45C', 'roundBar');
    const source = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '50*2' });
    const assembly = { ...createAssemblyDocument('組立'), components: [{ id: 'component-1', name: '丸鋼',
      source, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false }] };
    const plan = changeStandardSize(assembly, 'component-1', 'φ25', { bodies: [] });
    expect(plan?.nextSource).toMatchObject({ size: 'φ25', options: { materialGrade: 'S45C', length: '50*2' } });
    expect(plan?.nextSource.kind === 'standardPart' ? buildStandardPartFromSource(plan.nextSource) : null).not.toBeNull();
    expect(changeStandardSize(assembly, 'component-1', 'φ13', { bodies: [] })).toBeNull();
  });
});

describe('profile version provenance and stock-list compatibility', () => {
  it.each(STEEL_PRODUCTS.filter((row) => row.geometry === 'profileSection'))('$key keeps old and new geometry provenance separate', (row) => {
    const current = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '100' });
    const old = { ...current, generatorRevision: '2-steel-1' };
    expect(steelProductFromSource(current)?.geometry).toBe('profileSection');
    expect(steelProductFromSource(current)?.profileEvidence?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(steelProductFromSource(old)?.geometry).toBe('simplifiedSection');
    expect(steelProductFromSource(old)?.profileEvidence).toBeUndefined();
    // The product standard is a property of the product, not of the generated geometry: both revisions keep it.
    expect(steelProductFromSource(old)?.productStandardEvidence).toEqual(row.productStandardEvidence);
    expect(steelProductFromSource(old)?.productStandardEvidence?.locator).toContain('JIS G 3192');
    expect(partKeyOf(current)).not.toBe(partKeyOf(old));
    const make = (id: string, source: typeof current) => ({ id, name: id, source,
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false });
    const child = { ...createAssemblyDocument('Child'), components: [make('old', old), make('new', current)] };
    const assembly = { ...createAssemblyDocument('Versions'), components: [
      { ...make('a', current), source: { kind: 'subAssembly' as const, assemblyRef: 'child' } },
      { ...make('b', current), source: { kind: 'subAssembly' as const, assemblyRef: 'child' } },
    ] };
    const stock = buildSteelStockList(assembly, new Map([['child', child]]));
    expect(stock.issues).toEqual([]);
    expect(stock.rows).toHaveLength(2);
    expect(stock.rows.map((item) => item.quantity)).toEqual([2, 2]);
    expect(stock.totalLengthMm).toBe(400);
    // Reports read the saved revisions directly, never by parsing the grouping key.
    expect(stock.rows.map((item) => [item.catalogRevision, item.generatorRevision, item.product.geometry]))
      .toEqual([[STEEL_CATALOG_REVISION, '2-steel-1', 'simplifiedSection'],
        [STEEL_CATALOG_REVISION, STEEL_GENERATOR_REVISION, 'profileSection']]);
    const next = STEEL_PRODUCTS.find((item) => item.catalog === row.catalog && item.size !== row.size);
    if (next === undefined) throw new Error('Missing other compatible section size');
    const replacement = changeStandardSize({ ...createAssemblyDocument('Old'), components: [make('old', old)] },
      'old', next.size, { bodies: [] });
    expect(replacement?.nextSource).toEqual({ ...old, size: next.size,
      options: { ...steelProductOptions(next), length: '100' } });
    expect(replacement?.nextSource.kind === 'standardPart'
      ? buildStandardPartFromSource(replacement.nextSource)?.sketches[0].features.some((feature) => feature.kind === 'arc')
      : 'wrong-kind').toBe(false);
  });
});

/** Independent transcription: EX-03 gap-report §2.1 and sources §1/§2/§4 (2026-10-24).
 * These expected numbers, editions, statuses and keys are not obtained from the product ledger.
 */
const SS400_EDITION_ORACLE = [
  ['SS400:flatBar:FB 50×6', '王子製鉄 公表断面寸法', 'JIS G 3194', '2024'],
  ['SS400:flatBar:FB 50×9', '王子製鉄 公表断面寸法', 'JIS G 3194', '2024'],
  ['SS400:flatBar:FB 50×12', '王子製鉄 公表断面寸法', 'JIS G 3194', '2024'],
  ['SS400:flatBar:FB 100×6', '王子製鉄 公表断面寸法', 'JIS G 3194', '2024'],
  ['SS400:flatBar:FB 100×9', '王子製鉄 公表断面寸法', 'JIS G 3194', '2024'],
  ['SS400:roundBar:φ13', '大阪製鐵 公表丸鋼寸法', 'JIS G 3191', '2022'],
  ['SS400:roundBar:φ16', '大阪製鐵 公表丸鋼寸法', 'JIS G 3191', '2022'],
  ['SS400:roundBar:φ19', '大阪製鐵 公表丸鋼寸法', 'JIS G 3191', '2022'],
  ['SS400:roundBar:φ22', '大阪製鐵 公表丸鋼寸法', 'JIS G 3191', '2022'],
  ['SS400:roundBar:φ25', '大阪製鐵 公表丸鋼寸法', 'JIS G 3191', '2022'],
  ['SS400:equalAngle:L 40×40×5', 'JIS G 3192', 'JIS G 3192', '2024'],
  ['SS400:equalAngle:L 50×50×6', 'JIS G 3192', 'JIS G 3192', '2024'],
  ['SS400:equalAngle:L 65×65×6', 'JIS G 3192', 'JIS G 3192', '2024'],
  ['SS400:channel:[ 75×40×5×7', 'JIS G 3192', 'JIS G 3192', '2024'],
  ['SS400:channel:[ 100×50×5×7.5', 'JIS G 3192', 'JIS G 3192', '2024'],
  ['SS400:channel:[ 125×65×6×8', 'JIS G 3192', 'JIS G 3192', '2024'],
  ['SS400:hBeam:H 150×150×7×10', 'JIS G 3192', 'JIS G 3192', '2024'],
  ['SS400:hBeam:H 200×200×8×12', 'JIS G 3192', 'JIS G 3192', '2024'],
  ['SS400:hBeam:H 300×300×10×15', 'JIS G 3192', 'JIS G 3192', '2024'],
] as const;

function assertSS400Editions(rows: readonly Pick<SteelProduct,
  'key' | 'materialStandard' | 'productStandard' | 'standardEdition'>[]): void {
  expect(STEEL_CATALOG_REVISION).toBe('jp-steel-2026-10-10-r1');
  expect(rows.map((row) => [row.key, row.materialStandard, row.productStandard,
    row.standardEdition.material.number, row.standardEdition.material.edition, row.standardEdition.material.verification,
    row.standardEdition.dimensions.number, row.standardEdition.dimensions.edition, row.standardEdition.dimensions.verification]))
    .toEqual([...SS400_EDITION_ORACLE, ...SS400_EXPANSION_EDITION_ORACLE, ...SECTION_ADDITION_EDITION_ORACLE, ...H_BEAM_ADDITION_EDITION_ORACLE].map(([key, productStandard, number, edition]) => [key, 'JIS G 3101', productStandard,
      'JIS G 3101', '2024', 'draft', number, edition, 'draft']));
}

describe('non-persisted steel standard editions', () => {
  it('matches all 253 SS400 rows against independent standard, edition, status and catalog revision constants', () => {
    assertSS400Editions(steelProducts('SS400'));
  });

  it.each(STEEL_PRODUCTS)('$key derives both editions from the ledger without adding saved options', (row) => {
    expect(row.standardEdition.material).toBe(STEEL_STANDARDS[row.standardReferences.material]);
    expect(row.standardEdition.dimensions).toBe(STEEL_STANDARDS[row.standardReferences.dimensions]);
    for (const standard of Object.values(row.standardEdition)) {
      expect(standard.number).toMatch(/^JIS G [0-9]{4}$/u);
      expect(standard.edition).toMatch(/^[0-9]{4}$/u);
      expect(standard.verificationNote.length).toBeGreaterThan(0);
    }
    const source = createStandardPartSource(row.catalog, row.size, steelProductOptions(row));
    expect(Object.keys(source.options)).toEqual(['steelProduct', 'materialGrade', 'materialStandard',
      'productStandard', 'condition', 'evidence', 'length']);
    expect(JSON.stringify(source.options)).not.toContain('standardEdition');
    expect(JSON.stringify(source.options)).not.toContain('standardReferences');
    expect(steelProductFromSource(source)?.standardEdition).toEqual(row.standardEdition);
    expect(steelProductFromSource({ ...source, generatorRevision: '2-steel-1' })?.standardEdition)
      .toEqual(row.standardEdition);
  });

  it('rejects a copied ledger with an empty edition using the same independent SS400 oracle', () => {
    const copiedLedger = { ...STEEL_STANDARDS,
      'jis-g-3101-2024': { ...STEEL_STANDARDS['jis-g-3101-2024'], edition: '' } };
    const rows = steelProducts('SS400').map((row) => ({ ...row, standardEdition: {
      material: copiedLedger[row.standardReferences.material], dimensions: copiedLedger[row.standardReferences.dimensions],
    } }));
    expect(() => assertSS400Editions(rows)).toThrow();
    expect(STEEL_STANDARDS['jis-g-3101-2024'].edition).toBe('2024');
  });

  it.each(steelProducts('SS400', 'flatBar'))('$key stays within the evidenced SS400 flat thickness limit', (row) => {
    // sources §2: G 3101 table 1 limits SS400 flat bars to 100 mm; G 3194 gives standard dimensions.
    expect(STEEL_GRADE_RULES.SS400.flatBar.basis[0].locator).toContain('厚さ100 mm以下');
    expect(row.dimensions?.thickness).toBeGreaterThan(0);
    expect(row.dimensions?.thickness).toBeLessThanOrEqual(100);
  });
});
