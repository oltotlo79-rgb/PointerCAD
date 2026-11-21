import { describe, expect, it } from 'vitest';
import { createStandardPartSource } from '../assembly/standard/buildStandardPart.js';
import { steelProductOptions, steelProducts, type SteelMaterialGrade } from '../assembly/standard/steelCatalog.js';
import { catalogStrengthMaterials } from './catalogStrengthMaterials.js';

function sourceFor(grade: SteelMaterialGrade) {
  const row = steelProducts(grade)[0];
  if (!row) throw new Error('Missing catalog fixture');
  return createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '100' });
}

describe('catalog strength material candidates', () => {
  it('preserves both treatments and all three plate ranges', () => {
    expect(catalogStrengthMaterials(sourceFor('S45C')).map(row => row.id)).toEqual([
      's45c-normalized-reference', 's45c-quenched-tempered-reference',
    ]);
    expect(catalogStrengthMaterials(sourceFor('SS400')).map(row => row.thicknessMm?.atMost)).toEqual([16, 40, 100]);
  });

  it('requires the exact grade and a resolved catalog identity', () => {
    expect(catalogStrengthMaterials(sourceFor('SUS304TP'))).toEqual([]);
    expect(catalogStrengthMaterials(createStandardPartSource('hexBolt', 'M6', { length: '20' }))).toEqual([]);
    expect(catalogStrengthMaterials({ ...sourceFor('S45C'), catalogRevision: '' })).toEqual([]);
  });
});
