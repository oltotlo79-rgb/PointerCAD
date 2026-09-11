import type { StrengthMaterialPreset, StrengthMaterialProperty, StrengthSource } from './strengthMaterialTypes.js';

/** Source editions not stated by the publisher stay unknown; a supplier excerpt is not the full standard. */
export const STRENGTH_SOURCES: Readonly<Record<string, StrengthSource>> = {
  'jfe-steel-elastic': {
    url: 'https://www.jfe-steel.co.jp/products/building/assets/pdf/binran/binran_chapter04.pdf',
    publisher: 'JFEスチール', locator: '建築便覧4-1、PDF2ページ、鋼・鋳鋼・鍛鋼の弾性定数',
    checkedDate: '2026-09-11', standard: null, standardEdition: null, evidence: 'manufacturer-reference',
    sha256: '6ad196dbd6c400cada7ee28d6b2fd0c37b8d3f4c6ce51d923a5778909966db5f',
  },
  'nippon-ss400': {
    url: 'https://www.nipponsteel.com/product/plate/list/machinery/pdf/kyouken.pdf',
    publisher: '日本製鉄', locator: 'CORSPACE資料、PDF9ページ、表4-1（SS400と同じと記載された機械的性質）',
    checkedDate: '2026-09-11', standard: 'JIS G 3101', standardEdition: null, evidence: 'supplier-excerpt',
    sha256: 'aa11597e13f303f2fbe0b7b401906d9834ed8e80ce9e15b9f5fcc0b268d56a13',
  },
  'nippon-sus304': {
    url: 'https://www.nipponsteel.com/product/catalog_download/pdf/S008.pdf',
    publisher: '日本製鉄', locator: 'ステンレス冷延鋼板S008、PDF4ページ、SUS304の機械的性質と物理的性質',
    checkedDate: '2026-09-11', standard: 'JIS G 4305', standardEdition: null, evidence: 'supplier-excerpt',
    sha256: 'a5b2c358bbe56b6cc52a6d3bb0a1a8e4cb7310ac2ff42a0e780e8c2082c12ab7',
  },
  'jaa-a5052-h34': {
    url: 'https://www.aluminum.or.jp/fields/kenchiku/kenzai/guide/b/',
    publisher: '日本アルミニウム協会', locator: '建材ガイド、板材の機械的性質、A5052P-H34、厚さ0.2〜1.3mmの掲載範囲',
    checkedDate: '2026-09-11', standard: 'JIS H 4000', standardEdition: null, evidence: 'supplier-excerpt',
    sha256: '1f9958ae4e566c2f9ac831ac75fd9cd8a06376b683fd880d4e74d8e9b73a150f',
  },
  'tsubaki-s45c': {
    url: 'https://tt-net.tsubakimoto.co.jp/tecs/calc/kpl/calc_kpl_strength.asp?lang=jp&yp=b',
    publisher: '椿本チエイン', locator: '降伏点強度一覧、先頭の鋼材表と直前の熱処理脚注。適用寸法・温度の記載なし',
    checkedDate: '2026-09-11', standard: 'JIS G 4051', standardEdition: null, evidence: 'manufacturer-reference',
    sha256: '9514d65e9015514cfd7c550055160f86c9a5fa5268417103b808865a4cf5d4ee',
  },
};

const property = (mpa: string, sourceId: string, basis: StrengthMaterialProperty['basis']): StrengthMaterialProperty => ({ mpa, sourceId, basis });
const steelElastic = {
  youngModulus: property('205000', 'jfe-steel-elastic', 'reference'),
  shearModulus: property('79000', 'jfe-steel-elastic', 'reference'),
};

/** Each ID denotes material plus condition, not the body appearance/density selection. */
export const STRENGTH_MATERIALS: readonly StrengthMaterialPreset[] = [
  ...([
    ['ss400-plate-0-16', 0, 16, '245'], ['ss400-plate-16-40', 16, 40, '235'],
    ['ss400-plate-40-100', 40, 100, '215'],
  ] satisfies readonly (readonly [string, number, number, string])[]).map(([id, greaterThan, atMost, yieldStress]): StrengthMaterialPreset => ({
    id, densityMaterialId: 'steel', grade: 'SS400', condition: '圧延鋼板（熱処理の指定なし）', product: 'plate',
    thicknessMm: { greaterThan, atMost }, temperature: 'not-specified',
    yieldStress: property(yieldStress, 'nippon-ss400', 'minimum'), tensileStrength: property('400', 'nippon-ss400', 'minimum'),
    ...steelElastic,
  })),
  {
    id: 's45c-normalized-reference', densityMaterialId: 'steel', grade: 'S45C', condition: '焼ならし・適用寸法未指定の参考値',
    product: 'general', thicknessMm: null, temperature: 'not-specified',
    yieldStress: property('345', 'tsubaki-s45c', 'reference'), tensileStrength: property('570', 'tsubaki-s45c', 'reference'),
    ...steelElastic,
  },
  {
    id: 's45c-quenched-tempered-reference', densityMaterialId: 'steel', grade: 'S45C', condition: '焼入焼戻・適用寸法未指定の参考値',
    product: 'general', thicknessMm: null, temperature: 'not-specified',
    yieldStress: property('490', 'tsubaki-s45c', 'reference'), tensileStrength: property('690', 'tsubaki-s45c', 'reference'),
    ...steelElastic,
  },
  {
    id: 'sus304-solution-cold-rolled', densityMaterialId: 'stainless', grade: 'SUS304', condition: '冷延鋼板・固溶化処理',
    product: 'cold-rolled-sheet', thicknessMm: null, temperature: 'not-specified',
    yieldStress: property('205', 'nippon-sus304', 'minimum'), tensileStrength: property('520', 'nippon-sus304', 'minimum'),
    youngModulus: property('193000', 'nippon-sus304', 'reference'), shearModulus: null,
  },
  {
    id: 'a5052p-h34-0.2-1.3', densityMaterialId: 'aluminum', grade: 'A5052P', condition: 'H34',
    product: 'plate', thicknessMm: { greaterThan: 0.2, atMost: 1.3, lowerInclusive: true }, temperature: 'not-specified',
    yieldStress: property('180', 'jaa-a5052-h34', 'minimum'), tensileStrength: property('235', 'jaa-a5052-h34', 'minimum'),
    youngModulus: null, shearModulus: null,
  },
];

export function findStrengthMaterial(id: string): StrengthMaterialPreset | undefined {
  return STRENGTH_MATERIALS.find((material) => material.id === id);
}
