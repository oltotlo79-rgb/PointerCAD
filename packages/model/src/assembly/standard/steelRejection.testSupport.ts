import type { StandardPartSource } from '../resolveAssembly.js';
import { createStandardPartSource } from './buildStandardPart.js';
import { STEEL_MATERIAL_GRADES, STEEL_PRODUCTS, steelProductOptions, type SteelMaterialGrade, type SteelProduct, type SteelSectionCatalog } from './steelCatalog.js';
import { STEEL_SECTION_CATALOGS } from './steelGradeRules.js';
import { CHANNEL_TABLE, EQUAL_ANGLE_TABLE, H_BEAM_TABLE } from './sections.js';
import { STANDARD_CATALOG_REVISION } from './types.js';

const SAVED_FIELDS = ['steelProduct', 'materialGrade', 'materialStandard', 'productStandard', 'condition', 'evidence'] as const;
export const SIZES = [...new Set([...STEEL_PRODUCTS, ...EQUAL_ANGLE_TABLE, ...CHANNEL_TABLE, ...H_BEAM_TABLE]
  .map((row) => row.size)), 'size-not-existing'];
export const MATRIX = STEEL_MATERIAL_GRADES.flatMap((grade) => STEEL_SECTION_CATALOGS.flatMap((catalog) =>
  SIZES.map((size) => ({ grade, catalog, size }))));
export const TAMPERED = STEEL_PRODUCTS.flatMap((row) => SAVED_FIELDS.map((field) => ({ row, field })));
export function sourceOf(row: SteelProduct): StandardPartSource {
  return createStandardPartSource(row.catalog, row.size, steelProductOptions(row));
}

export function matrixSource(grade: SteelMaterialGrade, catalog: SteelSectionCatalog, size: string): StandardPartSource {
  const row = STEEL_PRODUCTS.find((candidate) => candidate.materialGrade === grade
    && candidate.catalog === catalog && candidate.size === size);
  if (row !== undefined) return sourceOf(row);
  const representative = STEEL_PRODUCTS.find((candidate) => candidate.materialGrade === grade);
  if (representative === undefined) throw new Error('Missing grade representative');
  return createStandardPartSource(catalog, size, { ...steelProductOptions(representative),
    steelProduct: `${grade}:${catalog}:${size}` });
}

export function steelMessageRejectionSourcesForUi(): StandardPartSource[] {
  const row = STEEL_PRODUCTS[0];
  if (row === undefined) throw new Error('Missing steel row');
  const steel = sourceOf(row);
  return [
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
}
