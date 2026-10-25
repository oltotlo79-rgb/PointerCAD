import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { StandardPartSource } from '../resolveAssembly.js';
import {
  buildStandardPart, buildStandardPartFromSource, buildStandardPartFromSourceWithReason,
  createStandardPartSource, standardPartRejection, type StandardPartRejection,
} from './buildStandardPart.js';
import {
  LEGACY_STEEL_GENERATOR_REVISION, STEEL_CATALOG_REVISION, STEEL_GENERATOR_REVISION,
  STEEL_MATERIAL_GRADES, STEEL_PRODUCTS, steelProductOptions, type SteelMaterialGrade,
  type SteelProduct, type SteelSectionCatalog,
} from './steelCatalog.js';
import { STEEL_SECTION_CATALOGS, steelGradeRule } from './steelGradeRules.js';
import { CHANNEL_TABLE, EQUAL_ANGLE_TABLE, H_BEAM_TABLE } from './sections.js';
import { STEEL_STANDARDS } from './steelStandards.js';
import { STANDARD_CATALOG_REVISION, STANDARD_PART_GENERATOR_REVISION } from './types.js';
import { STEEL_GOLDEN } from './steelGolden.fixture.js';

const SAVED_FIELDS = ['steelProduct', 'materialGrade', 'materialStandard', 'productStandard', 'condition', 'evidence'] as const;
const SIZES = [...new Set([...STEEL_PRODUCTS, ...EQUAL_ANGLE_TABLE, ...CHANNEL_TABLE, ...H_BEAM_TABLE]
  .map((row) => row.size)), 'size-not-existing'];
const MATRIX = STEEL_MATERIAL_GRADES.flatMap((grade) => STEEL_SECTION_CATALOGS.flatMap((catalog) =>
  SIZES.map((size) => ({ grade, catalog, size }))));
const TAMPERED = STEEL_PRODUCTS.flatMap((row) => SAVED_FIELDS.map((field) => ({ row, field })));
const ORIGINAL_SOURCES: readonly StandardPartSource[] = STEEL_GOLDEN.map(({ source }) => source)
  .filter((source) => source.catalogRevision === STEEL_CATALOG_REVISION);
const DENIED = [
  ['SS400', 'steelPipe', 'pipe-outside-scope'],
  ['S45C', 'equalAngle', 'section-not-standardized-in-grade'],
  ['S45C', 'channel', 'section-not-standardized-in-grade'],
  ['S45C', 'hBeam', 'section-not-standardized-in-grade'],
  ['S45C', 'steelPipe', 'pipe-outside-scope'],
  ['SGP', 'flatBar', 'section-outside-scope'],
  ['SGP', 'roundBar', 'section-outside-scope'],
  ['SGP', 'equalAngle', 'section-outside-scope'],
  ['SGP', 'channel', 'section-outside-scope'],
  ['SGP', 'hBeam', 'section-outside-scope'],
] as const;

function sourceOf(row: SteelProduct): StandardPartSource {
  return createStandardPartSource(row.catalog, row.size, steelProductOptions(row));
}

function matrixSource(grade: SteelMaterialGrade, catalog: SteelSectionCatalog, size: string): StandardPartSource {
  const row = STEEL_PRODUCTS.find((candidate) => candidate.materialGrade === grade
    && candidate.catalog === catalog && candidate.size === size);
  if (row !== undefined) return sourceOf(row);
  const representative = STEEL_PRODUCTS.find((candidate) => candidate.materialGrade === grade);
  if (representative === undefined) throw new Error('Missing grade representative');
  return createStandardPartSource(catalog, size, { ...steelProductOptions(representative),
    steelProduct: `${grade}:${catalog}:${size}` });
}

function expectJapaneseBasis(rejection: StandardPartRejection): void {
  expect(rejection.message).toMatch(/[ぁ-んァ-ン一-龠]/);
  expect(rejection.basis.length).toBeGreaterThan(0);
  for (const basis of rejection.basis) {
    expect(rejection.message).toContain(STEEL_STANDARDS[basis.standardId].number);
    expect(rejection.message).toContain(STEEL_STANDARDS[basis.standardId].name);
    expect(rejection.message).toContain(basis.locator);
  }
}

describe('steel typed rejection: exhaustive grade / section / size product', () => {
  it('covers all 18 families and all sizes, preserving the original 31 alongside catalog additions', () => {
    expect(STEEL_MATERIAL_GRADES).toHaveLength(3);
    expect(STEEL_SECTION_CATALOGS).toHaveLength(6);
    expect(ORIGINAL_SOURCES).toHaveLength(31);
    for (const source of ORIGINAL_SOURCES) {
      const row = STEEL_PRODUCTS.find((candidate) => candidate.key === source.options.steelProduct);
      if (row === undefined) throw new Error(`Missing original steel product: ${source.options.steelProduct}`);
      expect({ ...steelProductOptions(row), length: '1000' }).toEqual(source.options);
    }
    expect(MATRIX).toHaveLength(18 * SIZES.length);
    expect(MATRIX.filter(({ grade, catalog, size }) => STEEL_PRODUCTS.some((row) =>
      row.materialGrade === grade && row.catalog === catalog && row.size === size)))
      .toHaveLength(new Set(STEEL_PRODUCTS.map((row) => `${row.materialGrade}:${row.catalog}:${row.size}`)).size);
  });

  it.each(STEEL_PRODUCTS)('$key accepts every product condition, including additions sharing a nominal size', (row) => {
    const source = sourceOf(row);
    const result = buildStandardPartFromSourceWithReason(source);
    expect(result.rejection).toBeNull();
    expect(result.document).not.toBeNull();
    expect(result.document).toEqual(buildStandardPartFromSource(source));
  });

  it.each(MATRIX)('$grade / $catalog / $size is permitted only for a catalog row', ({ grade, catalog, size }) => {
    const source = matrixSource(grade, catalog, size);
    const expected = STEEL_PRODUCTS.find((row) => row.materialGrade === grade && row.catalog === catalog && row.size === size);
    const result = buildStandardPartFromSourceWithReason(source);
    const direct = buildStandardPart(catalog, size, source.options);
    const saved = buildStandardPartFromSource(source);
    if (expected !== undefined) {
      expect(result.rejection).toBeNull();
      expect(result.document).not.toBeNull();
      expect(result.document).toEqual(saved);
      expect(direct).toEqual(saved);
    } else {
      expect(direct).toBeNull();
      expect(saved).toBeNull();
      expect(result.document).toBeNull();
      if (result.rejection === null) throw new Error('Rejected combination lacks a reason');
      const rule = steelGradeRule(grade, catalog);
      expect(result.rejection.code).toBe(rule.allowed ? 'size-not-in-catalog' : rule.reasonCode);
      expectJapaneseBasis(result.rejection);
    }
  });

  it.each(DENIED)('%s / %s preserves the independent W1 reason code %s', (grade, catalog, code) => {
    const result = standardPartRejection(matrixSource(grade, catalog, 'size-not-existing'));
    expect(result?.code).toBe(code);
    if (result === null) throw new Error('Missing W1 reason');
    expectJapaneseBasis(result);
  });
});

describe('saved steel options: six fields for every original row', () => {
  it('has 186 individual field changes and does not mutate source options', () => {
    expect(TAMPERED).toHaveLength(STEEL_PRODUCTS.length * 6);
    expect(TAMPERED.filter(({ row }) => ORIGINAL_SOURCES.some((source) => source.options.steelProduct === row.key)))
      .toHaveLength(186);
    const row = STEEL_PRODUCTS[0];
    if (row === undefined) throw new Error('Missing steel row');
    const source = Object.freeze({ ...sourceOf(row), options: Object.freeze(sourceOf(row).options) });
    const before = JSON.stringify(source);
    buildStandardPartFromSourceWithReason(source);
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each(TAMPERED)('$row.key / changed $field', ({ row, field }) => {
    const source = sourceOf(row);
    const options = { ...source.options, [field]: `${source.options[field]}-tampered` };
    const result = buildStandardPartFromSourceWithReason({ ...source, options });
    expect(buildStandardPart(row.catalog, row.size, options)).toBeNull();
    expect(buildStandardPartFromSource({ ...source, options })).toBeNull();
    expect(result.document).toBeNull();
    expect(result.rejection?.code).toBe('saved-fields-mismatch');
    expect(result.rejection?.fields).toEqual([field]);
    expect(result.rejection?.message).toContain(field);
  });

  it.each(TAMPERED)('$row.key / missing $field', ({ row, field }) => {
    const source = sourceOf(row);
    const options = { ...source.options };
    delete options[field];
    const result = buildStandardPartFromSourceWithReason({ ...source, options });
    expect(result.document).toBeNull();
    expect(result.rejection?.code).toBe('saved-fields-mismatch');
    expect(result.rejection?.fields).toEqual([field]);
  });

  it.each(STEEL_PRODUCTS)('$key rejects an extra field and a real different grade as saved-field mismatches', (row) => {
    const source = sourceOf(row);
    const extra = buildStandardPartFromSourceWithReason({ ...source, options: { ...source.options, heatTreatment: 'QT' } });
    expect(extra.document).toBeNull();
    expect(extra.rejection?.code).toBe('saved-fields-mismatch');
    expect(extra.rejection?.fields).toEqual(['heatTreatment']);
    const changedGrade = buildStandardPartFromSourceWithReason({ ...source,
      options: { ...source.options, materialGrade: row.materialGrade === 'SS400' ? 'S45C' : 'SS400' } });
    expect(changedGrade.document).toBeNull();
    expect(changedGrade.rejection?.code).toBe('saved-fields-mismatch');
    expect(changedGrade.rejection?.fields).toEqual(['materialGrade']);
  });

  it('identifies a changed steelProduct even when the substituted key is a real row of another grade', () => {
    const row = STEEL_PRODUCTS.find((candidate) => candidate.key === 'SS400:roundBar:φ25');
    if (row === undefined) throw new Error('Missing original shared size');
    const source = sourceOf(row);
    const result = buildStandardPartFromSourceWithReason({ ...source,
      options: { ...source.options, steelProduct: 'S45C:roundBar:φ25' } });
    expect(result.document).toBeNull();
    expect(result.rejection?.fields).toEqual(['steelProduct']);
  });
});

describe('reasoned generation preserves legacy entry points', () => {
  const row = STEEL_PRODUCTS[0];
  if (row === undefined) throw new Error('Missing steel row');
  const steel = sourceOf(row);

  it.each(['equalAngle', 'channel', 'hBeam', 'hexBolt'] as const)('explicitly rejects legacy %s plus steel metadata only in the new API', (catalog) => {
    const size = catalog === 'hexBolt' ? 'M8' : catalog === 'equalAngle' ? 'L 50×50×6'
      : catalog === 'channel' ? '[ 100×50×5×7.5' : 'H 150×150×7×10';
    const legacy: StandardPartSource = { kind: 'standardPart', catalog, size,
      options: { length: '30', materialGrade: 'S45C' }, catalogRevision: STANDARD_CATALOG_REVISION,
      generatorRevision: STANDARD_PART_GENERATOR_REVISION };
    expect(buildStandardPartFromSource(legacy)).not.toBeNull();
    const result = buildStandardPartFromSourceWithReason(legacy);
    expect(result.document).toBeNull();
    expect(result.rejection?.code).toBe('steel-options-with-legacy-revision');
  });

  it.each([['catalogRevision', 'future', 'unsupported-catalog-revision'],
    ['generatorRevision', 'future', 'unsupported-generator-revision']] as const)('rejects unknown %s without upgrading a saved source', (field, value, code) => {
    const source = { ...steel, [field]: value };
    expect(buildStandardPartFromSource(source)).toBeNull();
    expect(buildStandardPartFromSourceWithReason(source).rejection?.code).toBe(code);
  });

  it.each(['', '0', '-1', '0.5', '12001', 'NaN', 'Infinity', 'not-a-length'])('rejects invalid length %s', (length) => {
    const source = { ...steel, options: { ...steel.options, length } };
    expect(buildStandardPartFromSource(source)).toBeNull();
    expect(buildStandardPartFromSourceWithReason(source).rejection?.code).toBe('invalid-steel-length');
  });

  it.each([STEEL_GENERATOR_REVISION, LEGACY_STEEL_GENERATOR_REVISION])('accepts supported saved generation %s without changing provenance', (generatorRevision) => {
    const source = { ...steel, generatorRevision };
    const result = buildStandardPartFromSourceWithReason(source);
    expect(result.rejection).toBeNull();
    expect(result.document).toEqual(buildStandardPartFromSource(source));
    expect(result.document?.steelStockSource).toEqual(source);
  });

  it('rejects a nonsteel catalog with steel revisions and preserves nonsteel failures', () => {
    const source: StandardPartSource = { ...steel, catalog: 'hexBolt', size: 'M8' };
    expect(buildStandardPartFromSource(source)).toBeNull();
    expect(buildStandardPartFromSourceWithReason(source).rejection?.code).toBe('unsupported-steel-catalog');
    const bolt = createStandardPartSource('hexBolt', 'size-not-existing');
    expect(standardPartRejection(bolt)).toBeNull();
    expect(buildStandardPartFromSourceWithReason(bolt)).toMatchObject({ document: null,
      rejection: { code: 'generation-unavailable', message: 'この呼び寸法は用意されていません。' } });
    expect(steel.catalogRevision).toBe(STEEL_CATALOG_REVISION);
  });

  it('keeps every reason code, UI template and Japanese fallback in agreement', () => {
    const messages = JSON.parse(readFileSync(new URL('../../../../ui/src/i18n/ja/assembly.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const sources = [
      ...MATRIX.map(({ grade, catalog, size }) => matrixSource(grade, catalog, size)),
      ...TAMPERED.map(({ row: candidate, field }) => {
        const source = sourceOf(candidate);
        return { ...source, options: { ...source.options, [field]: 'tampered' } };
      }),
      { ...steel, catalogRevision: STANDARD_CATALOG_REVISION },
      { ...steel, catalogRevision: 'future' }, { ...steel, generatorRevision: 'future' },
      { ...steel, catalog: 'hexBolt' as const }, { ...steel, options: { ...steel.options, length: '0' } },
      createStandardPartSource('hexBolt', 'size-not-existing'),
    ];
    const codes = new Set<string>();
    for (const source of sources) {
      const rejection = buildStandardPartFromSourceWithReason(source).rejection;
      if (rejection === null) continue;
      codes.add(rejection.code);
      const template = messages[rejection.messageKey];
      if (typeof template !== 'string') throw new Error(`Missing UI template: ${rejection.messageKey}`);
      let message: string = template;
      for (const [key, value] of Object.entries(rejection.parameters)) message = message.split(`{${key}}`).join(value);
      expect(message).toBe(rejection.message);
      expect(message).not.toMatch(/\{[^}]+\}/);
    }
    expect(codes.size).toBe(11);
  });
});
