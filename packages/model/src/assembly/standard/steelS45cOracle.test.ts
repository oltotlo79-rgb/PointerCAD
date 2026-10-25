import { describe, expect, it, vi } from 'vitest';

import { findStrengthMaterial, STRENGTH_MATERIALS } from '../../measure/strengthMaterials.js';
import { createStandardPartSource, buildStandardPartFromSource } from './buildStandardPart.js';
import {
  findSteelProduct, STEEL_EVIDENCE, STEEL_PRODUCTS, steelProductOptions, steelProducts,
} from './steelCatalog.js';
import { s45cProductRule, steelGradeRule } from './steelGradeRules.js';
import {
  S45C_BRIGHT_ORACLE, S45C_HOT_SAVED_OPTIONS, S45C_ORACLE_SOURCES, S45C_REJECTED_SECTIONS, S45C_STRENGTH_REFERENCE_ORACLE,
} from './steelS45cOracle.fixture.js';
import { STEEL_STANDARDS } from './steelStandards.js';

const TREATMENTS = ['N', 'A', 'QT', 'Q', 'T', 'normalized', 'annealed', 'quenched-tempered',
  '焼ならし', '焼なまし', '焼入焼戻し'] as const;
const TREATMENT_NAME = /(?:^|[^a-z0-9])(?:N|A|QT|Q|T)(?:$|[^a-z0-9])|normaliz|anneal|quench|temper|焼なら|焼なま|焼入|焼戻/i;

describe('independent S45C product and treatment oracle', () => {
  it('adds exactly 36 hot rounds and 116 hot flats in a separate saved contract', () => {
    const rows = steelProducts('S45C').filter((row) => row.condition === 'hotRolled-heatTreatmentUnspecified');
    expect(rows).toHaveLength(152);
    expect(rows.filter((row) => row.catalog === 'roundBar')).toHaveLength(36);
    expect(rows.filter((row) => row.catalog === 'flatBar')).toHaveLength(116);
    expect(rows.map((row) => row.key)).toEqual(S45C_HOT_SAVED_OPTIONS.map(([key]) => key));
    expect(new Set(rows.map((row) => row.key)).size).toBe(152);
  });

  it.each(S45C_HOT_SAVED_OPTIONS)('%s has the independently frozen hot condition and source',
    (steelProduct, materialGrade, materialStandard, productStandard, condition, evidence) => {
      const row = STEEL_PRODUCTS.find((candidate) => candidate.key === steelProduct);
      if (row === undefined) throw new Error(`Missing hot product: ${steelProduct}`);
      const saved = { steelProduct, materialGrade, materialStandard, productStandard, condition, evidence };
      expect(steelProductOptions(row)).toEqual(saved);
      expect(findSteelProduct(row.catalog, row.size, saved)).toBe(row);
      expect(row.geometry).toBe('nominal');
      expect(row.standardLengthsMm).toEqual([]);
      expect(STEEL_EVIDENCE[row.evidence].locator).toContain(row.catalog === 'roundBar' ? '表3' : 'p2〜3');
      expect(s45cProductRule(row.catalog, condition, productStandard).allowed).toBe(true);
      expect(steelGradeRule('S45C', row.catalog).allowed).toBe(true);
      expect(row.standardReferences).toEqual({ material: 'jis-g-4051-2026',
        dimensions: row.catalog === 'roundBar' ? 'jis-g-4051-2026' : 'jis-g-3194-2024' });
      const source = createStandardPartSource(row.catalog, row.size, { ...saved, length: '500*2' });
      expect(source.options).toEqual({ ...saved, length: '500*2' });
      expect(buildStandardPartFromSource(source)).not.toBeNull();
      // Same-size bright products retain their original identity; metadata cannot be exchanged.
      const bright = STEEL_PRODUCTS.find((candidate) => candidate.key === steelProduct.replace(':hotRolled', ''));
      if (bright !== undefined) {
        expect(bright.condition).toBe('brightBar-heatTreatmentUnspecified');
        expect(findSteelProduct(row.catalog, row.size, { ...saved, steelProduct: bright.key })).toBeUndefined();
        expect(findSteelProduct(row.catalog, row.size, { ...steelProductOptions(bright), steelProduct })).toBeUndefined();
      }
    });

  it('retains all six original bright products and their independently recorded source rows', () => {
    expect(S45C_BRIGHT_ORACLE).toHaveLength(6);
    expect(new Set(S45C_BRIGHT_ORACLE.map((row) => row.saved.steelProduct)).size).toBe(6);
    expect(S45C_BRIGHT_ORACLE.map((row) => row.inventoryRow)).toEqual([20, 21, 22, 23, 24, 25]);
    const bright = steelProducts('S45C').filter((row) => row.condition === 'brightBar-heatTreatmentUnspecified');
    expect(bright.map((row) => row.key)).toEqual(S45C_BRIGHT_ORACLE.map((row) => row.saved.steelProduct));
  });

  it.each(S45C_BRIGHT_ORACLE)('$saved.steelProduct preserves dimensions, six saved strings and source identity',
    (expected) => {
      const row = findSteelProduct(expected.catalog, expected.size, expected.saved);
      if (row === undefined) throw new Error(`Missing original product: ${expected.saved.steelProduct}`);
      expect(row.dimensions).toEqual(expected.dimensions);
      expect(row.key).toBe(expected.saved.steelProduct);
      expect(steelProductOptions(row)).toEqual(expected.saved);
      expect(Object.keys(steelProductOptions(row))).toHaveLength(6);
      expect(row.standardReferences).toEqual({ material: 'jis-g-4051-2026', dimensions: 'jis-g-3123-2004' });
      const evidence = S45C_ORACLE_SOURCES[expected.source];
      expect(STEEL_EVIDENCE[row.evidence]).toMatchObject({ url: evidence.url, sha256: evidence.sha256 });
      expect(row.productStandardEvidence).toMatchObject({
        url: S45C_ORACLE_SOURCES.brightProductStandard.url,
        sha256: S45C_ORACLE_SOURCES.brightProductStandard.sha256,
      });
      expect(row.standardLengthsMm).toEqual([]);
      expect(row.geometry).toBe('nominal');
      expect(s45cProductRule(row.catalog, row.condition, row.productStandard).allowed).toBe(true);
      // Nominal geometry is not a printed area/mass or a verified G 3123 standard table.
      expect(STEEL_STANDARDS['jis-g-3123-2004'].verification).toBe('unverified');
      const source = createStandardPartSource(row.catalog, row.size, { ...expected.saved, length: '500*2' });
      expect(source.options).toEqual({ ...expected.saved, length: '500*2' });
      expect(buildStandardPartFromSource(source)).not.toBeNull();
    });

  it('pins the provisional G 4051 evidence used for product and treatment reasons', () => {
    expect(STEEL_STANDARDS['jis-g-4051-2026'].draft).toMatchObject({
      url: S45C_ORACLE_SOURCES.carbonSteelDraft.url, sha256: S45C_ORACLE_SOURCES.carbonSteelDraft.sha256,
    });
    expect(STEEL_STANDARDS['jis-g-4051-2026'].verification).toBe('draft');
  });

  it.each(S45C_REJECTED_SECTIONS)('rejects S45C / %s with the independent clause and W1 reason code',
    (catalog, code, clause) => {
      for (const condition of ['brightBar-heatTreatmentUnspecified', 'hotRolled-heatTreatmentUnspecified', 'QT']) {
        const rule = s45cProductRule(catalog, condition, 'JIS G 4051');
        if (rule.allowed) throw new Error(`Unexpected S45C permission: ${catalog}`);
        expect(rule.reasonCode).toBe(code);
        expect(rule.reason).toContain('JIS G 4051');
        expect(rule.reason).toContain('機械構造用炭素鋼鋼材');
        expect(rule.reason).toContain(clause);
        if (catalog !== 'iBeam') {
          expect(rule).toBe(steelGradeRule('S45C', catalog));
          expect(steelProducts('S45C', catalog)).toEqual([]);
        } else {
          expect(rule).toBe(steelGradeRule('S45C', 'hBeam'));
        }
        if (catalog !== 'steelPipe') expect(rule.reason).toContain('協定品');
      }
    });

  it('scans every catalog row and every saved field for named heat treatments', () => {
    // SGP nominal sizes use an A suffix; it is not the stand-alone annealing code A.
    for (const nominal of ['15A', '20A', '25A', '32A', '40A', '50A']) {
      expect(nominal).not.toMatch(TREATMENT_NAME);
      expect(`SGP:steelPipe:${nominal}`).not.toMatch(TREATMENT_NAME);
    }
    for (const row of STEEL_PRODUCTS) {
      const options = steelProductOptions(row);
      expect(['hotRolled-heatTreatmentUnspecified', 'brightBar-heatTreatmentUnspecified', 'blackPipe-plainEnds', 'whitePipe-zincCoated'])
        .toContain(options.condition);
      for (const value of [row.key, row.size, ...Object.values(options)]) {
        expect(value, row.key).not.toMatch(TREATMENT_NAME);
      }
    }
  });

  it.each(TREATMENTS)('detects and rejects %s in saved fields, including appended or extra fields', (treatment) => {
    expect(treatment).toMatch(TREATMENT_NAME);
    for (const row of STEEL_PRODUCTS) {
      const options = steelProductOptions(row);
      for (const [field, value] of Object.entries(options)) {
        expect(findSteelProduct(row.catalog, row.size, { ...options, [field]: treatment })).toBeUndefined();
        expect(findSteelProduct(row.catalog, row.size, { ...options, [field]: `${value}-${treatment}` })).toBeUndefined();
      }
      expect(findSteelProduct(row.catalog, row.size, { ...options, heatTreatment: treatment })).toBeUndefined();
    }
    for (const row of S45C_BRIGHT_ORACLE) {
      const source = createStandardPartSource(row.catalog, row.size, { ...row.saved, length: '100' });
      expect(buildStandardPartFromSource({ ...source, options: { ...source.options, condition: treatment } })).toBeNull();
    }
  });

  it('keeps S45C strength references separate from product rows and saved options', () => {
    expect(STRENGTH_MATERIALS.filter((row) => row.grade === 'S45C').map((row) => row.id))
      .toEqual(S45C_STRENGTH_REFERENCE_ORACLE.map(([id]) => id));
    for (const [id, condition, yieldMpa, tensileMpa] of S45C_STRENGTH_REFERENCE_ORACLE) {
      const material = findStrengthMaterial(id);
      expect(material).toMatchObject({ id, grade: 'S45C', condition, product: 'general', thicknessMm: null,
        temperature: 'not-specified',
        yieldStress: { mpa: yieldMpa, basis: 'reference', sourceId: 'tsubaki-s45c' },
        tensileStrength: { mpa: tensileMpa, basis: 'reference', sourceId: 'tsubaki-s45c' } });
      expect(STEEL_PRODUCTS.some((row) => row.key === id || String(row.condition) === condition)).toBe(false);
    }
    for (const row of STEEL_PRODUCTS) {
      for (const field of ['yieldStress', 'tensileStrength', 'youngModulus', 'shearModulus', 'strengthMaterialId']) {
        expect(Object.hasOwn(row, field), row.key).toBe(false);
        expect(Object.hasOwn(steelProductOptions(row), field), row.key).toBe(false);
      }
      expect(findStrengthMaterial(row.key)).toBeUndefined();
      expect(findStrengthMaterial(row.materialGrade)).toBeUndefined();
    }
  });

  it('loads strength presets without evaluating the steel catalog', async () => {
    vi.resetModules();
    vi.doMock('./steelCatalog.js', () => { throw new Error('Strength must not read catalog data'); });
    try {
      const isolated = await import('../../measure/strengthMaterials.js');
      expect(isolated.findStrengthMaterial('s45c-normalized-reference')?.yieldStress.mpa).toBe('345');
      expect(isolated.findStrengthMaterial('s45c-quenched-tempered-reference')?.tensileStrength.mpa).toBe('690');
    } finally {
      vi.doUnmock('./steelCatalog.js');
      vi.resetModules();
    }
  });

  it('loads the steel catalog without evaluating strength presets', async () => {
    vi.resetModules();
    vi.doMock('../../measure/strengthMaterials.js', () => { throw new Error('Catalog must not read strength presets'); });
    try {
      const isolated = await import('./steelCatalog.js');
      for (const expected of S45C_BRIGHT_ORACLE) {
        expect(isolated.findSteelProduct(expected.catalog, expected.size, expected.saved)).toBeDefined();
      }
    } finally {
      vi.doUnmock('../../measure/strengthMaterials.js');
      vi.resetModules();
    }
  });
});
