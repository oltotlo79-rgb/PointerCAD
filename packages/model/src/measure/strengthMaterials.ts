import type { StrengthMaterialPreset, StrengthMaterialProperty, StrengthSource } from './strengthMaterialTypes.js';

/** Source editions not stated by the publisher stay unknown; a supplier excerpt is not the full standard. */
export const STRENGTH_SOURCES: Readonly<Record<string, StrengthSource>> = {
  'steel-elastic': {
    label: '鋼・鋳鋼・鍛鋼の弾性定数', standard: null, standardEdition: null,
    evidence: 'manufacturer-reference', revision: 1,
  },
  'ss400-plate': {
    label: 'SS400 鋼板', standard: 'JIS G 3101', standardEdition: null,
    evidence: 'supplier-excerpt', revision: 1,
  },
  'g3101-draft': {
    label: 'SS400 鋼板 表3', standard: 'JIS G 3101', standardEdition: 'JIS G 3101:9999（案）',
    evidence: 'standard-draft', revision: 1,
  },
  'sus304-sheet': {
    label: 'SUS304 冷延鋼板', standard: 'JIS G 4305', standardEdition: null,
    evidence: 'supplier-excerpt', revision: 1,
  },
  'a5052-h34': {
    label: 'A5052P-H34 板材', standard: 'JIS H 4000', standardEdition: null,
    evidence: 'supplier-excerpt', revision: 1,
  },
  's45c-heat-treatment': {
    label: 'S45C 熱処理別の参考値', standard: 'JIS G 4051', standardEdition: null,
    evidence: 'manufacturer-reference', revision: 1,
  },
};

const property = (mpa: string, sourceId: string, basis: StrengthMaterialProperty['basis']): StrengthMaterialProperty => ({ mpa, sourceId, basis });
const steelElastic = {
  youngModulus: property('205000', 'steel-elastic', 'reference'),
  shearModulus: property('79000', 'steel-elastic', 'reference'),
};

/** Each ID denotes material plus condition, not the body appearance/density selection. */
export const STRENGTH_MATERIALS: readonly StrengthMaterialPreset[] = [
  ...([
    ['ss400-plate-0-16', 0, 16, '245', '16 以下', '245 以上', 'G3101-T3-SS400-Y1'],
    ['ss400-plate-16-40', 16, 40, '235', '16 超え40 以下', '235 以上', 'G3101-T3-SS400-Y2'],
    ['ss400-plate-40-100', 40, 100, '215', '40 超え100 以下', '215 以上', 'G3101-T3-SS400-Y3'],
  ] satisfies readonly (readonly [string, number, number, string, string, string, string])[]).map(([id, greaterThan, atMost, yieldStress, thicknessPrinted, yieldPrinted, yieldRowId]): StrengthMaterialPreset => ({
    id, densityMaterialId: 'steel', grade: 'SS400', condition: '圧延鋼板（熱処理の指定なし）', product: 'plate',
    thicknessMm: { greaterThan, atMost }, thicknessPrinted, temperature: 'not-specified',
    yieldStress: { ...property(yieldStress, 'g3101-draft', 'minimum'),
      sourceValue: { printed: yieldPrinted, unit: 'N/mm2', rowId: yieldRowId } },
    tensileStrength: { ...property('400', 'g3101-draft', 'minimum'), maximumMpa: '510',
      sourceValue: { printed: '400～510', unit: 'N/mm2', rowId: 'G3101-T3-SS400-T1' } },
    ...steelElastic,
  })),
  {
    id: 's45c-normalized-reference', densityMaterialId: 'steel', grade: 'S45C', condition: '焼ならし・適用寸法未指定の参考値',
    product: 'general', thicknessMm: null, temperature: 'not-specified',
    yieldStress: property('345', 's45c-heat-treatment', 'reference'), tensileStrength: property('570', 's45c-heat-treatment', 'reference'),
    ...steelElastic,
  },
  {
    id: 's45c-quenched-tempered-reference', densityMaterialId: 'steel', grade: 'S45C', condition: '焼入焼戻・適用寸法未指定の参考値',
    product: 'general', thicknessMm: null, temperature: 'not-specified',
    yieldStress: property('490', 's45c-heat-treatment', 'reference'), tensileStrength: property('690', 's45c-heat-treatment', 'reference'),
    ...steelElastic,
  },
  {
    id: 'sus304-solution-cold-rolled', densityMaterialId: 'stainless', grade: 'SUS304', condition: '冷延鋼板・固溶化処理',
    product: 'cold-rolled-sheet', thicknessMm: null, temperature: 'not-specified',
    yieldStress: property('205', 'sus304-sheet', 'minimum'), tensileStrength: property('520', 'sus304-sheet', 'minimum'),
    youngModulus: property('193000', 'sus304-sheet', 'reference'), shearModulus: null,
  },
  {
    id: 'a5052p-h34-0.2-1.3', densityMaterialId: 'aluminum', grade: 'A5052P', condition: 'H34',
    product: 'plate', thicknessMm: { greaterThan: 0.2, atMost: 1.3, lowerInclusive: true }, temperature: 'not-specified',
    yieldStress: property('180', 'a5052-h34', 'minimum'), tensileStrength: property('235', 'a5052-h34', 'minimum'),
    youngModulus: null, shearModulus: null,
  },
];

export function findStrengthMaterial(id: string): StrengthMaterialPreset | undefined {
  return STRENGTH_MATERIALS.find((material) => material.id === id);
}
